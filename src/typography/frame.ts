import type { OutlinePatch } from '../geometry/patch'
import { ribbonPath, type BandDrift, type BandSpan, type Run } from '../geometry/run'
import type { DistortionSettings, GridDivider, PathData, Vec2 } from '../types/document'
import type { Span } from '../types/geometry'
import type { AnimationFrame } from './animation'
import { measureInkExtent } from './fontRegistry'
import { renderPackedLine, renderRunLine } from './glyphs'
import type { GlyphSlot } from './packLine'
import { createRunWarp, stripMotion, type RunMotion } from './runWarp'
import { createWarpField } from './warp'

/**
 * A solved layout, held so it can be drawn again at a different moment.
 *
 * The fit does two quite separate jobs: it SOLVES — wrapping the text into
 * rows, choosing sizes, packing characters into slots — and then it EMITS glyph
 * outlines through the warp field. Animation needs the first done once and the
 * second done per frame.
 *
 * That is not only about speed, though a full solve is ~130ms and could never
 * run at frame rate. It is about correctness: re-solving every frame lets the line
 * breaks change, and words would visibly jump between rows part-way through a
 * loop. Freezing the solution is what guarantees a loop shows the same words in
 * the same places throughout.
 */

export interface LayoutLine {
  characters: string[]
  slots: GlyphSlot[]
  bandTop: number
  bandBottom: number
  span: Span
  rowTop: number
  rowBottom: number
  /** Row boundaries from a manual grid, already offset by the row padding. */
  boundaryTop?: (u: number) => number
  boundaryBottom?: (u: number) => number
  /**
   * Set when this line is drawn along a RUN rather than through the patch.
   *
   * Per line rather than per layout, which is what lets a badge exist: its top
   * arc and its bottom arc are two lines with a run each, travelled in opposite
   * directions. A spiral is the same structure with one line in it.
   */
  run?: RunLayout
}

/** Everything a line set along a run needs to be drawn again. */
export interface RunLayout {
  run: Run
  /**
   * Set the letters ALONG the run rather than bending the strip onto it.
   *
   * A ring sets type the way a type-on-path tool does: each glyph moved and
   * turned as a rigid shape, never reshaped. A spiral bends the whole strip,
   * which is where its character comes from — a letter splays as it travels —
   * and also where a curve tighter than the type is tall turns letters inside
   * out. A rigid letter has nothing to fold.
   */
  rigid?: boolean
  /**
   * The words may be carried bodily round this run. See `RunSource.travels`.
   *
   * Decided by the fit rather than read off the run here, so the engine and the
   * preset picker agree about where the Travel preset applies.
   */
  travels?: boolean
  upright?: boolean
  /** Already in object units — the fit multiplied the em setting by the size. */
  baselineShift?: number
  /**
   * The banner this line travels in, if it has one.
   *
   * Offsets in the same space the glyphs are placed in, so the band and the
   * letters inside it are drawn from one description and cannot drift apart.
   */
  band?: BandSpan
}

export interface FittedLayout {
  /**
   * The container as a Coons patch, or null when there is no container.
   *
   * A drawn LINE has none. The patch describes the inside of a closed outline —
   * four edges and four corners — and a line has no inside, no corners and no
   * area. Nothing a run mode draws goes through it anyway: the type is bent onto
   * the run, and the patch is only there for the row modes and for the shape
   * presets that deform the container.
   */
  patch: OutlinePatch | null
  fontId: string
  subdivide: boolean
  maxSegment: number
  distortion: DistortionSettings
  seed: number
  /** Vertical deformers at rest — how WIDE the type is. A frame may shift them. */
  deformers: readonly GridDivider[]
  /** Horizontal deformers at rest — how TALL the type is. */
  rowDeformers: readonly GridDivider[]
  lines: LayoutLine[]
}

/**
 * What a line is doing this frame.
 *
 * A function of the line rather than one frame for the whole block, because
 * every preset carries a line offset: each line runs a little behind the one
 * above, so a wave travels DOWN the type instead of the whole block moving as
 * one rigid slab.
 */
export type FrameFor = (line: number, lineCount: number) => AnimationFrame

/**
 * Draw a frozen layout at one moment of the loop.
 *
 * Only the warp is rebuilt: the slots, the spans and the row bands are exactly
 * as they were solved, so the same characters stay in the same rows at the same
 * sizes and only their deformation changes.
 */
/**
 * The banner under the type, for the same frame.
 *
 * Separate from `renderFrame` rather than folded into it because it is a
 * separate FILL: the band is its own colour behind the letters, so it has to
 * reach the canvas as its own path. It takes the same frame and the same `move`,
 * which is what keeps the two in step while the shape is animating.
 *
 * Only lines set along a run have one. A row of text in a shape has a band in
 * the layout sense — `bandTop`/`bandBottom` — but nothing to draw it along.
 */
export function renderBandFrame(
  layout: FittedLayout,
  /** The moment of the loop. Omitted, the resting banner. */
  frame: AnimationFrame | FrameFor = STILL,
  move?: (point: Vec2) => Vec2,
): PathData {
  const frameFor: FrameFor = typeof frame === 'function' ? frame : () => frame
  const parts: string[] = []
  const count = layout.lines.length
  for (let row = 0; row < count; row++) {
    const line = layout.lines[row]
    const settings = line?.run
    if (!line || !settings?.band) continue
    const drawn = ribbonPath(
      settings.run,
      settings.band,
      move,
      bandDrift(layout, line, frameFor(row, count)),
    )
    if (drawn.length > 0) parts.push(drawn)
  }
  return parts.join('')
}

/** Nothing happening: the artwork as it was solved. */
const STILL: AnimationFrame = { distortion: {}, phase: 0, deformerShift: 0, travel: 0 }

/**
 * How this moment is displacing the banner, in the band's own terms.
 *
 * The banner is part of the strip, not a separate thing drawn near it — the
 * letters sit IN it — so the deformation a preset applies to the strip has to
 * reach it too. Reusing `stripMotion` rather than approximating it is what makes
 * that true rather than nearly true: the band edge and the letter standing on it
 * are displaced by one function evaluated at the same place.
 *
 * Deformation only. A banner is never carried ALONG its run — one that leaves
 * the words it belongs to has stopped being their background — so `travel` is
 * not read here, and the presets that carry a line bodily are not offered for a
 * banner at all.
 *
 * Without this the banner was drawn from the resting run under every preset, and
 * the words rippled straight out of their own background.
 */
function bandDrift(
  layout: FittedLayout,
  line: LayoutLine,
  moment: AnimationFrame,
): BandDrift | undefined {
  const motion = spiralMotion(layout, line, moment)
  /*
   * Carried bodily along the run, which is the banner's own version of Travel.
   *
   * Allowed on a CLOSED run and nowhere else, for the reason the words have the
   * same rule: a band slid along a run with two ends leaves one of them, and
   * `runAt` clamps there, so it would pile up at the end rather than loop. A lap
   * has no ends and comes round instead.
   *
   * Note what this does NOT ask: whether the WORDS may travel. They may not on a
   * split lap — they would come out of the banner's opening onto bare shape —
   * but the banner sliding round under type that stays put is exactly what that
   * opening makes visible, and is one of the two things a separate banner menu
   * is for.
   */
  if (!motion) return undefined

  const strip = stripMotion(motion)
  const x0 = line.span.x0
  /*
   * The band's offset and the strip's height are the same number: `ribbonPath`
   * puts an edge at `point - n * off` and the warp puts a glyph point at
   * `point - n * y`. So the two only differ by where the run begins.
   */
  return (arc, off) => {
    const moved = strip(arc + x0, off)
    return { arc: moved.x - x0, off: moved.y }
  }
}

/** One stretch of the ribbon: the banner under it, and the words on it. */
export interface RibbonSlice {
  band: PathData
  text: PathData
  /** The stretch of run the banner covers, in arc length. */
  from: number
  to: number
  /** The slots this slice draws, by index. Every slot is in exactly one slice. */
  first: number
  last: number
}

/**
 * How long a slice of ribbon is, as a multiple of how wide it is.
 *
 * Short enough that a slice does not lie across itself — which is the one thing
 * ordering cannot fix, because within a slice the banner and the words are drawn
 * once each. Long enough that a run of ordinary text is a few dozen slices and
 * not a few hundred.
 */
const SLICE_ASPECT = 1.5

/**
 * The ribbon, cut into pieces and handed back in the order it is travelled.
 *
 * A run that crosses itself has to be painted like a ribbon: where it passes
 * over its own earlier self, the banner covers what is underneath, words and
 * all. Drawn as two whole paths — the banner, then every word on top of it — it
 * cannot: the words from the first pass show through the banner of the second,
 * which reads as two flat layers rather than one strip of material.
 *
 * So the banner and the words are cut into slices along the run and returned in
 * order, for the renderer to lay down alternately. Anywhere the ribbon does not
 * overlap itself the order makes no difference and the drawing is identical.
 *
 * Cut BETWEEN letters, never through one. A letter split across two slices would
 * have the second slice's banner painted over its own first half.
 */
export function renderRibbon(
  layout: FittedLayout,
  frame: AnimationFrame | FrameFor,
  /** The banner's own moment. Omitted, it takes the type's. */
  bannerFrame: AnimationFrame | FrameFor = frame,
  move?: (point: Vec2) => Vec2,
): RibbonSlice[] {
  const frameFor: FrameFor = typeof frame === 'function' ? frame : () => frame
  const bandFor: FrameFor =
    typeof bannerFrame === 'function' ? bannerFrame : () => bannerFrame
  const out: RibbonSlice[] = []
  const count = layout.lines.length

  for (let row = 0; row < count; row++) {
    const line = layout.lines[row]
    const settings = line?.run
    if (!line || !settings?.band) continue
    const moment = frameFor(row, count)
    const drift = bandDrift(layout, line, bandFor(row, count))

    const band = settings.band
    const height = Math.abs(band.to - band.from) || 1
    const step = height * SLICE_ASPECT
    const from = band.start ?? 0
    const to = band.end ?? settings.run.total

    const slots = line.slots
    let first = 0
    let edge = from
    for (let i = 0; i < slots.length; i++) {
      const next = slots[i + 1]
      /*
       * The cut goes where the NEXT letter starts, which is where this one ends.
       *
       * Cutting at this letter's own start instead leaves its far half outside
       * the slice that draws it, and the following slice's banner paints over
       * that half — letters came out with their tails bitten off, one at every
       * boundary.
       */
      const boundary = next ? next.x - line.span.x0 : to
      if (next && boundary - edge < step) continue

      // A hair of overlap between neighbours: two filled shapes that merely abut
      // are antialiased twice and show a seam.
      out.push({
        band: ribbonPath(
          settings.run,
          { ...band, start: edge - SEAM, end: boundary + SEAM },
          move,
          drift,
        ),
        text: drawRunLine(layout, line, settings, moment, move, { first, last: i }),
        from: edge,
        to: boundary,
        first,
        last: i,
      })
      first = i + 1
      edge = boundary
    }
  }

  return out
}

/** Overlap between neighbouring slices, in object units. See above. */
const SEAM = 0.5

export function renderFrame(
  layout: FittedLayout,
  frame: AnimationFrame | FrameFor,
  /** The container as it is THIS frame. Omitted, the shape is holding still. */
  patch: OutlinePatch | null = layout.patch,
  /**
   * How the shape is bending the plane this frame, if it is.
   *
   * The patch cannot carry that information to a spiral — a spiral is not drawn
   * through the patch — so the bending itself is passed down and applied to the
   * run's own points. Without it a shape preset would move the container and
   * leave the type sitting where it was.
   */
  move?: (point: Vec2) => Vec2,
): PathData {
  const frameFor: FrameFor = typeof frame === 'function' ? frame : () => frame
  const parts: string[] = []
  const count = layout.lines.length

  for (let row = 0; row < count; row++) {
    const line = layout.lines[row]
    if (!line) continue
    const moment = frameFor(row, count)
    // Lines set along a run are drawn through it, not through the patch.
    if (line.run) {
      const drawn = drawRunLine(layout, line, line.run, moment, move)
      if (drawn.length > 0) parts.push(drawn)
      continue
    }
    // A row needs the patch to be warped through. A line has none, and has no
    // rows either — so there is nothing here to draw.
    if (!patch) continue
    const distortion: DistortionSettings = { ...layout.distortion, ...moment.distortion }
    const deformers = shiftDeformers(layout.deformers, moment.deformerShift)
    const warp = createWarpField({
      patch,
      bandTop: line.bandTop,
      bandBottom: line.bandBottom,
      bandLeft: line.span.x0,
      bandRight: line.span.x1,
      rowTop: line.rowTop,
      rowBottom: line.rowBottom,
      ...(line.boundaryTop ? { boundaryTop: line.boundaryTop } : {}),
      ...(line.boundaryBottom ? { boundaryBottom: line.boundaryBottom } : {}),
      ...(deformers.length > 0 ? { columnDeformers: deformers } : {}),
      // Not shifted: `deformerShift` is the Sweep preset's squeeze travelling
      // ACROSS the shape, which is the vertical deformers' axis.
      ...(layout.rowDeformers.length > 0 ? { rowDeformers: layout.rowDeformers } : {}),
      distortion,
      seed: layout.seed,
      phase: moment.phase,
    })

    const run = renderPackedLine({
      fontId: layout.fontId,
      slots: adjustSlots(layout.fontId, line, moment),
      characters: line.characters,
      warp,
      subdivide: layout.subdivide,
      maxSegment: layout.maxSegment,
    })
    if (run.path.length > 0) parts.push(run.path)
  }

  return parts.join('')
}

/**
 * How wide a chord a letter's facing angle is taken over, in its own advances.
 * See `RunLineOptions.turnSpan`.
 */
const TURN_SPAN = 4

/**
 * The same frame with any sideways letter offset held at zero.
 *
 * A spiral's slots are laid end to end with no gap — `fitSpiral` packs at
 * `gap: 0`, so the letters are already touching — and there is nowhere along the
 * run for one to move without running into its neighbours. Jitter is the only
 * preset that offers a sideways component, and on a spiral it slid the letters
 * far enough along the run to break the words apart while the type off to either
 * side stayed put. Off the line there is all the room in the world, so the shake
 * survives as a shimmer in and out; along it, there is none.
 *
 * The offset is also a share of `span`, and a spiral's span is the WHOLE run
 * rather than one row, so the same setting meant something different again on a
 * spiral with more turns. Both problems have the same answer here, but the
 * second is worth knowing about before allowing sideways motion back in.
 */
function alongRunHeld(frame: AnimationFrame): AnimationFrame {
  const offset = frame.letterOffset
  if (!offset) return frame
  return { ...frame, letterOffset: (index: number) => ({ x: 0, y: offset(index).y }) }
}

/**
 * What this frame is doing to the strip, or null when it is doing nothing.
 *
 * `deformerShift` becomes a slide along the run. A vertical deformer is a
 * block-layout idea — there are no rows on a spiral to push about — so the
 * preset that drives it, whose whole description is a squeeze travelling across
 * the shape and back, otherwise did nothing at all here.
 */
function spiralMotion(
  layout: FittedLayout,
  line: LayoutLine,
  frame: AnimationFrame,
): RunMotion | null {
  const d = frame.distortion
  const slide = frame.deformerShift
  const moves =
    slide !== 0 ||
    (d.shear ?? 0) !== 0 ||
    (d.waveAmount ?? 0) > 0 ||
    (d.noiseAmount ?? 0) > 0
  if (!moves) return null

  return {
    distortion: d,
    phase: frame.phase,
    seed: layout.seed,
    bandTop: line.bandTop,
    bandBottom: line.bandBottom,
    x0: line.span.x0,
    x1: line.span.x1,
    slide,
  }
}

/**
 * Carry the words along their run, by moving the SLOTS.
 *
 * Travel used to be added where the run is read — one number folded into the
 * warp and into the rigid placer, in two places with two sets of edge cases —
 * and that is why it only ever worked on a closed lap. On a run with two ends
 * `runAt` clamps, so a letter pushed past the end had every point of it land on
 * the same spot: packed letters smeared across the gap between the two ends and
 * rigid ones piled up at the last one.
 *
 * Moving the slots instead asks the question one level up, where a letter is
 * still a letter rather than a stream of points. A closed run needs nothing more
 * — the slots slide round and `runAt` wraps, which is exactly what folding the
 * number into the warp did, so nothing that already worked changes. A run with
 * two ends wraps the slot to wherever the letter fits WHOLE, and drops the one
 * letter at a time that would have to straddle the seam. That letter is missing
 * for the width of itself out of a whole lap; a smear across the artwork is not.
 */
function carrySlots(
  slots: readonly GlyphSlot[],
  run: Run,
  x0: number,
  travel: number,
): GlyphSlot[] {
  if (travel === 0) return slots as GlyphSlot[]
  // A closed run comes round by itself: shifting every slot by the same amount
  // is the whole of it, and `runAt` takes care of the seam.
  if (run.closed === true) return slots.map((slot) => ({ ...slot, x: slot.x + travel }))

  const total = run.total
  if (!(total > 0)) return slots as GlyphSlot[]

  return slots.map((slot, index) => {
    // How far this letter reaches, from where the next one starts.
    const next = slots[index + 1]
    const width = next ? Math.max(0, next.x - slot.x) : 0
    const along = slot.x - x0 + travel
    let at = ((along % total) + total) % total
    // Wrapped to whichever end it fits at, whole.
    if (at + width > total) at -= total
    // And dropped when it fits at neither, which is the moment it spans the seam.
    if (at < 0) return { ...slot, blank: true }
    return { ...slot, x: at + x0 }
  })
}

/**
 * Move and resize each character for this frame.
 *
 * Applied to the SLOTS rather than by re-packing: packing decides how the width
 * is shared out between characters, and that must not change from frame to
 * frame or the letters would jostle each other as well as move.
 *
 * Scaling is about each character's own INK centre, so a letter swells in place
 * rather than growing away from its slot's corner.
 */
function adjustSlots(fontId: string, line: LayoutLine, frame: AnimationFrame): GlyphSlot[] {
  const offset = frame.letterOffset
  const scale = frame.letterScale
  if (!offset && !scale) return line.slots

  const bandHeight = line.bandBottom - line.bandTop
  const bandWidth = line.span.x1 - line.span.x0

  return line.slots.map((slot) => {
    let next = slot

    if (scale) {
      const factor = scale(slot.index)
      if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
        const character = line.characters[slot.index]
        const ink = character ? measureInkExtent(fontId, character) : null
        if (ink && ink.width > 0) {
          const centreX = next.x + ((ink.left + ink.right) / 2) * next.scaleX
          const centreY = next.baselineY + ((ink.top + ink.bottom) / 2) * next.scaleY
          const scaleX = next.scaleX * factor
          const scaleY = next.scaleY * factor
          next = {
            ...next,
            scaleX,
            scaleY,
            x: centreX - ((ink.left + ink.right) / 2) * scaleX,
            baselineY: centreY - ((ink.top + ink.bottom) / 2) * scaleY,
          }
        }
      }
    }

    if (offset) {
      const shift = offset(slot.index)
      if (Number.isFinite(shift.x) && Number.isFinite(shift.y)) {
        next = {
          ...next,
          x: next.x + shift.x * bandWidth,
          baselineY: next.baselineY + shift.y * bandHeight,
        }
      }
    }

    return next
  })
}

/**
 * One deformer standing at the middle, used when the shape has none of its own.
 *
 * A deformer AT REST is the identity, so this changes nothing until something
 * moves it. It exists so a sweep works on any shape: needing to add a vertical
 * deformer by hand first would make the preset look broken to anyone who had not
 * discovered them, and a deformer is a mechanism rather than something the
 * effect should make you think about.
 */
const IMPLICIT_DEFORMER: readonly GridDivider[] = [
  {
    id: 'sweep',
    axis: 'column',
    points: [
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
  },
]

/** Slide every deformer along by the same amount, keeping them inside the shape. */
function shiftDeformers(
  own: readonly GridDivider[],
  shift: number,
): readonly GridDivider[] {
  if (!(Math.abs(shift) > 0)) return own
  const deformers = own.length > 0 ? own : IMPLICIT_DEFORMER
  return deformers.map((deformer) => ({
    ...deformer,
    points: deformer.points.map((point) => ({
      x: point.x,
      // A deformer's value is its position across the shape; the parameter runs
      // down it and is left alone.
      y: Math.min(0.99, Math.max(0.01, point.y + shift)),
    })),
  }))
}

/**
 * Draw the spiral's single line at one moment of the loop.
 *
 * Per-character offset and scale work here exactly as they do elsewhere — they
 * act on the slots, which the run knows nothing about. What does NOT carry over
 * is the distortion field: wave, noise and shear are terms of the patch warp,
 * and this line is not drawn through the patch. Spiral text has its own presets
 * for that reason.
 */
function drawRunLine(
  layout: FittedLayout,
  line: LayoutLine,
  settings: RunLayout,
  moment: AnimationFrame,
  move?: (point: Vec2) => Vec2,
  /** Draw only these slots, by index. Used to paint the ribbon in order. */
  only?: { first: number; last: number },
): PathData {
  /*
   * Only the FRAME's terms reach the spiral, never the layout's own.
   *
   * A frame is a delta — what this moment differs from the still artwork by —
   * and the still frame's is empty, so the artwork at rest comes out of this
   * byte for byte the same as `fitSpiral` drew it. The layout's distortion
   * settings are a boundary-warp control and are not offered in spiral mode;
   * folding them in here would silently deform every still spiral.
   */
  const motion = spiralMotion(layout, line, moment)

  /*
   * How far the words have travelled round, in object units.
   *
   * Only a CLOSED run carries it. On one with two ends the words would walk off
   * the end, and `runAt` clamps there — every point past it lands on the same
   * spot, which collapses a letter to a spike. A lap comes round again instead,
   * which is what lets this preset go one way and still close its loop.
   *
   * The banner does not take it, and that is the point: it is drawn from the
   * run itself, so it stays exactly where it is while the words move through it.
   */
  const travel = settings.travels ? (moment.travel ?? 0) * settings.run.total : 0

  const moved = carrySlots(
    adjustSlots(layout.fontId, line, alongRunHeld(moment)),
    settings.run,
    line.span.x0,
    travel,
  )
  const slots = only ? moved.slice(only.first, only.last + 1) : moved

  if (settings.rigid) {
    return renderRunLine({
      fontId: layout.fontId,
      slots,
      characters: line.characters,
      run: settings.run,
      x0: line.span.x0,
      turnSpan: TURN_SPAN,
      ...(settings.baselineShift ? { baselineShift: settings.baselineShift } : {}),
      ...(settings.upright ? { upright: settings.upright } : {}),
      ...(move ? { move } : {}),
      // The same deformation packed letters are mapped through, carrying rigid
      // ones instead of reshaping them. See `RunLineOptions.strip`.
      ...(motion ? { strip: stripMotion(motion) } : {}),
    }).path
  }

  const bend = createRunWarp({
    run: settings.run,
    x0: line.span.x0,
    baseline: 0,
    // How far the ink stands off its line, which is the stretch of run a single
    // letter is bent over.
    reach: Math.max(Math.abs(line.bandTop), Math.abs(line.bandBottom)),
    ...(settings.upright ? { upright: settings.upright } : {}),
    ...(settings.baselineShift ? { baselineShift: settings.baselineShift } : {}),
    ...(motion ? { motion } : {}),
  })

  // The shape's own motion, applied after the bend: the run is bent onto the
  // resting shape and the whole thing then moves with the container, so the
  // type keeps its place on the spiral however the shape is squashed.
  const warp = move ? (x: number, y: number): Vec2 => move(bend(x, y)) : bend

  return renderPackedLine({
    fontId: layout.fontId,
    slots,
    characters: line.characters,
    warp,
    subdivide: layout.subdivide,
    maxSegment: layout.maxSegment,
  }).path
}
