import { insetPath } from './clipper'
import { withPaper } from './paperContext'
import { applyToPaths, parsePathInScope } from './path'
import type { PathData, Vec2 } from '../types/document'

/**
 * A RUN: a sampled path that type is set along.
 *
 * The spiral was the first of these and for a while the only one, so all of this
 * lived in `spiral.ts` and was named after it. A ring around a shape is the same
 * object — a polyline with an arc-length table — wound once instead of inward,
 * and the machinery that bends type onto one bends type onto the other without
 * knowing which it has.
 *
 * The parts kept here are the ones that are about paths rather than about
 * spirals: sampling an offset of the outline, easing its corners enough for type
 * to travel through them, and looking up where the run is at a given distance.
 */

export interface Run {
  /** The run as one polyline. */
  points: readonly Vec2[]
  /**
   * Cumulative arc length at each point.
   *
   * One entry longer than `points` when the run is closed, because the segment
   * from the last point back to the first is a segment like any other.
   */
  distances: readonly number[]
  /** Total arc length. */
  total: number
  /**
   * The end joins the start, so `runAt` wraps rather than clamping.
   *
   * A spiral has two ends and a ring does not, and the difference is not
   * cosmetic: on an open run anything pushed past the end piles up there, which
   * collapses a glyph to a spike. On a closed one it simply comes round again.
   */
  closed?: boolean
}

export interface RunSample {
  point: Vec2
  /** Unit vector along the run. */
  tangent: Vec2
  /**
   * Which sample the position landed on, and how far past it.
   *
   * Reported so a caller with its own per-sample table — the warp's heading and
   * curvature — can read it without searching the arc-length table a second
   * time, and blend between two entries rather than stepping from one to the
   * next. A per-sample value used as-is makes the normal piecewise constant, and
   * type standing 153 units off its line turns each of those steps into a
   * visible notch in the side of a letter.
   *
   * This is called once per emitted point, tens of thousands of times a frame.
   */
  index: number
  /** How far between this sample and the next, 0 to 1. */
  t: number
}

/** Points per lap. Fine enough that a letter spans several samples. */
export const SAMPLES_PER_TURN = 720

/**
 * Build the arc-length table for a list of points.
 *
 * Returns null when there is not enough there to be a run, which every caller
 * has to treat as "no run" rather than as a failure.
 */
export function measureRun(points: readonly Vec2[], closed = false): Run | null {
  const n = points.length
  if (n < 2) return null

  const distances: number[] = [0]
  let total = 0
  const segments = closed ? n : n - 1
  for (let i = 1; i <= segments; i++) {
    const a = points[(i - 1) % n] as Vec2
    const b = points[i % n] as Vec2
    total += Math.hypot(b.x - a.x, b.y - a.y)
    distances.push(total)
  }

  if (!(total > 0)) return null
  return { points, distances, total, ...(closed ? { closed: true } : {}) }
}

/**
 * Where the run is at distance `s`, and which way it is heading.
 *
 * Clamped on an open run: it has two ends, and a character pushed past one
 * should pile up there rather than reappear at the start. Wrapped on a closed
 * one, where there is no end to pile up at.
 */
export function runAt(run: Run, s: number): RunSample {
  const { points, distances, total } = run
  const target = run.closed
    ? ((s % total) + total) % total
    : Math.min(Math.max(s, 0), total)

  // Binary search the arc-length table: this is called once per emitted point,
  // which is tens of thousands of times per frame.
  let lo = 0
  let hi = distances.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if ((distances[mid] as number) <= target) lo = mid
    else hi = mid
  }

  // Modulo on the point index, not on the distance index: a closed run's last
  // segment runs from its last point back to its first.
  const n = points.length
  const a = points[lo % n] as Vec2
  const b = points[hi % n] as Vec2
  const d0 = distances[lo] as number
  const d1 = distances[hi] as number
  const span = d1 - d0
  const f = span > 0 ? (target - d0) / span : 0

  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1

  return {
    point: { x: a.x + dx * f, y: a.y + dy * f },
    tangent: { x: dx / len, y: dy / len },
    index: lo % n,
    t: f,
  }
}

/**
 * Sample an OPEN path evenly along its length.
 *
 * The counterpart to `ringAt`, which offsets a closed outline and hands back a
 * loop. A drawn line has no inside to offset from and no area to speak of: it is
 * the run itself, and all it needs is to be walked at a steady pace so the
 * arc-length table that follows is honest.
 *
 * `sampleOutline` in `patch.ts` cannot be reused for this. It picks the subpath
 * with the largest AREA, which for a line is zero — it would choose arbitrarily
 * among them, and on a single line it would choose one with no area at all.
 * Length is the right measure here, so length is what this uses.
 */
export function samplePath(data: PathData, spacing: number): Vec2[] | null {
  if (!data || data.trim().length === 0 || !(spacing > 0)) return null

  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)

    // The longest subpath is the line; anything else is a stray from a stroke
    // that lifted and came back.
    let best: paper.Path | null = null
    applyToPaths(item, (candidate) => {
      if (!best || candidate.length > best.length) best = candidate
    })
    if (!best) {
      item.remove()
      return null
    }

    const line = best as paper.Path
    const total = line.length
    if (!(total > 0)) {
      item.remove()
      return null
    }

    const steps = Math.max(2, Math.ceil(total / spacing))
    const points: Vec2[] = []
    for (let i = 0; i <= steps; i++) {
      const at = line.getPointAt((total * i) / steps)
      if (at) points.push({ x: at.x, y: at.y })
    }
    item.remove()
    return points.length >= 2 ? points : null
  })
}

/**
 * The direction of travel at every sample, measured over a CHORD.
 *
 * Not from one sample to the next. The runs here come off an integer-grid
 * polygon offsetter, and while the resampling that follows is perfectly even —
 * segment lengths on a measured lap vary by less than a thousandth — the
 * DIRECTION from one sample to the next still kinks. Measured on a lap of a
 * plain oval, the turn between adjacent samples peaks at five times what the
 * shape's own curvature calls for.
 *
 * That does not matter to a point sitting on the run. It matters enormously to
 * one standing off it: the type is bent onto the normal, so an angular kink is
 * multiplied by how far the ink reaches. At 153 units of reach a kink of 0.06
 * radians throws a point nine units sideways, which is a visible notch in the
 * top of an O and a bite out of the shoulder of a C.
 *
 * A chord across the kink averages it away, and over a smooth stretch a chord
 * and a tangent agree. This is the same fix, for the same reason, as the chord
 * `renderRunLine` faces a rigid letter along — which is why set type never
 * showed this and wrapped type did.
 */
export function runHeadings(run: Run, chord: number): Float64Array {
  const points = run.points
  const n = points.length
  // Pairs of x, y — a flat array because this is read once per emitted point.
  const out = new Float64Array(n * 2)
  if (n < 2) return out

  const spacing = run.total > 0 ? run.total / n : 1
  const half = Math.max(1, Math.min(Math.round(chord / spacing), Math.floor(n / 4)))
  const at = (i: number): Vec2 =>
    points[
      run.closed ? ((i % n) + n) % n : Math.min(Math.max(i, 0), n - 1)
    ] as Vec2

  for (let i = 0; i < n; i++) {
    const a = at(i - half)
    const b = at(i + half)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    out[i * 2] = dx / length
    out[i * 2 + 1] = dy / length
  }
  return out
}


/**
 * How tightly the run turns at every sample, SIGNED, in the same terms the warp
 * bends type in.
 *
 * Read off the headings rather than off the points, and that is the whole point
 * of it. A curvature taken from three neighbouring samples is dominated by the
 * offsetter's own noise — on a lap of a plain oval the turn between adjacent
 * samples peaks at five times the shape's real curvature, so a direct measure
 * reports a hairpin on a curve that is nearly straight. The headings have
 * already had that averaged out of them over a chord, and they are what the type
 * is actually bent along, so the turn between one heading and the next is both
 * quieter and the thing that matters.
 *
 * The sign says which way. Positive is a turn toward `-n`, where `n` is the
 * normal `(hy, -hx)` the warp stands type on: so a point at height `h` off the
 * run is heading INTO the centre of the turn when `-k * h` is positive, and has
 * reached it when that product is 1.
 */
export function runCurving(run: Run, headings: Float64Array): Float64Array {
  const points = run.points
  const n = points.length
  const out = new Float64Array(n)
  if (n < 2) return out

  const distances = run.distances
  for (let i = 0; i < n; i++) {
    const j = run.closed ? (i + 1) % n : Math.min(i + 1, n - 1)
    if (j === i) break
    // The real spacing, not the average: a run is evenly sampled by intent and
    // only approximately so in fact.
    const step = (distances[i + 1] ?? run.total) - (distances[i] ?? 0)
    if (!(step > 0)) continue
    const ax = headings[i * 2] as number
    const ay = headings[i * 2 + 1] as number
    const bx = headings[j * 2] as number
    const by = headings[j * 2 + 1] as number
    out[i] = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / step
  }
  // The last sample of an open run has no next heading to turn toward.
  if (!run.closed && n >= 2) out[n - 1] = out[n - 2] as number
  return out
}

/** The run as a path, for drawing guides and for testing. */
export function runToPath(run: Run): PathData {
  const parts: string[] = []
  for (let i = 0; i < run.points.length; i++) {
    const p = run.points[i] as Vec2
    parts.push(`${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
  }
  if (run.closed) parts.push('Z')
  return parts.join('')
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Half the shorter axis of the shape's bounds — what depth is measured against. */
export function shapeReach(data: PathData): number {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const b = item.bounds
    item.remove()
    return Math.min(b.width, b.height) / 2
  })
}

/**
 * One offset of the outline, resampled to evenly spaced points.
 *
 * A POSITIVE inset moves inside the outline and a negative one outside; the
 * clipper handles both, and its round joins mean an outward offset rounds its
 * own corners on the way.
 *
 * KNOWN LIMIT: an offset of a waisted shape splits into several loops, and this
 * takes the longest. A run then simply does not reach the smaller lobe. Running
 * the text through every loop in turn is the right answer and is left for when
 * the rest of this is working.
 */
export function ringAt(
  shapePath: PathData,
  inset: number,
  minLength: number,
): { points: Vec2[]; length: number } | null {
  let data: PathData = shapePath
  if (inset !== 0) {
    const result = insetPath(shapePath, inset)
    if (result.collapsed || !result.path) return null
    data = result.path
  }

  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const children = (item as unknown as { children?: unknown[] }).children as
      | { length: number; getPointAt: (offset: number) => { x: number; y: number } | null }[]
      | undefined

    const paths =
      children && children.length > 0
        ? children
        : [item as unknown as { length: number; getPointAt: (o: number) => { x: number; y: number } | null }]

    let longest = paths[0]
    for (const path of paths) if (path.length > (longest?.length ?? 0)) longest = path

    if (!longest || !(longest.length > minLength)) {
      item.remove()
      return null
    }

    const points: Vec2[] = []
    for (let i = 0; i < SAMPLES_PER_TURN; i++) {
      const p = longest.getPointAt((i / SAMPLES_PER_TURN) * longest.length)
      if (!p) {
        item.remove()
        return null
      }
      points.push({ x: p.x, y: p.y })
    }
    const length = longest.length
    item.remove()

    // Every lap wound the same way, so the tangent — and with it which side the
    // type stands on — does not flip somewhere in the middle of the run.
    //
    // POSITIVE area, which with y pointing down is CLOCKWISE on screen. That is
    // the direction that runs the baseline left to right along the TOP of the
    // shape, which is how text on a closed path has to read. It also settles
    // which way up the type is, because the two are the same question: the
    // readable normal is always the tangent turned to (ty, -tx), and at the top
    // of a clockwise lap that points away from the middle — so the capitals
    // stand up out of the run rather than hanging into it.
    //
    // Wound the other way both of those invert together, and no amount of
    // flipping the normal afterwards recovers it: negating the normal alone
    // REFLECTS the letters rather than turning them, which is a mirror image.
    if (signedArea(points) < 0) points.reverse()
    return { points, length }
  })
}

/**
 * How sharp a single step has to be to count as a corner, as a cosine.
 *
 * Sampled at 720 points a lap, a smooth curve turns a fraction of a degree per
 * step whatever its radius, and a corner turns tens of degrees in one. cos(15°)
 * sits in the empty ground between the two.
 */
const CORNER_STEP = Math.cos((15 * Math.PI) / 180)

/**
 * Round a lap's corners just enough for type to travel through them.
 *
 * A moving average, applied ONLY where there is a corner to round.
 *
 * A plain average looks corner-seeking — averaging collinear points returns them
 * unchanged — and is, while the window stays small. It stops being so as the
 * window grows: over a wide one a smooth curve pulls measurably toward its own
 * middle, and a quarter-lap window shrinks a circle by a tenth. That is invisible
 * on a spiral, whose laps are drawn wherever they land, and very visible on a
 * ring, whose whole job is to put the type ON the outline — 30 units of daylight
 * appeared between the two on an ellipse with no corners to ease at all.
 *
 * So each point is moved toward its average by how much easing it actually
 * needs: nothing on a smooth arc, all of it within half a window of a corner.
 * The shape keeps its corners — they are rounded by well under the type's own
 * height, far too little to read as a rounded rectangle — and everything that is
 * not a corner is left exactly where it was.
 */
export function filletCorners(
  points: Vec2[],
  length: number,
  ease: number,
  /**
   * The widest the averaging window may get, as a share of the lap.
   *
   * There has to be a ceiling. The ease is an arc length, and a spiral's
   * innermost laps are short: without one the window reaches a sizeable fraction
   * of the way round a small lap and averages the lap itself away rather than
   * its corners, leaving a wandering little loop whose curvature is worse than
   * what it replaced. Measured on a rectangle, widening past an eighth made the
   * worst turn a letter had to absorb go UP, from 53 degrees to 122.
   *
   * A RING is a single lap and always the biggest one, so it can afford more
   * than a spiral's innermost turn can — see `buildRing`.
   */
  maxShare = 1 / 8,
): void {
  const n = points.length
  const arcPerSample = length / n
  const half = Math.min(Math.floor(ease / arcPerSample / 2), Math.floor((n * maxShare) / 2))
  if (half < 1) return

  smoothWhere(points, cornerFlags(points), half)
}

/**
 * Average each flagged point over a window, leaving the rest exactly as it is.
 *
 * The flags are dilated by the window first, because whatever is being eased is
 * a point or two and easing a point or two does nothing — it is the letters
 * ARRIVING at it that have to be brought round, so the neighbourhood moves too.
 */
export function smoothWhere(points: Vec2[], flags: readonly boolean[], half: number): void {
  const n = points.length
  if (half < 1) return

  const need: boolean[] = new Array<boolean>(n).fill(false)
  let any = false
  for (let i = 0; i < n; i++) {
    if (!flags[i]) continue
    any = true
    for (let k = -half; k <= half; k++) need[(i + k + n) % n] = true
  }
  if (!any) return

  const original = points.map((p) => ({ x: p.x, y: p.y }))
  const width = half * 2 + 1
  for (let i = 0; i < n; i++) {
    if (!need[i]) continue
    let x = 0
    let y = 0
    for (let k = -half; k <= half; k++) {
      const q = original[(i + k + n) % n] as Vec2
      x += q.x
      y += q.y
    }
    points[i] = { x: x / width, y: y / width }
  }
}

/**
 * Which points sit on a corner: a single step that turns sharply.
 *
 * Sampled at 720 points a lap, a smooth curve turns a fraction of a degree per
 * step whatever its radius, and a corner turns tens of degrees in one.
 */
function cornerFlags(points: readonly Vec2[]): boolean[] {
  const n = points.length
  const flags: boolean[] = new Array<boolean>(n).fill(false)

  for (let i = 0; i < n; i++) {
    const a = points[i] as Vec2
    const b = points[(i + 1) % n] as Vec2
    const c = points[(i + 2) % n] as Vec2
    const t1x = b.x - a.x
    const t1y = b.y - a.y
    const t2x = c.x - b.x
    const t2y = c.y - b.y
    const l1 = Math.hypot(t1x, t1y)
    const l2 = Math.hypot(t2x, t2y)
    if (l1 < 1e-9 || l2 < 1e-9) continue
    if ((t1x * t2x + t1y * t2y) / (l1 * l2) < CORNER_STEP) flags[(i + 1) % n] = true
  }
  return flags
}

/**
 * The tightest corner anywhere on a lap, as the cosine between the headings of
 * two adjacent sample steps.
 *
 * 1 is dead straight and -1 is a fold back on itself. Adjacent samples rather
 * than a wider window because a cusp is a single point, and anything wider
 * averages it away against the arc either side of it — which is exactly how an
 * earlier version of this managed to miss them. Facet noise from the clipper
 * does show up here, but it shows up as a few degrees.
 */
export function worstCornerTurn(points: readonly Vec2[]): number {
  const n = points.length
  if (n < 8) return 1

  let worst = 1
  for (let i = 0; i < n; i++) {
    const a = points[i] as Vec2
    const b = points[(i + 1) % n] as Vec2
    const c = points[(i + 2) % n] as Vec2
    const t1x = b.x - a.x
    const t1y = b.y - a.y
    const t2x = c.x - b.x
    const t2y = c.y - b.y
    const l1 = Math.hypot(t1x, t1y)
    const l2 = Math.hypot(t2x, t2y)
    if (l1 < 1e-9 || l2 < 1e-9) continue
    worst = Math.min(worst, (t1x * t2x + t1y * t2y) / (l1 * l2))
  }
  return worst
}

/** Shoelace. Sign tells us the winding; magnitude is not used. */
function signedArea(points: readonly Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2
    const b = points[(i + 1) % points.length] as Vec2
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Where a band sits across the run, and how far along it runs. */
export interface BandSpan {
  /** Offsets across the run, in the space the glyphs are placed in. */
  from: number
  to: number
  /**
   * Arc length the band covers, when it does not cover the whole run.
   *
   * A banner follows its TEXT. Set letters keep their drawn widths and can only
   * be spread so far, so on a run longer than the words the line stops short —
   * and a band drawn along the whole run then carries on past the last letter,
   * winding into the middle of the shape with nothing on it.
   *
   * Given, the band is a strip between these two points and is open at both
   * ends, even on a closed run.
   */
  start?: number
  end?: number
}

/**
 * The band the type travels in, as a filled outline.
 *
 * A ribbon of constant height laid along the run — the banner the type sits on.
 * `from` and `to` are offsets in the SAME space the glyphs are placed in, so the
 * band and the letters inside it cannot drift apart: `renderRunLine` puts a
 * glyph point at `point - n * off`, and so does this.
 *
 * The two cases differ in what has to be closed:
 *
 * OPEN (a spiral, or any band cut to its text) is one loop — out along one edge,
 * back along the other. Where the turns are closer together than the band is
 * tall the loop overlaps itself, which is exactly the solid banner someone asks
 * for by closing the gap, and `nonzero` fill draws it as one mass rather than
 * punching holes.
 *
 * CLOSED (a whole lap) is two loops, the inner one REVERSED, so `nonzero` leaves
 * the middle of the shape open instead of flooding it.
 */
export function ribbonPath(
  run: Run,
  band: BandSpan,
  /** How the shape is bending the plane, if it is. See `renderFrame`. */
  move?: (point: Vec2) => Vec2,
  /**
   * What the frame is doing to the band, if anything.
   *
   * The banner lives in the same strip the letters do, so a preset that ripples
   * the strip has to ripple the banner with it — otherwise the words climb out
   * of their own background, which is what they did: the band was drawn from the
   * resting run and could not move under any preset.
   *
   * Taken as a drift in the band's OWN terms — how far along the run, and how far
   * across it — rather than as the strip map itself, so this file stays clear of
   * the typography layer. `renderBandFrame` converts one to the other.
   */
  drift?: BandDrift,
): PathData {
  const { from, to } = band
  if (run.points.length < 2 || !(to > from)) return ''

  const hold = (value: number): number => Math.min(Math.max(value, 0), run.total)
  const first = hold(band.start ?? 0)
  const last = hold(band.end ?? run.total)

  const arcs = centreArcs(run, first, last)
  if (arcs.length < 2) return ''
  // A band cut to its text is a strip with two ends, whatever the run is.
  const closed = run.closed === true && band.start === undefined && band.end === undefined
  const n = arcs.length

  const at = (arc: number): Vec2 => {
    const p = runAt(run, arc).point
    return move ? move(p) : p
  }

  const edge = (index: number, off: number): Vec2 => {
    /*
     * The heading at a sample, from its neighbours.
     *
     * Centred where there are neighbours on both sides, one-sided at the ends
     * of an open strip, and wrapping on a closed lap. A one-sided difference at
     * an interior point would lean the edge half a sample forward and put a
     * visible nick in the band at every turn's seam.
     */
    const before = index > 0 ? index - 1 : closed ? n - 1 : index
    const after = index < n - 1 ? index + 1 : closed ? 0 : index

    // Drifted first, then measured: the band has to lean the way the moved type
    // leans, not the way the resting run did.
    const here = drift ? drift(arcs[index] as number, off) : { arc: arcs[index] as number, off }
    const p = at(here.arc)
    const a = at(drift ? drift(arcs[before] as number, off).arc : (arcs[before] as number))
    const b = at(drift ? drift(arcs[after] as number, off).arc : (arcs[after] as number))
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    // The same normal the renderer uses, so `off` means the same thing here.
    const nx = dy / length
    const ny = -dx / length
    return { x: p.x - nx * here.off, y: p.y - ny * here.off }
  }

  const loop = (off: number, reverse: boolean): string => {
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const p = edge(reverse ? n - 1 - i : i, off)
      parts.push(`${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
    }
    return parts.join('') + 'Z'
  }

  if (closed) return loop(from, false) + loop(to, true)

  // One loop: out along the far edge and back along the near one, which closes
  // the ends square without needing caps of their own.
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const p = edge(i, from)
    parts.push(`${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
  }
  for (let i = n - 1; i >= 0; i--) {
    const p = edge(i, to)
    parts.push(`L${round(p.x)} ${round(p.y)}`)
  }
  return parts.join('') + 'Z'
}

/**
 * How a frame is displacing the band: along the run, and across it.
 *
 * Both in the band's own units — arc length and the offset the band edges are
 * measured in — which are the units `ribbonPath` already works in.
 */
export type BandDrift = (arc: number, off: number) => { arc: number; off: number }

/**
 * The arc positions the band is laid along.
 *
 * The whole run unless the band was cut to its text, in which case the two ends
 * are interpolated rather than snapped to the nearest sample — a band that ended
 * at whichever sample happened to be closest would step in and out by up to half
 * a sample as the text was edited.
 */
function centreArcs(run: Run, start: number, end: number): number[] {
  // The whole of a closed run: its own samples, so a lap comes out as the lap
  // rather than as a strip that happens to meet itself.
  if (run.closed === true && start <= 0 && end >= run.total) {
    return run.points.map((_, i) => run.distances[i] as number)
  }
  if (!(end > start)) return []

  const arcs: number[] = [start]
  for (let i = 0; i < run.points.length; i++) {
    const d = run.distances[i] as number
    if (d > start && d < end) arcs.push(d)
  }
  arcs.push(end)
  return arcs
}
