import { runAt, runCurving, runHeadings, type Run } from '../geometry/run'
import type { DistortionSettings, Vec2 } from '../types/document'
import { clamp } from '../utils/math'
import { seededValue } from '../utils/rng'
import { NOISE_LOOP_RADIUS, smoothNoise, type WarpFn } from './warp'

/**
 * Bending a straight strip of type onto a run.
 *
 * This is the whole of a spiral's rendering, and a ring's. `packLine` lays the
 * characters out along a straight line exactly as it does for every other mode,
 * and this maps that line onto the run: how far along the strip a point sits
 * becomes how far along the run it sits, and how far above the baseline becomes
 * how far off to one side.
 *
 * Because it maps EVERY point of a glyph outline — not just the origin of each
 * character — rotation comes out of it for free, and so does the way a letter
 * standing on a tight turn splays slightly. Both are properties of the curve
 * rather than anything this has to compute.
 */

export interface RunWarpContext {
  run: Run
  /** Strip coordinate where the run begins. */
  x0: number
  /** Strip coordinate of the baseline. */
  baseline: number
  /**
   * Keep the letters vertical instead of following the curve.
   *
   * Following the curve is the look — it reads upside down along the bottom, as
   * text on a closed path always has. Upright is for when that is too much.
   */
  upright?: boolean
  /** Shifts the type off its line, as a fraction of the strip's own height. */
  baselineShift?: number
  /**
   * How far the words have moved along the run, in object units.
   *
   * Applied where the run is READ, so the whole line travels bodily rather than
   * being deformed. Only a closed run can carry it; the caller decides that.
   */
  travel?: number
  /**
   * How far the ink reaches off the line, in object units.
   *
   * Only used to decide how far along the run to look when working out how
   * tightly it curves: a letter is bent over that much of the run, so that is
   * the distance over which the curve has to be judged.
   */
  reach?: number
  /** What the loop is doing to the strip this frame. Still artwork has none. */
  motion?: RunMotion
}

/**
 * A frame's deformation, in the strip's own coordinates.
 *
 * Applied BEFORE the strip is bent onto the run, which is the whole point: a
 * ripple worked out in strip space travels ALONG the run and pushes the type
 * off its own line, which is what "a ripple travelling along the rows" has to
 * mean when the rows are one continuous run. Worked out afterwards, in object
 * space, it would slide the artwork about the artboard instead and the shape
 * would have nothing to do with it.
 *
 * The terms are the ones the motion presets already produce for block text, and
 * they are read here with the same meanings, so a preset does the same thing to
 * run as it does to a block without knowing which it is looking at.
 */
export interface RunMotion {
  distortion: Partial<DistortionSettings>
  /** 0 to 1 once per loop. */
  phase: number
  seed: number
  /** The band the type occupies, so an amount means the same at any size. */
  bandTop: number
  bandBottom: number
  /** The run's own extent, for the terms that travel along it. */
  x0: number
  x1: number
  /** Slide along the run, as a share of its length. */
  slide: number
}

/**
 * How far along the run the direction is measured, as a share of the reach.
 *
 * The kink a chord has to average away is a property of the run; how much it
 * matters is a property of how far the ink stands off it. So the chord is tied
 * to the reach: tall type leans on the direction harder and needs it steadier.
 * A quarter takes the measured kinks down to the shape's own curvature without
 * rounding off a corner the shape really has.
 */
export const HEADING_CHORD = 0.25

/**
 * How far toward the centre of a turn a point may travel before it is held
 * back, as a share of the whole distance to it.
 *
 * Under this nothing is touched at all, which is almost everything: a lap and a
 * spiral both stand their type on the OUTSIDE of the run's turns — between the
 * run and the outline it was inset from — and the outside of a turn has no
 * centre to fall into. Only a line the user drew turns both ways beneath its own
 * letters, so only a line reaches this at all.
 *
 * The value is where a letter can still be seen to be leaning into the curve
 * without any part of it being visibly held: at 0.55 of the way in, a capital on
 * the inside of a bend is narrowed on that side by a tenth.
 */
const FOLD_KNEE = 0.55

export function createRunWarp(context: RunWarpContext): WarpFn {
  const { run, x0, baseline } = context
  const shift = context.baselineShift ?? 0
  const move = context.motion ? stripMotion(context.motion) : null
  // Declared before the upright branch, which returns without reaching the rest.
  const travel = context.travel ?? 0

  if (context.upright) {
    return (rawX: number, rawY: number): Vec2 => {
      const { x, y } = move ? move(rawX, rawY) : { x: rawX, y: rawY }
      const { point } = runAt(run, x - x0 + travel)
      // The height above the baseline is kept as a vertical offset, so letters
      // stay upright and only their position follows the run.
      return { x: point.x, y: point.y + (y - baseline) + shift }
    }
  }

  /*
   * The direction of travel, and how tightly the run curves, as the LETTERS
   * feel them — both measured across a chord rather than between neighbouring
   * samples. Worked out once here rather than per point: a frame emits tens of
   * thousands of points and there are only as many samples as the run has.
   */
  const headings = runHeadings(run, Math.max(2, (context.reach ?? 0) * HEADING_CHORD))
  const curving = runCurving(run, headings)

  return (rawX: number, rawY: number): Vec2 => {
    const { x, y } = move ? move(rawX, rawY) : { x: rawX, y: rawY }
    const { point, tangent, index, t } = runAt(run, x - x0 + travel)
    // How far above the baseline this point sits. Positive is up the page,
    // which is negative y.
    const height = baseline - y + shift
    /*
     * The one normal that keeps the letters readable.
     *
     * There is no choice here, which is worth saying plainly because the code
     * used to offer one. Travel maps to the tangent and height maps to the
     * normal, so the pair has to turn the same way as (right, up) does on the
     * page; (ty, -tx) is the rotation that does, and its Jacobian determinant
     * is +1 everywhere along the run.
     *
     * Negating it instead — which is how a "which side does the type stand on"
     * option would be built — makes the determinant -1. That is a REFLECTION,
     * and it comes out as mirror-writing: every letter backwards, all the way
     * round. Which side the type ends up on is decided upstream, by which way
     * the run is wound.
     */
    /*
     * Blended between the two samples it sits between, not taken from one.
     *
     * A per-sample heading is piecewise constant, so the normal jumps at every
     * sample boundary — and the type is bent along that normal, so each jump
     * comes out as a step in the edge of a letter, magnified by however far the
     * ink reaches. Blending makes the normal continuous and the edges smooth.
     */
    const next = (index + 1) % (headings.length / 2)
    const hx = (headings[index * 2] ?? tangent.x) * (1 - t) + (headings[next * 2] ?? tangent.x) * t
    const hy =
      (headings[index * 2 + 1] ?? tangent.y) * (1 - t) +
      (headings[next * 2 + 1] ?? tangent.y) * t
    const length = Math.hypot(hx, hy) || 1
    const nx = hy / length
    const ny = -hx / length

    // Blended for the same reason the heading is: a piecewise-constant hold
    // would step, and a step in how far the ink reaches is a notch in a letter.
    const turn = (curving[index] ?? 0) * (1 - t) + (curving[next] ?? curving[index] ?? 0) * t
    const held = hold(height, turn)

    return { x: point.x + nx * held, y: point.y + ny * held }
  }
}

/**
 * Hold a point back from the centre of the curve it is being bent around.
 *
 * A point `h` off a run that turns with curvature `k` lands on a curve of radius
 * `1/|k| - h` when it leans into the turn. At `h = 1/|k|` the whole width of the
 * letter collapses to a point, and past it the outline crosses itself: the glyph
 * comes out as shards where its smooth side was. Measured on a drawn squiggle of
 * five waves, the type reached 3.3 times the distance to the centre, and the
 * letters in the troughs were unreadable — which is what a drawn line makes easy
 * to do and a shape does not, because a shape's letters stand on the OUTSIDE of
 * its turns and a drawn line turns both ways under the same sentence.
 *
 * Refusing to draw it is no answer, and neither is shrinking the type until it
 * fits: the words are laid down once, so smaller type does not spread out to
 * cover the line, it just stops earlier and leaves the rest of the line bare.
 * Measured at a third off, a squiggle carried its sentence a quarter of the way
 * along itself and no further, which reads as a bug rather than as a limit.
 *
 * So the last of the distance is COMPRESSED instead. Below the knee nothing
 * changes, and above it the remaining room is spent asymptotically, so a point
 * can approach the centre of the turn and never reach or pass it. The letter
 * keeps its shape near the run and squeezes toward the middle, which is what
 * type bent round a tight curve looks like when it is drawn rather than folded.
 *
 * Only on the side that curves TOWARD the type. The other side has no centre to
 * fall into and is left exactly alone, which is why this changes nothing on a
 * lap or a spiral.
 */
function hold(height: number, curvature: number): number {
  // Positive when the point is heading into the turn; 1 when it has arrived.
  const toward = -curvature * height
  if (!(toward > FOLD_KNEE)) return height

  const room = 1 - FOLD_KNEE
  const spent = FOLD_KNEE + room * (1 - Math.exp(-(toward - FOLD_KNEE) / room))
  // `height / toward` is the signed distance to the centre of the turn.
  return (height / toward) * spent
}

/**
 * Hold a point back from the centre of the curve it is being bent around.
 *
 * A point `h` off a run of radius `r` lands on a circle of radius `r - h`. At
 * `h = r` the letter's whole width collapses to a point, and past it the
 * outline crosses itself: the glyph comes out with spikes where its smooth top
 * was, and it happens first at the tightest part of the run — the sides of an
 * ellipse, where the radius is smallest. Measured on a 700x620 ellipse at the
 * size the fit chose, the type reached 176 units in against a tightest radius of
 * 97, so the inner half of every letter on the left and right was inside out.
 *
 * Refusing to draw it, or capping the type size until it fits, would both mean
 * smaller type on every shape with a tight side. Instead the last of the
 * distance is COMPRESSED: below the knee nothing changes, and above it the
 * remaining room is spent asymptotically, so a point can approach the centre of
 * curvature but never reach or pass it. The letter keeps its shape near the run
 * and squeezes toward the middle, which is what type bent round a tight curve
 * looks like when it is drawn rather than folded.
 *
 * Only on the side that curves TOWARD the type. The other side has no centre to
 * fall into and is left alone.
 */
/**
 * The frame's terms, in strip space.
 *
 * Everything is scaled by the band height so a setting means the same thing on
 * 12-unit type and on 400-unit type, exactly as it does for block text.
 */
/** How far a full slide carries the type, in band heights. */
const SLIDE_REACH = 3

export type StripMove = (x: number, y: number) => Vec2

/**
 * What a frame is doing to the STRIP, before it is laid on the run.
 *
 * Exported because there are two ways to lay type on a run and this is the one
 * thing they must share. Packed letters are mapped through it point by point and
 * so are deformed by it; set letters keep the shapes they were drawn in and are
 * carried by it instead — see `renderRunLine`. Either way the deformation is
 * this function, defined once, so a preset means the same thing whichever way
 * the letters are set.
 */
export function stripMotion(motion: RunMotion): StripMove {
  const d = motion.distortion
  const bandHeight = motion.bandBottom - motion.bandTop
  const bandCentre = (motion.bandTop + motion.bandBottom) / 2
  const span = motion.x1 - motion.x0

  const shear = clamp(d.shear ?? 0, -1, 1)
  const waveAmount = clamp(d.waveAmount ?? 0, 0, 1)
  const waveFrequency = clamp(d.waveFrequency ?? 2, 0.1, 8)
  const noiseAmount = clamp(d.noiseAmount ?? 0, 0, 1)
  const noiseScale = clamp(d.noiseScale ?? 2, 0.2, 8)

  const wavePixels = waveAmount * bandHeight * 0.5
  const noisePixels = noiseAmount * bandHeight * 0.35
  const wavePhase = seededValue(motion.seed, 1) * Math.PI * 2 + motion.phase * Math.PI * 2
  // Walked around a circle rather than along a line, so the loop closes.
  const driftX = Math.cos(motion.phase * Math.PI * 2) * NOISE_LOOP_RADIUS
  const driftY = Math.sin(motion.phase * Math.PI * 2) * NOISE_LOOP_RADIUS
  const cell = Math.max(1, bandHeight / noiseScale)

  return (x: number, y: number): Vec2 => {
    let outX = x
    let outY = y

    // Lean: displacement along the run, proportional to height off the line.
    if (shear !== 0 && bandHeight > 0) outX += shear * (y - bandCentre)

    // Ripple: the type lifts off its own line and settles back, in a wave that
    // travels along the run.
    if (waveAmount > 0 && bandHeight > 0) {
      outY += Math.sin((x / Math.max(1, bandHeight)) * waveFrequency + wavePhase) * wavePixels
    }

    if (noiseAmount > 0 && bandHeight > 0) {
      const nx = x / cell + driftX
      const ny = y / cell + driftY
      outX += smoothNoise(motion.seed, nx, ny, 0) * noisePixels
      outY += smoothNoise(motion.seed, nx, ny, 17) * noisePixels
    }

    /*
     * Slide along the run, easing to nothing at both ends.
     *
     * Measured in TYPE, not in run: a share of the band height, like every other
     * term here. Scaling it by the length of the run instead — which is what a
     * deformer's position means for block text, where it is a fraction of the
     * shape — moved the letters most of the way round the spiral and smeared the
     * whole thing into arcs.
     *
     * A run has two ends, unlike the closed path this looks like. Sliding the
     * type bodily along it would push the last letters off the end, and
     * `spiralAt` clamps there — every point of a letter past the end lands on
     * the same spot, which collapses it to a spike. Holding the two ends still
     * and moving the middle keeps every letter on the run, and turns the slide
     * into a squeeze traveling through the type, which is what the preset that
     * drives this says it does.
     */
    if (motion.slide !== 0 && span > 0 && bandHeight > 0) {
      const u = clamp((x - motion.x0) / span, 0, 1)
      outX += motion.slide * bandHeight * SLIDE_REACH * Math.sin(Math.PI * u)
    }

    if (!Number.isFinite(outX) || !Number.isFinite(outY)) return { x, y }
    return { x: outX, y: outY }
  }
}
