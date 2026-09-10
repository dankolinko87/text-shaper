import { transformPathData } from '../geometry/path'
import { compose } from '../geometry/transform'
import { getLoadedFont, isFontLoaded, measureInkExtent } from '../typography/fontRegistry'
import { inkBoxIn } from './glyphFit'
import type { PathData, Rect } from '../types/document'

/**
 * One character, stretched to fill a rectangle.
 *
 * Stretched, not fitted: the distortion IS the feature. A glyph in a tall narrow
 * tile becomes a tall narrow letter, strokes and counters and all, which is what
 * makes a mosaic read as type doing something rather than as type placed
 * somewhere.
 *
 * With one exception, and it is about which RECTANGLE rather than about the
 * stretch: characters shaped nothing like a letter — an `I`, a full stop — are
 * given a smaller box inside the tile, because filled to the edges the first
 * becomes a slab and the second a giant square. They are stretched by exactly as
 * much as the letters around them; they simply do not start from the same box.
 * See `inkBoxIn`, which is also what puts a comma back on its baseline.
 *
 * Measured by INK rather than by advance width. A glyph's advance includes its
 * sidebearings, so filling a tile by advance leaves a letter that is visibly not
 * touching two of its edges while touching the other two — and the amount by
 * which it misses differs per character, so a row of them looks misaligned. Ink
 * extent is the box the marks actually occupy, which is what the eye reads as
 * the letter's size.
 *
 * Null when there is nothing to draw: no font yet, an empty rectangle, or a
 * character that inks nothing at all — a space is a real thing to type into a
 * tile and it has no outline.
 *
 * A grapheme the font CANNOT draw is a different answer and gets a tofu, so that
 * a hole in the font never looks like an empty tile. See `graphemeSupport`.
 */
export function glyphInRect(fontId: string, char: string, rect: Rect): PathData | null {
  if (!char || !isFontLoaded(fontId)) return null
  if (!(rect.width > 0) || !(rect.height > 0)) return null

  const font = getLoadedFont(fontId)
  if (!font) return null

  const support = graphemeSupport(fontId, char)
  if (support === 'blank') return null
  if (support === 'missing') return tofuInRect(rect)

  const ink = measureInkExtent(fontId, char)
  if (!(ink.width > 0) || !(ink.height > 0)) return null

  /*
   * Drawn at roughly the size it will end up, so the stretch never magnifies the
   * serialiser's rounding.
   *
   * The outline is turned into a string before it is stretched, and a string
   * carries three decimal places. Draw at size 1 and an em is one unit, so those
   * places round to a two-thousandth — which becomes a fifth of a unit by the
   * time a period has been blown up to fill a two-hundred-unit tile, and the
   * letter visibly misses its edges.
   *
   * Choosing the size from the tile makes both residual scales at most 1, so the
   * rounding can only ever shrink. It also needs no constant: a period and a
   * capital W are magnified by wildly different amounts, and any fixed nominal
   * size would be wrong for one of them.
   */
  /*
   * The box the ink actually gets, which is the whole rectangle for a letter and
   * less than it for the handful of characters that would be unreadable filled.
   * See `inkBoxIn`.
   */
  const box = inkBoxIn(fontId, char, rect)

  const drawAt = Math.max(box.width / ink.width, box.height / ink.height)
  const data = outlineAt(font, char, drawAt)
  if (!data) return tofuInRect(rect)

  const scaleX = box.width / (ink.width * drawAt)
  const scaleY = box.height / (ink.height * drawAt)

  /*
   * Place the INK box on the rectangle, which is not the same as placing the
   * glyph's origin. The outline is drawn from a baseline at y = 0 with its marks
   * above and below it, so the offset has to be measured from where the ink
   * starts rather than from where the pen does.
   */
  return transformPathData(
    data,
    compose({
      x: box.x - ink.left * drawAt * scaleX,
      y: box.y - ink.top * drawAt * scaleY,
      scaleX,
      scaleY,
      rotation: 0,
      flipX: false,
      flipY: false,
    }),
  )
}

/** Decimal places in the emitted path. Three is what the rest of the app uses. */
const PLACES = 3

/**
 * A glyph's outline, written out from its COMMANDS rather than by opentype.js.
 *
 * `Path.toPathData()` is broken. For certain glyph-and-size pairs it writes
 * literal `NaN` into the string — knife-edge floating point inside its own
 * rounding, not anything about the glyph. Pirata One's `H` serialises fine at a
 * draw size of 222.222 and comes out poisoned at 222.2222, and five of its
 * twenty-six capitals break at whatever size their tile happens to ask for.
 *
 * That string then reaches paper.js, which reads the `a` of `NaN` as a relative
 * ARC command and throws inside `arcTo` — taking the whole editor down with it,
 * because nothing between here and there expects a number not to be a number.
 *
 * The commands themselves are perfectly finite; only the serialiser spoils them.
 * So this walks them directly. That is also why typography never hit this: it
 * reads `.commands` and emits its own path, and now so does the mosaic. Nothing
 * here is a retry or a workaround — the broken function is simply not called.
 *
 * Null if a coordinate really is not a number, which would mean broken font data
 * rather than a broken serialiser. That gets a tofu, honestly.
 */
function outlineAt(
  font: NonNullable<ReturnType<typeof getLoadedFont>>,
  char: string,
  drawAt: number,
): PathData | null {
  if (!(drawAt > 0) || !Number.isFinite(drawAt)) return null

  const out: string[] = []
  const n = (v: number | undefined): string | null =>
    v !== undefined && Number.isFinite(v) ? Number(v.toFixed(PLACES)).toString() : null

  for (const command of font.getPath(char, 0, 0, drawAt).commands) {
    const parts =
      command.type === 'Z'
        ? []
        : command.type === 'C'
          ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y]
          : command.type === 'Q'
            ? [command.x1, command.y1, command.x, command.y]
            : [command.x, command.y]

    const written = parts.map(n)
    if (written.some((value) => value === null)) return null
    out.push(command.type + written.join(' '))
  }

  return out.length > 0 ? out.join('') : null
}

/**
 * What a font can do with one grapheme.
 *
 * Three answers rather than a boolean, because there are three behaviours and
 * collapsing any two of them is a bug with a face: a space is not a missing
 * glyph, and a missing glyph is not an empty tile.
 */
export type GraphemeSupport =
  /** Real glyphs, and they put ink on the page. */
  | 'drawable'
  /** Real glyphs that ink nothing. A space is the whole of this case. */
  | 'blank'
  /** The font has no glyph for some visible part of it. */
  | 'missing'

/**
 * Code points that carry no ink and that no font is expected to have a glyph
 * for: variation selectors, the zero-width joiners and formats, the combining
 * grapheme joiner, the byte-order mark.
 *
 * These have to come out before the font is asked anything. A decomposed accent,
 * an emoji with a variation selector, a ZWJ sequence — every one of them
 * contains a code point that maps to `.notdef` in every font there is, so asking
 * about them one at a time rejects graphemes the font draws perfectly well.
 *
 * Emoji skin-tone modifiers are deliberately NOT in here. They are rendering
 * characters, not controls, and a font that lacks one is a font being asked for
 * something it cannot do.
 */
function isIgnorable(code: number): boolean {
  return (
    code === 0x034f ||
    code === 0xfeff ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}

/**
 * Whether this font can draw this grapheme, asked about the WHOLE grapheme.
 *
 * Asked per code point instead, this rejects things the font handles: `e` plus a
 * combining acute is two code points and one letter, and Anton has both parts.
 * So the ignorable code points come out, and what is left is put to the font as
 * one string — `stringToGlyphs` rather than a loop over `charToGlyphIndex`, so
 * whatever substitution the library does apply is reflected rather than assumed
 * away.
 *
 * A single `.notdef` anywhere in the sequence condemns the whole grapheme. Half
 * a grapheme is not a smaller problem than none of it — rendering the `e` and
 * dropping its accent shows a different letter, confidently.
 *
 * The limits of this are the limits of opentype.js, which is a font parser and
 * not a shaping engine: it does cmap lookup and kerning, not full GSUB/GPOS. So
 * a decomposed accent is placed by advance width rather than stacked over its
 * base, and complex scripts and multi-codepoint emoji are not properly shaped.
 * What is claimed here is narrower and true — the mosaic never silently drops a
 * required visible part of a grapheme, and never mistakes a space for a hole.
 */
export function graphemeSupport(fontId: string, char: string): GraphemeSupport {
  const font = getLoadedFont(fontId)
  if (!font || !char) return 'blank'

  const significant = [...char].filter((point) => !isIgnorable(point.codePointAt(0) ?? 0)).join('')
  // Nothing but controls: a zero-width joiner on its own is not a missing
  // letter, it is nothing at all.
  if (!significant) return 'blank'

  for (const glyph of font.stringToGlyphs(significant)) {
    if (glyph.index === 0) return 'missing'
  }

  const ink = measureInkExtent(fontId, significant)
  return ink.width > 0 && ink.height > 0 ? 'drawable' : 'blank'
}

/** How thick the missing-glyph frame is, as a share of the tile's shorter side. */
const TOFU_WEIGHT = 0.08

/**
 * The box a missing glyph draws as.
 *
 * The same thing a browser shows, and for the same reason: a hole you can see
 * beats a hole you cannot. Left to itself the tile would draw the font's own
 * `.notdef`, which is a box in some fonts and nothing at all in others — so the
 * same emoji looked like a deliberate tile in one font and like an empty one in
 * the next.
 *
 * Four filled bars rather than a stroked rectangle, because the renderer fills
 * these paths with `strokeWidth: 0`, and four separate subpaths wound the same
 * way need no help from the fill rule.
 */
function tofuInRect(rect: Rect): PathData {
  const weight = Math.max(0.5, Math.min(rect.width, rect.height) * TOFU_WEIGHT)
  // A tile too small to hold a frame gets a solid block: still visibly a hole.
  const t = Math.min(weight, rect.width / 2, rect.height / 2)
  const { x, y, width: w, height: h } = rect

  return [
    bar(x, y, w, t),
    bar(x, y + h - t, w, t),
    bar(x, y + t, t, Math.max(0, h - 2 * t)),
    bar(x + w - t, y + t, t, Math.max(0, h - 2 * t)),
  ].join(' ')
}

function bar(x: number, y: number, w: number, h: number): string {
  if (!(w > 0) || !(h > 0)) return ''
  const n = (v: number): string => Number(v.toFixed(3)).toString()
  return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`
}
