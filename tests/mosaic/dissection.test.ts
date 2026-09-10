import { describe, expect, it } from 'vitest'

import {
  copyMosaicIdentity,
  forkCoordinate,
  initialState,
  mergeCoordinates,
  seedMosaic,
  withCharacters,
} from '../../src/mosaic/dissection'
import { layoutMosaic } from '../../src/mosaic/layout'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'
import { X_MAX, X_MIN, Y_MAX, Y_MIN, isRim } from '../../src/types/mosaic'

/**
 * The tiles and the lines they name.
 *
 * The one thing worth stating over and over: sharing a coordinate IS alignment.
 * A fresh grid shares every line, so it behaves like a grid; a tile stops being
 * aligned only when a line is deliberately forked for it, and nothing about the
 * mosaic moves when that happens.
 */

const BOX: Rect = { x: 0, y: 0, width: 400, height: 400 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }

const rectsOf = (s: ReturnType<typeof seedMosaic>) =>
  layoutMosaic(s.tiles, s.x, s.y, BOX, NONE)

describe('seeding a grid', () => {
  it('makes columns × rows tiles, evenly spaced', () => {
    for (const [cols, rows] of [
      [1, 1],
      [3, 2],
      [4, 4],
    ] as const) {
      const seeded = seedMosaic(cols, rows)
      expect(seeded.tiles, `${cols}x${rows}`).toHaveLength(cols * rows)

      const rects = [...rectsOf(seeded).values()].map((t) => t.structural)
      const widths = new Set(rects.map((r) => Math.round(r.width * 1e6)))
      const heights = new Set(rects.map((r) => Math.round(r.height * 1e6)))
      expect(widths.size, 'one width').toBe(1)
      expect(heights.size, 'one height').toBe(1)
      expect([...widths][0]! / 1e6).toBeCloseTo(BOX.width / cols, 6)
    }
  })

  it('shares every line, so a fresh grid is fully aligned', () => {
    /*
     * The whole reason a grid behaves like a grid. Tiles in a column read the
     * same left and right; tiles in a row read the same top and bottom. Moving
     * one line moves the column, which is what should happen until somebody says
     * otherwise.
     */
    const seeded = seedMosaic(3, 3)
    const rects = rectsOf(seeded)
    const columns = new Map<string, Set<string>>()
    for (const tile of seeded.tiles) {
      const at = Math.round((rects.get(tile.id) as { structural: Rect }).structural.x)
      if (!columns.has(String(at))) columns.set(String(at), new Set())
      columns.get(String(at))!.add(tile.left)
    }
    // Every tile in a column names ONE left coordinate between them.
    for (const [, ids] of columns) expect(ids.size).toBe(1)
  })

  it('bounds the outside with the rim, which is never stored', () => {
    const seeded = seedMosaic(2, 2)
    const outer = seeded.tiles.filter((t) => t.left === X_MIN)
    expect(outer.length).toBeGreaterThan(0)
    expect(seeded.tiles.some((t) => t.right === X_MAX)).toBe(true)
    expect(seeded.tiles.some((t) => t.top === Y_MIN)).toBe(true)
    expect(seeded.tiles.some((t) => t.bottom === Y_MAX)).toBe(true)

    // The rim is a constant, so a state never stores a number for it and can
    // never disagree with itself about where the edge of the mosaic is.
    const state = initialState(seeded.x, seeded.y, { fontId: 'anton', weight: 400, italic: false })
    for (const id of Object.keys(state.x)) expect(isRim(id)).toBe(false)
    for (const id of Object.keys(state.y)) expect(isRim(id)).toBe(false)
  })

  it('fills tiles from a string and leaves the rest empty', () => {
    const seeded = seedMosaic(3, 2)
    const filled = withCharacters(seeded.tiles, 'ABCD')
    // Keyed by tile, in tree order, and an empty tile has no entry at all.
    expect(seeded.tiles.map((tile) => filled[tile.id] ?? null)).toEqual([
      'A',
      'B',
      'C',
      'D',
      null,
      null,
    ])
  })
})

describe('duplicating a mosaic', () => {
  it('shares no id with its original, and lays out identically', () => {
    const seeded = seedMosaic(3, 2)
    const tiles = seeded.tiles
    const written = withCharacters(tiles, 'ABCDEF')
    const states = [
      {
        ...initialState(seeded.x, seeded.y, { fontId: 'anton', weight: 400, italic: false }),
        chars: written,
      },
    ]
    const copy = copyMosaicIdentity(tiles, states)

    const originals = new Set(tiles.map((t) => t.id))
    for (const tile of copy.tiles) expect(originals.has(tile.id), tile.id).toBe(false)

    // Coordinates too: two mosaics sharing one would read each other's numbers.
    const usedX = new Set(tiles.flatMap((t) => [t.left, t.right]).filter((id) => !isRim(id)))
    for (const tile of copy.tiles) {
      for (const id of [tile.left, tile.right]) {
        if (!isRim(id)) expect(usedX.has(id), id).toBe(false)
      }
    }

    // Same picture, same letters.
    const before = [...layoutMosaic(tiles, seeded.x, seeded.y, BOX, NONE).values()]
    const after = [...layoutMosaic(copy.tiles, copy.states[0]!.x, copy.states[0]!.y, BOX, NONE).values()]
    expect(after.map((t) => t.structural)).toEqual(before.map((t) => t.structural))
    // The letters came with the copy, remapped onto its own tile ids.
    expect(copy.tiles.map((tile) => copy.states[0]!.chars[tile.id] ?? null)).toEqual(
      tiles.map((tile) => written[tile.id] ?? null),
    )
  })

  it('keeps the rim shared, because it is a constant rather than an identity', () => {
    const seeded = seedMosaic(2, 2)
    const copy = copyMosaicIdentity(seeded.tiles, [initialState(seeded.x, seeded.y, { fontId: 'anton', weight: 400, italic: false })])
    expect(copy.tiles.some((t) => t.left === X_MIN)).toBe(true)
    expect(copy.tiles.some((t) => t.bottom === Y_MAX)).toBe(true)
  })
})

describe('forking a line', () => {
  /** The interior vertical line of a 2-column grid, and the tiles either side. */
  const twoByTwo = () => {
    const seeded = seedMosaic(2, 2)
    const interior = Object.keys(seeded.x).find((id) => !isRim(id)) as string
    return { seeded, interior }
  }

  it('moves nothing, and gives the chosen tiles a line of their own', () => {
    const { seeded, interior } = twoByTwo()
    const rects = rectsOf(seeded)
    // The top row only: y from 0 to 0.5.
    const result = forkCoordinate(seeded.tiles, seeded.x, 'x', interior, { from: 0, to: 0.5 }, seeded.y)
    expect(result).toBeTruthy()
    if (!result) return

    expect(result.created).not.toBe(interior)
    expect(result.value).toBeCloseTo(0.5, 9)

    // Nothing has moved: the new line starts exactly where the old one is.
    const after = layoutMosaic(
      result.tiles,
      { ...seeded.x, [result.created]: result.value },
      seeded.y,
      BOX,
      NONE,
    )
    for (const tile of seeded.tiles) {
      expect(after.get(tile.id)!.structural, tile.id).toEqual(rects.get(tile.id)!.structural)
    }

    // And the top row now reads the new line while the bottom keeps the old.
    const top = result.tiles.filter((t) => t.top === Y_MIN)
    const bottom = result.tiles.filter((t) => t.bottom === Y_MAX)
    expect(top.some((t) => t.left === result.created || t.right === result.created)).toBe(true)
    expect(bottom.some((t) => t.left === interior || t.right === interior)).toBe(true)
  })

  it('repoints BOTH sides of the line, or the halves would come apart', () => {
    const { seeded, interior } = twoByTwo()
    const result = forkCoordinate(seeded.tiles, seeded.x, 'x', interior, { from: 0, to: 0.5 }, seeded.y)!
    const touching = result.tiles.filter(
      (t) => t.top === Y_MIN && (t.left === result.created || t.right === result.created),
    )
    // The tile left of the line and the tile right of it, both repointed.
    expect(touching).toHaveLength(2)
  })

  it('swallows a straddling tile whole rather than tearing it', () => {
    /*
     * Repointing a tile that is partly inside the span would move one of its
     * corners and not the other, which is a tile torn in half. So the span grows
     * to take that tile entirely — reaching further than was asked for, and
     * saying so, which is much better than refusing and leaving the line shared
     * with everything.
     */
    const { seeded, interior } = twoByTwo()
    // Half of the top row: every tile touching the line straddles this.
    const result = forkCoordinate(
      seeded.tiles,
      seeded.x,
      'x',
      interior,
      { from: 0, to: 0.25 },
      seeded.y,
    )
    expect(result).toBeTruthy()
    if (!result) return

    // It grew to the whole of the top row, and says as much. One run in, one
    // run out — widening a run never splits it.
    expect(result.covers).toHaveLength(1)
    expect(result.covers[0]?.from).toBeCloseTo(0, 9)
    expect(result.covers[0]?.to).toBeCloseTo(0.5, 9)

    // Nothing was torn: every tile still has four corners in the right places.
    const after = layoutMosaic(
      result.tiles,
      { ...seeded.x, [result.created]: result.value },
      seeded.y,
      BOX,
      NONE,
    )
    const before = rectsOf(seeded)
    for (const tile of seeded.tiles) {
      expect(after.get(tile.id)!.structural, tile.id).toEqual(before.get(tile.id)!.structural)
    }
  })

  it('refuses a line nothing in the span names', () => {
    const { seeded, interior } = twoByTwo()
    expect(
      forkCoordinate(seeded.tiles, seeded.x, 'x', interior, { from: 2, to: 3 }, seeded.y),
    ).toBeNull()
  })
})

describe('putting a forked line back together', () => {
  /*
   * Forking is silent and, until this existed, one-way: every drag that stopped
   * a column following one tile left another coordinate behind. Lines a third of
   * a unit apart look level and can never move together again, so a mosaic drifts
   * out of alignment one gesture at a time. Snapping is what makes two separate
   * drags land on the very same number; this is what that number is FOR.
   */
  const forked = () => {
    const seeded = seedMosaic(3, 3)
    const middle = seeded.tiles[4] as MosaicTile
    const result = forkCoordinate(
      seeded.tiles,
      seeded.x,
      'x',
      middle.left,
      { from: 1 / 3, to: 2 / 3 },
      seeded.y,
    )
    if (!result) throw new Error('the fixture expects this fork to be possible')
    return { seeded, result, x: { ...seeded.x, [result.created]: result.value } }
  }

  it('unifies two lines holding the same value', () => {
    const { seeded, result, x } = forked()
    const middleLeft = (seeded.tiles[4] as MosaicTile).left
    expect(Object.keys(x).length, 'the fork minted a line').toBe(Object.keys(seeded.x).length + 1)

    const merged = mergeCoordinates(result.tiles, [x], 'x')
    expect(merged, 'they hold the same value, so they are one line').toBeTruthy()
    // Exactly one goes. WHICH one is free here — the values are equal, so both
    // describe the same layout; a gesture picks deliberately, further down.
    expect(merged?.retired).toHaveLength(1)
    expect([middleLeft, result.created]).toContain(merged?.retired[0])
    // No tile names the retired line any more, whichever of the two it was.
    const gone = merged?.retired[0]
    for (const tile of merged?.tiles ?? []) {
      expect(tile.left).not.toBe(gone)
      expect(tile.right).not.toBe(gone)
    }
  })

  it('changes no rectangle at all — the two describe the same layout', () => {
    const { seeded, result, x } = forked()
    const before = layoutMosaic(result.tiles, x, seeded.y, BOX, NONE)
    const merged = mergeCoordinates(result.tiles, [x], 'x')
    const kept = { ...x }
    for (const id of merged?.retired ?? []) delete kept[id]
    const after = layoutMosaic(merged?.tiles ?? [], kept, seeded.y, BOX, NONE)

    expect(after.size).toBe(before.size)
    for (const [id, was] of before) {
      const now = after.get(id)?.structural
      expect(now, `${id} survived`).toBeTruthy()
      expect(now?.x).toBeCloseTo(was.structural.x, 12)
      expect(now?.y).toBeCloseTo(was.structural.y, 12)
      expect(now?.width).toBeCloseTo(was.structural.width, 12)
      expect(now?.height).toBeCloseTo(was.structural.height, 12)
    }
  })

  it('leaves lines that came to rest apart alone', () => {
    const { result, x } = forked()
    // The drag that followed the fork moved it somewhere else.
    const moved = { ...x, [result.created]: (result.value as number) + 0.05 }
    expect(mergeCoordinates(result.tiles, [moved], 'x')).toBeNull()
  })

  /*
   * A state says where the lines of a given set of tiles sit. Two that coincide
   * in the state on show but part company in another are genuinely different
   * lines, and joining them would flatten the animation between them into a still.
   */
  it('refuses when another state tells them apart', () => {
    const { seeded, result, x } = forked()
    const elsewhere = { ...x, [result.created]: (result.value as number) + 0.05 }
    expect(mergeCoordinates(result.tiles, [x, elsewhere], 'x')).toBeNull()
    // ...and agrees again once every state does.
    expect(mergeCoordinates(result.tiles, [x, { ...x }], 'x')).toBeTruthy()
    void seeded
  })

  it('only considers the lines a gesture wrote', () => {
    const { result, x } = forked()
    const untouched = new Set(['mc_nothing_the_drag_moved'])
    expect(mergeCoordinates(result.tiles, [x], 'x', untouched)).toBeNull()
    expect(mergeCoordinates(result.tiles, [x], 'x', new Set([result.created]))).toBeTruthy()
  })

  it('dissolves the fork back into the line it came from, not the reverse', () => {
    const { seeded, result, x } = forked()
    const original = (seeded.tiles[4] as MosaicTile).left
    const merged = mergeCoordinates(result.tiles, [x], 'x', new Set([result.created]))
    expect(merged?.retired, 'the newcomer is the one that goes').toEqual([result.created])
    for (const tile of merged?.tiles ?? []) {
      if (tile.left === result.created || tile.right === result.created) {
        throw new Error('a tile still names the retired line')
      }
    }
    // The tiles that were repointed at the fork are back on the original.
    const middle = merged?.tiles.find((t) => t.id === (seeded.tiles[4] as MosaicTile).id)
    expect(middle?.left).toBe(original)
  })

  it('has nothing to do on a fresh grid, where every line is already shared', () => {
    const seeded = seedMosaic(4, 4)
    expect(mergeCoordinates(seeded.tiles, [seeded.x], 'x')).toBeNull()
    expect(mergeCoordinates(seeded.tiles, [seeded.y], 'y')).toBeNull()
  })
})
