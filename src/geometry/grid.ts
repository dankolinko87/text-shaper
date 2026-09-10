import type { GridDivider, Vec2 } from '../types/document'
import { clamp } from '../utils/math'

/**
 * Row boundaries for the text grid.
 *
 * A divider is a smooth curve across the container that separates one row of
 * type from the next. The engine's automatic layout produces flat boundaries;
 * these are the same thing made editable, so a row can be given any profile and
 * the type follows it exactly.
 *
 * Pure geometry: no DOM, no paper.js. A divider is just a function from one
 * coordinate to another — used for the container's four edges in their own
 * parameter space, and for the row dividers across the unit square.
 */

/**
 * Evaluate a divider's y at a given x, through a smooth curve.
 *
 * Smooth rather than straight segments: dragging a point should bend the row,
 * not put a crease in it. The control points are the only thing to drag — no
 * Bézier handles to manage.
 *
 * SHAPE-PRESERVING (monotone cubic Hermite, Fritsch-Carlson tangents) rather
 * than Catmull-Rom. Catmull-Rom overshoots between control points, and for these
 * curves the overshoot is not a cosmetic wobble: the outer two curves ARE the
 * container's edges, so a curve that bulges past its own control points draws
 * the boundary outside the shape it is supposed to describe. It also forced the
 * fitter to spend points suppressing overshoot rather than describing the form —
 * an ellipse needed thirteen, a diamond twenty-four.
 *
 * A monotone cubic stays inside the range of the points it passes through, so
 * the drawn boundary cannot leave the outline, and far fewer points are needed
 * to follow it.
 */
export function evaluateDivider(divider: GridDivider, x: number): number {
  const points = divider.points
  if (points.length === 0) return 0

  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return 0
  if (points.length === 1) return first.y
  if (x <= first.x) return first.y
  if (x >= last.x) return last.y

  // Find the segment containing x.
  let i = 0
  for (; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (a && b && x >= a.x && x <= b.x) break
  }

  const p1 = points[i]
  const p2 = points[i + 1]
  if (!p1 || !p2) return first.y
  const h = p2.x - p1.x
  if (h <= 0) return p1.y

  const d = (p2.y - p1.y) / h
  const m1 = tangentAt(points, i, d)
  const m2 = tangentAt(points, i + 1, d)

  // Cubic Hermite on the unit interval.
  const t = (x - p1.x) / h
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * p1.y +
    (t3 - 2 * t2 + t) * h * m1 +
    (-2 * t3 + 3 * t2) * p2.y +
    (t3 - t2) * h * m2
  )
}

/**
 * Slope at point `index`, limited so the curve cannot overshoot.
 *
 * Where the data turns (the neighbouring slopes disagree in sign) the tangent is
 * flattened to zero, which puts the extremum exactly at the control point rather
 * than beyond it. Elsewhere it is the weighted harmonic mean of the two
 * neighbouring slopes, which keeps the curve inside their range.
 */
function tangentAt(points: readonly Vec2[], index: number, fallback: number): number {
  const previous = points[index - 1]
  const current = points[index]
  const next = points[index + 1]
  if (!current) return fallback

  const slopeBefore =
    previous && current.x > previous.x ? (current.y - previous.y) / (current.x - previous.x) : null
  const slopeAfter =
    next && next.x > current.x ? (next.y - current.y) / (next.x - current.x) : null

  if (slopeBefore === null) return slopeAfter ?? fallback
  if (slopeAfter === null) return slopeBefore

  // A turning point gets a flat tangent, which is what stops the overshoot.
  if (slopeBefore * slopeAfter <= 0) return 0

  const hBefore = current.x - (previous?.x ?? current.x)
  const hAfter = (next?.x ?? current.x) - current.x
  const w1 = 2 * hAfter + hBefore
  const w2 = hAfter + 2 * hBefore
  return (w1 + w2) / (w1 / slopeBefore + w2 / slopeAfter)
}

/** Which way a divider runs. Anything without one is a row. */
export function dividerAxis(divider: GridDivider): 'row' | 'column' {
  return divider.axis === 'column' ? 'column' : 'row'
}

/** Just the dividers of one family, in order along their own axis. */
export function dividersOfAxis(
  dividers: readonly GridDivider[],
  axis: 'row' | 'column',
): GridDivider[] {
  return sortDividers(dividers.filter((d) => dividerAxis(d) === axis))
}

/** Mean y of a divider, used to order rows top to bottom. */
export function dividerCentre(divider: GridDivider): number {
  if (divider.points.length === 0) return 0
  let sum = 0
  for (const p of divider.points) sum += p.y
  return sum / divider.points.length
}

/**
 * Dividers in row order, top to bottom.
 *
 * Rows are ordered by the divider's mean height rather than by inferring an
 * axis from the drag direction. Predictable beats clever here: a steeply angled
 * divider still lands somewhere sensible, and reading order never surprises.
 */
export function sortDividers(dividers: readonly GridDivider[]): GridDivider[] {
  return [...dividers].sort((a, b) => dividerCentre(a) - dividerCentre(b))
}

/**
 * Push a divider's points so it cannot cross its neighbours.
 *
 * Two crossing dividers would carve four regions with no sensible row order, so
 * a drag is clamped rather than rejected: the divider stops against whichever
 * neighbour it met, which is easier to work with than having the app refuse the
 * gesture after the fact.
 */
export function clampBetweenNeighbours(
  divider: GridDivider,
  above: GridDivider | null,
  below: GridDivider | null,
  minGap: number,
): GridDivider {
  const points = divider.points.map((p) => {
    let y = p.y
    if (above) y = Math.max(y, evaluateDivider(above, p.x) + minGap)
    if (below) y = Math.min(y, evaluateDivider(below, p.x) - minGap)
    return { x: p.x, y }
  })
  return { ...divider, points }
}

/**
 * Two points still describe a curve — a straight one. Removing down to it is
 * allowed; a point can always be added back to bend it again.
 */
const MIN_CURVE_POINTS = 2

/** Remove one control point, refusing to drop an end or leave too few behind. */
export function removeControlPoint(divider: GridDivider, index: number): GridDivider | null {
  if (index <= 0 || index >= divider.points.length - 1) return null
  if (divider.points.length <= MIN_CURVE_POINTS) return null
  return { ...divider, points: divider.points.filter((_, i) => i !== index) }
}

/** Insert a control point at `x`, sitting on the curve so nothing jumps. */
export function addControlPoint(divider: GridDivider, x: number): GridDivider {
  const y = evaluateDivider(divider, x)
  const points = [...divider.points, { x, y }].sort((a, b) => a.x - b.x)
  return { ...divider, points }
}

/** Move one control point, keeping the points ordered left to right. */
export function moveControlPoint(
  divider: GridDivider,
  index: number,
  to: Vec2,
  bounds: { x0: number; x1: number },
): GridDivider {
  const points = divider.points.map((p, i) => (i === index ? { ...p } : p))
  const point = points[index]
  if (!point) return divider

  // End points stay pinned to the container's width so a divider always spans
  // it; interior points may slide but never past their neighbours.
  const isFirst = index === 0
  const isLast = index === points.length - 1
  if (isFirst) point.x = bounds.x0
  else if (isLast) point.x = bounds.x1
  else {
    const prev = points[index - 1]
    const next = points[index + 1]
    const lo = prev ? prev.x + 1 : bounds.x0
    const hi = next ? next.x - 1 : bounds.x1
    point.x = clamp(to.x, lo, hi)
  }
  point.y = to.y
  return { ...divider, points }
}
