import { Circle, Line, Polyline, Rect, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useRef, useState } from 'react'

import { objectToArtboard } from '../geometry/objectSpace'
import { IDENTITY, applyToPoint, applyToVector, invert, multiply } from '../geometry/transform'
import {
  insertNodeOn,
  moveHandle,
  moveNode,
  outlineToPath,
  removeNode,
  toggleSmooth,
  type NodeRef,
} from '../geometry/outline'
import { distanceToPolyline } from '../geometry/resample'
import { samplePath } from '../geometry/run'
import { typographyById, useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { valuesFor } from '../frame/frame'
import { frameTargetFor } from './memberEdits'
import type { PathOutline, Transform2D, TypographyObject, Vec2 } from '../types/document'
import { pathContainsPoint } from '../geometry/path'

const LINE_COLOR = '#e0552f'
/** Radius of a node marker, in SCREEN pixels — divided by zoom before use. */
const HANDLE_RADIUS = 5
/** A Bézier handle's own dot, smaller so an anchor still reads as the main thing. */
const CONTROL_RADIUS = 3.5
/** Wash of the accent behind a point the pointer is over. */
const HOVER_FILL = '#f9ddd3'
/** How finely the guide follows the curve, in object units. */
const GUIDE_SPACING = 3
/** Screen pixels the pointer must travel before a press counts as a drag. */
const DRAG_THRESHOLD = 3
/** How near the line a double-click must land to add a point to it, in screen pixels. */
const CURVE_HIT_RADIUS = 8

/** A node marker's four states, and what each one looks like. */
interface NodeStyle {
  fill: string
  stroke: string
  strokeWidth: number
  /** Multiplier on the marker's radius. */
  scale: number
}

/**
 * How a point looks, given whether it is open and whether the pointer is on it.
 *
 * Two independent things to say and four combinations to say them in, so they
 * are worked out here rather than spelled out at the marker: FILL carries state
 * — hollow means untouched, solid means this is the point whose handles are out
 * — and SIZE carries the pointer, growing a little under it.
 *
 * Keeping the two on different channels is what makes the fourth combination
 * legible at all: a selected point under the pointer has to read as both, and it
 * cannot if either one owns the same property.
 */
function nodeStyle(selected: boolean, hovered: boolean): NodeStyle {
  return {
    fill: selected ? LINE_COLOR : hovered ? HOVER_FILL : '#fff',
    // A selected point is drawn in reverse — light on the accent — so it still
    // has an edge against the curve it sits on.
    stroke: selected ? '#fff' : LINE_COLOR,
    strokeWidth: hovered ? 2 : 1.5,
    scale: hovered ? 1.35 : 1,
  }
}

interface PathLayerProps {
  canvas: FabricCanvas | null
  /** The object whose points are being edited, if any. */
  object: TypographyObject | undefined
  /**
   * The transform of whatever CONTAINS the object, when something does.
   *
   * A frame's member is positioned relative to its frame, not to the artboard,
   * so its own transform maps its points into the FRAME's space and stops
   * there. Mapping with that alone drew every handle at frame-local coordinates
   * read as artboard ones — the points appeared bodily somewhere else on the
   * canvas, nowhere near the shape they belonged to. Composing this on top
   * finishes the journey.
   */
  host?: Transform2D | undefined
}

/** A node, and which of its handles — or none, for the anchor itself. */
interface Hit {
  ref: NodeRef
  side: 'in' | 'out' | null
}

const sameNode = (a: NodeRef | Hit | null, b: NodeRef | Hit | null): boolean => {
  const one = a && 'ref' in a ? a.ref : a
  const two = b && 'ref' in b ? b.ref : b
  if (!one || !two) return false
  return one.subpath === two.subpath && one.node === two.node
}

const sameHit = (a: Hit | null, b: Hit | null): boolean =>
  a === b || (sameNode(a, b) && a?.side === b?.side)

/** What a press took hold of, and where it started. */
interface Grab {
  ref: NodeRef
  /** A handle drag names its side; a node drag has none. */
  side: 'in' | 'out' | null
  from: Vec2
  /** The handle as it was when the press landed, so the drag is relative. */
  was: Vec2
  engaged: boolean
  /** Alt was down: this drag breaks the point rather than turning both sides. */
  breaking: boolean
}

/**
 * A path's own points, on screen and editable.
 *
 * Modelled on `GridLayer`, which solved the mechanics already: markers drawn
 * straight onto the Fabric canvas rather than into the document, gesture state
 * held in refs so the handlers never re-register, and one history entry per drag
 * rather than one per pointer sample.
 *
 * What it does NOT reuse is `gridModel`. That models a four-edge boundary stack
 * with dividers evaluated as a height across a width, which cannot describe a
 * free curve — a drawn path doubles back, loops, and goes wherever it was drawn.
 * The overlay is the reusable part; the model is not.
 *
 * The interaction is Figma's, and the same for a line and a shape: a click
 * selects the object to move and turn, a double-click goes INSIDE it to the
 * points, and clicking a point reveals the two handles that shape the curve
 * either side of it. Drag a point to move it, drag a handle to bend the curve.
 * Alt-click a point to switch it between a corner and a smooth point; Alt-drag a
 * handle to break the smooth one. Double-click a point to take it away, or the
 * curve to put one where you clicked. Escape leaves.
 *
 * Square markers are corners and round ones are smooth, which is the convention
 * every vector editor shares.
 */
export function PathLayer({ canvas, object, host }: PathLayerProps) {
  const shapesRef = useRef<FabricObject[]>([])
  /**
   * The nodes as they are being dragged.
   *
   * Held here rather than read back from the document, for the reason the grid
   * editor learned: an edit rewrites the geometry, and re-deriving the points
   * from that would feed the result into its own input. The document is written
   * to, never read from, for the length of a drag — so every frame of a drag is
   * measured from where the path was when the press landed, not from where the
   * last frame left it.
   *
   * A reference, not a copy, and safely so: every node operation returns a new
   * outline rather than editing one in place. That matters because
   * `duplicateObjects` spreads objects shallowly, so two objects can share an
   * outline, and an in-place edit here would change both.
   */
  const outlineRef = useRef<PathOutline | null>(null)
  const grabRef = useRef<Grab | null>(null)

  /**
   * Which node has its handles showing.
   *
   * State rather than a ref: revealing the handles has to redraw the overlay,
   * which is the one piece of this component's gesture handling that the user
   * sees change without anything being written to the document.
   */
  const [revealed, setRevealed] = useState<NodeRef | null>(null)
  /**
   * What the pointer is over, if anything.
   *
   * Its own state rather than a ref, because it is the one thing here that has
   * to redraw without the document changing. Only ever written when the answer
   * actually differs, so an ordinary mouse move across the canvas costs a hit
   * test and nothing else.
   */
  const [hovered, setHovered] = useState<Hit | null>(null)

  const outline = object?.outline ?? null
  const active = Boolean(outline)

  /*
   * Object space to the artboard and back, through the container if there is
   * one. Matrices rather than a combined `Transform2D`, because composing two
   * transforms is not in general a transform — a rotated frame holding a scaled
   * member produces a shear, which the seven fields cannot express.
   */
  const toArtboardMat = object
    ? host
      ? multiply(objectToArtboard(host), objectToArtboard(object.transform))
      : objectToArtboard(object.transform)
    : IDENTITY
  const toObjectMat = invert(toArtboardMat)

  /*
   * Leaving takes the highlights with it.
   *
   * Both survive as state otherwise, and the overlay would come back next time
   * with a point already lit and another already opened — pointing at whatever
   * happened to be under the pointer when the user left.
   */
  useEffect(() => {
    if (active) return
    setHovered(null)
    setRevealed(null)
  }, [active])

  /* Draw the overlay. */
  useEffect(() => {
    if (!canvas) return

    const clear = (): void => {
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }

    clear()
    if (!active || !object || !outline) {
      canvas.requestRenderAll()
      return
    }

    // Markers are sized in SCREEN pixels: a point you cannot aim at when zoomed
    // out is not a point you can edit. `GridLayer` already does this.
    const zoom = canvas.getZoom() || 1
    const radius = HANDLE_RADIUS / zoom
    const toArtboard = (p: Vec2): Vec2 => applyToPoint(toArtboardMat, p)

    const add = (shape: FabricObject): void => {
      canvas.add(shape)
      shapesRef.current.push(shape)
    }

    const shared = {
      selectable: false,
      evented: false,
      objectCaching: false,
      strokeUniform: true,
    } as const

    outline.subpaths.forEach((subpath, index) => {
      /*
       * The curve ITSELF, sampled, rather than a polyline through the anchors.
       *
       * Those were the same thing back when a drawn line came out with sixty-odd
       * anchors — chords between points a few units apart lie on the curve. Once
       * the fit was loosened to the half-dozen anchors a line actually needs, the
       * chords started cutting visibly across every bend, so the guide showed a
       * different line from the one the letters were standing on.
       *
       * Sampled per subpath, because `samplePath` keeps only the longest one and
       * a shape with a hole has more than one contour to draw.
       */
      const data = outlineToPath({ subpaths: [subpath] })
      const along = samplePath(data, GUIDE_SPACING) ?? subpath.nodes.map((n) => n.point)
      const samples = along.map(toArtboard)
      // A closed contour's sampling stops at the last point before the seam;
      // joining it back to the start keeps the guide from showing a gap that is
      // not there.
      if (subpath.closed && samples[0]) samples.push({ ...samples[0] })

      // A copy, taken before Fabric is handed the array: a `Polyline` owns its
      // points and is free to rebase them against its own origin, and the hit
      // test below needs them in the space they were measured in.
      const hitSamples = samples.map((p) => ({ ...p }))

      const guide = new Polyline(samples, {
        ...shared,
        stroke: LINE_COLOR,
        strokeWidth: 1,
        fill: 'transparent',
      })
      guide.set('gridRole', 'curve')
      guide.set('subpath', index)
      /*
       * Kept on the shape rather than recomputed on demand.
       *
       * This is the same curve the double-click hit test needs, and Fabric's own
       * hit testing is no use for it — the guide is deliberately not evented, so
       * that a press goes to the nodes rather than to a hairline.
       */
      guide.set('samples', hitSamples)
      add(guide)
    })

    outline.subpaths.forEach((subpath, subpathIndex) => {
      subpath.nodes.forEach((node, nodeIndex) => {
        const ref = { subpath: subpathIndex, node: nodeIndex }
        const at = toArtboard(node.point)
        // Hovering a HANDLE must not light its anchor up as well: they are two
        // different things to grab, and saying so is the whole point.
        const style = nodeStyle(
          sameNode(ref, revealed),
          hovered?.side === null && sameNode(ref, hovered),
        )
        const size = radius * style.scale
        /*
         * Square for a corner, round for a smooth point — the convention every
         * vector editor shares, and the only way to see at a glance which points
         * will kink when they are dragged.
         */
        const common = {
          ...shared,
          left: at.x,
          top: at.y,
          originX: 'center',
          originY: 'center',
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth / zoom,
        } as const
        const marker = node.smooth
          ? new Circle({ ...common, radius: size })
          : new Rect({ ...common, width: size * 2, height: size * 2 })
        marker.set('gridRole', 'node')
        marker.set('nodeRef', ref)
        add(marker)
      })
    })

    /*
     * The revealed node's handles, drawn LAST so they sit above every anchor.
     *
     * Only one node's at a time. Showing every handle on a path at once is a
     * thicket you cannot aim into, and it is not what the user asked to see:
     * they clicked one point.
     */
    const node = revealed ? outline.subpaths[revealed.subpath]?.nodes[revealed.node] : null
    if (node && revealed) {
      const anchor = toArtboard(node.point)
      for (const side of ['in', 'out'] as const) {
        const handle = side === 'in' ? node.handleIn : node.handleOut
        if (Math.abs(handle.x) < 1e-9 && Math.abs(handle.y) < 1e-9) continue
        const offset = applyToVector(toArtboardMat, handle)
        const tip = { x: anchor.x + offset.x, y: anchor.y + offset.y }

        add(
          new Line([anchor.x, anchor.y, tip.x, tip.y], {
            ...shared,
            stroke: LINE_COLOR,
            strokeWidth: 1,
          }),
        )
        const warm = hovered?.side === side && sameNode(revealed, hovered)
        const dot = new Circle({
          ...shared,
          left: tip.x,
          top: tip.y,
          radius: ((warm ? CONTROL_RADIUS + 1.5 : CONTROL_RADIUS)) / zoom,
          originX: 'center',
          originY: 'center',
          fill: LINE_COLOR,
          stroke: warm ? '#fff' : LINE_COLOR,
          strokeWidth: 1.5 / zoom,
        })
        dot.set('gridRole', 'nodeHandle')
        dot.set('nodeRef', revealed)
        dot.set('handleSide', side)
        add(dot)
      }
    }

    canvas.requestRenderAll()
    return clear
  }, [canvas, active, object, outline, revealed, hovered])

  /* Keep the live values the handlers read, without re-registering them. */
  const liveRef = useRef({ object, active, revealed, hovered, toObjectMat })
  liveRef.current = { object, active, revealed, hovered, toObjectMat }

  useEffect(() => {
    if (!canvas) return

    /**
     * What the pointer is over.
     *
     * HANDLES BEFORE ANCHORS, always. A handle that has been dragged onto its
     * own anchor sits exactly on top of it, and an anchor-first scan would then
     * make that handle unreachable — the one case where the user most needs to
     * grab it back.
     */
    const hit = (scene: Vec2): Hit | null => {
      const zoom = canvas.getZoom() || 1
      for (const role of ['nodeHandle', 'node'] as const) {
        const reach = ((role === 'node' ? HANDLE_RADIUS : CONTROL_RADIUS) + 4) / zoom
        let best: Hit | null = null
        let bestDistance = reach
        for (const shape of shapesRef.current) {
          if (shape.get('gridRole') !== role) continue
          const distance = Math.hypot(shape.left - scene.x, shape.top - scene.y)
          if (distance > bestDistance) continue
          bestDistance = distance
          best = {
            ref: shape.get('nodeRef') as NodeRef,
            side: (shape.get('handleSide') as 'in' | 'out' | undefined) ?? null,
          }
        }
        if (best) return best
      }
      return null
    }

    const onDown = (opt: { e: Event }): void => {
      const { object: target, active: on } = liveRef.current
      if (!on || !target?.outline) return
      /*
       * One press, one owner.
       *
       * The grid editor shares this mode and this canvas, and it registers its
       * handlers first, so it sees a press before this does. When it takes one —
       * a divider handle under the pointer — it says so by flagging the object as
       * being interacted with, and this stands down. Without that a press landing
       * near both a divider's end and an outline node started two drags at once,
       * and the shape and the line inside it moved together.
       */
      if (useUiStore.getState().interacting === target.id) return
      // Scene units, not page ones — the same conversion the grid editor makes.
      const scene = canvas.getScenePoint(opt.e as MouseEvent)
      const found = hit(scene)
      if (!found) return

      const alt = (opt.e as MouseEvent).altKey === true

      /*
       * Alt on an ANCHOR is not a drag at all — it changes what the point is,
       * and does it there and then. Alt on a HANDLE is a drag that breaks the
       * point, which is a different gesture and is handled in `onMove`.
       */
      if (alt && !found.side) {
        const next = toggleSmooth(target.outline, found.ref)
        if (next !== target.outline) {
          write(target, next, target.outline.subpaths[found.ref.subpath]?.nodes[found.ref.node]
            ?.smooth
            ? 'Make corner'
            : 'Make smooth')
        }
        setRevealed(found.ref)
        return
      }

      // Clicking an anchor is what reveals its handles. Clicking a handle keeps
      // whatever is already revealed — it belongs to that node.
      if (!found.side) setRevealed(found.ref)

      const node = target.outline.subpaths[found.ref.subpath]?.nodes[found.ref.node]
      if (!node) return
      const was = found.side === 'in' ? node.handleIn : found.side === 'out' ? node.handleOut : node.point

      /*
       * The object holds still for the length of the drag, so it is the resting
       * shape whose node is being moved rather than a frame of an animation. A
       * marker sitting where the deformed curve is, over geometry that is
       * somewhere else, cannot be aimed at.
       */
      useUiStore.getState().setInteracting(target.id)
      outlineRef.current = target.outline
      grabRef.current = {
        ref: found.ref,
        side: found.side,
        from: scene,
        was: { ...was },
        engaged: false,
        breaking: alt,
      }
    }

    const onMove = (opt: { e: Event }): void => {
      const grab = grabRef.current
      const { object: target } = liveRef.current
      const held = outlineRef.current
      const scene = canvas.getScenePoint(opt.e as MouseEvent)

      /*
       * What the pointer is over, while nothing is being dragged.
       *
       * Not during a drag: the answer would be whatever the dragged point is
       * passing over, and lighting those up as the pointer sweeps them is noise
       * about something that is not going to happen.
       */
      if (!grab) {
        if (liveRef.current.active) {
          const over = hit(scene)
          if (!sameHit(over, liveRef.current.hovered)) setHovered(over)
        }
        return
      }
      if (!target || !held) return

      if (!grab.engaged) {
        const zoom = canvas.getZoom() || 1
        const moved = Math.hypot(scene.x - grab.from.x, scene.y - grab.from.y)
        if (moved * zoom < DRAG_THRESHOLD) return
        grab.engaged = true
      }

      if (!grab.side) {
        write(target, moveNode(held, grab.ref, applyToPoint(liveRef.current.toObjectMat, scene)), null)
        return
      }

      /*
       * A handle moves by the pointer's DELTA rather than to the pointer itself.
       *
       * The dot the user grabbed is a few pixels wide and they will not have
       * caught its centre, so moving it to the pointer would jump it by that
       * much on the first pixel of the drag. The delta keeps the grab where they
       * put it.
       */
      const delta = applyToVector(liveRef.current.toObjectMat, {
        x: scene.x - grab.from.x,
        y: scene.y - grab.from.y,
      })
      write(
        target,
        moveHandle(
          held,
          grab.ref,
          grab.side,
          { x: grab.was.x + delta.x, y: grab.was.y + delta.y },
          grab.breaking,
        ),
        null,
      )
    }

    const onUp = (): void => {
      const grab = grabRef.current
      const { object: target } = liveRef.current
      useUiStore.getState().setInteracting(null)
      grabRef.current = null
      const held = outlineRef.current
      outlineRef.current = null
      if (!grab?.engaged || !target || !held) return

      /*
       * ONE history entry for the whole drag, and it says what the drag DID:
       * breaking a smooth point is a change to what the point is, not just to
       * where its handle sits, and undo should read truthfully.
       */
      const label = !grab.side
        ? 'Move point'
        : grab.breaking
          ? 'Break point'
          : 'Bend curve'
      // The document already holds the last frame of the drag; this only marks
      // it, which is why the outline is re-read rather than recomputed.
      // As the STORE has it now, and for a member that means the state's own
      // points — `typographyById` would answer with the member's resting shape,
      // which is the one thing a morph guarantees is not what is on screen.
      const current = currentOutline(target.id)
      if (current) write(target, current, label)
    }

    /**
     * Double-click adds or removes, and what is under the pointer decides which.
     *
     * The same rule the grid editor uses, for the same reason: adding on a plain
     * click means every press that misses a point quietly changes the drawing,
     * and a few stray clicks leave a path full of points nobody asked for. A
     * double-click cannot happen by accident.
     */
    /** How far the pointer is from the drawn curve, in scene units. */
    const distanceToCurve = (scene: Vec2): number => {
      let best = Infinity
      for (const shape of shapesRef.current) {
        if (shape.get('gridRole') !== 'curve') continue
        const samples = shape.get('samples') as Vec2[] | undefined
        if (samples) best = Math.min(best, distanceToPolyline(scene, samples))
      }
      return best
    }

    /**
     * Double-click adds, removes, or leaves — and what is under the pointer
     * decides which.
     *
     * Add and remove are double-clicks for the reason the grid editor uses them:
     * doing either on a plain press means every click that misses a point
     * quietly changes the drawing, and a few stray clicks leave a path full of
     * points nobody asked for.
     *
     * Leaving is the same gesture again, on nothing. Measured against the CURVE,
     * not against the object's bounding box: the box is not drawn in this mode,
     * so making it the boundary means a double-click in the middle of a shape
     * does nothing for a reason the user cannot see. Anywhere that is not the
     * path is "outside".
     */
    const onDoubleClick = (opt: { e: Event }): void => {
      const { object: target, active: on } = liveRef.current
      if (!on || !target?.outline) return
      const scene = canvas.getScenePoint(opt.e as MouseEvent)

      // Any half-finished grab is dropped: the first press of this double-click
      // took hold of something, and the gesture turned out to mean otherwise.
      outlineRef.current = null
      grabRef.current = null

      const found = hit(scene)
      if (found) {
        // Stops here either way, refused or not: the pointer is on a point, and
        // the gesture means "take this away".
        if (found.side) return
        const kept = removeNode(target.outline, found.ref)
        if (kept) {
          setRevealed(null)
          write(target, kept, 'Remove point')
        }
        return
      }

      const reach = CURVE_HIT_RADIUS / (canvas.getZoom() || 1)
      if (distanceToCurve(scene) > reach) {
        /*
         * Away from the outline AND outside the shape means "let me out".
         *
         * Away from the outline alone is not enough, because the whole interior
         * qualifies — and the interior belongs to the grid, where a double-click
         * adds a deformer line. Taking it as an exit meant that double-clicking
         * in the middle of a shape to add one closed the editor instead, after
         * the grid had already added the line.
         */
        const at = applyToPoint(liveRef.current.toObjectMat, scene)
        if (!pathContainsPoint(target.currentSourcePath, at)) {
          useUiStore.getState().setEditingPoints(null)
        }
        return
      }

      const at = applyToPoint(liveRef.current.toObjectMat, scene)
      // Object units: the hit radius is in screen pixels, and the object may be
      // scaled as well as zoomed.
      const local = applyToVector(liveRef.current.toObjectMat, { x: reach, y: 0 })
      const result = insertNodeOn(target.outline, at, Math.hypot(local.x, local.y))
      if (!result) return
      setRevealed(result.ref)
      write(target, result.outline, 'Add point')
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    canvas.on('mouse:dblclick', onDoubleClick)
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      canvas.off('mouse:dblclick', onDoubleClick)
    }
  }, [canvas])

  return null
}

/**
 * Write an edited outline, and the path it describes, to the document.
 *
 * Both halves together through `setGeometry`, which is the only door geometry
 * goes through: the path is what every downstream reader consumes and the nodes
 * are what the editor takes hold of, and a writer that updates one without the
 * other leaves a stale list that jumps the shape on the next drag.
 *
 * The local origin is left where it is. It is fixed for the object's lifetime —
 * every transform in the document is measured from it — so a point moving
 * changes the bounds and never the origin.
 */
function write(target: TypographyObject, outline: PathOutline, label: string | null): void {
  const path = outlineToPath(outline)
  if (!path) return
  const store = useDocumentStore.getState()

  /*
   * Inside a frame, a shape belongs to the ARRANGEMENT on show.
   *
   * The same rule as a member's colour and its position: what a member looks
   * like is per state, and only its structure — how many points, in how many
   * subpaths — is shared. That split is what makes a morph possible at all, and
   * it is why `setGeometry` is wrong here: it would rewrite the member itself
   * and every state would reshape at once, so there would be nothing to blend.
   */
  const target_ = frameTargetFor(target.id)
  if (target_) {
    store.setMemberValues(target_.frameId, target_.at, target_.memberId, { nodes: outline })
    if (label) store.commit(label)
    return
  }

  store.setGeometry(target.id, { path, outline })
  if (label) store.commit(label)
}

/** The outline as the store has it now — the shown state's, inside a frame. */
function currentOutline(id: string): PathOutline | null {
  const target = frameTargetFor(id)
  if (!target) return typographyById(id)?.outline ?? null
  const frame = useDocumentStore.getState().doc.objects[target.frameId]
  if (!frame || frame.kind !== 'frame') return null
  const member = frame.members.find((each) => each.id === target.memberId)
  return member ? (valuesFor(member, frame.states[target.at]).nodes ?? null) : null
}

