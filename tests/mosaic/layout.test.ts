import { describe, expect, it } from 'vitest'

import { seedMosaic } from '../../src/mosaic/dissection'
import { layoutMosaic } from '../../src/mosaic/layout'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'

/**
 * From coordinates to the rectangles on screen.
 *
 * Two properties carry the whole feature. The structural rectangles must COVER
 * their box — no overlaps, no holes, nothing outside — because that is what
 * makes any set of coordinates a valid layout and therefore what makes an
 * animation between two layouts valid at every frame. And the gap must be the
 * same everywhere, including where a tile meets two others, because a gap that
 * varies with position is a gap that looks like a mistake.
 */

const BOX: Rect = { x: -300, y: -300, width: 600, height: 600 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }
const spacing = (patch: Partial<MosaicSpacing>): MosaicSpacing => ({ ...NONE, ...patch })

interface Fixture {
  list: MosaicTile[]
  x: Record<string, number>
  y: Record<string, number>
}

const grid = (cols: number, rows: number): Fixture => {
  const seeded = seedMosaic(cols, rows)
  return { list: seeded.tiles, x: seeded.x, y: seeded.y }
}

function rects(
  f: Fixture,
  space: MosaicSpacing = NONE,
  which: 'structural' | 'visible' | 'glyph' = 'structural',
  box: Rect = BOX,
): Rect[] {
  const tiles = layoutMosaic(f.list, f.x, f.y, box, space)
  return f.list.map((tile) => {
    const found = tiles.get(tile.id)
    if (!found) throw new Error(`no rectangle for tile ${tile.id}`)
    return found[which]
  })
}

const area = (r: Rect): number => r.width * r.height

function overlaps(a: Rect, b: Rect): boolean {
  const slack = 1e-9
  return (
    a.x < b.x + b.width - slack &&
    b.x < a.x + a.width - slack &&
    a.y < b.y + b.height - slack &&
    b.y < a.y + a.height - slack
  )
}

describe('covering the box', () => {
  it('covers it exactly, at any size and any coordinates', () => {
    /*
     * The property everything else rests on. If the tiles cover the box for ANY
     * set of coordinates, then a drag can never produce an invalid layout and
     * neither can a frame halfway between two of them.
     */
    for (const [cols, rows] of [
      [1, 1],
      [2, 1],
      [1, 4],
      [3, 3],
      [5, 4],
    ] as const) {
      const f = grid(cols, rows)
      const all = rects(f)
      expect(all).toHaveLength(cols * rows)

      const total = all.reduce((sum, r) => sum + area(r), 0)
      expect(total, `${cols}x${rows} fills the box`).toBeCloseTo(area(BOX), 6)

      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          expect(overlaps(all[i] as Rect, all[j] as Rect), `${i} and ${j} overlap`).toBe(false)
        }
      }
      for (const r of all) {
        expect(r.x).toBeGreaterThanOrEqual(BOX.x - 1e-9)
        expect(r.y).toBeGreaterThanOrEqual(BOX.y - 1e-9)
        expect(r.x + r.width).toBeLessThanOrEqual(BOX.x + BOX.width + 1e-9)
        expect(r.y + r.height).toBeLessThanOrEqual(BOX.y + BOX.height + 1e-9)
      }
    }
  })

  it('still covers it wherever the lines are pushed, so long as they keep their order', () => {
    /*
     * Coverage is now a property of the COORDINATES rather than of a
     * construction, so it has to hold for numbers nobody vetted — but only while
     * they stay in order. Ordering is exactly what the drag clamp guarantees:
     * a line can never be pushed past its neighbour, because the tile between
     * them stops it at its minimum first.
     */
    const f = grid(4, 4)
    const shove = (values: Record<string, number>, at: number[]): Record<string, number> => {
      const interior = Object.entries(values)
        .filter(([, v]) => v > 0 && v < 1)
        .sort((a, b) => a[1] - b[1])
      return Object.fromEntries(
        interior.map(([id], i) => [id, at[i] as number]),
      )
    }
    const moved = { ...f, x: shove(f.x, [0.05, 0.5, 0.93]), y: shove(f.y, [0.8, 0.85, 0.9]) }

    const all = rects(moved)
    const total = all.reduce((sum, r) => sum + area(r), 0)
    expect(total).toBeCloseTo(area(BOX), 6)
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(overlaps(all[i] as Rect, all[j] as Rect)).toBe(false)
      }
    }
  })
})

describe('the gap', () => {
  /** The smallest space between any two tiles that are not the same tile. */
  function narrowestSeam(list: Rect[]): number {
    let seam = Infinity
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        if (overlapY > 1e-6) seam = Math.min(seam, Math.abs(b.x - (a.x + a.width)))
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        if (overlapX > 1e-6) seam = Math.min(seam, Math.abs(b.y - (a.y + a.height)))
      }
    }
    return seam
  }

  it('leaves touching tiles when it is zero', () => {
    const f = grid(3, 4)
    const total = rects(f, NONE, 'visible').reduce((sum, r) => sum + area(r), 0)
    expect(total).toBeCloseTo(area(BOX), 4)
  })

  it('is exactly one gap between neighbours, everywhere', () => {
    for (const [cols, rows] of [
      [3, 3],
      [4, 2],
      [5, 5],
    ] as const) {
      const f = grid(cols, rows)
      for (const gap of [4, 20]) {
        expect(
          narrowestSeam(rects(f, spacing({ gap }), 'visible')),
          `${cols}x${rows} at gap ${gap}`,
        ).toBeCloseTo(gap, 6)
      }
    }
  })

  it('takes nothing off the rim of the mosaic', () => {
    // The outside is what `outerPadding` answers for. Half a gap taken off the
    // true edge would read as padding nobody asked for.
    const f = grid(3, 3)
    const all = rects(f, spacing({ gap: 30 }), 'visible')
    expect(Math.min(...all.map((r) => r.x))).toBeCloseTo(BOX.x, 6)
    expect(Math.min(...all.map((r) => r.y))).toBeCloseTo(BOX.y, 6)
    expect(Math.max(...all.map((r) => r.x + r.width))).toBeCloseTo(BOX.x + BOX.width, 6)
    expect(Math.max(...all.map((r) => r.y + r.height))).toBeCloseTo(BOX.y + BOX.height, 6)
  })

  it('is unchanged by padding and by the glyph inset', () => {
    const f = grid(4, 4)
    const plain = narrowestSeam(rects(f, spacing({ gap: 12 }), 'visible'))
    const padded = narrowestSeam(rects(f, spacing({ gap: 12, outerPadding: 40 }), 'visible'))
    const inset = narrowestSeam(rects(f, spacing({ gap: 12, glyphInset: 9 }), 'visible'))
    expect(padded).toBeCloseTo(plain, 6)
    expect(inset).toBeCloseTo(plain, 6)
  })
})

describe('outer padding', () => {
  it('is applied before the coordinates are read, so every tile shrinks alike', () => {
    const f = grid(3, 4)
    const before = rects(f)
    const after = rects(f, spacing({ outerPadding: 60 }))
    const shrink = (BOX.width - 120) / BOX.width

    for (let i = 0; i < before.length; i++) {
      const a = before[i] as Rect
      const b = after[i] as Rect
      expect(b.width / a.width, `tile ${i} width`).toBeCloseTo(shrink, 6)
      expect(b.height / a.height, `tile ${i} height`).toBeCloseTo(shrink, 6)
    }
  })
})

describe('the glyph rectangle', () => {
  it('is the visible one inset, and leaves the tiles alone', () => {
    const f = grid(3, 3)
    const visible = rects(f, spacing({ gap: 10 }), 'visible')
    const glyph = rects(f, spacing({ gap: 10, glyphInset: 12 }), 'glyph')
    const stillVisible = rects(f, spacing({ gap: 10, glyphInset: 12 }), 'visible')

    for (let i = 0; i < visible.length; i++) {
      expect(stillVisible[i], `tile ${i} untouched`).toEqual(visible[i])
      expect((glyph[i] as Rect).width).toBeCloseTo((visible[i] as Rect).width - 24, 6)
      expect((glyph[i] as Rect).height).toBeCloseTo((visible[i] as Rect).height - 24, 6)
    }
  })

  it('collapses rather than turning inside out', () => {
    const f = grid(2, 2)
    for (const r of rects(f, spacing({ glyphInset: 5000 }), 'glyph')) {
      expect(r.width).toBeGreaterThanOrEqual(0)
      expect(r.height).toBeGreaterThanOrEqual(0)
    }
  })
})
