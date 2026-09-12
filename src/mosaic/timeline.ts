import {
  authoredTimeFor as authoredTimeAt,
  authoredDuration as totalDuration,
  momentAt,
  playbackDuration as watchedDuration,
  segmentsOf as segmentsOfStates,
} from '../anim/timeline'
export { formatDuration } from '../anim/timeline'
import { ease } from '../anim/easing'
import { contentBounds, layoutMosaic } from './layout'
import { blendColour, mixColours } from '../typography/colour'
import { blendStroke } from '../geometry/stroke'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'
import type { FontSettings, LetterMosaicObject, PositionedStroke } from '../types/document'
import type {
  Coordinate,
  MosaicCorners,
  MosaicSpacing,
  MosaicState,
  MosaicTileLayout,
} from '../types/mosaic'
import {
  MOSAIC_DEFAULT_CORNERS,
  MOSAIC_DEFAULT_SPACING,
  MOSAIC_MIN_TRANSITION_MS,
} from '../types/mosaic'

/** Answers for a mosaic with no states at all, which nothing should produce. */
const FALLBACK_FONT: FontSettings = { fontId: 'anton', weight: 400, italic: false }

/**
 * Where a mosaic is at a given moment, worked out and never written down.
 *
 * One evaluator, shared by the live preview and by whatever exports frames
 * later, so the two cannot drift apart. It is pure: it reads the object and
 * returns a picture of it, and touches neither the document nor the canvas.
 *
 * The time it takes is AUTHORED time — the timeline as written, before playback
 * speed. Speed belongs to the thing driving the clock, which converts
 * `authored = elapsed * speed` before asking. Keeping it out here means the
 * evaluator has one unambiguous time domain: a test that asks for the midpoint
 * of a transition asks for the same number whatever the speed happens to be, and
 * an export that samples authored time gets the artwork rather than the rate
 * somebody last left the preview at.
 */

export interface EvaluatedMosaicFrame {
  /** The state being shown, or the one being transitioned OUT of. */
  stateIndex: number
  /** Where it is going, or null on a final state that has nowhere to go. */
  nextStateIndex: number | null
  segment: 'hold' | 'transition'
  /** Milliseconds into the current segment. */
  localTime: number
  /** Position through the current segment, 0 to 1. */
  progress: number
  /**
   * The eased position, which is what the geometry actually blends by.
   *
   * Zero throughout a hold: a held state is itself, not a blend of itself with
   * anything.
   */
  easedProgress: number
  /** Every line's value at this moment. Both axes; coordinate ids are unique. */
  coordinateValues: Record<string, number>
  /** Gap, padding and inset at this moment — all three interpolate. */
  spacing: MosaicSpacing
  /**
   * How the rectangles are rounded at this moment. Both radii interpolate.
   *
   * Paint only, so unlike the coordinates they carry no legality argument: a
   * radius cannot make a layout illegal, and is clamped to the rectangle it is
   * drawn on when it is drawn.
   */
  corners: MosaicCorners
  /**
   * The typeface at this moment.
   *
   * Not interpolated: two typefaces' outlines are different shapes, not two
   * positions of one shape. It is the font of the state being LEFT, which means
   * the cut lands on arrival — the letters change the instant the movement
   * finishes, rather than part-way through it.
   */
  font: FontSettings
  /**
   * That font as one string, which is how the canvas asks for it.
   *
   * Derived rather than compared field by field at sixty frames a second, and
   * derived HERE so the evaluator stays the single answer to "what does this
   * moment look like".
   */
  fontKey: string
  /**
   * What each tile shows at this moment, by tile id. Absent means empty.
   *
   * Not interpolated, for the same reason the font is not: two letters are
   * different shapes rather than two positions of one shape. So it is the
   * writing of the state being LEFT, and the change lands on arrival — the
   * letters hold still for the whole movement and cut the instant it finishes.
   */
  chars: Record<string, string>
  /**
   * What each tile's outline is, as one string, by tile id.
   *
   * Letter and typeface together, because both decide which outline is wanted
   * and the canvas has one of each cut in advance. Derived here so the evaluator
   * stays the single answer to "what does this moment look like", and so the
   * painter can compare one string instead of two fields per tile per frame.
   */
  glyphKeys: Record<string, string>
  /** The colour of each tile's letter at this moment, by tile id. */
  glyphColours: Record<string, string>
  /**
   * The colour behind each tile at this moment, by tile id.
   *
   * Null means no background at all, which is not the same as a transparent one
   * — a tile fading OUT is a colour at zero alpha, and a tile that was never
   * given a colour is nothing.
   */
  tileColours: Record<string, string | null>
  /**
   * Behind the whole mosaic at this moment, or null for no backdrop.
   *
   * Not part of `tileColours`: it belongs to the composition's box rather than
   * to any tile, and it is what fills the outer padding and the gaps.
   */
  background: string | null
  /**
   * The composition's own edge at this moment, or null for none.
   *
   * Blended like the backdrop: a border appearing or disappearing fades through
   * zero alpha at the width it has, rather than popping into existence at full
   * weight on the first frame of a transition.
   */
  stroke: PositionedStroke | null
  tileLayouts: Map<string, MosaicTileLayout>
}

/*
 * The shape of the timeline is not a mosaic's, and no longer lives here.
 *
 * `src/anim/timeline.ts` holds it: segments, the length, the wrap past the end,
 * and which segment a moment falls in. It only ever asked four things of a
 * state — how long it holds, how long it takes to leave, where it sits, and how
 * many there are — so it was never about mosaics.
 *
 * What stays here is what a mosaic state MEANS: the blending below. That is the
 * part that genuinely differs between one thing with states and the next.
 */
export type { Segment } from '../anim/timeline'

/** This mosaic's segments. The shape of them is `anim/timeline`'s. */
export const segmentsOf = (mosaic: LetterMosaicObject) =>
  segmentsOfStates(mosaic.states, MOSAIC_MIN_TRANSITION_MS)

/** The timeline's length in authored milliseconds, before playback speed. */
export const authoredDuration = (mosaic: LetterMosaicObject): number =>
  totalDuration(mosaic.states, MOSAIC_MIN_TRANSITION_MS)

/** How long it actually takes to watch, which is where speed comes in. */
export const playbackDuration = (mosaic: LetterMosaicObject): number =>
  watchedDuration(mosaic.states, mosaic.speed, MOSAIC_MIN_TRANSITION_MS)

/** Authored milliseconds for a moment of wall-clock playback. */
export const authoredTimeFor = (mosaic: LetterMosaicObject, elapsedWallMs: number): number =>
  authoredTimeAt(mosaic.speed, elapsedWallMs)

/**
 * Every line named by either state, blended by one shared factor.
 *
 * In ABSOLUTE units, not as fractions — which matters only when the outer
 * padding differs between the two states, and matters completely then.
 *
 * A tile's width in units is its coordinate difference times the content box's
 * size. Blend the fractions while the padding moves and that is a product of two
 * changing numbers: quadratic in time, so it can dip below the minimum in the
 * middle even though both ends are legal, and the guarantee this whole design
 * rests on would be gone. Blending `coordinate × size` instead makes a tile's
 * width linear in time again, so the minimum can only ever be at an end.
 *
 * With the padding held still the two are identical arithmetic — `size` is a
 * constant that multiplies straight back out — so nothing is paid for this in
 * the ordinary case.
 */
function blend(
  from: Record<string, Coordinate>,
  to: Record<string, Coordinate>,
  t: number,
  sizeFrom: number,
  sizeTo: number,
): Record<string, Coordinate> {
  const size = sizeFrom + (sizeTo - sizeFrom) * t
  const out: Record<string, Coordinate> = {}
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    /*
     * A line missing from one side holds still at the value the other gives it,
     * rather than sliding out of a zero. Normalisation at the load boundary is
     * meant to make this unreachable; it is here because a coordinate that
     * silently animated from nowhere would be very hard to see and very easy to
     * ship.
     */
    const a = (from[key] ?? to[key] ?? 0) * sizeFrom
    const b = (to[key] ?? from[key] ?? 0) * sizeTo
    const at = a + (b - a) * t
    out[key] = size > 0 ? at / size : (from[key] ?? to[key] ?? 0)
  }
  return out
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

export function blendColours(
  from: Record<string, string | null>,
  to: Record<string, string | null>,
  t: number,
  fallback: string | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    out[key] = blendColour(from[key] ?? fallback, to[key] ?? fallback, t)
  }
  return out
}

/** Glyph colours have a default rather than a null, so they never disappear. */
export function blendGlyphColours(
  from: Record<string, string>,
  to: Record<string, string>,
  t: number,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = from[key] ?? DEFAULT_GLYPH_COLOUR
    const b = to[key] ?? DEFAULT_GLYPH_COLOUR
    out[key] = t <= 0 ? a : t >= 1 ? b : mixColours(a, b, t)
  }
  return out
}

export function evaluateMosaicAtTime(
  mosaic: LetterMosaicObject,
  authoredTimeMs: number,
): EvaluatedMosaicFrame {
  const states = mosaic.states

  const spacingOf = (state: MosaicState): MosaicSpacing => ({
    gap: state.gap,
    outerPadding: state.outerPadding,
    glyphInset: state.glyphInset,
  })

  const cornersOf = (state: MosaicState): MosaicCorners => ({
    tileRadius: state.tileRadius,
    outerRadius: state.outerRadius,
  })

  const frameFor = (
    stateIndex: number,
    nextStateIndex: number | null,
    segment: 'hold' | 'transition',
    localTime: number,
    progress: number,
    easedProgress: number,
    x: Record<string, Coordinate>,
    y: Record<string, Coordinate>,
    spacing: MosaicSpacing,
    corners: MosaicCorners,
    chars: Record<string, string>,
    font: FontSettings,
    glyphColours: Record<string, string>,
    tileColours: Record<string, string | null>,
    background: string | null,
    stroke: PositionedStroke | null,
  ): EvaluatedMosaicFrame => ({
    stateIndex,
    nextStateIndex,
    segment,
    localTime,
    progress,
    easedProgress,
    // Both axes in one record, which is unambiguous because coordinate ids are
    // minted globally unique rather than per axis.
    coordinateValues: { ...x, ...y },
    spacing,
    corners,
    font,
    fontKey: `${font.fontId}|${font.weight}|${font.italic ? 'i' : 'r'}`,
    chars,
    glyphKeys: Object.fromEntries(
      Object.entries(chars).map(([tile, char]) => [
        tile,
        `${char}|${font.fontId}|${font.weight}|${font.italic ? 'i' : 'r'}`,
      ]),
    ),
    glyphColours,
    tileColours,
    background,
    stroke,
    tileLayouts: layoutMosaic(mosaic.tiles, x, y, mosaic.localBounds, spacing),
  })

  const first = states[0]
  if (!first) {
    return frameFor(
      0,
      null,
      'hold',
      0,
      0,
      0,
      {},
      {},
      MOSAIC_DEFAULT_SPACING,
      MOSAIC_DEFAULT_CORNERS,
      {},
      FALLBACK_FONT,
      {},
      {},
      null,
      null,
    )
  }

  const time = Number.isFinite(authoredTimeMs) ? authoredTimeMs : 0

  const resting = (state: MosaicState, index: number, next: number | null): EvaluatedMosaicFrame =>
    frameFor(
      index,
      next,
      'hold',
      0,
      next === null ? 1 : 0,
      0,
      state.x,
      state.y,
      spacingOf(state),
      cornersOf(state),
      state.chars,
      state.font,
      state.glyphColour,
      state.tileColour,
      state.background ?? null,
      state.stroke ?? null,
    )

  /*
   * Which segment this moment falls in, and how far through it — asked of
   * `anim/timeline`, which owns the wrap past the end and the walk. Everything
   * below is the part that is a mosaic's: what those two states MEAN together.
   */
  const moment = momentAt(states, time, MOSAIC_MIN_TRANSITION_MS)
  if (moment) {
    const from = states[moment.from] as MosaicState

    if (moment.kind === 'hold') {
      return frameFor(
        moment.from,
        moment.to,
        'hold',
        moment.localTime,
        moment.progress,
        0,
        from.x,
        from.y,
        spacingOf(from),
        cornersOf(from),
        from.chars,
        from.font,
        from.glyphColour,
        from.tileColour,
        from.background ?? null,
        from.stroke ?? null,
      )
    }

    const to = states[moment.to] as MosaicState
    /*
     * One curve for the whole transition, taken from the state being LEFT.
     *
     * It must not overshoot: a layout is legal when linear inequalities between
     * its coordinates hold, and a blend of two legal states is legal only while
     * the factor stays within 0..1. See `easing.ts`.
     */
    const e = ease(from.easing, moment.progress)

    // The content box moves with the padding, and the coordinates are blended
    // against it — see `blend`.
    const boxFrom = contentBounds(mosaic.localBounds, from.outerPadding)
    const boxTo = contentBounds(mosaic.localBounds, to.outerPadding)

    return frameFor(
      moment.from,
      moment.to,
      'transition',
      moment.localTime,
      moment.progress,
      e,
      blend(from.x, to.x, e, boxFrom.width, boxTo.width),
      blend(from.y, to.y, e, boxFrom.height, boxTo.height),
      {
        gap: mix(from.gap, to.gap, e),
        outerPadding: mix(from.outerPadding, to.outerPadding, e),
        glyphInset: mix(from.glyphInset, to.glyphInset, e),
      },
      {
        tileRadius: mix(from.tileRadius, to.tileRadius, e),
        outerRadius: mix(from.outerRadius, to.outerRadius, e),
      },
      // The writing and the font of the state being LEFT: both cut on arrival.
      from.chars,
      from.font,
      blendGlyphColours(from.glyphColour, to.glyphColour, e),
      blendColours(from.tileColour, to.tileColour, e, null),
      blendColour(from.background ?? null, to.background ?? null, e),
      blendStroke(from.stroke ?? null, to.stroke ?? null, e),
    )
  }

  /*
   * No moment at all, which means no states — `momentAt` answers for every
   * other case including a timeline of nothing but zero-length segments. A
   * mosaic with no states has no composition, so the first one, resting, is
   * all there is to say.
   */
  return resting(first, 0, null)
}
