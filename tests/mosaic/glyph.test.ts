import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { beforeAll, describe, expect, it } from 'vitest'

import { pathBounds, transformPathData } from '../../src/geometry/path'
import { compose } from '../../src/geometry/transform'
import { glyphInRect, graphemeSupport } from '../../src/mosaic/glyph'
import { registerFont } from '../../src/typography/fontRegistry'
import type { Rect } from '../../src/types/document'

/**
 * One character, stretched to fill a rectangle.
 *
 * Stretched rather than fitted — the distortion is the feature — so what has to
 * be true is that the letter's INK fills the tile exactly, in both directions,
 * whatever shape the tile is.
 */

const FONT_ID = 'anton'
/** Blackletter, and the font that exposed opentype.js's `NaN` coordinates. */
const PIRATA = 'pirata-one'

beforeAll(() => {
  for (const [id, file] of [
    [FONT_ID, 'Anton-Regular.ttf'],
    [PIRATA, 'PirataOne-Regular.ttf'],
  ] as const) {
    const p = fileURLToPath(new URL(`../../src/fonts/files/${file}`, import.meta.url))
    const b = readFileSync(p)
    registerFont(id, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  }
})

const fills = (rect: Rect, data: string, tolerance = 0.01): void => {
  const box = pathBounds(data)
  expect(box.x).toBeCloseTo(rect.x, 2)
  expect(box.y).toBeCloseTo(rect.y, 2)
  expect(Math.abs(box.width - rect.width)).toBeLessThan(tolerance)
  expect(Math.abs(box.height - rect.height)).toBeLessThan(tolerance)
}

describe('a glyph in a tile', () => {
  it('fills it exactly, whatever shape the tile is', () => {
    for (const rect of [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: -60, y: 20, width: 240, height: 40 },
      { x: 5, y: -80, width: 30, height: 300 },
    ] as Rect[]) {
      const data = glyphInRect(FONT_ID, 'A', rect)
      expect(data, JSON.stringify(rect)).not.toBeNull()
      fills(rect, data as string)
    }
  })

  it('measures by ink, not by advance width', () => {
    /*
     * A glyph's advance includes its sidebearings, so a letter placed by advance
     * sits away from two of its tile's edges by an amount that differs per
     * character — and a row of them reads as misaligned. Ink extent is the box
     * the marks occupy, which is what the eye takes for the letter's size.
     *
     * `M` has narrow sidebearings and `A` and `W` wide ones, so if advance were
     * being used they would not all touch all four edges.
     */
    const rect: Rect = { x: 0, y: 0, width: 120, height: 200 }
    for (const char of ['M', 'A', 'W']) {
      const data = glyphInRect(FONT_ID, char, rect)
      expect(data, char).not.toBeNull()
      fills(rect, data as string)
    }
  })

  it('keeps the counter in a letter that has one', () => {
    // A stretch is an affine map, so it cannot turn a two-contour glyph into a
    // one-contour one — but a fill rule applied wrongly would fill the hole.
    const data = glyphInRect(FONT_ID, 'D', { x: 0, y: 0, width: 100, height: 100 })
    expect(data).not.toBeNull()
    // Two contours: the outside, and the counter inside it.
    expect((data as string).match(/[Mm]/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('says nothing rather than drawing nothing', () => {
    const rect: Rect = { x: 0, y: 0, width: 100, height: 100 }
    // A space is a real thing to type into a tile, and it inks nothing.
    expect(glyphInRect(FONT_ID, ' ', rect)).toBeNull()
    expect(glyphInRect(FONT_ID, '', rect)).toBeNull()
    // A tile with no room in it.
    expect(glyphInRect(FONT_ID, 'A', { x: 0, y: 0, width: 0, height: 100 })).toBeNull()
    expect(glyphInRect(FONT_ID, 'A', { x: 0, y: 0, width: 100, height: 0 })).toBeNull()
  })

  it('waits for the font rather than throwing', () => {
    // The renderer runs before the font has arrived, every time the page loads.
    expect(glyphInRect('not-a-font', 'A', { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
  })

  it('stretches to the tile it is given, wide or tall', () => {
    // The distortion is the feature: a wide tile makes a wide letter and a tall
    // one makes a tall letter, out of the same outline.
    const wide = glyphInRect(FONT_ID, 'H', { x: 0, y: 0, width: 300, height: 60 })
    const tall = glyphInRect(FONT_ID, 'H', { x: 0, y: 0, width: 60, height: 300 })
    const w = pathBounds(wide as string)
    const t = pathBounds(tall as string)
    expect(w.width / w.height).toBeGreaterThan(4)
    expect(t.height / t.width).toBeGreaterThan(4)
  })

  /**
   * The characters that are not shaped like letters.
   *
   * Filling the tile is right for a letter and ruinous for these: an `I` becomes
   * a solid slab you cannot tell from an empty coloured tile, and a full stop
   * becomes a giant square that is no longer a full stop. They are held back to
   * the box a capital's own scale would give them — so they still carry the
   * tile's distortion, they simply do not start from its edges.
   */
  describe('a character shaped nothing like a letter', () => {
    const square: Rect = { x: 0, y: 0, width: 200, height: 200 }
    const box = (char: string, rect: Rect = square) => {
      const data = glyphInRect(FONT_ID, char, rect)
      expect(data, char).not.toBeNull()
      return pathBounds(data as string)
    }

    it('does not let a narrow letter fill the tile', () => {
      for (const narrow of ['I', 'l', '!', 'i']) {
        expect(box(narrow).width, narrow).toBeLessThan(square.width * 0.75)
      }
    })

    it('still lets an ordinary letter fill it', () => {
      // The whole point: the aesthetic is untouched for everything but outliers.
      for (const letter of ['H', 'E', 'O', 'W', 'o', 'x']) {
        expect(box(letter).width, letter).toBeCloseTo(square.width, 1)
        expect(box(letter).height, letter).toBeCloseTo(square.height, 1)
      }
    })

    it('centres a narrow letter across the tile', () => {
      const drawn = box('I')
      const left = drawn.x - square.x
      const right = square.x + square.width - (drawn.x + drawn.width)

      expect(left).toBeCloseTo(right, 1)
    })

    it('keeps a narrow letter full height', () => {
      // `I` is as tall as an `H`; only its width was ever the problem.
      expect(box('I').height).toBeCloseTo(square.height, 1)
    })

    it('does not let a mark fill the tile', () => {
      for (const mark of ['.', ',', '-', "'", ':']) {
        expect(box(mark).height, mark).toBeLessThan(square.height * 0.75)
      }
    })

    it('puts a full stop on the baseline, at the bottom', () => {
      const drawn = box('.')
      const bottom = drawn.y + drawn.height

      expect(bottom).toBeGreaterThan(square.y + square.height * 0.8)
    })

    it('hangs a comma lower than an apostrophe', () => {
      /*
       * The single property that makes the two marks different characters: an
       * apostrophe hangs from the cap line and a comma sits on the baseline.
       * Filled to the tile, both became the same shape in the same place.
       */
      expect(box(',').y).toBeGreaterThan(box("'").y + square.height * 0.5)
    })

    it('shares the tile’s distortion rather than escaping it', () => {
      // A wide tile makes a wide full stop, exactly as it makes a wide `H`.
      const wide = box('.', { x: 0, y: 0, width: 400, height: 200 })
      const narrow = box('.', square)

      expect(wide.width).toBeGreaterThan(narrow.width * 1.9)
      expect(wide.height).toBeCloseTo(narrow.height, 1)
    })
  })
})

/**
 * Which graphemes a font can actually draw.
 *
 * The interesting cases are the ones where a naive per-code-point check gets it
 * wrong. A grapheme is one letter to the person typing it and may be several
 * code points, some of which no font has a glyph for and none of which need one.
 */
describe('what a font can draw', () => {
  const RECT: Rect = { x: 0, y: 0, width: 100, height: 100 }

  it('draws an accented letter, spelled either way', () => {
    /*
     * `é` is one grapheme with two spellings: precomposed U+00E9, and `e`
     * followed by a combining acute. Anton has a glyph for both parts of the
     * decomposed form, so both spellings are drawable — and a check that asked
     * about U+0301 as though it were a letter on its own would still be right
     * here, which is exactly why the emoji case below matters.
     */
    expect(graphemeSupport(FONT_ID, 'é')).toBe('drawable')
    expect(graphemeSupport(FONT_ID, 'é')).toBe('drawable')

    const precomposed = glyphInRect(FONT_ID, 'é', RECT)
    const decomposed = glyphInRect(FONT_ID, 'é', RECT)
    expect(precomposed).not.toBeNull()
    expect(decomposed).not.toBeNull()
    // Both fill the tile. They are not the same picture — opentype.js places the
    // combining mark by advance width rather than stacking it, since it does
    // cmap and kerning but not GPOS mark positioning — and that is a documented
    // limit of the shaping, not something this test should pretend away.
    fills(RECT, precomposed as string)
    fills(RECT, decomposed as string)
  })

  it('ignores the code points that carry no ink', () => {
    // A variation selector and a zero-width joiner have no glyph in any text
    // font. Counting them as missing letters would condemn every emoji sequence
    // and every deliberately-joined form, including ones the font can draw.
    expect(graphemeSupport(FONT_ID, 'A️')).toBe('drawable')
    expect(graphemeSupport(FONT_ID, 'é︀')).toBe('drawable')
    expect(graphemeSupport(FONT_ID, '‍')).toBe('blank')
  })

  it('tells a space apart from a hole in the font', () => {
    expect(graphemeSupport(FONT_ID, ' ')).toBe('blank')
    expect(graphemeSupport(FONT_ID, '😀')).toBe('missing')
  })

  it('draws a box for a grapheme it has no glyph for', () => {
    /*
     * Left alone, the tile would draw the font's own `.notdef` — which Anton
     * inks and many fonts do not, so the same emoji was a box in one font and an
     * empty tile in the next. A tofu is the same answer everywhere.
     */
    const data = glyphInRect(FONT_ID, '😀', RECT)
    expect(data).not.toBeNull()

    const box = pathBounds(data as string)
    expect(box.x).toBeGreaterThanOrEqual(RECT.x - 1e-6)
    expect(box.y).toBeGreaterThanOrEqual(RECT.y - 1e-6)
    expect(box.x + box.width).toBeLessThanOrEqual(RECT.x + RECT.width + 1e-6)
    expect(box.y + box.height).toBeLessThanOrEqual(RECT.y + RECT.height + 1e-6)
    // Four bars, so the middle reads as empty rather than as a filled block.
    expect((data as string).match(/M/g)).toHaveLength(4)
  })

  it('draws a whole grapheme or none of it', () => {
    /*
     * The failure this rules out: rendering the parts the font has and dropping
     * the rest. A flag is two regional indicators and Anton has neither; showing
     * one of them, or a bare letter where an accent was asked for, is a
     * confidently wrong answer rather than a visible gap.
     */
    expect(graphemeSupport(FONT_ID, '🇫🇷')).toBe('missing')
    const data = glyphInRect(FONT_ID, '🇫🇷', RECT)
    expect((data as string).match(/M/g)).toHaveLength(4)
  })

  it('never hands paper.js a coordinate that is not a number', () => {
    /*
     * Found by changing a mosaic's font in the browser, which took the whole
     * editor down with it.
     *
     * opentype.js's `toPathData` writes literal `NaN` into the string for
     * certain glyph-and-size pairs — its own rounding, nothing about the glyph,
     * whose commands are perfectly finite. Pirata One's `H` serialises fine at a
     * draw size of 222.222 and comes out poisoned at 222.2222, and a tile asks
     * for whichever size it needs. Paper.js then reads the `a` of `NaN` as a
     * relative arc command and throws inside `arcTo`.
     *
     * Every capital, at the size its own tile asks for, because the size is what
     * decides it: a test of one letter at one size proves nothing here.
     */
    const rect: Rect = { x: 0, y: 0, width: 100, height: 100 }
    const broken: string[] = []

    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      const data = glyphInRect(PIRATA, ch, rect)
      if (data === null) continue
      if (/NaN|Infinity/.test(data)) {
        broken.push(`${ch}: not a number`)
        continue
      }
      // And it must survive the parser that crashed, not merely look finite.
      try {
        pathBounds(data)
      } catch (error) {
        broken.push(`${ch}: ${(error as Error).message}`)
      }
    }

    expect(broken).toEqual([])
  })

  it('still draws the letter, rather than giving up and showing a box', () => {
    // The glyph is drawable and always was; only the serialiser spoiled it.
    // Writing the commands out directly keeps an `H` an `H` — a tofu here would
    // be a crash wearing a disguise.
    const rect: Rect = { x: 0, y: 0, width: 100, height: 100 }
    for (const ch of ['H', 'G']) {
      const data = glyphInRect(PIRATA, ch, rect)
      expect(data, ch).not.toBeNull()
      // A tofu is four bars and nothing else. A letter is not.
      expect((data as string).match(/[MmCcQq]/g)!.length, ch).toBeGreaterThan(4)
      fills(rect, data as string, 0.05)
    }
  })

  it('never draws a tofu larger than its tile', () => {
    for (const rect of [
      { x: 0, y: 0, width: 4, height: 90 },
      { x: -10, y: -10, width: 1, height: 1 },
      { x: 3, y: 3, width: 200, height: 6 },
    ] as Rect[]) {
      const box = pathBounds(glyphInRect(FONT_ID, '😀', rect) as string)
      expect(box.width, JSON.stringify(rect)).toBeLessThanOrEqual(rect.width + 1e-6)
      expect(box.height, JSON.stringify(rect)).toBeLessThanOrEqual(rect.height + 1e-6)
    }
  })
})

describe('one outline, stretched into any rectangle', () => {
  /*
   * What playback rests on.
   *
   * A frame moves a glyph with a transform instead of writing a new path, which
   * is only honest if the two produce the same geometry. They do, because the
   * deformation is a plain non-uniform stretch either way — and the precision
   * holds because `glyphInRect` picks its draw size from the rectangle it fills,
   * so building at the LARGEST rectangle a tile reaches keeps the residual scale
   * at or below 1 for every frame between.
   */
  const affine = (from: Rect, to: Rect) =>
    compose({
      x: to.x + to.width / 2 - ((from.x + from.width / 2) * to.width) / from.width,
      y: to.y + to.height / 2 - ((from.y + from.height / 2) * to.height) / from.height,
      scaleX: to.width / from.width,
      scaleY: to.height / from.height,
      rotation: 0,
      flipX: false,
      flipY: false,
    })

  /** Every number in a path, in order. */
  const numbersIn = (data: string): number[] =>
    (data.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)

  const commandsIn = (data: string): string => (data.match(/[A-Za-z]/g) ?? []).join('')

  it('lands in the same place as rebuilding it there', () => {
    // The reference is the biggest the glyph gets; the targets are all smaller,
    // which is the direction an animation actually travels.
    const reference: Rect = { x: -60, y: -40, width: 200, height: 160 }
    const targets: Rect[] = [
      { x: -60, y: -40, width: 200, height: 160 },
      { x: 10, y: 20, width: 120, height: 150 },
      { x: -5, y: -5, width: 40, height: 30 },
      { x: 0, y: 0, width: 190, height: 20 },
    ]

    for (const char of ['A', 'W', 'i', '.']) {
      const built = glyphInRect(FONT_ID, char, reference)
      expect(built, char).toBeTruthy()

      for (const target of targets) {
        const mapped = transformPathData(built as string, affine(reference, target))
        const direct = glyphInRect(FONT_ID, char, target) as string
        expect(direct, `${char} at ${target.width}x${target.height}`).toBeTruthy()

        expect(commandsIn(mapped), `${char}: same commands`).toBe(commandsIn(direct))

        const a = numbersIn(mapped)
        const b = numbersIn(direct)
        expect(a.length, `${char}: same number of coordinates`).toBe(b.length)

        // The serialiser keeps three decimals at the draw size, and the residual
        // scale here is at most 1, so the two can only differ in that last place.
        const slack = Math.max(target.width, target.height) * 1e-3 + 1e-6
        for (let at = 0; at < a.length; at++) {
          expect(Math.abs((a[at] as number) - (b[at] as number)), `${char}: coordinate ${at}`)
            .toBeLessThanOrEqual(slack)
        }
      }
    }
  })

  it('fills the rectangle it was mapped into, exactly', () => {
    const reference: Rect = { x: -50, y: -50, width: 180, height: 140 }
    const target: Rect = { x: 12, y: -30, width: 45, height: 96 }
    const mapped = transformPathData(
      glyphInRect(FONT_ID, 'G', reference) as string,
      affine(reference, target),
    )
    const bounds = pathBounds(mapped)
    expect(bounds.x).toBeCloseTo(target.x, 2)
    expect(bounds.y).toBeCloseTo(target.y, 2)
    expect(bounds.width).toBeCloseTo(target.width, 2)
    expect(bounds.height).toBeCloseTo(target.height, 2)
  })
})
