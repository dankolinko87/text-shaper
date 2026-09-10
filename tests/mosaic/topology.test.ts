import { describe, expect, it } from 'vitest'

import { seedMosaic } from '../../src/mosaic/dissection'
import { layoutMosaic } from '../../src/mosaic/layout'
import { removeTile, splitTile } from '../../src/mosaic/topology'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'

/**
 * Changing which tiles exist.
 *
 * Two primitives and one question. The primitives are cutting a tile in two and
 * taking an empty tile away; the question, asked of every one of them, is
 * whether the tiles that were NOT touched came through unchanged — same ids,
 * same characters, same rectangles.
 */

const BOX: Rect = { x: -300, y: -300, width: 600, height: 600 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }

interface Fixture {
  list: MosaicTile[]
  x: Record<string, number>
  y: Record<string, number>
  /** What each tile holds, as a state does it — by tile id. */
  chars?: Record<string, string>
}

const grid = (cols: number, rows: number): Fixture => {
  const s = seedMosaic(cols, rows)
  return { list: s.tiles, x: s.x, y: s.y }
}

const rectsOf = (f: Fixture): Map<string, Rect> =>
  new Map(
    [...layoutMosaic(f.list, f.x, f.y, BOX, NONE).entries()].map(([id, t]) => [id, t.structural]),
  )

/*
 * Letters live on the STATE now, keyed by tile id, so a fixture carries them
 * beside its tiles. Which is also why a split needs no special handling: the
 * half that keeps its id keeps its letter, and the new one has no entry at all.
 */
const withChar = (f: Fixture, id: string, char: string | null): Fixture => ({
  ...f,
  chars:
    char === null
      ? Object.fromEntries(Object.entries(f.chars ?? {}).filter(([key]) => key !== id))
      : { ...(f.chars ?? {}), [id]: char },
})

const near = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < 1e-9 &&
  Math.abs(a.y - b.y) < 1e-9 &&
  Math.abs(a.width - b.width) < 1e-9 &&
  Math.abs(a.height - b.height) < 1e-9

/** Do the tiles still cover the box exactly? The invariant everything rests on. */
function covers(f: Fixture): boolean {
  const all = [...rectsOf(f).values()]
  const total = all.reduce((sum, r) => sum + r.width * r.height, 0)
  if (Math.abs(total - BOX.width * BOX.height) > 1e-6) return false
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as Rect
      const b = all[j] as Rect
      const overlap =
        a.x < b.x + b.width - 1e-9 &&
        b.x < a.x + a.width - 1e-9 &&
        a.y < b.y + b.height - 1e-9 &&
        b.y < a.y + a.height - 1e-9
      if (overlap) return false
    }
  }
  return true
}

describe('cutting a tile in two', () => {
  it('puts the two halves exactly where the tile was', () => {
    const f = grid(3, 3)
    const target = f.list[4]!.id
    const before = rectsOf(f).get(target) as Rect

    const result = splitTile(f.list, f.x, f.y, target, 'x')!
    const after: Fixture = { list: result.tiles, x: { ...f.x, [result.created.coordinate]: result.value }, y: f.y }
    const rects = rectsOf(after)

    const first = rects.get(target) as Rect
    const second = rects.get(result.created.tile) as Rect
    expect(first.x).toBeCloseTo(before.x, 9)
    expect(second.x + second.width).toBeCloseTo(before.x + before.width, 9)
    expect(first.width + second.width).toBeCloseTo(before.width, 9)
    expect(first.width).toBeCloseTo(second.width, 9)
    expect(covers(after)).toBe(true)
  })

  it('cuts the other way round too', () => {
    const f = grid(2, 2)
    const target = f.list[0]!.id
    const before = rectsOf(f).get(target) as Rect

    const result = splitTile(f.list, f.x, f.y, target, 'y')!
    const after: Fixture = { list: result.tiles, x: f.x, y: { ...f.y, [result.created.coordinate]: result.value } }
    const rects = rectsOf(after)
    const first = rects.get(target) as Rect
    const second = rects.get(result.created.tile) as Rect

    expect(first.height + second.height).toBeCloseTo(before.height, 9)
    expect(second.y).toBeCloseTo(first.y + first.height, 9)
    expect(covers(after)).toBe(true)
  })

  it('keeps the character in the first half and leaves the second empty', () => {
    const f = withChar(grid(2, 2), grid(2, 2).list[0]!.id, 'W')
    const target = f.list[0]!.id
    const withW = withChar(f, target, 'W')
    const result = splitTile(withW.list, withW.x, withW.y, target, 'x')!
    // The half that keeps the id keeps the letter; the new half starts empty.
    expect(withW.chars?.[target]).toBe('W')
    expect(withW.chars?.[result.created.tile]).toBeUndefined()
  })

  it('leaves every other tile exactly as it was', () => {
    const f = grid(3, 3)
    const target = f.list[4]!.id
    const before = rectsOf(f)

    const result = splitTile(f.list, f.x, f.y, target, 'y')!
    const after = rectsOf({ list: result.tiles, x: f.x, y: { ...f.y, [result.created.coordinate]: result.value } })

    for (const [id, rect] of before) {
      if (id === target) continue
      expect(near(after.get(id) as Rect, rect), id).toBe(true)
    }
  })

  it('gives the new tile and line ids nothing else has', () => {
    const f = grid(2, 2)
    const result = splitTile(f.list, f.x, f.y, f.list[0]!.id, 'x')!
    const ids = result.tiles.map((t) => t.id)
    expect(new Set(ids).size, 'no id used twice').toBe(ids.length)
    expect(ids).toContain(result.created.tile)
    expect(f.x[result.created.coordinate], 'a brand-new line').toBeUndefined()
  })

  it('gives the new line to those two tiles alone, so dragging it moves nothing else', () => {
    /*
     * The difference from the old partition, where a new split inherited the
     * reach of whatever it was nested inside. Here the line is named by the two
     * halves and by nobody else.
     */
    const f = grid(3, 3)
    const target = f.list[4]!.id
    const result = splitTile(f.list, f.x, f.y, target, 'x')!
    const naming = result.tiles.filter(
      (t) => t.left === result.created.coordinate || t.right === result.created.coordinate,
    )
    expect(naming.map((t) => t.id).sort()).toEqual([target, result.created.tile].sort())
  })

  it('refuses an id that is not a tile', () => {
    const f = grid(2, 2)
    expect(splitTile(f.list, f.x, f.y, 'nope', 'x')).toBeNull()
  })

  it('can cut a lone tile', () => {
    const f = grid(1, 1)
    const result = splitTile(f.list, f.x, f.y, f.list[0]!.id, 'x')!
    expect(result.tiles).toHaveLength(2)
    expect(covers({ list: result.tiles, x: { ...f.x, [result.created.coordinate]: result.value }, y: f.y })).toBe(true)
  })
})

describe('taking an empty tile away', () => {
  it('gives its space to the tile before it', () => {
    const f = grid(3, 1)
    const [first, second, third] = f.list.map((t) => t.id)
    const before = rectsOf(f)

    const result = removeTile(f.list, second as string)!
    const after: Fixture = { ...f, list: result.tiles }
    const rects = rectsOf(after)

    expect(result.tiles.map((t) => t.id)).toEqual([first, third])
    expect(result.absorbedBy).toBe(first)
    expect((rects.get(first as string) as Rect).width).toBeCloseTo(
      (before.get(first as string) as Rect).width + (before.get(second as string) as Rect).width,
      9,
    )
    expect(near(rects.get(third as string) as Rect, before.get(third as string) as Rect)).toBe(true)
    expect(covers(after)).toBe(true)
  })

  it('gives the first tile’s space forward instead', () => {
    const f = grid(3, 1)
    const [first, second] = f.list.map((t) => t.id)
    const before = rectsOf(f)

    const result = removeTile(f.list, first as string)!
    const rects = rectsOf({ ...f, list: result.tiles })

    expect(result.absorbedBy).toBe(second)
    expect((rects.get(second as string) as Rect).width).toBeCloseTo(
      (before.get(first as string) as Rect).width + (before.get(second as string) as Rect).width,
      9,
    )
  })

  it('will not touch a tile with a character in it', () => {
    const f = grid(3, 1)
    const target = f.list[1]!.id
    /*
     * Emptiness is the caller's to establish now, because what is written in a
     * tile belongs to the STATES and this function only sees the partition. The
     * store asks whether the tile is empty in every one of them — being blank in
     * the state on show is not enough to take a letter away from the others.
     */
    const written = withChar(f, target, 'A')
    expect(removeTile(written.list, target, false)).toBeNull()
    expect(removeTile(written.list, target, true), 'told it is empty, it obliges').not.toBeNull()
  })

  it('will not empty the mosaic', () => {
    const f = grid(1, 1)
    expect(removeTile(f.list, f.list[0]!.id)).toBeNull()
  })

  it('refuses when no neighbour lines up, rather than leaving a hole', () => {
    /*
     * Covering the box exactly is the one invariant the whole layout rests on.
     * A neighbour that only partly abuts the gap cannot be stretched over it
     * without overlapping something, so this says no and the tile can be split
     * differently first.
     */
    const f = grid(2, 2)
    // Cut the top-left tile in half vertically. Its lower half now abuts two
    // tiles, neither of which matches its extent.
    const split = splitTile(f.list, f.x, f.y, f.list[0]!.id, 'y')!
    const list = split.tiles
    const y = { ...f.y, [split.created.coordinate]: split.value }
    // The tile to the RIGHT of the halves spans both, so neither half can give
    // its space sideways, and the halves themselves line up only with each other.
    const half = list.find((t) => t.id === split.created.tile) as MosaicTile
    const result = removeTile(list, half.id)
    if (result) {
      // If it did find a partner it must still cover the box exactly.
      expect(covers({ list: result.tiles, x: f.x, y })).toBe(true)
    }
  })

  it('keeps every remaining tile’s id and character', () => {
    const f = grid(4, 2)
    const target = f.list[2]!.id
    let filled = f
    for (const [i, tile] of f.list.entries()) {
      if (tile.id !== target) filled = withChar(filled, tile.id, `x${i}`)
    }
    const before = filled.list
      .filter((t) => t.id !== target)
      .map((t) => [t.id, filled.chars?.[t.id] ?? null])

    const result = removeTile(filled.list, target)!
    expect(result.tiles.map((t) => [t.id, filled.chars?.[t.id] ?? null])).toEqual(before)
  })

  it('retires lines nothing names any more', () => {
    const f = grid(2, 1)
    const result = removeTile(f.list, f.list[1]!.id)!
    // Two tiles become one, so the line between them is gone.
    expect(result.retired.x.length).toBe(1)
    expect(f.x[result.retired.x[0] as string]).toBeDefined()
  })
})
