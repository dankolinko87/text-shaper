import { measureInkExtent } from '../typography/fontRegistry'
import type { Rect } from '../types/document'

/**
 * Where a character's ink belongs inside its tile.
 *
 * A mosaic stretches its letters to fill their tiles, and the distortion IS the
 * feature — a tall narrow tile makes a tall narrow letter. That reads beautifully
 * for letters, whose ink boxes are all roughly the same shape, and falls apart
 * for the characters whose are not:
 *
 * - An `I` has about two fifths the width of an `H`. Filled to the tile it
 *   becomes a solid slab, indistinguishable from a coloured tile with nothing
 *   written in it. Same for `l`, `!`, `i`, `j` and often `1`.
 * - A full stop has about a sixth the height of an `H`. Filled to the tile it
 *   becomes a giant rounded square that reads as anything but a full stop —
 *   and, worse, it stops sitting on the baseline, which is the only thing that
 *   makes a comma a comma rather than an apostrophe.
 *
 * The rule is RELATIVE to the font's own letters rather than absolute, which is
 * what keeps the aesthetic intact. Every glyph that is shaped like a letter goes
 * on filling its tile exactly as before; only the outliers are held back, and
 * they are held to the scale a capital would have been given — so they are
 * stretched by the same amount everything else is, and a wide tile still makes a
 * wide full stop. Nothing is hard-coded per character: `I` and `.` are found by
 * measuring them, so the rule holds for a typeface this app has never seen.
 */

/**
 * Narrower than this share of the reference capital's width and a glyph keeps
 * its own width rather than being stretched to the tile's.
 *
 * Measured, not guessed. Across Anton and Pirata One the letters sit at 0.84 (an
 * `E`, the narrowest ordinary capital) and above, while `I`, `l`, `!`, `i` and
 * `j` sit between 0.38 and 0.53. Seven tenths is the empty middle between them.
 */
const NARROW = 0.7

/**
 * Shorter than this share of the x-height and a glyph is a MARK, not a letter.
 *
 * Measured against the x-height rather than the cap height because lowercase
 * letters are legitimately short: `o` and `x` come in at 1.00 of it in both
 * fonts, while `:` reaches 0.69–0.77 and everything smaller — `.`, `,`, `-`,
 * `'`, `"` — is far below. Cap height would have called an `o` a mark.
 */
const SHORT = 0.85

/** The capital whose proportions stand for "an ordinary letter" in this font. */
const REFERENCE_LETTER = 'H'
/** And the lowercase whose height stands for "as short as a letter gets". */
const REFERENCE_LOWERCASE = 'x'

export function inkBoxIn(fontId: string, char: string, rect: Rect): Rect {
  if (!(rect.width > 0) || !(rect.height > 0)) return rect

  const ink = measureInkExtent(fontId, char)
  const reference = measureInkExtent(fontId, REFERENCE_LETTER)
  const lowercase = measureInkExtent(fontId, REFERENCE_LOWERCASE)
  /*
   * No reference to measure against, no rule. A font with no `H` — a symbol set,
   * a script this app has never seen — falls back to filling the tile, which is
   * what every character did before this existed.
   */
  if (!(reference.width > 0) || !(reference.height > 0)) return rect
  if (!(ink.width > 0) || !(ink.height > 0)) return rect

  /*
   * The mapping a capital would get: it fills the tile, so its ink box maps onto
   * the rectangle. Everything below is expressed through it, which is what makes
   * a held-back glyph share the tile's distortion instead of escaping it.
   */
  const scaleX = rect.width / reference.width
  const scaleY = rect.height / reference.height

  const narrow = ink.width / reference.width < NARROW
  const short = lowercase.height > 0 && ink.height < SHORT * lowercase.height

  const width = narrow ? ink.width * scaleX : rect.width
  const height = short ? ink.height * scaleY : rect.height

  // Centred across the tile: a held-back glyph has no reason to favour a side.
  const x = narrow ? rect.x + (rect.width - width) / 2 : rect.x
  /*
   * Down the tile it is the BASELINE that decides, not the centre. A comma hangs
   * below it and an apostrophe hangs from the cap line, and those two positions
   * are the whole difference between the two marks — centring both would leave
   * them the same shape in the same place.
   */
  let y = rect.y
  if (short) {
    y = rect.y + (ink.top - reference.top) * scaleY
    // A descender would otherwise hang out of the tile and into the gap below.
    const bottom = rect.y + rect.height
    if (y + height > bottom) y = bottom - height
    if (y < rect.y) y = rect.y
  }

  return { x, y, width, height }
}

/**
 * Where a glyph's centre goes, mapping its ink box from one rectangle to another.
 *
 * Fabric positions a path by its BOUNDING BOX, so the usual "centre it on the
 * tile" only worked while every glyph's ink filled its rectangle exactly. Once a
 * full stop occupies a small box near the bottom, centring its bbox on the tile
 * hauls it back into the middle and undoes the baseline it was just given.
 *
 * `from` is the rectangle the outline was BUILT for and `to` the one it is being
 * shown in — the same pair the scale factors come from — so this is the image of
 * the ink box's centre under that map, and nothing about it depends on which
 * character it is.
 */
export function placeInk(box: Rect, from: Rect, to: Rect): { x: number; y: number } {
  const scaleX = from.width > 0 ? to.width / from.width : 1
  const scaleY = from.height > 0 ? to.height / from.height : 1
  return {
    x: to.x + (box.x + box.width / 2 - from.x) * scaleX,
    y: to.y + (box.y + box.height / 2 - from.y) * scaleY,
  }
}
