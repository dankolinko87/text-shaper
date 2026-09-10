import { clamp } from '../utils/math'
import { seededValue } from '../utils/rng'
import { measureInkExtent, measureUnitWidth } from './fontRegistry'

/**
 * Per-character packing: every character sized independently to fill its own
 * slot in the line.
 *
 * This is the difference between text set inside a shape and typography that
 * becomes the shape. Distributing surplus width as tracking leaves the letters
 * at their designed proportions with gaps between them — the result still reads
 * as a line of type with loose spacing. Here each character is given a slot and
 * scaled, independently in x and y, to occupy it. Characters end up at wildly
 * different widths and heights, which is the point: the letterforms themselves
 * carry the shape.
 *
 * Slots are laid end to end and never overlap, so characters can be packed hard
 * against one another without ever colliding.
 */

export interface PackOptions {
  fontId: string
  /** Horizontal extent the line must fill. */
  x0: number
  x1: number
  /** Vertical extent the line must fill. */
  bandTop: number
  bandBottom: number
  /**
   * Gap between adjacent characters, as a fraction of the average slot width.
   * Keeps letters from touching however hard they are packed.
   */
  gap: number
  /**
   * Letter spacing in em, added to (or taken off) every gap.
   *
   * Packed characters have no single type size to measure an em against — each
   * one is scaled independently — so the band height stands in for it. That
   * makes a given setting mean the same thing whether the line is 20 units tall
   * or 400. Negative values tighten, down to letters touching.
   */
  letterSpacing: number
  /**
   * How unevenly width is shared out, 0..1.
   *
   * At 0 every character gets width in proportion to its natural design width,
   * so the line reads evenly. Raising it pushes the distribution towards equal
   * slots and then past them into seeded per-character variation, so letters
   * start to fight each other for room.
   */
  variation: number
  /**
   * How completely each character fills its band vertically, 0..1.
   *
   * At 0 characters keep one shared height and only their widths differ. At 1
   * every character is stretched to the full band height, so an `o` and a `T`
   * both span it and the line becomes a solid mass of letterforms.
   */
  verticalFill: number
  seed: number
}

export interface GlyphSlot {
  /** Index into the string's glyph list. */
  index: number
  /** Left edge of the drawn glyph. */
  x: number
  /** Baseline for this character. */
  baselineY: number
  scaleX: number
  scaleY: number
  /** Blank glyphs (spaces) hold their slot but draw nothing. */
  blank: boolean
}

/** Spaces get a narrow share: room spent on them is room not spent on letters. */
const BLANK_WEIGHT = 0.35
/** How far width variation may swing a character's share, at full strength. */
const VARIATION_RANGE = 2.6
/**
 * Never scale a glyph beyond these, so geometry cannot explode or invert.
 *
 * These are in OBJECT UNITS PER EM, because outlines are generated at size 1 and
 * scaled here — so a value of 200 means roughly a 200px character, not 200x its
 * design size. Bounds sized for the latter capped every character at a third of
 * its slot and left the line full of gaps.
 */
const MIN_GLYPH_SCALE = 0.1
const MAX_GLYPH_SCALE = 20000

/**
 * The width the packer would give this text at its natural proportions, per em.
 *
 * The packer shares a line out by INK width, not by advance width — a slot is
 * proportional to how much of the character is drawn, and a space gets a fixed
 * small share. So a caller that wants to know how far it can let the packer
 * stretch the letters has to ask in the packer's own currency: measured in
 * advances instead, a ceiling of 1.4 came out as 1.48 on one line and would come
 * out differently on the next, because the two bases differ by however much side
 * bearing and however many spaces the text happens to have.
 *
 * Only true at `variation: 0`, which is what the run modes use: variation blends
 * the shares towards equal slots and then jitters them, and there is no single
 * natural width once it does.
 */
export function packedUnitWidth(fontId: string, characters: readonly string[]): number {
  let total = 0
  for (const character of characters) {
    const ink = measureInkExtent(fontId, character)
    total += ink.width <= 0 ? BLANK_WEIGHT : Math.max(0.05, ink.width)
  }
  return total
}

export function packLine(characters: readonly string[], options: PackOptions): GlyphSlot[] {
  const count = characters.length
  if (count === 0) return []

  const bandHeight = options.bandBottom - options.bandTop
  const bandCentre = (options.bandTop + options.bandBottom) / 2
  const totalWidth = options.x1 - options.x0
  if (!(bandHeight > 0) || !(totalWidth > 0)) return []

  const variation = clamp(options.variation, 0, 1)
  const verticalFill = clamp(options.verticalFill, 0, 1)

  const inks = characters.map((c) => measureInkExtent(options.fontId, c))

  // --- share the width out ---
  const weights: number[] = []
  let totalWeight = 0
  for (let i = 0; i < count; i++) {
    const ink = inks[i]
    if (!ink) {
      weights.push(0)
      continue
    }
    const blank = ink.width <= 0
    // Blend from natural proportions towards equal slots, then add seeded
    // variation on top so characters differ even where their widths do not.
    const natural = blank ? BLANK_WEIGHT : Math.max(0.05, ink.width)
    const even = blank ? BLANK_WEIGHT : 1
    const base = natural * (1 - variation) + even * variation
    // The spread reaches well past even slots at the top of the range: at full
    // strength one character can be several times the width of its neighbour,
    // which is the point of the control. The floor below is what keeps a
    // character from being driven to nothing when the jitter goes negative.
    const jitter = 1 + (seededValue(options.seed, i * 7 + 11) - 0.5) * variation * VARIATION_RANGE
    const weight = Math.max(0.05, base * jitter)
    weights.push(weight)
    totalWeight += weight
  }
  if (totalWeight <= 0) return []

  // Gaps are taken off the top so the slots still tile the span exactly.
  const gapFraction = clamp(options.gap, 0, 0.5)
  const gapCount = Math.max(0, count - 1)
  // Letter spacing rides on top of the base gap, measured against the band
  // height because that is the only em-like quantity a packed line has.
  const tracking = options.letterSpacing * bandHeight
  const rawGap = gapCount > 0 ? (totalWidth * gapFraction) / gapCount + tracking : 0
  // Bounded both ways: wide enough tracking must not squeeze the letters out of
  // existence, and tight tracking must not run the slots past each other far
  // enough to invert the line.
  const gapWidth = gapCount > 0 ? clamp(rawGap, -totalWidth / (gapCount * 4), totalWidth / (gapCount * 1.4)) : 0
  const usableWidth = clamp(totalWidth - gapWidth * gapCount, totalWidth * 0.2, totalWidth * 1.5)

  // --- one shared height, for the characters that are not fully stretched ---
  let sharedInkHeight = 0
  for (const ink of inks) {
    if (ink && ink.width > 0 && ink.height > sharedInkHeight) sharedInkHeight = ink.height
  }
  if (sharedInkHeight <= 0) sharedInkHeight = 1
  const sharedScaleY = bandHeight / sharedInkHeight

  const slots: GlyphSlot[] = []
  let cursor = options.x0

  for (let i = 0; i < count; i++) {
    const ink = inks[i]
    const weight = weights[i]
    if (!ink || weight === undefined) continue

    const slotWidth = (usableWidth * weight) / totalWeight
    const blank = ink.width <= 0

    if (blank) {
      slots.push({ index: i, x: cursor, baselineY: bandCentre, scaleX: 1, scaleY: 1, blank: true })
      cursor += slotWidth + gapWidth
      continue
    }

    // Fill the slot horizontally: the INK, not the advance, so the drawn shape
    // reaches both edges of its slot.
    const scaleX = clamp(slotWidth / ink.width, MIN_GLYPH_SCALE, MAX_GLYPH_SCALE)

    // Fill the band vertically, blended towards the shared height so the
    // control moves smoothly between an even line and a packed mass.
    const ownScaleY = bandHeight / ink.height
    const scaleY = clamp(
      sharedScaleY * (1 - verticalFill) + ownScaleY * verticalFill,
      MIN_GLYPH_SCALE,
      MAX_GLYPH_SCALE,
    )

    // Centre the character's ink on the band, then solve for the baseline that
    // puts it there. Each character has its own scale, so each has its own
    // baseline — they do not share a common one by design.
    const inkCentre = ((ink.top + ink.bottom) / 2) * scaleY
    const baselineY = bandCentre - inkCentre

    // `x` positions the glyph's INK at the slot's left edge, cancelling the
    // font's own side bearing so no slot starts with invisible space.
    slots.push({
      index: i,
      x: cursor - ink.left * scaleX,
      baselineY,
      scaleX,
      scaleY,
      blank: false,
    })
    cursor += slotWidth + gapWidth
  }

  return slots
}

/**
 * The widest gap tracking may open between two letters, in type heights.
 *
 * Beyond this the line stops being a line. An eighth of the type is a wide
 * letterspace and still reads as words.
 */
export const MAX_TRACKING = 0.12

export interface SetOptions {
  fontId: string
  /** One size for every character — that is the whole difference from packing. */
  size: number
  /** In ems, as everywhere else, because here there IS a size to measure against. */
  letterSpacing: number
  /** The stretch of run to set the line into. */
  from: number
  to: number
  /**
   * Where the leftover goes when the line is shorter than the space it has.
   *
   * A lap centres it, because a closed run has no beginning — the space belongs
   * at the seam, on both sides of it. A spiral starts, so its type starts too:
   * centring left the first letter hanging part way along the outermost turn.
   */
  align?: 'centre' | 'start'
}

/**
 * Lay the characters out along the run at ONE size, at their drawn widths.
 *
 * The counterpart to `packLine`, and its opposite in the one way that matters:
 * nothing is scaled to fit. Packing gives every character its own slot and
 * stretches it independently in x and y, so the letterforms themselves carry the
 * shape. Setting keeps the proportions the letters were drawn at and lets the
 * run decide only where they sit and which way they face — what a type-on-path
 * tool does, and what someone means by asking for text that does not wrap.
 *
 * Both are wanted, on both kinds of run, which is why this is here rather than
 * inside either fit.
 */
export function setLine(characters: readonly string[], options: SetOptions): GlyphSlot[] {
  const { fontId, size, from, to } = options
  const count = characters.length
  if (count === 0 || !(to > from)) return []

  /*
   * Each character's advance taken as the DIFFERENCE between two cumulative
   * measurements, so the parts add up to the whole.
   *
   * Measuring characters one at a time does not: `getAdvanceWidth` kerns the
   * pairs inside a string, and a letter measured alone has no pair to kern
   * against. The sum then runs a little long — 0.06% on one line of Anton, 1.5%
   * on "AVATAR Wo." — and a little long is enough. The size search sizes the
   * text by the STRING's width, so the placement overran the lap by a fraction
   * of a letter, and on a closed lap the overrun comes round and lands on top of
   * the first word.
   */
  const upTo = (index: number): number =>
    measureUnitWidth(fontId, characters.slice(0, index).join('')) * size
  const advances = characters.map((_, index) => upTo(index + 1) - upTo(index))
  const tracking = options.letterSpacing * size
  const natural =
    advances.reduce((sum, advance) => sum + advance, 0) + tracking * Math.max(0, count - 1)

  /*
   * Spread the slack between the letters, but only so far.
   *
   * Whatever the size search leaves over is normally a sliver — the size was
   * chosen to make the text this long — and spreading it keeps the line ending
   * where the run does. When the size is capped by the shape rather than by the
   * text, though, the slack is not a sliver: a short line on a shape that will
   * not take bigger type had a third of the lap to give away, and spreading all
   * of it set the words as loose single letters.
   *
   * Past the cap the line is simply SET, at its own width, in the space it has.
   * That is what a type-on-path tool does with a line shorter than its path, and
   * it reads as a line of text rather than as a row of letters.
   */
  const spare = Math.max(0, to - from - natural)
  const perGap = count > 1 ? spare / (count - 1) : 0
  const extra = Math.min(perGap, size * MAX_TRACKING)
  const used = natural + extra * Math.max(0, count - 1)

  const slots: GlyphSlot[] = []
  let cursor = options.align === 'start' ? from : from + (to - from - used) / 2
  for (let index = 0; index < count; index++) {
    const character = characters[index] as string
    slots.push({
      index,
      x: cursor,
      // The baseline IS the run: it was placed so the capitals arrive where they
      // were asked to.
      baselineY: 0,
      scaleX: size,
      scaleY: size,
      blank: measureInkExtent(fontId, character).width <= 0,
    })
    cursor += (advances[index] as number) + tracking + extra
  }
  return slots
}

/**
 * How much of the run the line actually covers, when it does not cover it all.
 *
 * Nothing when the letters are PACKED: the packer scales every character into a
 * slot and the slots fill the run exactly, so the band belongs along the whole
 * of it.
 *
 * SET letters are the case this exists for. They keep the widths they were drawn
 * at, and the only give is tracking, which is capped before the line stops
 * reading as words — so on a run longer than the words the line simply stops,
 * and a banner drawn along the whole run carried on past the last letter and
 * wound into the middle of the shape with nothing on it. The bigger the gap
 * between the turns the further it went, because a wider pitch means the run's
 * length jumps in coarser steps and the size search has more slack left over.
 *
 * The banner follows the text instead.
 */
export function textSpan(
  slots: readonly GlyphSlot[],
  characters: readonly string[],
  fontId: string,
  size: number,
  /** Where the line's span begins; slots are placed from there, runs from 0. */
  x0: number,
  rigid: boolean,
): { start: number; end: number } | Record<string, never> {
  const first = slots[0]
  const last = slots[slots.length - 1]
  if (!rigid || !first || !last) return {}
  const advance = measureUnitWidth(fontId, characters[last.index] as string) * size
  return { start: first.x - x0, end: last.x + advance - x0 }
}
