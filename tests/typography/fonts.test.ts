import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope } from '../../src/geometry/paperContext'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { DEFAULT_FONT_ID, FONTS, findFont } from '../../src/fonts/manifest'
import { documentDefaults } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'

/**
 * Every bundled font, through the whole pipeline.
 *
 * A font that parses is not the same as a font that WORKS here: the fit has to
 * find a layout, the glyphs have to survive the warp, and the exact text has to
 * come out. A face that failed any of those would look like a broken app rather
 * than a bad choice of font, and only running it would say which.
 */

const SHAPE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const TEXT = 'RONESHA IS THE VERY BEST'

/** Load the bundled binaries from disk — the browser fetches them by URL. */
beforeAll(() => {
  for (const font of FONTS) {
    // The manifest holds a bundler URL, so the filename is taken from it.
    const name = decodeURIComponent(font.url.split('/').pop() ?? '')
    const path = fileURLToPath(new URL(`../../src/fonts/files/${name}`, import.meta.url))
    const bytes = readFileSync(path)
    registerFont(
      font.id,
      opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    )
  }
})

afterEach(() => {
  resetPaperScope()
})

const fit = (fontId: string, shapePath = SHAPE) =>
  fitTextToShape({
    text: TEXT,
    shapePath,
    fontId,
    flowMode: 'word',
    lineSpacing: documentDefaults.typography.lineSpacing,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'boundary-warp',
    distortion: { ...documentDefaults.distortion },
    seed: 3,
  })

describe('every bundled font', () => {
  it('fills a shape', () => {
    for (const font of FONTS) {
      const result = fit(font.id)
      expect(result.ok, `${font.family} cannot fill a shape`).toBe(true)
      if (!result.ok) continue
      expect(result.path.length, font.family).toBeGreaterThan(0)
      expect(result.path, font.family).not.toMatch(/NaN|Infinity/)
    }
  })

  it('keeps the text exact, which is the one rule', () => {
    for (const font of FONTS) {
      const result = fit(font.id)
      if (!result.ok) continue
      const lines = result.lines.map((line) => line.text)
      expect(verifyExactText(TEXT, lines, 'word').ok, font.family).toBe(true)
    }
  })

  it('works in every primitive shape, not only a friendly one', () => {
    // A triangle is the hard case: its rows vary wildly in width, so a face that
    // only just fits an ellipse can fail here.
    for (const font of FONTS) {
      for (const primitive of PRIMITIVES) {
        const result = fit(font.id, primitive.build(680, 600))
        expect(result.ok, `${font.family} in ${primitive.label}`).toBe(true)
      }
    }
  })

  it('draws enough ink to survive being squeezed', () => {
    // The reason the set is what it is. A light face loses its thin strokes the
    // moment a row is compressed, so every font here has to put down a
    // substantial amount of outline for the same words in the same shape.
    for (const font of FONTS) {
      const result = fit(font.id)
      if (!result.ok) continue
      // Curve and line commands in the emitted outline: a rough but honest
      // measure of how much letter there is.
      const commands = (result.path.match(/[CLQ]/g) ?? []).length
      expect(commands, `${font.family} draws almost nothing`).toBeGreaterThan(200)
    }
  })
})

describe('the manifest', () => {
  it('gives every font a unique id', () => {
    expect(new Set(FONTS.map((f) => f.id)).size).toBe(FONTS.length)
  })

  it('points every entry at a file that exists', () => {
    for (const font of FONTS) {
      const name = decodeURIComponent(font.url.split('/').pop() ?? '')
      expect(name, font.family).toMatch(/\.ttf$/)
      const path = fileURLToPath(new URL(`../../src/fonts/files/${name}`, import.meta.url))
      expect(readFileSync(path).length, font.family).toBeGreaterThan(1000)
    }
  })

  it('ships a licence for every family, as the OFL requires', () => {
    for (const font of FONTS) {
      const name = decodeURIComponent(font.url.split('/').pop() ?? '').replace(
        /-Regular\.ttf$/,
        '',
      )
      const path = fileURLToPath(new URL(`../../src/fonts/licenses/${name}-OFL.txt`, import.meta.url))
      expect(readFileSync(path, 'utf8'), font.family).toContain('SIL OPEN FONT LICENSE')
      expect(font.license).toBe('SIL Open Font License 1.1')
    }
  })

  it('describes what each face is for', () => {
    // The picker shows these. "Anton" tells you nothing if you do not already
    // know it; "Condensed grotesque" tells you what you are choosing.
    for (const font of FONTS) {
      expect(font.note.length, font.family).toBeGreaterThan(3)
    }
    expect(new Set(FONTS.map((f) => f.note)).size, 'two fonts described the same way').toBe(
      FONTS.length,
    )
  })

  it('can find the default, and resolves unknown ids to nothing', () => {
    expect(findFont(DEFAULT_FONT_ID)?.family).toBe('Anton')
    expect(findFont('not-a-font')).toBeUndefined()
  })
})
