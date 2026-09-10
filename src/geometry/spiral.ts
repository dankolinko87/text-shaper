import {
  SAMPLES_PER_TURN,
  filletCorners,
  measureRun,
  ringAt,
  shapeReach,
  worstCornerTurn,
  type Run,
} from './run'
import type { PathData, Vec2 } from '../types/document'

/**
 * The spiral a shape winds into.
 *
 * Not a mathematical spiral. Every turn is the OUTLINE THE USER DREW, offset
 * inward — so a blob stays blobby as it tightens and a hexagon keeps its
 * corners. That is the whole reason to build it this way: the shape's character
 * has to survive all the way to the middle, which an Archimedean spiral scaled
 * to fit would throw away on the first turn.
 *
 * The one thing that does not come for free is the JOIN between turns. The
 * clipper hands back each offset with its own arbitrary starting point — on an
 * ellipse the outline starts at (-340, 0) and its first offset at (16, -260) —
 * so joining them as they arrive flings the text 440 units across the shape at
 * every turn. Aligning the turns is therefore not a refinement; without it there
 * is no spiral, only a heap of rings.
 *
 * Sampling an offset, easing its corners and reading a position off the finished
 * polyline are all in `run.ts`, because a ring around a shape needs every one of
 * them and is not a spiral.
 */

export interface SpiralOptions {
  shapePath: PathData
  /** Distance between one turn and the next. */
  pitch: number
  /** How far inside the drawn edge the first turn sits. */
  padding?: number
  /**
   * Share of the shape left empty in the middle, 0..0.9.
   *
   * The innermost turns of a small shape crowd the inside of every letter; this
   * is the way out of that, and the reference artwork has one anyway.
   */
  centreHole?: number
  /** Cap, so a huge shape with a tiny pitch cannot run away. */
  maxTurns?: number
  /**
   * Start at the innermost turn and wind out to the drawn edge.
   *
   * The turns themselves are identical — only the order they are strung
   * together in changes. It has to be done here rather than by reversing the
   * finished run, because reversing a run also reverses the direction it
   * travels, and the direction of travel is what decides which way up the type
   * reads. Winding out has to read the same way as winding in.
   */
  fromCentre?: boolean
  /**
   * Arc length over which a corner of the shape is eased.
   *
   * Set by the caller from the height of the type that will travel the run,
   * because that is what decides whether a corner is survivable: a point sitting
   * `d` away from the run is swung by `d` times the turn, so what matters is the
   * corner's radius measured against how far the ink reaches off its line — not
   * against how far apart the turns are, which is a different question with a
   * different answer at every line-spacing setting.
   */
  cornerEase?: number
}

export interface Spiral extends Run {
  /** How many complete turns it makes. */
  turns: number
  pitch: number
  /**
   * How far inside the outline the innermost turn sits.
   *
   * Reported because the caller cannot predict it: a turn is dropped when it
   * grows too short or too sharp to carry type, so the run routinely stops well
   * before the depth it was allowed. The fit uses this to tell a spiral that
   * reached the middle from one that gave up near the edge.
   */
  depth: number
  /** Half the shape's shorter axis — what `depth` and `centreHole` measure against. */
  reach: number
}

/**
 * A turn shorter than this many pitches is not worth having.
 *
 * The innermost offsets shrink toward a dot, and a turn only a few pitches round
 * curves so tightly that a letter standing on it is bent into a ring. Measured
 * on an ellipse at pitch 40: stopping at 8 pitches drops one turn and takes the
 * worst heading change across a letter's width from 51 degrees to 18, for 5% of
 * the run. Stopping at 12 costs a triangle a whole turn and buys nothing.
 *
 * The centre-hole control is the deliberate version of this; the constant is
 * only the floor below which the geometry stops being usable at all.
 */
const MIN_TURN_PITCHES = 8

/**
 * How much sharper than the shape ITSELF a turn may be before the run stops.
 *
 * Offsetting an irregular outline inward eventually makes it self-intersect;
 * the clipper removes the crossing loop and leaves a cusp where it was. Type
 * drawn through a cusp folds over itself. A cusp is the ONLY thing this is
 * meant to catch.
 *
 * Judged against the outermost turn rather than against a fixed angle, because
 * a hexagon is meant to have corners and a triangle is meant to have sharper
 * ones. What is not meant to happen is a NEW corner appearing that the shape
 * the user drew did not have.
 *
 * Measured between adjacent samples, which is where a cusp actually lives, and
 * the separation is not close. Sampling every ring at 720 points:
 *
 *   drawn blob        1.00 at the edge, 0.998 for four turns, then 0.617
 *   630x435 ellipse   1.00 at the edge, 0.997 for four turns, then 0.071
 *   triangle          -0.49 at the edge and -0.49 all the way in
 *
 * So a healthy turn sits within a few thousandths of the outermost turn however
 * tight it gets, a cusp drops by 0.3 or more the moment it appears, and a
 * triangle's real corners never move because they were there from the start.
 * 0.3 sits in the empty ground between those.
 *
 * This replaced a version that measured over a whole PITCH rather than between
 * samples. Averaged over that distance a cusp is indistinguishable from a turn
 * that has simply become tighter, so the guard could not be set loosely enough
 * to allow the one without also allowing the other: it stopped runs several
 * turns early on smooth shapes — the inner offsets of an ellipse are relatively
 * more elongated than the ellipse, and that alone was enough to trip it — while
 * still passing genuine cusps on a blob. It was the guard, not the centre-hole
 * setting, that decided how much of a shape got filled.
 */
const CUSP_MARGIN = 0.3

/**
 * Fallback ease when the caller does not say how tall its type is, as a share of
 * the pitch. See `SpiralOptions.cornerEase`.
 */
const CORNER_FILLET = 1.6

/**
 * Wind a shape inward.
 *
 * Returns null when the shape cannot hold even one turn, which the caller must
 * treat as "no spiral" rather than as an error: a heavy padding on a small shape
 * is a legitimate state, not a failure.
 */
export function buildSpiral(options: SpiralOptions): Spiral | null {
  const { shapePath, pitch } = options
  if (!(pitch > 0)) return null

  const padding = Math.max(0, options.padding ?? 0)
  const hole = Math.min(0.9, Math.max(0, options.centreHole ?? 0))
  const maxTurns = Math.max(1, Math.round(options.maxTurns ?? 64))

  // How far in we may go before the middle is reached. Measured from the
  // shape's own size so the hole means the same thing on any shape.
  const reach = shapeReach(shapePath)
  if (!(reach > 0)) return null
  const deepest = reach * (1 - hole)

  const rings: Vec2[][] = []
  let depth = 0
  let outerSharpness = 1
  for (let k = 0; k <= maxTurns; k++) {
    const inset = padding + pitch * k
    if (k > 0 && inset > deepest) break
    const ring = ringAt(shapePath, inset, pitch * MIN_TURN_PITCHES)
    if (!ring) break

    // Judged on the raw offset, BEFORE the corners are eased. Filleting softens
    // exactly the feature this is looking for, so measuring afterwards would
    // hide the cusps it exists to catch — which is precisely what happened the
    // first time these two were put in the wrong order.
    const sharpness = worstCornerTurn(ring.points)
    if (k === 0) outerSharpness = sharpness
    else if (sharpness < outerSharpness - CUSP_MARGIN) break

    filletCorners(ring.points, ring.length, options.cornerEase ?? CORNER_FILLET * pitch)
    rings.push(ring.points)
    depth = inset
  }

  // One ring is a closed loop, not a spiral: the run needs somewhere to wind to.
  if (rings.length < 2) return null

  alignTurns(rings)
  // Aligned first, then reversed: alignment only rotates each turn's starting
  // point to sit under its neighbour's, which is as true read outward as inward.
  if (options.fromCentre) rings.reverse()
  return weave(rings, pitch, depth, reach)
}

/**
 * Rotate each turn so its start sits directly inside the previous turn's.
 *
 * THE step that makes a spiral out of a stack of rings. Offsetting does not
 * preserve where a path begins, so without this the run jumps by hundreds of
 * units at every join. Measured on an ellipse: 440 units before, 40 after —
 * which is one pitch, exactly as a spiral should be.
 */
function alignTurns(rings: Vec2[][]): void {
  for (let k = 1; k < rings.length; k++) {
    const previous = rings[k - 1] as Vec2[]
    const ring = rings[k] as Vec2[]
    const anchor = previous[0] as Vec2

    let bestIndex = 0
    let bestDistance = Infinity
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i] as Vec2
      const d = (p.x - anchor.x) ** 2 + (p.y - anchor.y) ** 2
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }

    if (bestIndex > 0) rings[k] = ring.slice(bestIndex).concat(ring.slice(0, bestIndex))
  }
}

/**
 * Blend the aligned turns into one continuous run.
 *
 * Part-way round turn k the run has already moved part of the way toward turn
 * k+1, which is what makes it a spiral rather than a ring that jumps inward at
 * the seam. At the end of turn k the blend has reached turn k+1 exactly, so the
 * next turn picks up from the same point and the join is invisible.
 */
function weave(
  rings: readonly Vec2[][],
  pitch: number,
  depth: number,
  reach: number,
): Spiral | null {
  const turns = rings.length - 1
  const points: Vec2[] = []

  for (let k = 0; k < turns; k++) {
    const from = rings[k] as Vec2[]
    const to = rings[k + 1] as Vec2[]
    const n = from.length
    // The last sample of turn k lands exactly on turn k+1's start, which is
    // where turn k+1 begins — so the run is continuous with no point repeated.
    for (let i = 0; i < n; i++) {
      const t = i / n
      const a = from[i] as Vec2
      const b = to[Math.round(t * to.length) % to.length] as Vec2
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  // No closing point is appended. The blend already ends a fraction short of the
  // innermost turn's start, and snapping onto it turns the last step 47 degrees
  // off the heading — a visible shear on the final letter, for a quarter of a
  // unit of extra run.
  const run = measureRun(points)
  if (!run) return null
  return { ...run, turns, pitch, depth, reach }
}

/** Kept so `SAMPLES_PER_TURN` still reads as a spiral fact where it is used. */
export { SAMPLES_PER_TURN }
