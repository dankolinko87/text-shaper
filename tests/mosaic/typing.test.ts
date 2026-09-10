import { describe, expect, it } from 'vitest'

import { graphemes, isTypedCharacter } from '../../src/mosaic/graphemes'
import { layoutMosaic } from '../../src/mosaic/layout'
import { readingOrder, stepThrough, tileInDirection } from '../../src/mosaic/order'
import { seedMosaic, withCharacters } from '../../src/mosaic/dissection'
import {
  backspaceCharacter,
  characterAt,
  deleteCharacter,
  pasteCharacters,
  setCharacter,
  typeCharacter,
} from '../../src/mosaic/typing'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile, MosaicTileLayout } from '../../src/types/mosaic'

/**
 * Typing into a mosaic.
 *
 * The whole of it is plain functions over the tiles, so what a keystroke MEANS is
 * settled here rather than by clicking around: where the caret goes, what
 * backspace does in an empty tile, what happens to a paste that will not fit.
 */

const BOX: Rect = { x: 0, y: 0, width: 500, height: 500 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }

/** A mosaic and the order it reads in, which is what typing walks along. */
function mosaic(columns: number, rows: number, text = '') {
  const seeded = seedMosaic(columns, rows)
  // The tiles are the places; the letters are a state's, keyed by tile id.
  const chars = withCharacters(seeded.tiles, text)
  const tiles = layoutMosaic(seeded.tiles, seeded.x, seeded.y, BOX, NONE)
  return { list: seeded.tiles, chars, x: seeded.x, y: seeded.y, tiles, order: readingOrder(tiles) }
}

const tilesOf = (list: readonly MosaicTile[], x: Record<string, number>, y: Record<string, number>) =>
  layoutMosaic(list, x, y, BOX, NONE)

const letters = (chars: Record<string, string>, order: readonly string[]): string =>
  order.map((id) => characterAt(chars, id) ?? '·').join('')

describe('the order a mosaic reads in', () => {
  it('is worked out from where the tiles ARE, not from the order they are stored in', () => {
    /*
     * A fresh grid is seeded row by row, so the two agree — which is exactly why
     * this has to be checked with the list shuffled. Reading order asks the
     * geometry; if it were merely echoing the stored order it would pass on a
     * seeded mosaic and fail on every one that had been edited.
     */
    const { list, chars, x, y, order } = mosaic(5, 5, 'ABCDEFGHIJKLMNOPQRSTUVWXY')
    expect(order).toHaveLength(25)
    expect(letters(chars, order), 'reads across').toBe('ABCDEFGHIJKLMNOPQRSTUVWXY')

    const shuffled = [...list].reverse()
    const reversedOrder = readingOrder(layoutMosaic(shuffled, x, y, BOX, NONE))
    expect(letters(chars, reversedOrder), 'same answer from a jumbled list').toBe(
      'ABCDEFGHIJKLMNOPQRSTUVWXY',
    )
  })

  it('sorts rows top to bottom and tiles left to right', () => {
    const { tiles, order } = mosaic(4, 3)
    const centres = order.map((id) => {
      const rect = (tiles.get(id) as MosaicTileLayout).structural
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })

    for (let i = 1; i < centres.length; i++) {
      const a = centres[i - 1]!
      const b = centres[i]!
      const sameRow = Math.abs(a.y - b.y) < 1
      if (sameRow) expect(b.x, `tile ${i}`).toBeGreaterThan(a.x)
      else expect(b.y, `tile ${i}`).toBeGreaterThan(a.y)
    }
  })

  it('keeps tiles of different heights in the same row when they line up', () => {
    /*
     * The tolerance is what makes an irregular mosaic still read as rows. Two
     * tiles that start at the same height are one row even when one is twice as
     * tall as the other, which is exactly what the partition produces once a
     * boundary has been pulled about.
     */
    const tiles = new Map<string, MosaicTileLayout>([
      ['tall', layoutOf({ x: 0, y: 0, width: 100, height: 200 })],
      ['short', layoutOf({ x: 100, y: 0, width: 100, height: 90 })],
      ['below', layoutOf({ x: 100, y: 90, width: 100, height: 110 })],
    ])
    // `tall` and `short` start together; `below` is a row of its own.
    // Same row, so left to right: `tall` starts at x = 0.
    expect(readingOrder(tiles)).toEqual(['tall', 'short', 'below'])
  })

  it('reads the other way when asked, without changing the rows', () => {
    // Right-to-left is a sort direction, not a different algorithm.
    const { tiles, order } = mosaic(3, 2, 'ABCDEF')
    const back = readingOrder(tiles, 'rtl')
    expect(back.slice(0, 3)).toEqual(order.slice(0, 3).reverse())
    expect(back.slice(3)).toEqual(order.slice(3).reverse())
  })

  it('does not move a single character when the geometry changes', () => {
    /*
     * The rule the whole model rests on. Pulling a boundary about changes which
     * tile is visited first; it must never change which tile holds which letter.
     */
    const { list, chars, x, y, order } = mosaic(3, 3, 'ABCDEFGHI')
    const before = Object.entries(chars).sort()

    // Every line shoved somewhere else entirely, so the tiles land elsewhere.
    const pulled = Object.fromEntries(Object.entries(x).map(([id], i) => [id, 0.2 + i * 0.05]))
    const moved = layoutMosaic(list, pulled, y, BOX, NONE)

    // The tiles really did move — otherwise this proves nothing.
    const shifted = order.filter(
      (id) => moved.get(id)!.structural.width !== tilesOf(list, x, y).get(id)!.structural.width,
    )
    expect(shifted.length, 'geometry changed').toBeGreaterThan(0)

    // And not one character went with them.
    expect(Object.entries(chars).sort()).toEqual(before)
    expect(readingOrder(moved).sort()).toEqual([...order].sort())
  })
})

describe('stepping through the order', () => {
  it('stops at either end rather than wrapping', () => {
    /*
     * Wrapping would read as the caret jumping, and the next keystroke would
     * overwrite the first tile — the opposite of what running out should do.
     */
    const { order } = mosaic(3, 1, 'ABC')
    expect(stepThrough(order, order[0]!, -1)).toBe(order[0])
    expect(stepThrough(order, order[2]!, 1)).toBe(order[2])
    expect(stepThrough(order, order[0]!, 1)).toBe(order[1])
    expect(stepThrough(order, order[2]!, -1)).toBe(order[1])
  })

  it('starts from the beginning when the caret is on nothing it knows', () => {
    const { order } = mosaic(2, 2)
    expect(stepThrough(order, 'gone', 1)).toBe(order[0])
  })
})

describe('arrow keys', () => {
  it('go to the tile in that direction, not the next one in reading order', () => {
    /*
     * The difference matters at the end of a row: reading order says "first tile
     * of the next row", and Down has to say "the tile below this one".
     */
    const { tiles, order } = mosaic(3, 3)
    const topRight = order[2] as string
    const middleRight = order[5] as string

    expect(tileInDirection(tiles, topRight, 'down')).toBe(middleRight)
    expect(tileInDirection(tiles, topRight, 'left')).toBe(order[1])
    expect(tileInDirection(tiles, topRight, 'right'), 'nothing to the right').toBeNull()
    expect(tileInDirection(tiles, topRight, 'up'), 'nothing above').toBeNull()
  })

  it('prefers a tile in line over a nearer one off to the side', () => {
    const { tiles, order } = mosaic(4, 4)
    // Straight down the second column, four times.
    let at = order[1] as string
    for (const expected of [order[5], order[9], order[13]]) {
      at = tileInDirection(tiles, at, 'down') as string
      expect(at).toBe(expected)
    }
  })

  it('says nothing rather than guessing at the edge', () => {
    const { tiles, order } = mosaic(2, 2)
    expect(tileInDirection(tiles, order[0] as string, 'up')).toBeNull()
    expect(tileInDirection(tiles, order[3] as string, 'down')).toBeNull()
  })
})

describe('typing', () => {
  it('puts a character in the focused tile and moves on', () => {
    const { chars, order } = mosaic(3, 1)
    const typed = typeCharacter(chars, order, order[0] as string, 'A')
    expect(characterAt(typed.chars, order[0] as string)).toBe('A')
    expect(typed.focus).toBe(order[1])
  })

  it('replaces what was already there', () => {
    // A tile holds one character, so typing into a full one is how you change it.
    const { chars, order } = mosaic(2, 1, 'AB')
    const typed = typeCharacter(chars, order, order[0] as string, 'Z')
    expect(letters(typed.chars, order)).toBe('ZB')
  })

  it('stays put on the last tile', () => {
    const { chars, order } = mosaic(2, 1, 'AB')
    const typed = typeCharacter(chars, order, order[1] as string, 'Z')
    expect(typed.focus).toBe(order[1])
    expect(letters(typed.chars, order)).toBe('AZ')
  })

  it('fills a 5x5 across its rows, in the order it is read', () => {
    const seed = mosaic(5, 5)
    let written = seed.chars
    const order = seed.order
    let focus = order[0] as string
    for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXY') {
      const typed = typeCharacter(written, order, focus, char)
      written = typed.chars
      focus = typed.focus as string
    }
    expect(letters(written, order)).toBe('ABCDEFGHIJKLMNOPQRSTUVWXY')
  })

  it('leaves a tile empty and keeps it usable', () => {
    // An empty tile is a real one — it takes its share of the mosaic and the
    // caret can sit in it.
    const { chars, order } = mosaic(3, 1, 'A')
    expect(letters(chars, order)).toBe('A··')
    const typed = typeCharacter(chars, order, order[2] as string, 'C')
    expect(letters(typed.chars, order)).toBe('A·C')
  })
})

describe('delete and backspace', () => {
  it('empties the tile and stays, on Delete', () => {
    const { chars, order } = mosaic(3, 1, 'ABC')
    const after = deleteCharacter(chars, order[1] as string)
    expect(letters(after.chars, order)).toBe('A·C')
    expect(after.focus).toBe(order[1])
  })

  it('empties the tile and stays, on Backspace with something in it', () => {
    // One press after typing undoes that keystroke without moving, which is what
    // the caret's position implies.
    const { chars, order } = mosaic(3, 1, 'ABC')
    const after = backspaceCharacter(chars, order, order[1] as string)
    expect(letters(after.chars, order)).toBe('A·C')
    expect(after.focus).toBe(order[1])
  })

  it('steps back and empties that one when the tile is already empty', () => {
    const { chars, order } = mosaic(3, 1, 'AB')
    const after = backspaceCharacter(chars, order, order[2] as string)
    expect(letters(after.chars, order)).toBe('A··')
    expect(after.focus).toBe(order[1])
  })

  it('has nowhere to go back to from the first tile', () => {
    const { chars, order } = mosaic(3, 1)
    const after = backspaceCharacter(chars, order, order[0] as string)
    expect(after.focus).toBe(order[0])
    expect(letters(after.chars, order)).toBe('···')
  })

  it('walks backwards through what was typed, one press at a time', () => {
    const seed = mosaic(4, 1, 'ABCD')
    let written = seed.chars
    const order = seed.order
    let focus = order[3] as string
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const after = backspaceCharacter(written, order, focus)
      written = after.chars
      focus = after.focus as string
      seen.push(letters(written, order))
    }
    expect(seen).toEqual(['ABC·', 'AB··', 'A···', '····'])
  })
})

describe('pasting', () => {
  it('fills consecutive tiles from the caret', () => {
    const { chars, order } = mosaic(3, 2)
    const after = pasteCharacters(chars, order, order[0] as string, 'HELLO')
    expect(letters(after.chars, order)).toBe('HELLO·')
    expect(after.dropped).toBe(0)
    expect(after.focus).toBe(order[5])
  })

  it('starts where the caret is, not at the beginning', () => {
    const { chars, order } = mosaic(4, 1, 'XY')
    const after = pasteCharacters(chars, order, order[2] as string, 'AB')
    expect(letters(after.chars, order)).toBe('XYAB')
  })

  it('places what fits and says how much did not', () => {
    /*
     * Dropped and counted rather than wrapped. Wrapping would overwrite the
     * beginning of the mosaic with the end of the paste, and saying nothing
     * would leave the user believing it all went in.
     */
    const { chars, order } = mosaic(2, 1)
    const after = pasteCharacters(chars, order, order[0] as string, 'ABCDE')
    expect(letters(after.chars, order)).toBe('AB')
    expect(after.dropped).toBe(3)
    expect(after.focus).toBe(order[1])
  })

  it('does nothing with nothing', () => {
    const { chars, order } = mosaic(2, 1, 'AB')
    const after = pasteCharacters(chars, order, order[0] as string, '')
    expect(letters(after.chars, order)).toBe('AB')
    expect(after.dropped).toBe(0)
  })
})

describe('what counts as one character', () => {
  it('keeps an accented letter whole', () => {
    // Composed and decomposed: the second is two code points and one character.
    expect(graphemes('é')).toEqual(['é'])
    expect(graphemes('é')).toEqual(['é'])
    expect(graphemes('café')).toEqual(['c', 'a', 'f', 'é'])
  })

  it('keeps an emoji whole, however many code points it is made of', () => {
    expect(graphemes('😀')).toEqual(['😀'])
    // A flag is two regional indicators; a family is people joined by ZWJs.
    expect(graphemes('🇬🇧')).toEqual(['🇬🇧'])
    expect(graphemes('👩‍👩‍👧')).toEqual(['👩‍👩‍👧'])
    expect(graphemes('a🇬🇧b')).toEqual(['a', '🇬🇧', 'b'])
  })

  it('puts one of them in one tile', () => {
    // The whole reason for any of this: half a letter in a tile and its accent
    // in the next would be what code-unit splitting produced.
    const { chars, order } = mosaic(3, 1)
    const after = pasteCharacters(chars, order, order[0] as string, 'é😀🇬🇧')
    expect(order.map((id) => characterAt(after.chars, id))).toEqual(['é', '😀', '🇬🇧'])
  })

  it('tells a typed character from a command key', () => {
    expect(isTypedCharacter('A', false)).toBe(true)
    expect(isTypedCharacter('é', false)).toBe(true)
    expect(isTypedCharacter('😀', false)).toBe(true)
    expect(isTypedCharacter(' ', false)).toBe(true)
    expect(isTypedCharacter('Enter', false)).toBe(false)
    expect(isTypedCharacter('ArrowLeft', false)).toBe(false)
    expect(isTypedCharacter('Backspace', false)).toBe(false)
    // ⌘A is a command, and its key is one letter.
    expect(isTypedCharacter('a', true)).toBe(false)
  })
})

describe('setting a character directly', () => {
  it('touches one leaf and leaves every other alone', () => {
    const { chars, order } = mosaic(3, 1, 'ABC')
    const after = setCharacter(chars, order[1] as string, 'Z')
    expect(letters(after, order)).toBe('AZC')
    // Keyed by the same tile ids: this is an edit, not a rebuild.
    expect(Object.keys(after).sort()).toEqual(Object.keys(chars).sort())
  })

  it('does nothing for a leaf that is not there', () => {
    const { chars, order } = mosaic(2, 1, 'AB')
    expect(letters(setCharacter(chars, 'gone', 'Z'), order)).toBe('AB')
  })
})

/** A tile layout whose three rectangles are all the same, for order tests. */
function layoutOf(rect: Rect): MosaicTileLayout {
  return { structural: rect, visible: rect, glyph: rect }
}
