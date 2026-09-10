import { buildPatch } from '../geometry/patch'
import type { Run } from '../geometry/run'
import { MIN_FONT_SIZE, MIN_LINE_HEIGHT, type DistortionSettings } from '../types/document'
import { clamp } from '../utils/math'
import { STATIC_FRAME } from './animation'
import type { FitOptions, FitOutcome, FittedLine } from './fit'
import {
  renderBandFrame,
  renderFrame,
  renderRibbon,
  type FittedLayout,
  type LayoutLine,
} from './frame'
import { measureInkExtent, measureUnitWidth, unitMetrics } from './fontRegistry'
import { verifyExactText } from './invariant'
import {
  packLine,
  packedUnitWidth,
  setLine,
  type GlyphSlot,
  type SetOptions,
} from './packLine'

/**
 * Fitting text along a run.
 *
 * A lap around a shape and a spiral into it are the same fit. Both measure the
 * ink, work out how far off the outline the type has to sit, then search for the
 * one size at which the words fill the run they themselves create — a lap gets
 * SHORTER as the type grows, because bigger type sits further in; a spiral gets
 * LONGER as the type shrinks, because smaller type means more turns. Opposite
 * directions, one bisection.
 *
 * They were written twice, and it cost: 117 identical lines, a dead option that
 * survived in one copy, and a band that could sit outside the outline in one
 * mode but not the other for no reason anyone chose. Every change to the band
 * arithmetic this feature has had was made in two places.
 *
 * What genuinely differs is gathered in `RunSource` — five small questions about
 * one kind of run. Everything else lives here once.
 *
 * The text is laid down ONCE, as everywhere else in this tool. A short line
 * around a large shape comes out wide rather than repeated.
 */

/** Where the search starts and stops, in object units per em. */
export const MIN_SIZE = 2
export const MAX_SIZE = 600
/** Enough halvings to land within a fraction of a unit across that range. */
export const SEARCH_STEPS = 34

/**
 * How wide a corner is eased, as a multiple of the type's own height.
 *
 * Against the type rather than against the pitch. A corner shears a letter by
 * its height times the angle the run turns through while crossing it, so the
 * height is the term that decides whether a corner is survivable — and the pitch
 * is a different question with a different answer at every line-spacing setting.
 */
export const CORNER_EASE = 5

/**
 * How much sharper than the shape itself a turn may be before the run stops.
 *
 * Offsetting an irregular outline inward eventually makes it self-intersect, and
 * the clipper leaves a cusp where the crossing was. A cusp is the only thing
 * this is meant to catch. See `spiral.ts` for the measurements behind the value.
 */
export const CUSP_MARGIN = 0.3

/**
 * How much wider than its natural proportions a letter may be stretched in
 * order to wind the run deeper into the shape.
 *
 * The packer fills whatever run it is given — characters are scaled into their
 * slots, they never run out — so a longer run does not drop text, it widens it.
 * Widening is therefore the only currency a deeper run can be bought with, and
 * this is the ceiling on the spend.
 *
 * Measured on an ellipse with a short line and the hole closed: at 1.4 the type
 * drops from 75 units to 54 and the run makes half again as many turns, with
 * the letters visibly extended but still reading as the face. At 1.8 the
 * innermost turns start to crowd and the wider letters read as bars; by 3 the
 * whole run is ribbons with no letters left in it.
 *
 * It is enforced HERE, on the space the packer is given, because that is the
 * only place it cannot be got round. It used to be a floor on the type size in
 * the spiral's depth scan, and a size floor is not a stretch ceiling at all: a
 * smaller size also buys a LONGER run, and the two compound. Measured on the
 * drawn blob the letters came out 1.9 times their designed width and on an
 * ellipse 2.4 — past the point the note above calls ribbons, and far enough
 * that the letters of one turn crossed into the next.
 *
 * The size search can overshoot it too, without any depth scan involved. When
 * the shape rather than the text decides the size — a big centre hole leaves
 * room for only the smallest type that can still wind twice — the run comes out
 * far longer than the words, and the packer fills whatever it is given. A hole
 * of 80% reached 6.6.
 *
 * So the packer is given the run only up to this, and past it the run is simply
 * left empty. That is what SET letters already do, and a run that stops where
 * its words stop reads better than one filled with ribbons.
 */
export const MAX_STRETCH = 1.4

/**
 * May the WORDS be carried bodily along this kind of run?
 *
 * One function because the answer is needed in two places that must not drift:
 * the fit, which decides whether a frame's travel reaches the letters, and the
 * panel, which decides whether to offer the preset at all. Offering a preset
 * the fit ignores is a control that does nothing, which reads as broken.
 *
 * Every run carries them — a lap, a spiral and a drawn line alike, whether the
 * letters are set or packed. The one refusal is a lap CUT OPEN at the side: the
 * words would travel out through the banner's opening onto bare shape.
 *
 * It used to take a third argument, for whether the letters were SET, because
 * travel was folded into the run as it was read and `runAt` clamps at the end of
 * an open one. That was never a fact about letters — it was a fact about where
 * the number was added. `carrySlots` moves the words a level up, where a letter
 * is still a letter rather than a stream of points, and the distinction went
 * away along with the argument.
 */
export function wordsCanTravel(closed: boolean, split = false): boolean {
  return closed ? !split : true
}

/** Everything a run source needs that comes out of the type, not the shape. */
export interface RunMetrics {
  characters: readonly string[]
  fontId: string
  /** How far the ink reaches above and below its baseline, per em. */
  ink: { top: number; bottom: number; height: number; width: number }
  /** The ink's height, per em, with a fallback for text that inks nothing. */
  inkHeight: number
  /** The banner's height, per em. `lineHeight` times the above. */
  bandHeight: number
  /**
   * What one line OCCUPIES: the band, or the letters, whichever is taller.
   *
   * A band shorter than the type is a deliberate look — a stripe through the
   * middle of the letters — and the letters still stand their full height
   * whatever is drawn behind them.
   */
  carriage: number
  /** The middle of the band, in the space glyphs are placed in. */
  bandMiddle: number
  /** How far in from the outline the run has to sit for the type to fit inside. */
  reach: number
  padding: number
  /** The baseline shift, in ems. */
  shift: number
  /** Letters set at their drawn widths rather than packed into the run. */
  rigid: boolean
  /** How long the text is at a given size, tracking included. */
  textWidth: (size: number) => number
  /**
   * What the packer would make it, per em, at the letters' natural proportions.
   *
   * A different sum from `textWidth`: the packer shares a line out by ink width
   * where the size search measures it in advances. The stretch ceiling has to be
   * in the packer's currency or it does not mean what it says.
   */
  packedWidth: number
  /** How far off the outline the run sits at a given size. */
  inset: (size: number) => number
  /**
   * The same, for a run that reaches a different distance.
   *
   * A run travelled BACKWARDS stands its type on the other side of itself, so a
   * lap placed for type reaching outward leaves that type reaching inward
   * instead — floating an ink height inside the shape with a bare margin around
   * it. Mirroring the reach about the band's own middle puts it back in the ring
   * it was meant to occupy.
   */
  insetFor: (reach: number, size: number) => number
}

/** A size and the run it produced, which the search carries around together. */
export interface Solved<R extends Run = Run> {
  size: number
  run: R
}

/**
 * The five things that differ between one kind of run and another.
 *
 * Deliberately small. Anything that can be shared is shared, and a hook here is
 * an admission that two runs really do need different arithmetic.
 */
export interface RunSource<R extends Run = Run> {
  /** What to say when the shape cannot hold this kind of run at any size. */
  noSpace: string
  /** The run at a given type size, or null when there is none to be had. */
  build(size: number, m: RunMetrics): R | null
  /** Does the text fit it? */
  fits(run: R, size: number, m: RunMetrics): boolean
  /**
   * Trade the solved size for a better run, if this kind of run has that choice.
   *
   * A spiral does: taking the type down tightens the pitch and wins turns, so
   * there is a deeper run to be had at a smaller size. A lap has nothing to
   * trade — one turn is one turn.
   */
  refine?(solved: Solved<R>, m: RunMetrics): Solved<R>
  /** Where along the run the words sit, and where leftover space goes. */
  place(run: R, size: number, m: RunMetrics): { from: number; to: number; align?: SetOptions['align'] }
  /**
   * How much of the run the banner covers, when it does not cover all of it.
   *
   * Nothing means the whole run — which on a closed lap is an annulus, and on an
   * open one a strip from end to end.
   */
  bandRange?(
    run: R,
    size: number,
    m: RunMetrics,
    slots: readonly GlyphSlot[],
    /** The stretch of run the words were actually given. */
    where: { from: number; to: number },
  ): { start?: number; end?: number }
  /** How finely a letter's straight strokes are split so they can bend. */
  maxSegment(run: R, size: number, m: RunMetrics): number
  /**
   * May the words be carried bodily round this run?
   *
   * Only where they can come back to where they started AND the banner goes the
   * whole way round with them. A spiral has two ends; a split lap is closed but
   * has a deliberate opening, and words travelling through it would come out on
   * bare shape while the banner stayed put.
   */
  travels?: boolean
}

/** What the caller passes in on top of the shared fitting options. */
export interface RunFitExtras {
  /** How far inside the drawn edge the run sits, before the band offset. */
  padding?: number
  /**
   * Where the band sits across the outline.
   *
   * 1 puts the type just inside it, 0 centres the type on it, -1 puts it
   * outside. Anything between is allowed; the number is a position, not a mode.
   */
  side?: number
  /** Keeps letters vertical instead of turning them to follow the run. */
  upright?: boolean
  /**
   * Set the letters at their drawn widths instead of packing them into the run.
   *
   * The two ways type can meet a curve. PACKED, each character is scaled
   * independently into its own slot and the letterforms carry the shape. SET,
   * they keep the proportions they were drawn at and the run decides only where
   * they sit and which way they face.
   */
  rigid?: boolean
  /** Lifts the type off its line, in ems. */
  baselineShift?: number
  /**
   * How tall the band the type travels in is, in ink heights.
   *
   * 1 is the letters' own height. Above that the band gains room around them,
   * and the run moves further inside the outline to keep it within the shape.
   */
  lineHeight?: number
  /** Draw the band as a filled path. Without it the number above is just leading. */
  band?: boolean
  /**
   * How big the type is, in object units per em. 0 asks for as big as fits.
   *
   * Capped at what the shape can hold, because past that there is nowhere for
   * the words to go. The ceiling is not arbitrary and it is not the same in both
   * modes: a lap SHORTENS as the type grows, since the band pushes further
   * inside the outline, and a spiral loses whole turns, since the pitch is the
   * line height and wider letters push the turns apart until there is nothing
   * left to wind into. Measured on a 700x620 ellipse with one line: 40 units
   * winds four turns, 60 winds two, 67 winds one, and at 90 no spiral exists at
   * all. More loops come from SMALLER type, not bigger.
   *
   * Below the ceiling the words simply cover less of the run. What is left over
   * is not drawn: the run itself is never inked, so a run longer than its words
   * is invisible, and the banner stops where they do.
   */
  fontSize?: number
}

/**
 * Fit the text along one run, whatever kind of run it is.
 *
 * The whole shape of it: measure the ink once, bisect for the size at which the
 * words fill the run they make, place them, and draw. The bisection is not a
 * formula because a run's length is not a smooth function of the size — an
 * offset can collapse, a turn can appear, all at once — so there is nothing to
 * differentiate. It is monotonic enough for bisection, which is all bisection
 * asks.
 */
export function fitAlongRun<R extends Run>(
  options: FitOptions & RunFitExtras,
  makeSource: (m: RunMetrics) => RunSource<R>,
): FitOutcome {
  const { text, shapePath, fontId } = options

  let metrics: { ascender: number; descender: number; lineHeight: number }
  try {
    metrics = unitMetrics(fontId)
  } catch {
    return { ok: false, reason: 'font-not-loaded', message: 'Font is still loading.' }
  }

  const characters = [...text]
  if (characters.length === 0) {
    return { ok: false, reason: 'empty-text', message: 'Enter text to fill this shape.' }
  }

  const unitWidth = measureUnitWidth(fontId, text)
  if (!(unitWidth > 0)) {
    return { ok: false, reason: 'empty-text', message: 'Enter text to fill this shape.' }
  }

  /*
   * Everything below comes from the INK, not from the font's line box.
   *
   * The same reason `measureInkExtent` exists at all: Anton declares a line
   * height of 1.505em while a line of its capitals inks 0.73em of that. Spacing
   * by the declared figure left more than half the gap empty and forced the type
   * down to a third of the size it could have been.
   */
  const ink = measureInkExtent(fontId, text)
  const inkHeight = ink.height > 0 ? ink.height : metrics.lineHeight
  const lineHeight = Math.max(MIN_LINE_HEIGHT, options.lineHeight ?? 1)
  const bandHeight = inkHeight * lineHeight
  const carriage = Math.max(bandHeight, inkHeight)
  const padding = Math.max(0, options.padding ?? 0)
  const shift = options.baselineShift ?? 0
  const side = clamp(options.side ?? 1, -1, 1)
  const rigid = options.rigid === true

  /*
   * How far off the drawn edge the run sits, for a given type size.
   *
   * At `side` 1 the baseline is exactly the type's reach inside the outline, so
   * the capitals arrive at the edge and stop. The baseline shift belongs in it
   * too: moving the type off its line moves where the type ENDS, and left out, a
   * shift of -0.4em simply opened a second gap that nothing could close.
   *
   * Winding that back by half the carriage centres the band on the outline, and
   * by the whole of it puts the baseline on the outline with the type standing
   * outside. The clipper offsets outward on a negative inset, so the three cases
   * are one expression rather than three branches.
   */
  const bandMiddle = (ink.top + ink.bottom) / 2 - shift
  const reach = carriage / 2 - bandMiddle

  const m: RunMetrics = {
    characters,
    fontId,
    ink,
    inkHeight,
    bandHeight,
    carriage,
    bandMiddle,
    reach,
    padding,
    shift,
    rigid,
    textWidth: (size) =>
      unitWidth * size + options.letterSpacing * size * Math.max(0, characters.length - 1),
    packedWidth: packedUnitWidth(fontId, characters),
    inset: (size) => padding + (reach - ((1 - side) / 2) * carriage) * size,
    insetFor: (own, size) => padding + (own - ((1 - side) / 2) * carriage) * size,
  }

  const source = makeSource(m)

  let low = MIN_SIZE
  let high = MAX_SIZE
  let solved: Solved<R> | null = null

  for (let step = 0; step < SEARCH_STEPS; step++) {
    const size = (low + high) / 2
    const run = source.build(size, m)
    if (!run) {
      // Too big for the shape to hold a run at all: the only way is down.
      high = size
      continue
    }

    if (source.fits(run, size, m)) {
      low = size
      solved = { size, run }
    } else {
      high = size
    }
  }

  // Nothing fits: the shape cannot hold a run at any size we would set type at.
  // A small shape with heavy padding does this, and it is a legitimate state
  // rather than a fault.
  if (!solved) return { ok: false, reason: 'no-space', message: source.noSpace }

  const solvedRun = source.refine ? source.refine(solved, m) : solved

  /*
   * Taken down to the size that was asked for, and the run REBUILT at it.
   *
   * Not simply scaled: the run is built from the size — a spiral's pitch is the
   * line height, and how far off the outline a lap sits is the type's own reach
   * — so smaller type on the run it made at full size would sit wrong against
   * the outline and leave the turns further apart than the letters need.
   *
   * Asking for nothing, or for more than fits, leaves the solved size alone, so
   * the default is exactly what it was before there was a control.
   */
  const ceiling = solvedRun.size
  const chosen = options.fontSize ?? 0
  const wanted = chosen > 0 ? clamp(chosen, MIN_FONT_SIZE, ceiling) : ceiling

  let { size, run } = solvedRun
  if (wanted < ceiling) {
    const smaller = source.build(wanted, m)
    if (smaller) {
      size = wanted
      run = smaller
    }
  }

  /*
   * The container as a patch, when there is a container.
   *
   * A drawn LINE has none: no inside, no corners, no area. Nothing a run mode
   * draws goes through it anyway — the type is bent onto the run — so a null
   * one is a legitimate state rather than a failure, and only the shape presets
   * that deform a container notice.
   */
  const patch = buildPatch(shapePath)

  const bandTop = ink.top * size
  const bandBottom = ink.bottom * size
  const asked = source.place(run, size, m)
  /*
   * Packed letters fill whatever they are given, so what they are given is the
   * one place the stretch ceiling can be enforced. Set letters keep their drawn
   * widths and need no ceiling — they leave the run empty on their own.
   */
  const where = {
    ...asked,
    to: rigid
      ? asked.to
      : Math.min(asked.to, asked.from + m.packedWidth * size * MAX_STRETCH),
  }

  const slots = rigid
    ? setLine(characters, {
        fontId,
        size,
        letterSpacing: options.letterSpacing,
        from: where.from,
        to: where.to,
        ...(where.align ? { align: where.align } : {}),
      })
    : packLine(characters, {
        fontId,
        x0: where.from,
        x1: where.to,
        bandTop,
        bandBottom,
        gap: 0,
        letterSpacing: options.letterSpacing,
        // One long line, so the width variation that gives the row modes their
        // character would here make every letter a different size for no reason.
        // Text on a run gets its texture from the curve instead.
        variation: 0,
        verticalFill: 0,
        seed: options.seed ?? 0,
      })

  if (slots.length === 0) {
    return { ok: false, reason: 'no-space', message: 'Not enough space for text.' }
  }

  const line: LayoutLine = {
    characters,
    slots,
    bandTop,
    bandBottom,
    /*
     * The span is the WHOLE run, and the slots sit where they sit inside it.
     *
     * `renderRunLine` reads a slot's place on the run as `slot.x - span.x0`, so
     * a span that started at the margin cancelled the margin out again: the
     * words were laid out from the margin and then drawn from arc zero, and the
     * whole line sat half a gap round from where it was placed.
     */
    span: { x0: 0, x1: run.total, y: 0 },
    rowTop: 0,
    rowBottom: 1,
    run: {
      run,
      ...(source.travels ? { travels: true } : {}),
      ...(options.band
        ? {
            band: {
              from: (bandMiddle - bandHeight / 2) * size,
              to: (bandMiddle + bandHeight / 2) * size,
              ...(source.bandRange?.(run, size, m, slots, where) ?? {}),
            },
          }
        : {}),
      ...(rigid ? { rigid: true } : {}),
      ...(options.upright ? { upright: true } : {}),
      ...(shift ? { baselineShift: shift * size } : {}),
    },
  }

  const layout: FittedLayout = {
    patch,
    fontId,
    subdivide: true,
    // A letter bends as it travels, so its straight strokes have to be split
    // finely enough to bend with it.
    maxSegment: source.maxSegment(run, size, m),
    distortion: options.distortion ?? EMPTY_DISTORTION,
    seed: options.seed ?? 0,
    deformers: [],
    rowDeformers: [],
    lines: [line],
  }

  // The invariant, checked here as everywhere: one line holding exactly the text
  // that was typed. A run cannot wrap, so this can only fail if the packer
  // dropped something — which is precisely why it is worth asking.
  const check = verifyExactText(text, [characters.join('')], 'character')
  if (!check.ok) {
    return { ok: false, reason: 'invariant-violated', message: check.detail }
  }

  const path = renderFrame(layout, STATIC_FRAME)
  const band = renderBandFrame(layout)
  // Cut into slices as well, for a run that crosses itself. The two whole paths
  // above are still what the still artwork IS; these are how it is laid down.
  const ribbon = band ? renderRibbon(layout, STATIC_FRAME) : []

  const fitted: FittedLine = {
    text,
    path: '',
    y: 0,
    size,
    horizontalScale: 1,
    span: line.span,
    rowTop: 0,
    rowBottom: 1,
  }

  return {
    ok: true,
    lines: [fitted],
    path,
    ...(band ? { band } : {}),
    ...(ribbon.length > 0 ? { ribbon } : {}),
    // What the type COULD be, so a control can offer the whole range and no
    // more. It moves as the text is edited and as the shape is resized, which is
    // the honest answer to wanting bigger type: make the shape bigger.
    autoSize: ceiling,
    extremeDistortion: false,
    lineCount: 1,
    layout,
  }
}

const EMPTY_DISTORTION: DistortionSettings = {
  boundaryInfluence: 0,
  horizontal: 0,
  vertical: 0,
  waveAmount: 0,
  waveFrequency: 0,
  shear: 0,
  noiseAmount: 0,
  noiseScale: 0,
  glyphScaleVariation: 0,
  glyphRotation: 0,
}
