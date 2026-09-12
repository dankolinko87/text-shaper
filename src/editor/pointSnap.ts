import type { Vec2 } from '../types/document'

/**
 * Snapping a point to the other points of its path.
 *
 * What every vector editor does while a point is dragged or placed: when it
 * comes within a few screen pixels of lining up with another anchor — same x,
 * same y, or both — it lands exactly on that line, and a guide is drawn
 * through the points it lines up with so the user can see why it stuck. Only
 * the path's own anchors, which is Figma's rule for vector editing; other
 * objects are the selection tool's business.
 *
 * Pure: takes points in whatever space the caller measures in and a reach in
 * that space, and says where the point goes and what to draw. The layers
 * convert screen pixels to that space and draw the guides.
 */

/** How near, in SCREEN pixels, before a point snaps. Divided by zoom before use. */
export const SNAP_RADIUS = 6

/** Two coordinates this close share a guide. */
const SHARED = 0.5

/** A line worth drawing: every target on it, and the coordinate it sits at. */
export interface SnapGuide {
  /** Which coordinate is shared: `x` is a vertical line, `y` a horizontal one. */
  axis: 'x' | 'y'
  at: number
  through: Vec2[]
}

export interface Snapped {
  point: Vec2
  guides: SnapGuide[]
}

/**
 * Which way Shift has constrained a drag, from where it started and where the
 * constrained pointer is: along `x` (y is fixed), along `y` (x is fixed), or a
 * diagonal. Null when nothing is constrained.
 */
export type AxisLock = 'x' | 'y' | 'diagonal' | null

export function constrainLock(from: Vec2, to: Vec2): AxisLock {
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  if (dx < 1e-9 && dy < 1e-9) return null
  if (dy < 1e-6) return 'x'
  if (dx < 1e-6) return 'y'
  return 'diagonal'
}

/**
 * Where `candidate` lands among `targets`, and the guides that say so.
 *
 * A target within reach on BOTH axes wins outright: the point lands on it, and
 * that is what closing a loop or stacking two points needs. Failing that each
 * axis snaps on its own, to the nearest target within reach on that axis. A
 * locked axis is never snapped — Shift said where that coordinate is — and a
 * diagonal lock snaps nothing, since moving either coordinate would leave it.
 */
export function snapPoint(
  candidate: Vec2,
  targets: readonly Vec2[],
  reach: number,
  lock: AxisLock = null,
): Snapped {
  const none: Snapped = { point: { x: candidate.x, y: candidate.y }, guides: [] }
  if (reach <= 0 || targets.length === 0 || lock === 'diagonal') return none

  if (lock === null) {
    let best: Vec2 | null = null
    let bestDistance = Infinity
    for (const target of targets) {
      const dx = Math.abs(target.x - candidate.x)
      const dy = Math.abs(target.y - candidate.y)
      if (dx > reach || dy > reach) continue
      const distance = Math.hypot(dx, dy)
      if (distance < bestDistance) {
        bestDistance = distance
        best = target
      }
    }
    if (best) {
      const point = { x: best.x, y: best.y }
      return {
        point,
        guides: [
          { axis: 'x', at: point.x, through: onLine(targets, 'x', point.x) },
          { axis: 'y', at: point.y, through: onLine(targets, 'y', point.y) },
        ],
      }
    }
  }

  const point = { x: candidate.x, y: candidate.y }
  const guides: SnapGuide[] = []
  for (const axis of ['x', 'y'] as const) {
    // `lock: 'x'` means the drag runs along x, so y is the fixed coordinate.
    if (lock === (axis === 'x' ? 'y' : 'x')) continue
    let at: number | null = null
    let bestDistance = reach
    for (const target of targets) {
      const distance = Math.abs(target[axis] - candidate[axis])
      if (distance <= bestDistance) {
        bestDistance = distance
        at = target[axis]
      }
    }
    if (at === null) continue
    point[axis] = at
    guides.push({ axis, at, through: onLine(targets, axis, at) })
  }
  return { point, guides }
}

function onLine(targets: readonly Vec2[], axis: 'x' | 'y', at: number): Vec2[] {
  return targets.filter((target) => Math.abs(target[axis] - at) <= SHARED).map((t) => ({ x: t.x, y: t.y }))
}
