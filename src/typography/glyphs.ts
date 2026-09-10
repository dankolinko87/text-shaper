import { runAt, type Run } from '../geometry/run'
import type { PathData, Vec2 } from '../types/document'
import { clamp } from '../utils/math'
import { seededValue } from '../utils/rng'
import { getLoadedFont } from './fontRegistry'
import type { GlyphSlot } from './packLine'
import type { StripMove } from './runWarp'
import type { WarpFn } from './warp'

/**
 * Text to glyph outlines.
 *
 * The engine emits SVG path strings, which are the single vector representation
 * used everywhere: the document model stores them, Fabric renders them, and the
 * SVG exporter writes the same strings out. On-screen and exported artwork
 * therefore cannot drift apart.
 *
 * Compound paths and internal counters are preserved — opentype.js emits one
 * `M` command per contour, so a glyph like "o" arrives as two contours with
 * opposite winding. These MUST be filled with the nonzero fill rule for the
 * counter to stay open.
 */

export interface GlyphRun {
  /** Path data for the whole line, already positioned, stretched, and warped. */
  path: PathData
  /** Advance width at the requested size, before horizontal stretch. */
  naturalWidth: number
}

export interface LineRenderOptions {
  fontId: string
  /** Font size in object-local units. */
  size: number
  /** Baseline origin. */
  x: number
  y: number
  /** Extra space between glyphs, in em. */
  letterSpacing: number
  /** Horizontal scale about `x` — the LINE STRETCH mechanism. */
  horizontalScale: number
  /**
   * Extra width to distribute across the line, in object units — the GLYPH
   * STRETCH mechanism. Spread between glyphs rather than applied as one scale,
   * so the line follows the shape without uniformly fattening every letter.
   */
  extraWidth?: number
  /** Optional deformation applied to every emitted point. */
  warp?: WarpFn
  /** Subdivide curves before warping, for fields that vary within a glyph. */
  subdivide?: boolean
  /**
   * Longest straight run emitted before it is split, in object units. Zero
   * leaves straight segments alone. See `createEmitter`.
   */
  maxSegment?: number
  /** Per-glyph size variation, 0..1. */
  glyphScaleVariation?: number
  /** Per-glyph rotation, 0..1, mapped to a small angle. */
  glyphRotation?: number
  seed?: number
}

const PRECISION = 1000
/** Segments per curve when subdividing for a high-frequency warp. */
const SUBDIVISIONS = 10
/** Ceiling on the pieces one straight run is split into, to bound path size. */
const MAX_LINE_STEPS = 32
/** Maximum per-glyph rotation at full strength. */
const MAX_GLYPH_ROTATION_DEG = 12

function fmt(value: number): string {
  return String(Math.round(value * PRECISION) / PRECISION)
}

/**
 * Render one line of text to a single compound path.
 *
 * Built from opentype's command list rather than by rewriting a serialised path
 * string: the commands are already structured (M/L/Q/C/Z with explicit x/y
 * fields), so there is no need to guess which numbers in a `d` attribute are
 * coordinates — and the structure is what makes warping control points possible.
 */
export function renderLine(text: string, options: LineRenderOptions): GlyphRun {
  const font = getLoadedFont(options.fontId)
  if (!font) throw new Error(`Font not loaded: ${options.fontId}`)

  const glyphs = font.stringToGlyphs(text)
  const upm = font.unitsPerEm
  const spacing = options.letterSpacing * options.size
  const scale = options.horizontalScale
  const seed = options.seed ?? 0
  const scaleVariation = clamp(options.glyphScaleVariation ?? 0, 0, 1)
  const rotation = clamp(options.glyphRotation ?? 0, 0, 1)

  let naturalWidth = 0
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i]
    if (!glyph) continue
    naturalWidth += ((glyph.advanceWidth ?? 0) / upm) * options.size
    if (i < glyphs.length - 1) naturalWidth += spacing
  }

  // GLYPH STRETCH: share the surplus between the gaps rather than scaling the
  // letterforms, which keeps the line filling its span without every glyph
  // reading as a heavier weight.
  const gaps = Math.max(1, glyphs.length - 1)
  const extraPerGap = (options.extraWidth ?? 0) / gaps

  const emitter = createEmitter(options.warp, options.subdivide === true, options.maxSegment ?? 0)
  let penX = 0

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i]
    if (!glyph) continue

    const originX = options.x + penX * scale
    // Deterministic per-glyph variation, stable for a given seed and position.
    const jitter = scaleVariation > 0 ? 1 + (seededValue(seed, i * 2 + 3) - 0.5) * scaleVariation * 0.5 : 1
    const angle =
      rotation > 0
        ? (seededValue(seed, i * 2 + 4) - 0.5) * rotation * MAX_GLYPH_ROTATION_DEG * (Math.PI / 180)
        : 0
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const glyphSize = options.size * jitter

    /** Map a glyph-space point into line space, before any warp. */
    const place = (gx: number, gy: number): Vec2 => {
      // Rotate about the glyph's own baseline origin so letters pivot in place.
      const rx = gx * cos - gy * sin
      const ry = gx * sin + gy * cos
      return { x: originX + rx * scale, y: options.y + ry }
    }

    emitter.beginGlyph()
    for (const cmd of glyph.getPath(0, 0, glyphSize).commands) {
      switch (cmd.type) {
        case 'M':
          emitter.moveTo(place(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'L':
          emitter.lineTo(place(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'Q':
          emitter.quadTo(place(cmd.x1 ?? 0, cmd.y1 ?? 0), place(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'C':
          emitter.cubicTo(
            place(cmd.x1 ?? 0, cmd.y1 ?? 0),
            place(cmd.x2 ?? 0, cmd.y2 ?? 0),
            place(cmd.x ?? 0, cmd.y ?? 0),
          )
          break
        case 'Z':
          emitter.close()
          break
      }
    }

    penX += ((glyph.advanceWidth ?? 0) / upm) * options.size + spacing + extraPerGap / scale
  }

  return { path: emitter.toPathData(), naturalWidth }
}

export interface PackedLineOptions {
  fontId: string
  /** Slots from `packLine`, one per character. */
  slots: readonly GlyphSlot[]
  /** The characters the slots refer to, in source order. */
  characters: readonly string[]
  warp?: WarpFn
  subdivide?: boolean
  /** Longest straight run emitted before it is split, in object units. */
  maxSegment?: number
}

/**
 * Render a line whose characters were packed individually.
 *
 * Each character carries its own horizontal and vertical scale and its own
 * baseline, so this cannot go through `renderLine` — that walks a single pen
 * with one shared size. Glyph outlines are generated at size 1 and scaled per
 * character, which is what lets a letter be stretched to twice its height and
 * a third of its width while its neighbour is not.
 */
export function renderPackedLine(options: PackedLineOptions): GlyphRun {
  const font = getLoadedFont(options.fontId)
  if (!font) throw new Error(`Font not loaded: ${options.fontId}`)

  const emitter = createEmitter(options.warp, options.subdivide === true, options.maxSegment ?? 0)
  let width = 0

  for (const slot of options.slots) {
    if (slot.blank) continue
    const char = options.characters[slot.index]
    if (char === undefined) continue

    const glyph = font.charToGlyph(char)
    if (!glyph) continue

    const map = (gx: number, gy: number): Vec2 => ({
      x: slot.x + gx * slot.scaleX,
      y: slot.baselineY + gy * slot.scaleY,
    })

    // Outlines at size 1, scaled per character. Anything else would bake one
    // shared size back into the glyph before the per-character scale applies.
    for (const cmd of glyph.getPath(0, 0, 1).commands) {
      switch (cmd.type) {
        case 'M':
          emitter.moveTo(map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'L':
          emitter.lineTo(map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'Q':
          emitter.quadTo(map(cmd.x1 ?? 0, cmd.y1 ?? 0), map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'C':
          emitter.cubicTo(
            map(cmd.x1 ?? 0, cmd.y1 ?? 0),
            map(cmd.x2 ?? 0, cmd.y2 ?? 0),
            map(cmd.x ?? 0, cmd.y ?? 0),
          )
          break
        case 'Z':
          emitter.close()
          break
      }
    }
    width = Math.max(width, slot.x)
  }

  return { path: emitter.toPathData(), naturalWidth: width }
}

/**
 * Emits path data, optionally displacing every point through a warp field.
 *
 * Bézier control points are warped along with the on-curve points. For the
 * boundary field that is exact enough to be invisible — it varies over the
 * whole width of the shape, which is very low frequency next to a glyph — and
 * it keeps the emitted path compact, which matters because animation will
 * re-evaluate this per frame. Wave and noise can vary within a single glyph, so
 * those subdivide curves into short segments first and emit polylines, where
 * the field is locally near-linear.
 *
 * STRAIGHT segments are subdivided too, which is not an optimisation but a
 * correctness requirement. A warp only moves the points it is given, so a
 * straight run emitted as its two endpoints stays a straight chord no matter
 * how much the field curves between them. Letters built almost entirely from
 * long straight runs — E, F, H, L, T — therefore touched the boundary only at
 * their corners and cut across it everywhere else, while a round letter with
 * many on-curve points followed it closely. Splitting straight runs is what
 * makes deformation depend on the shape rather than on how many points the
 * typeface happened to spend on a letter.
 */
function createEmitter(warp: WarpFn | undefined, subdivide: boolean, maxSegment: number) {
  const out: string[] = []
  let current: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = { x: 0, y: 0 }

  const apply = (p: Vec2): Vec2 => (warp ? warp(p.x, p.y) : p)

  const emit = (command: string, points: Vec2[]): void => {
    out.push(command + points.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' '))
  }

  /**
   * How many pieces a straight run has to be split into.
   *
   * Measured by HORIZONTAL extent for the boundary field: that field follows
   * the shape across x but is linear in y within a band, so a vertical stem
   * maps exactly and needs no splitting at all, while a horizontal arm needs a
   * lot. Wave and noise vary along both axes, so they count y as well.
   */
  const stepsFor = (a: Vec2, b: Vec2): number => {
    if (!warp || !(maxSegment > 0)) return 1
    const dx = Math.abs(b.x - a.x)
    const dy = subdivide ? Math.abs(b.y - a.y) : 0
    const extent = Math.max(dx, dy)
    if (!(extent > maxSegment)) return 1
    return Math.min(MAX_LINE_STEPS, Math.ceil(extent / maxSegment))
  }

  const straightTo = (from: Vec2, to: Vec2, includeEnd: boolean): void => {
    const steps = stepsFor(from, to)
    const last = includeEnd ? steps : steps - 1
    for (let i = 1; i <= last; i++) {
      const t = i / steps
      emit('L', [apply({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })])
    }
  }

  return {
    beginGlyph(): void {
      // Nothing to reset: contours are self-delimiting via M/Z.
    },
    moveTo(p: Vec2): void {
      current = p
      start = p
      emit('M', [apply(p)])
    },
    lineTo(p: Vec2): void {
      straightTo(current, p, true)
      current = p
    },
    quadTo(c: Vec2, p: Vec2): void {
      if (warp && subdivide) {
        for (let i = 1; i <= SUBDIVISIONS; i++) {
          emit('L', [apply(quadPoint(current, c, p, i / SUBDIVISIONS))])
        }
      } else {
        emit('Q', [apply(c), apply(p)])
      }
      current = p
    },
    cubicTo(c1: Vec2, c2: Vec2, p: Vec2): void {
      if (warp && subdivide) {
        for (let i = 1; i <= SUBDIVISIONS; i++) {
          emit('L', [apply(cubicPoint(current, c1, c2, p, i / SUBDIVISIONS))])
        }
      } else {
        emit('C', [apply(c1), apply(c2), apply(p)])
      }
      current = p
    },
    close(): void {
      // `Z` draws a straight segment back to the contour start, and that
      // segment is warped by its endpoints alone like any other — often the
      // full-width bottom edge of a letter. Walk it out first; `Z` then closes
      // over what is left.
      straightTo(current, start, false)
      out.push('Z')
      current = start
    },
    toPathData(): PathData {
      return out.join('')
    },
  }
}

function quadPoint(p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  }
}

function cubicPoint(p0: Vec2, c1: Vec2, c2: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  }
}


export interface RunLineOptions {
  fontId: string
  /** Slots along the strip, one per character. Scales are uniform for a run. */
  slots: readonly GlyphSlot[]
  characters: readonly string[]
  run: Run
  /** Strip coordinate where the run begins. */
  x0: number
  /** Lifts the type off its line, in object units. */
  baselineShift?: number
  /** Keeps letters vertical instead of turning them to follow the run. */
  upright?: boolean
  /**
   * How the shape is bending the plane this frame, if it is.
   *
   * Applied to the run BEFORE each letter is placed, and the heading is taken
   * from the moved run rather than the resting one — so a letter turns with the
   * shape instead of keeping the angle the shape used to have.
   */
  move?: (point: Vec2) => Vec2
  /**
   * How wide a chord the facing angle is taken over, in glyph advances.
   *
   * 1 is the letter's own width, which is what SVG specifies. Wider averages the
   * turn over its neighbours as well, which is not about where a letter SITS —
   * that never moves — but about how far its angle may differ from the letter
   * beside it.
   *
   * That difference is the whole of the problem on a drawn shape. Measured on
   * one: at the baseline every gap was a uniform 3.84 units, and at cap height,
   * 55 units up, the same gaps ran from -29 to +63. A pair leaning apart by a
   * couple of degrees opens a hole at the top; a pair leaning together closes
   * one and the letters cross.
   */
  turnSpan?: number
  /**
   * How far the words have moved along the run, in object units.
   *
   * Added where the run is READ, so the line travels bodily. Only a closed run
   * can carry it — an open one would walk its letters off the end, and past the
   * end every point lands on the same place.
   */
  travel?: number
  /**
   * What the frame is doing to the strip this moment, if anything.
   *
   * The SAME function packed letters are mapped through — `stripMotion` — asked
   * a different question. A packed letter is deformed by it, point by point. A
   * set letter cannot be: it keeps the shape it was drawn in, which is the whole
   * of what Set means. So it is CARRIED by it instead, and where it is carried
   * to is read at the letter's own anchor rather than at each of its points.
   *
   * Without this the strip presets did nothing at all to set type — and Set is
   * the default, so Wave, Boil, Sway and Sweep appeared broken in every run
   * mode while Bounce, Pop and Jitter worked, those three being the ones that
   * move the slots rather than the strip.
   */
  strip?: StripMove
}

/**
 * Set a line ALONG a run, one whole letter at a time.
 *
 * The type-on-path way, and a different thing from bending a strip onto a curve
 * even though both put letters on a path. Here each glyph is placed and turned
 * as a RIGID shape: the outline is moved and rotated, never reshaped. It cannot
 * shear, and — the reason this exists — it cannot fold.
 *
 * Bending the strip maps every point of every outline through the curve, which
 * is what gives spiral text its character: a letter splays as it travels, and
 * the splay is a property of the curve rather than anything computed. It also
 * means the curve can eat a letter. Where the run bends toward the type more
 * tightly than the type is tall, the mapping turns inside out, and on a drawn
 * outline that happens wherever the band is deeper than a bulge is wide — no
 * amount of easing fixes it, because the geometry really is folded there.
 *
 * A rigid letter has nothing to fold. It rotates around a corner and fans away
 * from its neighbours, which is what type on a path has always done.
 *
 * Each glyph is turned about its OWN MIDDLE rather than its left edge, so it
 * sits astride the curve instead of swinging off the end of it.
 */
export function renderRunLine(options: RunLineOptions): GlyphRun {
  const font = getLoadedFont(options.fontId)
  if (!font) throw new Error(`Font not loaded: ${options.fontId}`)

  // No warp and no subdivision: the outline is emitted exactly as drawn, curves
  // and all, because nothing is bending it.
  const emitter = createEmitter(undefined, false, 0)
  const shift = options.baselineShift ?? 0
  let width = 0

  for (const slot of options.slots) {
    if (slot.blank) continue
    const char = options.characters[slot.index]
    if (char === undefined) continue

    const glyph = font.charToGlyph(char)
    if (!glyph) continue

    // Per em, not in font units: `getPath(0, 0, 1)` hands back an outline at
    // size 1 while `advanceWidth` stays in the font's own grid, and mixing the
    // two puts every letter a couple of thousand ems along the run.
    const advance = ((glyph.advanceWidth ?? 0) / font.unitsPerEm) * slot.scaleX

    /*
     * Where this letter is carried to, and how far the strip is turning under it.
     *
     * The strip deformation is a map of the plane, so at any point it has a
     * local displacement and a local change of direction. A packed letter takes
     * both by being mapped through it. A rigid one takes the displacement as a
     * move and the direction as a TURN — the rotation nearest to what the strip
     * is doing there, which is the only part of a deformation a shape that may
     * not be reshaped can follow.
     *
     * Nearest in the polar sense: for a Jacobian [[a,b],[c,d]] that is
     * `atan2(c - b, a + d)`. One expression, and it is the reason no preset
     * needs a case of its own here. A ripple tilts the baseline and the letters
     * tilt with it; a lean shears the plane sideways and the letters lean; a
     * shimmer moves them without turning them, because it barely turns the
     * plane at all.
     */
    const strip = options.strip
    const anchorX = slot.x + advance / 2
    const anchorY = slot.baselineY - shift
    const carried = strip ? strip(anchorX, anchorY) : { x: anchorX, y: anchorY }
    const lean = strip ? stripTurn(strip, anchorX, anchorY, Math.max(advance, 1e-3)) : 0

    const middle = carried.x
    /*
     * Where this letter sits along the run, wrapped when it is travelling.
     *
     * A closed run wraps by itself — `runAt` takes the modulo. A run with two
     * ends does not, so a travelling letter would walk off one end and be gone;
     * wrapping here sends it back to the beginning instead, which is what makes
     * the loop close. It jumps rather than slides at the seam, and that is what
     * a marquee does: the two ends of a line are not near each other.
     *
     * Only when travelling. A letter placed off the end of a STILL run is a
     * letter the fit could not place, and the guard below is right to drop it.
     */
    const travel = options.travel ?? 0
    const raw = middle - options.x0 + travel
    const total = options.run.total
    const at =
      travel !== 0 && !options.run.closed && total > 0
        ? ((raw % total) + total) % total
        : raw

    /*
     * Where the glyph SITS is its midpoint on the run; which way it FACES comes
     * from the chord between the two ends of its own advance.
     *
     * The chord, not the tangent under the midpoint. This is the rule SVG
     * specifies for text on a path — the glyph's midline is perpendicular to the
     * line through its startpoint-on-the-path and its endpoint-on-the-path — and
     * it is the one that lets a letter turn a sharp corner. Sampling the tangent
     * at one point reads the curvature exactly where it is worst and swings the
     * whole letter by it; the chord averages the turn over the letter's own
     * width, which is the distance the letter actually has to cover. Most
     * browsers use the midpoint tangent and are known to handle right-angle
     * corners worse than the spec's rule for exactly this reason.
     */
    const half = (advance / 2) * (options.turnSpan ?? 1)
    const move = options.move
    const centre = runAt(options.run, at).point
    const from = runAt(options.run, at - half).point
    const to = runAt(options.run, at + half).point
    const point = move ? move(centre) : centre
    const a = move ? move(from) : from
    const b = move ? move(to) : to
    const span = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const tangent = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
    // The readable normal: the heading turned so that it points away from the
    // middle of the shape at the top of a clockwise lap.
    const nx = tangent.y
    const ny = -tangent.x

    /*
     * A glyph whose middle falls off the end of an open run is not drawn.
     *
     * The rule SVG gives for text on a path, and the right one: `runAt` clamps
     * at the ends of an open run, so a letter pushed past one does not stop
     * there — every point of it lands on the same spot and it collapses to a
     * spike. A closed lap has no ends to fall off, and comes round instead.
     */
    if (!options.run.closed && (at < 0 || at > total)) continue

    const turnCos = Math.cos(lean)
    const turnSin = Math.sin(lean)

    const map = (gx: number, gy: number): Vec2 => {
      /*
       * The point relative to the letter's own anchor, turned, then put back.
       *
       * Relative FIRST and absolute again at the end, which is the part worth
       * being careful about: `off` is measured from the run's line, not from the
       * letter, so the anchor's own height has to come back at the end or the
       * slot's baseline cancels out — and that baseline is exactly what Bounce
       * and Jitter move.
       */
      const localAlong = slot.x + gx * slot.scaleX - anchorX
      const localOff = slot.baselineY + gy * slot.scaleY - shift - anchorY
      const along = localAlong * turnCos - localOff * turnSin
      const off = carried.y + (localAlong * turnSin + localOff * turnCos)
      if (options.upright) return { x: point.x + along, y: point.y + off }
      // Along the run, and off it: `off` is measured downward, and the normal
      // points up out of the run, so it subtracts.
      return {
        x: point.x + tangent.x * along - nx * off,
        y: point.y + tangent.y * along - ny * off,
      }
    }

    for (const cmd of glyph.getPath(0, 0, 1).commands) {
      switch (cmd.type) {
        case 'M':
          emitter.moveTo(map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'L':
          emitter.lineTo(map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'Q':
          emitter.quadTo(map(cmd.x1 ?? 0, cmd.y1 ?? 0), map(cmd.x ?? 0, cmd.y ?? 0))
          break
        case 'C':
          emitter.cubicTo(
            map(cmd.x1 ?? 0, cmd.y1 ?? 0),
            map(cmd.x2 ?? 0, cmd.y2 ?? 0),
            map(cmd.x ?? 0, cmd.y ?? 0),
          )
          break
        case 'Z':
          emitter.close()
          break
      }
    }
    width = Math.max(width, slot.x + advance)
  }

  return { path: emitter.toPathData(), naturalWidth: width }
}

/**
 * The rotation nearest to what a strip deformation does at one point.
 *
 * Estimated from the Jacobian by finite difference over the letter's own width,
 * which is the distance the letter actually spans — a derivative taken over a
 * hair would report the deformation at a point rather than across the shape that
 * has to follow it.
 */
function stripTurn(strip: StripMove, x: number, y: number, span: number): number {
  const h = span / 2
  const at = strip(x, y)
  const alongX = (strip(x + h, y).x - at.x) / h
  const alongY = (strip(x + h, y).y - at.y) / h
  const offX = (strip(x, y + h).x - at.x) / h
  const offY = (strip(x, y + h).y - at.y) / h
  // [[alongX, offX], [alongY, offY]] as [[a, b], [c, d]].
  const turn = Math.atan2(alongY - offX, alongX + offY)
  return Number.isFinite(turn) ? turn : 0
}
