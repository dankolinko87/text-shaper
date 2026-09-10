import { filletCorners, measureRun, ringAt, worstCornerTurn, type Run } from './run'
import type { PathData, Vec2 } from '../types/document'

/**
 * One lap of the shape, for type that goes AROUND it rather than into it.
 *
 * The spiral's outermost turn with the winding taken out. Everything that makes
 * it work is already in `run.ts` — offsetting the drawn outline, easing its
 * corners, reading a position off the result — so what is left here is the two
 * things a lap needs and a spiral does not: it is CLOSED, and it can be cut in
 * half so the bottom of a badge reads the right way up.
 */

export interface RingOptions {
  shapePath: PathData
  /**
   * How far off the drawn edge the lap sits.
   *
   * Signed. Positive is inside the outline, negative outside — the clipper
   * offsets both ways, and its round joins mean an outward lap rounds its own
   * corners on the way, which is the one place this geometry gets easier rather
   * than harder as it leaves the shape.
   */
  inset: number
  /** Arc length over which a corner is eased. See `SpiralOptions.cornerEase`. */
  cornerEase?: number
  /**
   * Travel the lap the other way round.
   *
   * Reversing which way a run is travelled flips which side of it the type
   * stands on, so the capitals point inward instead of out — the badge look. It
   * stays readable because handedness is preserved when the direction and the
   * normal turn together; flipping only the normal is a reflection, and that is
   * mirror-writing.
   *
   * The spiral has had this since it was written, as Winds inward/outward. A lap
   * could not, for no reason anyone chose: the two were the same fit written
   * twice, and the option only ever got added to one copy.
   */
  reversed?: boolean
  /**
   * Reject the lap if a corner is this much sharper than the drawn outline's.
   *
   * Offsetting inward far enough makes an irregular outline self-intersect, and
   * the clipper leaves a cusp where the crossing was. Type drawn through a cusp
   * folds over itself. The caller measures the outline once and passes the floor
   * in, because it does not change with the type size and the fit asks for a lap
   * some thirty times while it searches.
   */
  cuspFloor?: number
}

/** Sharpest corner the drawn outline has, for `RingOptions.cuspFloor`. */
export function outlineSharpness(shapePath: PathData): number {
  const base = ringAt(shapePath, 0, 0)
  return base ? worstCornerTurn(base.points) : 1
}

/**
 * One closed lap around the shape.
 *
 * Returns null when the offset collapses or folds, which the caller must treat
 * as "no ring here" rather than as an error: a band pushed deep inside a small
 * shape is a legitimate state, and the fit backs off to a smaller size.
 */
/** The widest a ring eases a corner, as a share of the lap. */
const RING_EASE_SHARE = 1 / 4

export function buildRing(options: RingOptions): Run | null {
  const lap = ringAt(options.shapePath, options.inset, 0)
  if (!lap) return null

  // Judged BEFORE the corners are eased, for the same reason the spiral does:
  // easing softens exactly the feature this is looking for.
  if (options.cuspFloor !== undefined && worstCornerTurn(lap.points) < options.cuspFloor) {
    return null
  }

  if (options.cornerEase !== undefined) {
    // A wider ceiling than a spiral allows. That ceiling exists to stop a short
    // inner turn being averaged away, and a ring has no short turns — it is one
    // lap, and always the largest one the shape can hold.
    filletCorners(lap.points, lap.length, options.cornerEase, RING_EASE_SHARE)
  }
  // Reversed after the corners are eased rather than before. Easing walks the
  // points in order and a lap eases to the same shape either way, so doing it
  // last keeps one code path instead of two.
  if (options.reversed) lap.points.reverse()
  return measureRun(lap.points, true)
}

/**
 * Rotate a lap so it begins at a chosen bearing from the shape's middle.
 *
 * A lap is a loop and has no beginning of its own — the one it arrives with is
 * wherever the offsetter happened to start the path, which lands somewhere
 * different on every shape. That does not matter until the line has to BREAK
 * somewhere, and then it matters entirely: the break is the one place a reader
 * looks for the start of the words.
 *
 * Bearings are read like a clock face: 0 is twelve o'clock and they run
 * clockwise, so 90 is three, 180 is six and 270 is nine. The lap winds clockwise
 * from wherever it is put, so a break at nine sends the words up over the top
 * first, which is the half that reads the right way up — and that is why nine is
 * where this used to be nailed down.
 *
 * Nearest BEARING rather than nearest edge, which is what makes one rule serve
 * every shape. The version this replaces looked for the leftmost sample and then
 * needed a special case for flat sides, because a rectangle's whole left edge
 * shares its leftmost x and the sampler's choice among them was arbitrary —
 * often a corner, which is a bad place for a line of type to begin. Bearings
 * have no ties to break: on that same rectangle the left edge spans a range of
 * them and exactly one is closest to nine o'clock.
 *
 * The lap stays CLOSED. Nothing is cut; the gap is left by the text not filling
 * the whole way round, so the opening straddles the point the words begin at.
 */
export function startAtAngle(ring: Run, degrees: number): Run | null {
  const points = ring.points
  const n = points.length
  if (n < 8) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const want = wrapDegrees(degrees)
  let best = 0
  let bestGap = Infinity
  for (let i = 0; i < n; i++) {
    const p = points[i] as Vec2
    const gap = Math.abs(wrapDegrees(bearing(p.x - cx, p.y - cy) - want + 180) - 180)
    if (gap < bestGap) {
      bestGap = gap
      best = i
    }
  }

  if (best === 0) return ring
  return measureRun(points.slice(best).concat(points.slice(0, best)), true)
}

/** Clock bearing of a vector: 0 straight up, growing clockwise. Screen y is down. */
function bearing(dx: number, dy: number): number {
  return wrapDegrees((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/** Into [0, 360). */
function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360
}
