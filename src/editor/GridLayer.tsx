import { Circle, Polyline, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useRef } from 'react'

import { dividerAxis } from '../geometry/grid'
import { pathContainsPoint } from '../geometry/path'
import { pointArtboardToObject, pointObjectToArtboard } from '../geometry/objectSpace'
import { useDocumentStore } from '../state/documentStore'
import { isTypography } from '../types/document'
import { useUiStore } from '../state/uiStore'
import type { TypographyObject, Vec2 } from '../types/document'
import {
  addPoint,
  buildStack,
  curveHandles,
  curveSamples,
  insertDivider,
  movePoint,
  removePoint,
  stackCurves,
  type BoundaryStack,
  type CurveRef,
  type StackEdit,
} from './gridModel'

const ROW_COLOR = '#7fd1c1'
const COLUMN_COLOR = '#b39ddb'
const HANDLE_RADIUS = 5
/** Screen-space slack for landing on a curve, in the same units as the handles. */
const CURVE_HIT_RADIUS = 7
/** Screen pixels the pointer must travel before a press counts as a drag. */
const DRAG_THRESHOLD = 3

interface GridLayerProps {
  canvas: FabricCanvas | null
  /** The bands the engine laid the rows out in, so the stack opens on them. */
  rowBands: { top: number; bottom: number }[]
}

/** Nearest point on segment `a`-`b` to `p`, and how far away it is. */
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; distance: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
      : 0
  const point = { x: a.x + t * dx, y: a.y + t * dy }
  return { point, distance: Math.hypot(p.x - point.x, p.y - point.y) }
}

/**
 * The boundary editor overlay.
 *
 * Draws every curve in the stack — the container's own four edges and the row
 * dividers across it — with the same handles, because they are the same kind of
 * thing. Dragging a handle on an outer curve reshapes the container; dragging
 * one on an inner curve reshapes a row. Nothing about the interaction
 * distinguishes them.
 *
 * The overlay lives outside the document: it is drawn straight onto the Fabric
 * canvas and torn down when the tool changes, so nothing about it is persisted
 * or enters undo history. Only the committed edits do.
 */
export function GridLayer({ canvas, rowBands }: GridLayerProps) {
  const editing = useUiStore((s) => s.editingPoints)
  const interacting = useUiStore((s) => s.interacting)
  const selection = useDocumentStore((s) => s.selection)
  const objects = useDocumentStore((s) => s.doc.objects)

  const stackRef = useRef<BoundaryStack | null>(null)
  const shapesRef = useRef<FabricObject[]>([])
  /**
   * The handle under the pointer, where the press started, and whether the
   * pointer has yet travelled far enough for this to count as a drag.
   */
  const dragRef = useRef<{
    ref: CurveRef
    point: number
    from: Vec2
    engaged: boolean
  } | null>(null)

  const objectId = selection.length === 1 ? selection[0] : undefined
  // The grid deforms text laid out in a shape. A mosaic has its own partition
  // and its own editor; this overlay must not open on one.
  const selected = objectId ? objects[objectId] : undefined
  const object = selected && isTypography(selected) ? selected : undefined
  /*
   * One way of being inside a shape, not two.
   *
   * This used to be its own tool, which meant the grid and the outline's nodes
   * were separate modes over the same object — and switching to one while the
   * other was open drew both. There is a single mode now, entered by
   * double-clicking a shape, and this overlay is the half of it that shows the
   * lines the text flows through.
   */
  const active = editing === objectId && Boolean(object)

  /**
   * Rebuild the stack when the outline it was derived from has changed.
   *
   * It used to be built once and never again, because an edit here rewrote the
   * container path and re-deriving from that path fed the result into its own
   * input — a drag walked the shape away from under the cursor. That loop is
   * gone: this editor no longer touches the outline, so the outline is the one
   * source and the patch is only ever derived FROM it. Which means it now has to
   * be re-derived, or the dividers would be drawn against the shape as it was
   * before its nodes were moved.
   *
   * Never mid-gesture, though. `setGeometry` bumps the revision on every frame of
   * a node drag, and `buildPatch` samples the outline 240 times and fits four
   * edges to it — doing that per frame would make dragging a node crawl. The
   * dividers ride the old patch until the drag ends, which is a frame or two of
   * lag on lines that are not being dragged.
   */
  const builtForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!active || !object) {
      stackRef.current = null
      builtForRef.current = null
      return
    }
    // Whoever is holding something down owns the shape until they let go.
    if (interacting !== null && stackRef.current) return

    const key = `${object.id}:${object.geometryRevision}`
    if (builtForRef.current === key && stackRef.current) return

    // The rows come from what the engine actually laid out, not from the divider
    // count — with no dividers yet that is zero, and the stack would open with no
    // inner cuts at all while three rows sat on screen.
    stackRef.current = buildStack(object, rowBands)
    builtForRef.current = key
  }, [active, object, rowBands, interacting])

  /* Draw the overlay. */
  useEffect(() => {
    if (!canvas) return

    const clear = (): void => {
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }

    clear()
    const stack = stackRef.current
    if (!active || !object || !stack) {
      canvas.requestRenderAll()
      return
    }

    const toArtboard = (p: Vec2): Vec2 => pointObjectToArtboard(object.transform, p)

    stackCurves(stack).forEach((ref, curveIndex) => {
      /*
       * Rows and columns, and nothing in the container's own colour.
       *
       * The boundary used to be drawn here too, in the same orange the outline
       * editor uses — so with both open there were two lines saying where the
       * edge was, disagreeing, and no way to tell which one a press would move.
       * The outline is drawn once now, by the editor that owns it.
       */
      const colour =
        dividerAxis(stack.dividers[ref.index] ?? { id: '', points: [] }) === 'column'
          ? COLUMN_COLOR
          : ROW_COLOR
      const samples = curveSamples(stack, ref).map(toArtboard)

      const line = new Polyline(samples, {
        stroke: colour,
        strokeWidth: 1.5,
        fill: '',
        strokeUniform: true,
        selectable: false,
        evented: false,
        objectCaching: false,
      })
      line.set('gridRole', 'curve')
      line.set('curveIndex', curveIndex)
      // The samples are kept for hit-testing. A Polyline's own points are
      // rewritten relative to its bounding box once Fabric lays it out, so
      // reading them back is not the same as the artboard positions drawn here.
      line.set('samples', samples)
      canvas.add(line)
      shapesRef.current.push(line)

      curveHandles(stack, ref).forEach(({ index: pointIndex, point }) => {
        const p = toArtboard(point)
        const handle = new Circle({
          left: p.x,
          top: p.y,
          radius: HANDLE_RADIUS / canvas.getZoom(),
          fill: '#ffffff',
          stroke: colour,
          strokeWidth: 1.5,
          strokeUniform: true,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
          objectCaching: false,
        })
        handle.set('gridRole', 'handle')
        handle.set('curveIndex', curveIndex)
        handle.set('pointIndex', pointIndex)
        canvas.add(handle)
        shapesRef.current.push(handle)
      })
    })

    // The overlay must sit above the artwork. `syncCanvas` re-raises every
    // object to front on each store update, so without this the container is
    // pushed over the guides the moment anything changes.
    for (const shape of shapesRef.current) canvas.bringObjectToFront(shape)

    canvas.requestRenderAll()
    return clear
  }, [canvas, active, object, stackRef.current])

  /* Keep the live values the handlers read, without re-registering them. */
  const liveRef = useRef<{ active: boolean; object: TypographyObject | undefined }>({
    active: false,
    object: undefined,
  })
  liveRef.current = { active, object }

  /**
   * Pointer handling, registered ONCE per canvas.
   *
   * The handlers deliberately read their state from refs rather than closing
   * over it. Registering them from an effect that depended on the selected
   * object meant every store write during a drag tore the listeners down and
   * re-added them — and the release landed in that gap, so the edit never
   * reached undo. Registering once removes the gap entirely.
   */
  useEffect(() => {
    if (!canvas) return

    const curveAt = (index: number): CurveRef | null => {
      const stack = stackRef.current
      if (!stack) return null
      return stackCurves(stack)[index] ?? null
    }

    const nearestHandle = (scene: Vec2): { ref: CurveRef; point: number } | null => {
      let best: { ref: CurveRef; point: number } | null = null
      let bestDistance = (HANDLE_RADIUS * 2.5) / canvas.getZoom()
      for (const shape of shapesRef.current) {
        if (shape.get('gridRole') !== 'handle') continue
        const d = Math.hypot(shape.left - scene.x, shape.top - scene.y)
        if (d < bestDistance) {
          const ref = curveAt(shape.get('curveIndex') as number)
          if (!ref) continue
          bestDistance = d
          best = { ref, point: shape.get('pointIndex') as number }
        }
      }
      return best
    }

    /** The curve under the pointer, and where on it, for adding a point. */
    const nearestCurve = (scene: Vec2): { ref: CurveRef; at: Vec2 } | null => {
      let best: { ref: CurveRef; at: Vec2 } | null = null
      let bestDistance = CURVE_HIT_RADIUS / canvas.getZoom()

      for (const shape of shapesRef.current) {
        if (shape.get('gridRole') !== 'curve') continue
        const samples = shape.get('samples') as Vec2[] | undefined
        if (!samples) continue
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1]
          const b = samples[i]
          if (!a || !b) continue
          const hit = closestOnSegment(scene, a, b)
          if (hit.distance < bestDistance) {
            const ref = curveAt(shape.get('curveIndex') as number)
            if (!ref) continue
            bestDistance = hit.distance
            best = { ref, at: hit.point }
          }
        }
      }
      return best
    }

    const write = (
      target: TypographyObject,
      result: { stack: BoundaryStack; edit: StackEdit } | null,
      label: string | null,
    ): boolean => {
      if (!result) return false
      stackRef.current = result.stack
      const store = useDocumentStore.getState()
      /*
       * Dividers, and only dividers.
       *
       * This used to also write a rebuilt container path, because dragging a
       * patch edge reshaped the outline — and it cleared the shape's nodes on
       * the way, since what it wrote was a polyline of several hundred points
       * that nobody could aim at. The outline is edited as an outline now, by
       * its own nodes, so nothing here touches the shape at all: an edit from
       * this editor moves lines INSIDE a container it never rewrites.
       *
       * `stackCurves` is what guarantees that — it offers no edge to drag, so
       * `StackEdit.path` is always null.
       */
      store.updateObject(target.id, { dividers: result.edit.dividers })
      if (label) store.commit(label)
      return true
    }

    /**
     * Add a boundary, and advance the in-memory stack with it.
     *
     * Updating only the document left the stack holding the dividers as they
     * were, so a second insert built on stale state and REPLACED the first
     * rather than adding to it — two columns in a row produced one.
     */
    const insert = (
      target: TypographyObject,
      stack: BoundaryStack,
      at: Vec2,
      axis: 'row' | 'column',
    ): void => {
      const edit = insertDivider(stack, at, axis)
      if (!edit) return
      stackRef.current = { ...stack, dividers: edit.dividers }
      const store = useDocumentStore.getState()
      store.updateObject(target.id, { dividers: edit.dividers })
      store.commit(axis === 'column' ? 'Add deformer' : 'Add row')
    }

    // A plain press only ever grabs a handle. Adding is deliberately NOT on
    // click: it was, and any press that missed a handle quietly added a
    // divider, so a few stray clicks left a shape full of them. Everything that
    // adds or removes is a double-click, which cannot happen by accident.
    const onDown = (opt: { e: Event }): void => {
      const { active: on, object: target } = liveRef.current
      if (!on) return
      const scene = canvas.getScenePoint(opt.e as MouseEvent)
      const handle = nearestHandle(scene)
      dragRef.current = handle ? { ...handle, from: scene, engaged: false } : null
      // The shape holds still while its grid is being pulled about, so what the
      // dividers are laid over is the geometry they actually describe.
      if (dragRef.current && target) useUiStore.getState().setInteracting(target.id)
    }

    /**
     * Double-click means "add or remove", and WHAT is under the pointer decides
     * which: a handle is removed, a curve gains a point where it was clicked,
     * and open space gets a new divider.
     */
    const onDoubleClick = (opt: { e: Event }): void => {
      const { active: on, object: target } = liveRef.current
      const stack = stackRef.current
      if (!on || !target || !stack) return

      const scene = canvas.getScenePoint(opt.e as MouseEvent)
      const local = pointArtboardToObject(target.transform, scene)

      /*
       * Outside the shape is not this editor's business.
       *
       * A double-click out on the artboard is how you LEAVE the mode, and
       * without this the grid heard it too and added a row on the way out —
       * every trip in and out of the editor left another deformer behind, and
       * the type moved a little further each time. Nothing about a point beyond
       * the container says where a row inside it should go.
       */
      if (!pathContainsPoint(target.currentSourcePath, local)) return

      // Alt means "add a column here", full stop. Checked BEFORE the handle and
      // curve tests: once a shape has rows, most of its interior is within a few
      // pixels of one, so asking for a column would otherwise land on a curve
      // and quietly add a point to it instead.
      if ((opt.e as MouseEvent).altKey) {
        insert(target, stack, local, 'column')
        return
      }

      const handle = nearestHandle(scene)
      if (handle) {
        // Removing is refused on the two end points of a curve — they pin its
        // span — and once a curve is down to its minimum. Falling through to
        // adding a divider there would be a nasty surprise, so this stops here
        // either way.
        write(target, removePoint(stack, handle.ref, handle.point), 'Remove point')
        return
      }

      const curve = nearestCurve(scene)
      if (curve) {
        const at = pointArtboardToObject(target.transform, curve.at)
        write(target, addPoint(stack, curve.ref, at), 'Add point')
        return
      }

      // Open space adds a row. Columns are the Alt case above.
      insert(target, stack, local, 'row')
    }

    const onMove = (opt: { e: Event }): void => {
      const { active: on, object: target } = liveRef.current
      const drag = dragRef.current
      const stack = stackRef.current
      if (!on || !target || !drag || !stack) return

      const scene = canvas.getScenePoint(opt.e as MouseEvent)

      // NOTHING is written until the pointer has actually travelled. Grabbing a
      // handle used to rewrite the container on the first stray pixel, so a
      // plain click — including the first click of a double-click — rebuilt the
      // outline and re-fitted the text without the user having moved anything.
      // The shape changes when a dot is dragged, and at no other time.
      if (!drag.engaged) {
        const travelled = Math.hypot(scene.x - drag.from.x, scene.y - drag.from.y)
        if (travelled * canvas.getZoom() < DRAG_THRESHOLD) return
        drag.engaged = true
      }

      const local = pointArtboardToObject(target.transform, scene)
      // Rows are separated in patch space, where the whole square is one unit
      // tall, so the smallest gap between them is a share of that.
      const minGap = 0.02
      write(target, movePoint(stack, drag.ref, drag.point, local, minGap), null)
    }

    const onUp = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      useUiStore.getState().setInteracting(null)
      // A press that never travelled far enough to move a dot wrote nothing, so
      // there is nothing to record either.
      if (!drag || !drag.engaged) return
      // One drag, one history entry. The store ignores a commit that would
      // record no change, so this needs no further guard.
      useDocumentStore.getState().commit('Reshape grid')
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
