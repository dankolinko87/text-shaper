import opentype, { type Font } from 'opentype.js'

import { DEFAULT_FONT_ID, findFont } from '../fonts/manifest'

/**
 * Font loading and measurement caches.
 *
 * Parsing a TTF and measuring advance widths are both hot paths during fitting
 * (the engine tests many candidate layouts per reflow), so both are memoised.
 */

const fonts = new Map<string, Font>()
const loading = new Map<string, Promise<Font>>()

/** `${fontId}|${text}` -> advance width at size 1. */
const advanceCache = new Map<string, number>()

export async function loadFont(fontId: string): Promise<Font> {
  const cached = fonts.get(fontId)
  if (cached) return cached

  const pending = loading.get(fontId)
  if (pending) return pending

  const descriptor = findFont(fontId)
  if (!descriptor) throw new Error(`Unknown font: ${fontId}`)

  const promise = fetch(descriptor.url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Failed to load font ${fontId}: ${response.status}`)
      return response.arrayBuffer()
    })
    .then((buffer) => {
      const font = opentype.parse(buffer)
      fonts.set(fontId, font)
      loading.delete(fontId)
      return font
    })
    .catch((error: unknown) => {
      loading.delete(fontId)
      throw error
    })

  loading.set(fontId, promise)
  return promise
}

/** Register an already-parsed font — used by tests, which read from disk. */
export function registerFont(fontId: string, font: Font): void {
  fonts.set(fontId, font)
}

export function getLoadedFont(fontId: string): Font | undefined {
  return fonts.get(fontId)
}

export function isFontLoaded(fontId: string): boolean {
  return fonts.has(fontId)
}

export { DEFAULT_FONT_ID }

/**
 * Advance width of `text` at font size 1, memoised.
 * Multiply by the desired size to get the real width.
 */
export function measureUnitWidth(fontId: string, text: string): number {
  const key = `${fontId}|${text}`
  const cached = advanceCache.get(key)
  if (cached !== undefined) return cached

  const font = fonts.get(fontId)
  if (!font) throw new Error(`Font not loaded: ${fontId}`)

  const width = font.getAdvanceWidth(text, 1)
  advanceCache.set(key, width)
  return width
}

export interface InkExtent {
  /** Distance above the baseline the ink reaches, in em (negative = above). */
  top: number
  /** Distance below the baseline the ink reaches, in em (positive = below). */
  bottom: number
  /** Total ink height in em. */
  height: number
  /** Left edge of the ink relative to the pen origin, in em. */
  left: number
  /** Right edge of the ink relative to the pen origin, in em. */
  right: number
  /** Total ink width in em. Zero for a blank glyph such as a space. */
  width: number
}

/** `${fontId}|${text}` -> ink extent at size 1. */
const inkCache = new Map<string, InkExtent>()

/**
 * The vertical extent of the ACTUAL INK of a string, at font size 1.
 *
 * This is deliberately not the font's line height. For Anton the line height is
 * 1.505em while a line of capitals only inks 0.875em of that — so sizing text
 * by the line height draws it around 40% smaller than the space it was given,
 * which is why fitted text used to sit in the middle of a shape rather than
 * filling it. Sizing and vertical centring both use real ink instead.
 */
export function measureInkExtent(fontId: string, text: string): InkExtent {
  const key = `${fontId}|${text}`
  const cached = inkCache.get(key)
  if (cached) return cached

  const font = fonts.get(fontId)
  if (!font) throw new Error(`Font not loaded: ${fontId}`)

  const box = font.getPath(text, 0, 0, 1).getBoundingBox()
  // A string of only spaces inks nothing; fall back to the font's own metrics
  // so callers never divide by zero.
  const empty = !Number.isFinite(box.y1) || !Number.isFinite(box.y2) || box.y2 - box.y1 <= 0
  const extent: InkExtent = empty
    ? {
        top: -font.ascender / font.unitsPerEm,
        bottom: -font.descender / font.unitsPerEm,
        height: 1,
        left: 0,
        right: 0,
        width: 0,
      }
    : {
        top: box.y1,
        bottom: box.y2,
        height: box.y2 - box.y1,
        left: box.x1,
        right: box.x2,
        width: box.x2 - box.x1,
      }

  inkCache.set(key, extent)
  return extent
}

/** Vertical metrics, normalised to a font size of 1. */
export function unitMetrics(fontId: string): { ascender: number; descender: number; lineHeight: number } {
  const font = fonts.get(fontId)
  if (!font) throw new Error(`Font not loaded: ${fontId}`)
  const upm = font.unitsPerEm
  const ascender = font.ascender / upm
  const descender = font.descender / upm
  return { ascender, descender, lineHeight: ascender - descender }
}

export function clearFontCaches(): void {
  fonts.clear()
  loading.clear()
  advanceCache.clear()
  inkCache.clear()
}
