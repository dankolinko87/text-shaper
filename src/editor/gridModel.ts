import {
  addControlPoint,
  clampBetweenNeighbours,
  dividerAxis,
  evaluateDivider,
  removeControlPoint,
  sortDividers,
} from '../geometry/grid'
import {
  buildPatch,
  evaluatePatch,
  invertPatch,
  patchToPath,
  refreshPatch,
  type OutlinePatch,
  type PatchEdge,
} from '../geometry/patch'
import type { GridDivider, TypographyObject, Vec2 } from '../types/document'
import { createId } from '../utils/id'
import { clamp } from '../utils/math'

/**
 * What the grid editor edits: the container as a patch, plus its row dividers.
 *
 * The outer boundary and the inner dividers are still the same kind of thing —
 * curves you drag by their control points — but they now live in the patch. The
 * four EDGES are the container's own outline, and the DIVIDERS are curves across
 * the unit square, `v = f(u)`. That is what removed the old model's preferred
 * axis: a divider in patch space is a gentle function whatever the shape does in
 * object space, including where its outline runs vertical.
 */

/** How far an edge may stray from the outline it was fitted to. */
const SIMPLIFY_TOLERANCE = 0.012
/** Samples taken around the outline before the edges are fitted. */
const BOUNDARY_SAMPLES = 240

export type EdgeName = 'top' | 'bottom' | 'left' | 'right'

export type CurveRef =
  | { kind: 'edge'; edge: EdgeName }
  | { kind: 'divider'; index: number }

/** A curve the editor will actually offer. See `stackCurves`. */
export type DividerRef = Extract<CurveRef, { kind: 'divider' }>

export interface BoundaryStack {
  patch: OutlinePatch
  /** Row boundaries in patch space: each point is (u, v). */
  dividers: GridDivider[]
}

export interface StackEdit {
  /** Curves to store back on the object as its dividers. */
  dividers: GridDivider[]
  /** Rebuilt container outline, when one of the four edges moved. */
  path: string | null
}

export const EDGE_NAMES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

/**
 * Build the editable stack for an object.
 *
 * Entering the editor materialises what the engine already produced — the
 * container's own edges plus the row cuts it chose — so you adjust boundaries
 * you can see rather than starting from nothing.
 */
export function buildStack(
  object: TypographyObject,
  /** The bands the engine actually laid the rows out in, top to bottom. */
  rowBands: readonly { top: number; bottom: number }[],
): BoundaryStack | null {
  const bounds = object.localBounds
  const scale = Math.max(1, Math.min(bounds.width || 1, bounds.height || 1))
  const patch = buildPatch(object.currentSourcePath, {
    samples: BOUNDARY_SAMPLES,
    tolerance: scale * SIMPLIFY_TOLERANCE,
  })
  if (!patch) return null

  const dividers =
    object.dividers.length > 0 ? sortDividers(object.dividers) : materialiseRowCuts(rowBands)

  return { patch, dividers }
}

/**
 * Cuts at the boundaries between the rows the engine actually produced.
 *
 * Taken from the layout rather than spread evenly. Rows are not evenly tall —
 * they are sized to their own content, so a four-row block might sit at 0.28,
 * 0.44 and 0.66 while an even split would say 0.25, 0.50 and 0.75. Opening the
 * editor on the even split drew the guides where the type was not, and the first
 * edit then dragged the type across to meet them: the jump.
 *
 * Flat in PATCH space, which is not flat on screen — a cut at v = 0.5 already
 * follows the shape, because the patch does.
 */
function materialiseRowCuts(rowBands: readonly { top: number; bottom: number }[]): GridDivider[] {
  const out: GridDivider[] = []
  for (let i = 1; i < rowBands.length; i++) {
    const above = rowBands[i - 1]
    const below = rowBands[i]
    if (!above || !below) continue
    // Halfway through the gap between one row's bottom and the next row's top,
    // so the boundary sits in the space between them rather than on either.
    const v = clamp((above.bottom + below.top) / 2, 0, 1)
    out.push({
      id: createId(),
      points: [
        { x: 0, y: v },
        { x: 0.5, y: v },
        { x: 1, y: v },
      ],
      /*
       * It rests exactly where it is, which is what makes it a no-op.
       *
       * These cuts are materialised from the rows the engine ACTUALLY laid out,
       * so they are already where the type is. But a divider that does not say
       * where it rests is assumed by the warp to rest at an even split, and a
       * boundary at 0.32 was therefore read as "dragged from 0.25 to 0.32" —
       * so merely opening the editor and touching anything shoved the whole
       * block across to meet a grid nobody had asked for.
       */
      rest: v,
    })
  }
  return out
}

/** Every curve the overlay draws, in one list, so the editor treats them alike. */
export function stackCurves(stack: BoundaryStack): DividerRef[] {
  /*
   * Dividers only. The four edges are NOT offered, and that is the whole of what
   * keeps the container's outline safe.
   *
   * The edges of the patch are the container's outline, so dragging one rewrote
   * the shape — through `patchToPath`, which emits seventy-two straight segments
   * a side. A single drag turned a four-node circle into a 288-point polyline:
   * past the editable-node limit, so the app put up a warning saying the shape
   * could no longer be edited by hand; several pixels off where it had been; and
   * heavier for every animation frame, since the warp insets and subdivides that
   * path sixty times a second.
   *
   * The outline is edited as an outline now — by its own nodes, in the same mode,
   * which is exact and leaves a circle with four points. This editor offers what
   * it is actually for.
   *
   * Every `patchToPath` call in this file sits behind an early return for
   * dividers, so it is reachable only from an edge ref. Putting edges back here
   * without first making `patchToPath` emit real curves would bring all three
   * problems back at once.
   */
  return stack.dividers.map((_, index) => ({ kind: 'divider', index }) as DividerRef)
}

/**
 * Which corner of the patch an edge's endpoint IS.
 *
 * Every corner is the end of two edges — a horizontal one and a vertical one —
 * and both of them keep their own control point for it. That is what the Coons
 * map needs, and it is also why the editor drew two handles at every corner,
 * one exactly on top of the other. Dragging whichever happened to be on top
 * moved that edge's end and left the other edge's behind, so the outline came
 * apart at the corner and the curve that was not dragged bent to reach a point
 * it no longer had a control point for.
 */
const CORNERS: Record<'p00' | 'p10' | 'p01' | 'p11', readonly [EdgeName, EdgeName]> = {
  p00: ['top', 'left'],
  p10: ['top', 'right'],
  p01: ['bottom', 'left'],
  p11: ['bottom', 'right'],
}

/** Which end of each edge meets that corner: 0 is its first point. */
const CORNER_END: Record<'p00' | 'p10' | 'p01' | 'p11', readonly ['first' | 'last', 'first' | 'last']> = {
  p00: ['first', 'first'],
  p10: ['last', 'first'],
  p01: ['first', 'last'],
  p11: ['last', 'last'],
}

type CornerKey = keyof typeof CORNERS

/** The corner an edge endpoint belongs to, or null if it is not an endpoint. */
function cornerAt(edge: EdgeName, index: number, count: number): CornerKey | null {
  const end = index === 0 ? 'first' : index === count - 1 ? 'last' : null
  if (!end) return null
  for (const key of Object.keys(CORNERS) as CornerKey[]) {
    const edges = CORNERS[key]
    const ends = CORNER_END[key]
    if (edges[0] === edge && ends[0] === end) return key
    if (edges[1] === edge && ends[1] === end) return key
  }
  return null
}

/**
 * The points of a curve that get a handle you can grab.
 *
 * The vertical edges keep their corner control points but do not offer them:
 * the horizontal edge's handle at the same spot moves the corner, and moving a
 * corner moves both edges. One corner, one handle.
 */
export function curveHandles(
  stack: BoundaryStack,
  ref: CurveRef,
): { index: number; point: Vec2 }[] {
  const points = curvePoints(stack, ref)
  const vertical = ref.kind === 'edge' && (ref.edge === 'left' || ref.edge === 'right')
  return points.flatMap((point, index) =>
    vertical && (index === 0 || index === points.length - 1) ? [] : [{ index, point }],
  )
}

/** The control points of a curve, as points in OBJECT space. */
export function curvePoints(stack: BoundaryStack, ref: CurveRef): Vec2[] {
  if (ref.kind === 'divider') {
    const divider = stack.dividers[ref.index]
    if (!divider) return []
    // A row's points are (u, v); a column's are (v, u). Both are the same curve
    // with its axes swapped, so only the read order differs here.
    return dividerAxis(divider) === 'column'
      ? divider.points.map((p) => evaluatePatch(stack.patch, p.y, p.x))
      : divider.points.map((p) => evaluatePatch(stack.patch, p.x, p.y))
  }
  const edge = stack.patch[ref.edge]
  return edge.points.map((p) => fromEdgeSpace(edge, p))
}

/** Sample a curve across its whole span, in OBJECT space, for drawing. */
export function curveSamples(stack: BoundaryStack, ref: CurveRef, count = 64): Vec2[] {
  const out: Vec2[] = []
  if (ref.kind === 'divider') {
    const divider = stack.dividers[ref.index]
    if (!divider) return out
    const column = dividerAxis(divider) === 'column'
    for (let i = 0; i <= count; i++) {
      const t = i / count
      const value = clamp(evaluateDivider(divider, t), 0, 1)
      // A row runs across the square at a height; a column runs down it at a
      // position. Swapping which of the two the parameter is turns one into the
      // other, and the patch draws both as curves that follow the shape.
      out.push(column ? evaluatePatch(stack.patch, value, t) : evaluatePatch(stack.patch, t, value))
    }
    return out
  }

  for (let i = 0; i <= count; i++) {
    const t = i / count
    switch (ref.edge) {
      case 'top':
        out.push(evaluatePatch(stack.patch, t, 0))
        break
      case 'bottom':
        out.push(evaluatePatch(stack.patch, t, 1))
        break
      case 'left':
        out.push(evaluatePatch(stack.patch, 0, t))
        break
      case 'right':
        out.push(evaluatePatch(stack.patch, 1, t))
        break
    }
  }
  return out
}

/**
 * Move one control point, in BOTH directions.
 *
 * A point used to keep its parameter and move only across the curve, which made
 * the outer handles feel like they slid one way and the inner ones the other —
 * top and bottom handles moved vertically, left and right horizontally, and the
 * row handles vertically again. That was never a design decision, only the
 * cheapest way to stop a point overtaking its neighbour and folding the curve
 * back on itself.
 *
 * So it moves freely, and the parameter is CLAMPED between its neighbours
 * instead. A point can slide along the curve as far as the points either side
 * of it, and no further, which prevents the fold without pinning the gesture to
 * an axis. The two ends stay put along the curve: on an edge they are the
 * patch's corners, and on a divider they are what makes the row span the shape.
 */
export function movePoint(
  stack: BoundaryStack,
  ref: CurveRef,
  pointIndex: number,
  to: Vec2,
  minGap: number,
): { stack: BoundaryStack; edit: StackEdit } | null {
  if (ref.kind === 'divider') {
    const target = invertPatch(stack.patch, to)
    if (!target) return null

    const dividers = cloneDividers(stack.dividers)
    const divider = dividers[ref.index]
    const point = divider?.points[pointIndex]
    if (!divider || !point) return null

    // A row moves in `v` along `u`; a column moves in `u` along `v`.
    const column = dividerAxis(divider) === 'column'
    const value = column ? target.u : target.v
    const parameter = column ? target.v : target.u
    point.y = clamp(value, 0, 1)
    point.x = slideParameter(divider.points, pointIndex, parameter, 0, 1)

    // Never let a boundary cross its neighbours — that would carve regions with
    // no sensible reading order. Neighbours are found within the SAME family:
    // a row and a column are supposed to cross.
    const family = neighboursOf(dividers, ref.index)
    dividers[ref.index] = clampBetweenNeighbours(divider, family.before, family.after, minGap)
    return { stack: { ...stack, dividers }, edit: { dividers, path: null } }
  }

  const edge = stack.patch[ref.edge]
  const corner = cornerAt(ref.edge, pointIndex, edge.points.length)
  if (corner) return moveCorner(stack, corner, to)

  const points = edge.points.map((p) => ({ ...p }))
  const point = points[pointIndex]
  if (!point) return null

  const moved = toEdgeSpace(edge, to)
  point.y = moved.y
  const first = points[0]
  const last = points[points.length - 1]
  point.x = slideParameter(points, pointIndex, moved.x, first?.x ?? moved.x, last?.x ?? moved.x)

  const patch = refreshPatch({ ...stack.patch, [ref.edge]: { ...edge, points } })

  return {
    stack: { ...stack, patch },
    edit: { dividers: stack.dividers, path: patchToPath(patch) },
  }
}

/**
 * Move a corner, and with it the end of both edges that meet there.
 *
 * Freely, in both axes. An endpoint used to be pinned to its edge's own value
 * axis — a corner of the top edge could be dragged up and down but not along —
 * because letting it move would re-parameterise the edge. It re-parameterises
 * perfectly well: an edge runs between its two corners and the table is rebuilt
 * from them, so the only thing that has to hold is that it still runs the same
 * way round. The two limits are independent, one per edge, so each axis is
 * clamped by the edge that owns it and neither has to give up its freedom for
 * the other.
 */
function moveCorner(
  stack: BoundaryStack,
  corner: CornerKey,
  to: Vec2,
): { stack: BoundaryStack; edit: StackEdit } | null {
  const [horizontal, vertical] = CORNERS[corner]
  const [horizontalEnd, verticalEnd] = CORNER_END[corner]

  /**
   * How far along its own axis this corner may go before the edge doubles back.
   *
   * Compared against the point one in from the end, in the edge's parameter —
   * which is object x for the horizontal edges and object y for the vertical
   * ones, so the two limits never touch the same number.
   */
  const limit = (name: EdgeName, end: 'first' | 'last', wanted: number): number => {
    const points = stack.patch[name].points
    const first = points[0]
    const last = points[points.length - 1]
    const inner = end === 'first' ? points[1] : points[points.length - 2]
    if (!inner || !first || !last) return wanted
    const ascending = last.x >= first.x
    const margin = Math.abs(last.x - first.x) * 0.02
    const before = (end === 'first') === ascending
    return before ? Math.min(wanted, inner.x - margin) : Math.max(wanted, inner.x + margin)
  }

  // Each edge constrains the axis it is parameterised along, and only that one.
  const at: Vec2 = {
    x: limit(horizontal, horizontalEnd, to.x),
    y: limit(vertical, verticalEnd, to.y),
  }

  const patch = { ...stack.patch }
  for (const [name, end] of [
    [horizontal, horizontalEnd],
    [vertical, verticalEnd],
  ] as [EdgeName, 'first' | 'last'][]) {
    const source = stack.patch[name]
    const points = source.points.map((q) => ({ ...q }))
    const index = end === 'first' ? 0 : points.length - 1
    points[index] = toEdgeSpace(source, at)
    patch[name] = { ...source, points }
  }
  patch.corners = { ...stack.patch.corners, [corner]: at }

  const refreshed = refreshPatch(patch)
  return {
    stack: { ...stack, patch: refreshed },
    edit: { dividers: stack.dividers, path: patchToPath(refreshed) },
  }
}

/** Add a control point to a curve, sitting exactly on it so nothing moves. */
export function addPoint(
  stack: BoundaryStack,
  ref: CurveRef,
  at: Vec2,
): { stack: BoundaryStack; edit: StackEdit } | null {
  if (ref.kind === 'divider') {
    const target = invertPatch(stack.patch, at)
    if (!target) return null
    const dividers = cloneDividers(stack.dividers)
    const divider = dividers[ref.index]
    if (!divider) return null
    const parameter = dividerAxis(divider) === 'column' ? target.v : target.u
    if (divider.points.some((p) => Math.abs(p.x - parameter) < MIN_POINT_SPACING)) return null
    dividers[ref.index] = addControlPoint(divider, clamp(parameter, 0, 1))
    return { stack: { ...stack, dividers }, edit: { dividers, path: null } }
  }

  const edge = stack.patch[ref.edge]
  const parameter = toEdgeSpace(edge, at).x
  if (edge.points.some((p) => Math.abs(p.x - parameter) < MIN_POINT_SPACING)) return null

  const patch = refreshPatch({
    ...stack.patch,
    [ref.edge]: { ...edge, points: addControlPoint({ id: 'edge', points: edge.points }, parameter).points },
  })
  return {
    stack: { ...stack, patch },
    edit: { dividers: stack.dividers, path: patchToPath(patch) },
  }
}

/** Remove a control point. Ends are refused: they pin the curve's span. */
export function removePoint(
  stack: BoundaryStack,
  ref: CurveRef,
  pointIndex: number,
): { stack: BoundaryStack; edit: StackEdit } | null {
  if (ref.kind === 'divider') {
    const dividers = cloneDividers(stack.dividers)
    const divider = dividers[ref.index]
    if (!divider) return null
    const reduced = removeControlPoint(divider, pointIndex)
    if (!reduced) return null
    dividers[ref.index] = reduced
    return { stack: { ...stack, dividers }, edit: { dividers, path: null } }
  }

  const edge = stack.patch[ref.edge]
  const reduced = removeControlPoint({ id: 'edge', points: edge.points }, pointIndex)
  if (!reduced) return null

  const patch = refreshPatch({ ...stack.patch, [ref.edge]: { ...edge, points: reduced.points } })
  return {
    stack: { ...stack, patch },
    edit: { dividers: stack.dividers, path: patchToPath(patch) },
  }
}

/**
 * Insert a boundary through a point, running whichever way was asked for.
 *
 * A row is placed at the height of the click and spans the width; a column is
 * placed at its position across and spans the height. In patch space that is the
 * same construction twice with the axes swapped.
 */
export function insertDivider(
  stack: BoundaryStack,
  at: Vec2,
  axis: 'row' | 'column' = 'row',
): StackEdit | null {
  const target = invertPatch(stack.patch, at)
  if (!target) return null
  const value = clamp(axis === 'column' ? target.u : target.v, 0.04, 0.96)

  const added: GridDivider = {
    id: createId(),
    points: [
      { x: 0, y: value },
      { x: 0.5, y: value },
      { x: 1, y: value },
    ],
    axis,
  }

  // Sorting is per family, so a new column does not reorder the rows.
  let rows = sortDividers(stack.dividers.filter((d) => dividerAxis(d) === 'row'))
  let columns = sortDividers(stack.dividers.filter((d) => dividerAxis(d) === 'column'))
  if (axis === 'column') {
    /*
     * The new column rests where it was put down, so putting it down does
     * nothing: it squeezes the type from its resting place to where it has been
     * dragged, and at the moment of creation those are the same place.
     *
     * The columns already there have their resting places written down at the
     * same time, at whatever they are being assumed to be right now. Left
     * implicit they are `(i + 1) / (count + 1)`, so a new column would re-space
     * every one of them and move type nowhere near where the click was.
     */
    columns = columns.map((d, i) =>
      d.rest === undefined ? { ...d, rest: (i + 1) / (columns.length + 1) } : d,
    )
    columns.push({ ...added, rest: value })
  } else {
    /*
     * A row is a deformer too, and gets exactly the same treatment.
     *
     * It never used to, and that asymmetry was the bug: a new row arrived with
     * no resting place, so the warp assumed an even one and dragged the type to
     * it the instant the row appeared. Writing down the existing rows' resting
     * places at the same moment matters for the same reason it does for columns
     * — left implicit they are `(i + 1) / (count + 1)`, which CHANGES when the
     * count goes up, so adding one row would silently re-space every other.
     */
    rows = rows.map((d, i) =>
      d.rest === undefined ? { ...d, rest: (i + 1) / (rows.length + 1) } : d,
    )
    rows.push({ ...added, rest: value })
  }

  return { dividers: [...sortDividers(rows), ...sortDividers(columns)], path: null }
}

/** The dividers either side of one, within its own family. */
function neighboursOf(
  dividers: readonly GridDivider[],
  index: number,
): { before: GridDivider | null; after: GridDivider | null } {
  const target = dividers[index]
  if (!target) return { before: null, after: null }
  const axis = dividerAxis(target)

  let before: GridDivider | null = null
  let after: GridDivider | null = null
  for (let i = index - 1; i >= 0; i--) {
    const d = dividers[i]
    if (d && dividerAxis(d) === axis) {
      before = d
      break
    }
  }
  for (let i = index + 1; i < dividers.length; i++) {
    const d = dividers[i]
    if (d && dividerAxis(d) === axis) {
      after = d
      break
    }
  }
  return { before, after }
}

/** Distance below which a new control point would duplicate an existing one. */
const MIN_POINT_SPACING = 1e-3

/**
 * Where a point may sit along its curve: between its neighbours, and no further.
 *
 * The ends do not move along at all. On an edge they are the patch's corners,
 * where two edges meet; on a divider they are what pins the row to the
 * container's sides. Letting either slide would either tear the patch open or
 * leave a row hanging short of the shape.
 */
function slideParameter(
  points: readonly Vec2[],
  index: number,
  wanted: number,
  low: number,
  high: number,
): number {
  const current = points[index]
  if (!current) return wanted
  if (index === 0 || index === points.length - 1) return current.x

  const previous = points[index - 1]
  const next = points[index + 1]
  const span = high - low
  const margin = Math.abs(span) * 0.01
  const lower = (previous?.x ?? low) + margin
  const upper = (next?.x ?? high) - margin
  if (!(upper > lower)) return current.x
  return clamp(wanted, lower, upper)
}

function cloneDividers(dividers: readonly GridDivider[]): GridDivider[] {
  return dividers.map((d) => ({ ...d, points: d.points.map((p) => ({ ...p })) }))
}

/** An object-space point in an edge's own (parameter, value) coordinates. */
function toEdgeSpace(edge: PatchEdge, p: Vec2): Vec2 {
  return edge.axis === 'x' ? { x: p.x, y: p.y } : { x: p.y, y: p.x }
}

/** The inverse: an edge control point back in object space. */
function fromEdgeSpace(edge: PatchEdge, p: Vec2): Vec2 {
  return edge.axis === 'x' ? { x: p.x, y: p.y } : { x: p.y, y: p.x }
}

