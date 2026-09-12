import { Circle, Line, Polyline, Rect, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useRef, useState } from 'react'

import { pathBounds } from '../geometry/path'
import { artboardToObject } from '../geometry/objectSpace'
import { outlineToPath, transformOutline } from '../geometry/outline'
import { samplePath } from '../geometry/run'
import { compose } from '../geometry/transform'
import {
  closePen,
  constrain,
  dropStray,
  penClosesAt,
  penDown,
  penDrag,
  penOutline,
  retractPen,
  shapingIndex,
  reverseNodes,
  startPen,
  PEN_DRAG_THRESHOLD,
  type PenState,
} from './penModel'
import { SNAP_RADIUS, constrainLock, snapPoint, type SnapGuide } from './pointSnap'
import { useDocumentStore } from '../state/documentStore'
import { isTypography } from '../types/document'
import { useUiStore } from '../state/uiStore'
import type { PathNode, PathOutline, Vec2 } from '../types/document'

/** A node the preview can hold without sharing objects with the live run. */
const copyNode = (node: PathNode): PathNode => ({
  point: { ...node.point },
  handleIn: { ...node.handleIn },
  handleOut: { ...node.handleOut },
  smooth: node.smooth,
})

const PEN_COLOR = '#e0552f'
/** Node marker radius, in SCREEN pixels — divided by zoom before use. */
const NODE_RADIUS = 4.5
const CONTROL_RADIUS = 3
/** How finely the run being drawn is sampled, in artboard units. */
const GUIDE_SPACING = 3
/** How near the first node a press must land to close the run, in screen pixels. */
const CLOSE_RADIUS = 8
/** Smallest area a closed pen path needs before it counts as a shape to fill. */
const MIN_SHAPE_AREA = 120
/** How far a guide line runs past the points it joins, in screen pixels. */
const GUIDE_OVERSHOOT = 24

/**
 * Where an aim lands: Shift squares it to the last anchor, then it snaps to
 * line up with the run's other anchors unless ⌘ holds it free. The same rule
 * for the press that places a node and for the rubber band before it, so the
 * band shows exactly where the click will go.
 */
function aimAt(
  state: PenState,
  at: Vec2,
  modifiers: { shift: boolean; free: boolean },
  reach: number,
): { point: Vec2; guides: SnapGuide[] } {
  const last = state.nodes[state.nodes.length - 1]
  const squared = modifiers.shift && last ? constrain(last.point, at) : at
  if (modifiers.free) return { point: squared, guides: [] }
  const lock = modifiers.shift && last ? constrainLock(last.point, squared) : null
  // Every node but the one just placed: lining up with the segment's own start
  // is what Shift is for, and the snap would fight it.
  const targets = state.nodes.slice(0, -1).map((node) => node.point)
  return snapPoint(squared, targets, reach, lock)
}

interface PenLayerProps {
  canvas: FabricCanvas | null
  /** True while the pen is the active tool. */
  armed: boolean
}

/**
 * The pen: click to place a corner, drag to pull a curve out of it.
 *
 * Its own layer rather than another branch of `Canvas`'s drawing effect, which
 * is a freehand-stroke machine — press, sample, release, done. A pen is nothing
 * like that: it is a state machine spanning many press-release cycles, and the
 * run outlives every one of them. The split is the same one `GridLayer` and
 * `PathLayer` already make, and it is what makes `penModel` testable.
 *
 * Click for a corner. Click-and-drag for a smooth point, the pointer pulling the
 * forward handle with the other side mirrored; hold Alt during that drag to pull
 * only the forward one, which starts a curve out of a corner. Click the first
 * node to close the run and finish. Enter or a double-click finishes it open.
 * Escape throws it away.
 *
 * With one open, node-editable path selected, the pen CONTINUES it: press near
 * either end and the run picks up from there. It will not join two different
 * paths — that is what keeps the endpoint hit test to two points rather than
 * every path in the document.
 */
export function PenLayer({ canvas, armed }: PenLayerProps) {
  const shapesRef = useRef<FabricObject[]>([])
  const stateRef = useRef<PenState | null>(null)
  /** Where the pointer is, for the rubber band. Artboard units. */
  const hoverRef = useRef<Vec2 | null>(null)
  const pressRef = useRef<{ from: Vec2; engaged: boolean } | null>(null)
  /** Whether Shift is down, for the 45° constraint and the preview that shows it. */
  const shiftRef = useRef(false)
  /** Whether ⌘ is down, which holds the aim free of snapping. */
  const freeRef = useRef(false)
  /** Bumped to redraw; the run itself lives in a ref so handlers never re-register. */
  const [revision, setRevision] = useState(0)

  /* Draw the run being made. */
  useEffect(() => {
    if (!canvas) return
    void revision

    const clear = (): void => {
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }

    clear()
    const state = stateRef.current
    if (!armed || !state || state.nodes.length === 0) {
      canvas.requestRenderAll()
      return
    }

    const zoom = canvas.getZoom() || 1
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

    const outline = penOutline(state)
    if (outline) {
      const data = outlineToPath(outline)
      const along = samplePath(data, GUIDE_SPACING) ?? state.nodes.map((n) => n.point)
      const points = [...along]
      if (state.closed && points[0]) points.push(points[0])
      add(
        new Polyline(points, {
          ...shared,
          stroke: PEN_COLOR,
          strokeWidth: 1.5 / zoom,
          fill: 'transparent',
        }),
      )
    }

    /*
     * The rubber band: the segment a click would actually add.
     *
     * CURVED, following the handle the previous node is already carrying. It was
     * drawn straight on the grounds that the next segment's curve depends on a
     * handle that does not exist yet — but that is only half true. A segment is
     * shaped by the handle LEAVING the node behind it as much as by the one
     * arriving at the node ahead, and the first of those was set the moment that
     * node was dragged out. Drawing a straight line there meant the curve you
     * had just committed to was invisible until one more click had been spent
     * finding out where it went.
     *
     * The node ahead is drawn as a corner because that is what a click makes; a
     * drag pulls a handle out of it and the shape follows the pointer from
     * there.
     */
    const last = state.nodes[state.nodes.length - 1]
    const hover = hoverRef.current
    const aim = hover
      ? aimAt(state, hover, { shift: shiftRef.current, free: freeRef.current }, SNAP_RADIUS / zoom)
      : null
    const aimed = aim?.point ?? null
    if (aim && last && !state.closed && !pressRef.current) {
      // The lines the aim lines up with, so the snap is seen before the click.
      for (const guide of aim.guides) {
        const along = [aim.point, ...guide.through]
        const other = guide.axis === 'x' ? 'y' : 'x'
        const lows = along.map((p) => p[other])
        const low = Math.min(...lows) - GUIDE_OVERSHOOT / zoom
        const high = Math.max(...lows) + GUIDE_OVERSHOOT / zoom
        const coords: [number, number, number, number] =
          guide.axis === 'x' ? [guide.at, low, guide.at, high] : [low, guide.at, high, guide.at]
        const line = new Line(coords, {
          ...shared,
          excludeFromExport: true,
          stroke: PEN_COLOR,
          strokeWidth: 1 / zoom,
          strokeDashArray: [4 / zoom, 3 / zoom],
          opacity: 0.9,
        })
        line.set('gridRole', 'snapGuide')
        add(line)
      }
    }
    if (last && aimed && !state.closed && !pressRef.current) {
      const preview: PathOutline = {
        subpaths: [
          {
            closed: false,
            nodes: [
              { ...copyNode(last), handleIn: { x: 0, y: 0 } },
              {
                point: { ...aimed },
                handleIn: { x: 0, y: 0 },
                handleOut: { x: 0, y: 0 },
                smooth: false,
              },
            ],
          },
        ],
      }
      const band = samplePath(outlineToPath(preview), GUIDE_SPACING) ?? [last.point, aimed]
      add(
        new Polyline(band, {
          ...shared,
          stroke: PEN_COLOR,
          strokeWidth: 1 / zoom,
          fill: 'transparent',
          opacity: 0.55,
        }),
      )
    }

    /*
     * A ring on the first node when a press there would close the run.
     *
     * Closing is the one thing the pen does that depends on being within a few
     * pixels of something, and there was no sign of it at all: the first node is
     * drawn filled whether or not a click would close, so the only way to find
     * the boundary was to click and see what happened. The ring answers before
     * the click.
     */
    const closable =
      hover && !state.closed && penClosesAt(state, hover, CLOSE_RADIUS / zoom)
    const firstNode = state.nodes[0]
    if (closable && firstNode) {
      add(
        new Circle({
          ...shared,
          left: firstNode.point.x,
          top: firstNode.point.y,
          radius: (NODE_RADIUS + 3.5) / zoom,
          originX: 'center',
          originY: 'center',
          fill: 'transparent',
          stroke: PEN_COLOR,
          strokeWidth: 1.5 / zoom,
        }),
      )
    }

    state.nodes.forEach((node, index) => {
      const radius = NODE_RADIUS / zoom
      // Square for a corner, round for a smooth point — the same language the
      // point editor speaks, so a path looks the same while it is being drawn as
      // it does afterwards.
      const marker = node.smooth
        ? new Circle({
            ...shared,
            left: node.point.x,
            top: node.point.y,
            radius,
            originX: 'center',
            originY: 'center',
            fill: index === 0 ? PEN_COLOR : '#fff',
            stroke: PEN_COLOR,
            strokeWidth: 1.5 / zoom,
          })
        : new Rect({
            ...shared,
            left: node.point.x,
            top: node.point.y,
            width: radius * 2,
            height: radius * 2,
            originX: 'center',
            originY: 'center',
            // The first node is filled: it is the one you click to close, and
            // there is no other way to tell which end of the run it is.
            fill: index === 0 ? PEN_COLOR : '#fff',
            stroke: PEN_COLOR,
            strokeWidth: 1.5 / zoom,
          })
      add(marker)
    })

    /*
     * The handles of the node most recently placed — while it is being pulled
     * out AND after the button comes up.
     *
     * They used to disappear on release, which took away the only picture of the
     * curve about to be drawn at exactly the moment it started mattering: the
     * handle is what shapes the NEXT segment, so it is most worth seeing while
     * you are deciding where that segment goes.
     */
    const pulling = state.nodes[shapingIndex(state)] ?? null
    if (pulling) {
      for (const handle of [pulling.handleIn, pulling.handleOut]) {
        if (Math.abs(handle.x) < 1e-9 && Math.abs(handle.y) < 1e-9) continue
        const tip = { x: pulling.point.x + handle.x, y: pulling.point.y + handle.y }
        add(
          new Line([pulling.point.x, pulling.point.y, tip.x, tip.y], {
            ...shared,
            stroke: PEN_COLOR,
            strokeWidth: 1 / zoom,
          }),
        )
        add(
          new Circle({
            ...shared,
            left: tip.x,
            top: tip.y,
            radius: CONTROL_RADIUS / zoom,
            originX: 'center',
            originY: 'center',
            fill: PEN_COLOR,
            stroke: PEN_COLOR,
            strokeWidth: 1 / zoom,
          }),
        )
      }
    }

    canvas.requestRenderAll()
    return clear
  }, [canvas, armed, revision])

  /* Putting the pen away throws away whatever was half-drawn. */
  useEffect(() => {
    if (armed) return
    stateRef.current = null
    hoverRef.current = null
    pressRef.current = null
    useUiStore.getState().setDrawing(false)
    setRevision((n) => n + 1)
  }, [armed])

  /*
   * Escape throws the run away — which is what this file has always claimed and
   * never did.
   *
   * The shortcut layer owns Escape and answers it by clearing `isDrawing`,
   * peeling one layer off at a time: a half-drawn gesture first, then point
   * editing, then the selection. Nothing here read that flag, so the "half-drawn
   * gesture" rung did nothing at all — the run stayed on screen and the next
   * click carried on adding to it. Following the flag rather than binding
   * Escape here keeps one owner for the key and the ladder intact.
   */
  const drawing = useUiStore((s) => s.isDrawing)
  useEffect(() => {
    if (drawing || !stateRef.current) return
    stateRef.current = null
    hoverRef.current = null
    pressRef.current = null
    setRevision((n) => n + 1)
  }, [drawing])

  const armedRef = useRef(armed)
  armedRef.current = armed

  useEffect(() => {
    if (!canvas) return

    const redraw = (): void => setRevision((n) => n + 1)

    const onDown = (opt: { e: Event }): void => {
      if (!armedRef.current) return
      const at = canvas.getScenePoint(opt.e as MouseEvent)
      const raw = { x: at.x, y: at.y }
      const reach = CLOSE_RADIUS / (canvas.getZoom() || 1)
      shiftRef.current = (opt.e as MouseEvent).shiftKey === true
      freeRef.current = (opt.e as MouseEvent).metaKey === true || (opt.e as MouseEvent).ctrlKey === true

      let state = stateRef.current
      if (!state) {
        // A fresh run, unless the pen was pressed on the end of a selected path,
        // in which case it picks that one up where it left off.
        state = continueSelected(raw, reach) ?? startPen()
        useUiStore.getState().setDrawing(true)
      }

      /*
       * Closing is tested against where the pointer REALLY is, before Shift has
       * had its say. Snapping first could throw a press that was on the first
       * node off it, so holding Shift would quietly stop a path being closable.
       */
      if (penClosesAt(state, raw, reach)) {
        /*
         * Closed, but NOT finished — the run ends when this press is released.
         *
         * Closing used to commit on the press, which made the final segment the
         * one piece of a path that could not be curved while it was drawn: the
         * shape snapped shut with a straight line the instant the button went
         * down, and the only way to bend it was to go back in afterwards. Held
         * open, the same drag that shapes every other node shapes this one too,
         * and `shapingIndex` points it at the first node, whose `handleIn` IS
         * the closing segment.
         */
        stateRef.current = closePen(state)
        hoverRef.current = raw
        pressRef.current = { from: raw, engaged: false }
        redraw()
        return
      }

      const scene = aim(state, raw, canvas.getZoom() || 1)
      // The overlay reads the pointer from here, and a press is the most recent
      // thing the pointer did. Left to move events alone, the close ring could
      // still be lit around a node the pointer had long since clicked away from.
      hoverRef.current = raw
      stateRef.current = penDown(state, scene)
      pressRef.current = { from: scene, engaged: false }
      redraw()
    }

    const onMove = (opt: { e: Event }): void => {
      if (!armedRef.current) return
      const at = canvas.getScenePoint(opt.e as MouseEvent)
      const scene = { x: at.x, y: at.y }
      hoverRef.current = scene
      shiftRef.current = (opt.e as MouseEvent).shiftKey === true
      freeRef.current = (opt.e as MouseEvent).metaKey === true || (opt.e as MouseEvent).ctrlKey === true

      const press = pressRef.current
      const state = stateRef.current
      if (!press || !state) {
        /*
         * Moving with the button UP still redraws, which no other gesture in
         * this codebase does — every existing `onMove` returns unless a drag is
         * running. A pen without a rubber band is guesswork: you cannot see
         * where the next segment goes until you have already committed to it.
         */
        if (state) redraw()
        return
      }

      if (!press.engaged) {
        const moved = Math.hypot(scene.x - press.from.x, scene.y - press.from.y)
        if (moved * (canvas.getZoom() || 1) < PEN_DRAG_THRESHOLD) return
        press.engaged = true
      }
      /*
       * Shift snaps the HANDLE's direction, measured from the node it belongs to
       * rather than from where the press began — the handle is what is being
       * aimed, and it starts at the anchor.
       */
      const node = state.nodes[shapingIndex(state)]
      const pulled =
        shiftRef.current && node ? constrain(node.point, scene) : scene
      stateRef.current = penDrag(state, pulled, (opt.e as MouseEvent).altKey === true)
      redraw()
    }

    const onUp = (): void => {
      if (!armedRef.current) return
      const closing = stateRef.current?.closed === true
      pressRef.current = null
      // Letting go of the press that closed the run is what ends it. Whatever
      // the drag did to the closing curve is already in the state.
      if (closing) {
        finish(true)
        return
      }
      redraw()
    }

    /**
     * A double-click finishes the run where it is, open.
     *
     * The stray node the second press left behind is taken back first: a
     * double-click is two full press-release cycles and THEN this event, so by
     * the time it arrives the pen has already put a node down on top of the last
     * one. Nothing about that order can be changed.
     */
    const onDoubleClick = (): void => {
      if (!armedRef.current || !stateRef.current) return
      stateRef.current = dropStray(stateRef.current)
      finish(false)
    }

    /**
     * Where the next anchor really goes, once Shift has had its say.
     *
     * Square to the anchor the segment leaves, so the constraint is about the
     * line being drawn rather than the screen. With nothing to measure from —
     * the first node of a run — Shift has no meaning and the pointer wins.
     */
    const aim = (state: PenState, at: Vec2, zoom: number): Vec2 =>
      aimAt(state, at, { shift: shiftRef.current, free: freeRef.current }, SNAP_RADIUS / zoom).point

    /** Pick up a selected open path at whichever end the pen was pressed on. */
    const continueSelected = (at: Vec2, reach: number): PenState | null => {
      const store = useDocumentStore.getState()
      if (store.selection.length !== 1) return null
      const id = store.selection[0] as string
      const selected = store.doc.objects[id]
      const object = selected && isTypography(selected) ? selected : undefined
      const subpaths = object?.outline?.subpaths
      // One open contour only. A shape has no ends to continue from, and a path
      // with several would leave "which one" unanswerable.
      if (!object || !subpaths || subpaths.length !== 1 || subpaths[0]!.closed) return null

      /*
       * Into artboard space through the object's own matrix. The whole matrix,
       * not just its translation: the handles are relative to their anchors, so
       * a rotated or resized path's handles have to be carried through the
       * linear part as well, which is exactly what `transformOutline` does.
       */
      const placed = transformOutline(object.outline!, compose(object.transform)).subpaths[0]!.nodes
      const first = placed[0]!.point
      const last = placed[placed.length - 1]!.point
      if (Math.hypot(at.x - last.x, at.y - last.y) <= reach) return startPen(id, placed)
      if (Math.hypot(at.x - first.x, at.y - first.y) <= reach) {
        return startPen(id, reverseNodes(placed))
      }
      return null
    }

    /**
     * Turn the run into an object, and stay inside it.
     *
     * Every way of finishing does the same — Enter, a double-click, and closing
     * onto the first node. A path is one gesture, and when it is over the pen
     * should not still be armed over a finished drawing; `P` picks it up again.
     *
     * But finishing does NOT hand back a bounding box. The last thing anyone
     * does after drawing a path is adjust it, and coming out to an object
     * selection put a frame and eight scale handles over the very nodes that
     * wanted moving — you had to double-click back into the shape you had not
     * left. So the run finishes INSIDE the object it just made, nodes and
     * handles still on screen and still draggable. Escape leaves, the same as
     * from any other shape.
     *
     * The tool is released FIRST, before the object is made. Creating an object
     * selects it, and selecting one while a drawing tool is still active is a
     * combination the canvas gates against — it would arrive selected and
     * untouchable. `setTool` also clears the editing mode for any tool but
     * Select, so going inside has to come after it, never before.
     */
    const finish = (closed: boolean): void => {
      const state = stateRef.current
      stateRef.current = null
      pressRef.current = null
      hoverRef.current = null
      const ui = useUiStore.getState()
      ui.setDrawing(false)
      ui.setTool('select')
      redraw()
      if (!state) return

      const outline = penOutline({ ...state, closed })
      if (!outline) return
      const store = useDocumentStore.getState()

      /*
       * A closed run with no meaningful area stays a LINE — text along the
       * curve, no interior to fill.
       *
       * Not repaired, deliberately. Uniting a self-crossing path with itself
       * returns different segments: a six-node bow tie comes back as eight nodes
       * in two triangles, silently replacing the node list the user is holding.
       * Better to leave what they drew alone and let it be a path.
       */
      const area = closed ? Math.abs(outlineArea(outline)) : 0
      const fillable = closed && area >= MIN_SHAPE_AREA

      const bounds = pathBounds(outlineToPath(outline))
      const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      const local = transformOutline(
        outline,
        compose({
          x: -centre.x,
          y: -centre.y,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          flipX: false,
          flipY: false,
        }),
      )
      const path = outlineToPath(local)

      if (state.extending) {
        // Continuing a path replaces its geometry rather than making a second
        // object, and the object keeps the origin it has always had.
        const object = store.doc.objects[state.extending]
        if (object && isTypography(object)) {
          /*
           * Back through the object's whole matrix, not just its position. The
           * run was drawn in artboard space over an object that may be turned or
           * resized, and undoing only the translation would leave every new node
           * rotated away from the path it is being added to.
           *
           * The origin is left where it is, as everywhere else: it is fixed for
           * the object's lifetime and every transform in the document is
           * measured from it.
           */
          const back = transformOutline(outline, artboardToObject(object.transform))
          store.setGeometry(state.extending, { path: outlineToPath(back), outline: back })
          store.commit('Extend path')
          store.setSelection([state.extending])
          useUiStore.getState().setEditingPoints(state.extending)
          return
        }
      }

      const made = store.createObjectFromGeometry({
        pathData: path,
        outline: local,
        localBounds: pathBounds(path),
        artboardCenter: centre,
        open: !fillable,
        name: fillable ? undefined : 'Path',
      })
      store.commit('Draw path')
      /*
       * Straight into the path's own nodes. Point editing needs the object to be
       * the whole selection as well as the named one — `Canvas` checks both, so
       * that a stale id can never leave the artboard in a mode nothing escapes.
       */
      useDocumentStore.getState().setSelection([made])
      useUiStore.getState().setEditingPoints(made)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (!armedRef.current || !stateRef.current) return
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(false)
        return
      }
      /*
       * Backspace takes back the last anchor, the way every pen does.
       *
       * Without it a misplaced point could only be escaped by throwing the whole
       * run away and starting again. Taking back the last one empties the run
       * and ends it, which is how a path begun by accident is abandoned.
       */
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        const next = retractPen(stateRef.current)
        if (next.nodes.length === 0) {
          stateRef.current = null
          pressRef.current = null
          useUiStore.getState().setDrawing(false)
        } else {
          stateRef.current = next
        }
        redraw()
        return
      }
      // The preview shows the constraint and the snap, so they have to follow
      // the keys rather than wait for the pointer to move.
      if (e.key === 'Shift' && !shiftRef.current) {
        shiftRef.current = true
        redraw()
      }
      if ((e.key === 'Meta' || e.key === 'Control') && !freeRef.current) {
        freeRef.current = true
        redraw()
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift' && shiftRef.current) {
        shiftRef.current = false
      } else if ((e.key === 'Meta' || e.key === 'Control') && freeRef.current) {
        freeRef.current = false
      } else return
      if (armedRef.current && stateRef.current) redraw()
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    canvas.on('mouse:dblclick', onDoubleClick)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      canvas.off('mouse:dblclick', onDoubleClick)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [canvas])

  return null
}

/**
 * Roughly how much a run encloses, for telling a shape from a path drawn shut.
 *
 * The shoelace formula over the ANCHORS, which ignores how far the curves bulge
 * away from them. That is fine for the only question being asked — is there an
 * interior here at all — and it keeps the check to arithmetic on a handful of
 * points rather than a trip through paper on every finished path.
 */
function outlineArea(outline: PathOutline): number {
  let total = 0
  for (const subpath of outline.subpaths) {
    const nodes = subpath.nodes
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!.point
      const b = nodes[(i + 1) % nodes.length]!.point
      total += (a.x * b.y - b.x * a.y) / 2
    }
  }
  return total
}
