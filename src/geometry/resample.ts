import type { Vec2 } from '../types/document'
import { lerp } from '../utils/math'

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Uniform arc-length resampling of a polyline.
 *
 * This is the step that removes velocity and device dependence from freehand
 * input: a slow stroke and a fast flick of the same shape produce the same point
 * density afterwards, so the simplify tolerance behaves consistently. Without
 * it, a fast flick on a 240Hz tablet and a slow drag with a 60Hz mouse simplify
 * to visibly different curves.
 */
export function resamplePolyline(points: readonly Vec2[], spacing: number): Vec2[] {
  const pts = dedupe(points)
  if (pts.length < 2 || spacing <= 0 || !Number.isFinite(spacing)) return pts

  const start = pts[0]
  if (!start) return pts

  const out: Vec2[] = [{ x: start.x, y: start.y }]
  let prev: Vec2 = start
  /** Arc length walked since the last emitted sample. */
  let accumulated = 0

  for (let i = 1; i < pts.length; i++) {
    const target = pts[i]
    if (!target) continue

    let remaining = distance(prev, target)
    while (accumulated + remaining >= spacing) {
      const t = (spacing - accumulated) / remaining
      const sample: Vec2 = { x: lerp(prev.x, target.x, t), y: lerp(prev.y, target.y, t) }
      out.push(sample)
      prev = sample
      remaining = distance(prev, target)
      accumulated = 0
    }
    accumulated += remaining
    prev = target
  }

  // Always preserve the exact final point so the stroke ends where the user lifted.
  const last = pts[pts.length - 1]
  const tail = out[out.length - 1]
  if (last && tail && (tail.x !== last.x || tail.y !== last.y)) {
    out.push({ x: last.x, y: last.y })
  }
  return out
}

/**
 * Low-pass filter a closed point sequence: a wrap-around moving average.
 *
 * This is what removes hand tremor, and it has to happen HERE — on the points,
 * before Bézier fitting. `Path.simplify` does not remove tremor at any
 * tolerance (a jittery circle stays at ~300 segments however coarse the
 * tolerance), and `Path.smooth` afterwards only redistributes handles, which
 * badly distorts an already-fitted curve. Filtering first lets the fit run at a
 * tight tolerance and still produce a clean, compact path.
 */
/**
 * The same filter for a stroke that does NOT come back to its start.
 *
 * Wrapping is exactly wrong on an open line: the far end would be averaged with
 * the near one and the whole thing would be dragged toward its own middle.
 *
 * So the window CLOSES toward each end, reaching nothing at the last point. Not
 * clamped — repeating the end point to fill the window out is the obvious way to
 * write this and it is a one-sided average, which drags the end of the line
 * inward: measured on a drawn S with an 18-sample window, the first point
 * finished 17 units from where the hand put it. Where the line ends is where the
 * words end, so that is a visible amount. A window that closes is symmetric
 * everywhere, which is what leaves the ends alone — at the cost of less
 * smoothing near them, and there is nothing beyond the end to smooth with
 * anyway.
 */
export function smoothOpenPolyline(
  points: readonly Vec2[],
  radius: number,
  passes: number,
): Vec2[] {
  const n = points.length
  if (n < 3 || radius < 1 || passes < 1) return points.map((p) => ({ x: p.x, y: p.y }))

  let current: Vec2[] = points.map((p) => ({ x: p.x, y: p.y }))
  const window = Math.min(radius, Math.floor((n - 1) / 2))
  if (window < 1) return current

  for (let pass = 0; pass < passes; pass++) {
    const next: Vec2[] = new Array<Vec2>(n)
    for (let i = 0; i < n; i++) {
      const reach = Math.min(window, i, n - 1 - i)
      let sx = 0
      let sy = 0
      let count = 0
      for (let k = -reach; k <= reach; k++) {
        const q = current[i + k]
        if (!q) continue
        sx += q.x
        sy += q.y
        count++
      }
      next[i] = count > 0 ? { x: sx / count, y: sy / count } : (current[i] as Vec2)
    }
    current = next
  }
  return current
}

export function smoothClosedPolyline(
  points: readonly Vec2[],
  radius: number,
  passes: number,
): Vec2[] {
  const n = points.length
  if (n < 3 || radius < 1 || passes < 1) return points.map((p) => ({ x: p.x, y: p.y }))

  let current: Vec2[] = points.map((p) => ({ x: p.x, y: p.y }))
  const window = Math.min(radius, Math.floor((n - 1) / 2))
  if (window < 1) return current

  for (let pass = 0; pass < passes; pass++) {
    const next: Vec2[] = new Array<Vec2>(n)
    for (let i = 0; i < n; i++) {
      let sx = 0
      let sy = 0
      let count = 0
      for (let k = -window; k <= window; k++) {
        // Wrap around: the stroke is a closed loop, so the filter must be too,
        // or the seam where the stroke began would keep its tremor.
        const index = ((i + k) % n + n) % n
        const q = current[index]
        if (!q) continue
        sx += q.x
        sy += q.y
        count++
      }
      next[i] = count > 0 ? { x: sx / count, y: sy / count } : (current[i] as Vec2)
    }
    current = next
  }
  return current
}

/** Drop non-finite and consecutive duplicate points, which break angle and length maths downstream. */
export function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const prev = out[out.length - 1]
    if (prev && prev.x === p.x && prev.y === p.y) continue
    out.push({ x: p.x, y: p.y })
  }
  return out
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    total += distance(a, b)
  }
  return total
}

/**
 * How far a point lies from a polyline, measured to the SEGMENTS rather than to
 * the vertices.
 *
 * The difference matters wherever the answer is compared against a hit radius.
 * Nearest-vertex distance is wrong by up to half the sample spacing, so a curve
 * sampled every few units would report a click sitting exactly on it as being
 * a unit or two away — and at a tight zoom, where the radius in scene units is
 * small, that is the difference between hitting the line and missing it.
 */
export function distanceToPolyline(point: Vec2, polyline: readonly Vec2[]): number {
  let best = Infinity
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1] as Vec2
    const b = polyline[i] as Vec2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t =
      length > 0
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
        : 0
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}
