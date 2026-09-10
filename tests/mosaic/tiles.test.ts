import { beforeEach, describe, expect, it } from 'vitest'

import { activeState, firstTile, tileAt, mosaicTiles } from '../../src/mosaic/tiles'

import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * Finding a tile by pointing at it.
 *
 * What the canvas asks on every press: which tile is under here. The answer has
 * to be "one of them" for any point inside the mosaic — a press that falls in a
 * gap and finds nothing reads as broken rather than as precise.
 */

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
})

function mosaic(columns = 4, rows = 3): LetterMosaicObject {
  const id = useDocumentStore.getState().createMosaic({
    columns,
    rows,
    artboardCenter: { x: 0, y: 0 },
  })
  return mosaicIn(useDocumentStore.getState().doc, id)
}

describe('the tile under a point', () => {
  it('finds one for every point inside the mosaic, gaps included', () => {
    /*
     * Measured against the STRUCTURAL rectangles, which tile the mosaic exactly.
     * The visible ones are inset by half a gap all round, so using those would
     * leave a lattice of dead ground between the tiles — and every press that
     * landed in it would do nothing.
     */
    const object = mosaic()
    const b = object.localBounds
    let misses = 0
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = {
          x: b.x + (b.width * i) / 20,
          y: b.y + (b.height * j) / 20,
        }
        if (!tileAt(object, point)) misses++
      }
    }
    expect(misses, 'points inside that hit nothing').toBe(0)
  })

  it('finds nothing outside', () => {
    // The mosaic's own box is the boundary: a press beyond it is a press on
    // something else, and the caret should leave rather than stay.
    const object = mosaic()
    const b = object.localBounds
    expect(tileAt(object, { x: b.x - 1, y: b.y })).toBeNull()
    expect(tileAt(object, { x: b.x, y: b.y - 1 })).toBeNull()
    expect(tileAt(object, { x: b.x + b.width + 1, y: b.y })).toBeNull()
    expect(tileAt(object, { x: b.x, y: b.y + b.height + 1 })).toBeNull()
  })

  it('finds the tile that is actually there', () => {
    const object = mosaic(3, 3)
    for (const [id, tile] of mosaicTiles(object)) {
      const centre = {
        x: tile.structural.x + tile.structural.width / 2,
        y: tile.structural.y + tile.structural.height / 2,
      }
      expect(tileAt(object, centre), id).toBe(id)
    }
  })
})

describe('where a new mosaic puts its caret', () => {
  it('is the top-left tile, not the tree\'s first leaf', () => {
    /*
     * The seed peels the first column into its own branch, so the tree's first
     * leaf is the top of that column — the top-left only by coincidence. On a
     * mosaic whose partition has been rearranged it would be somewhere else
     * entirely, and the caret would appear to start in the middle.
     */
    const object = mosaic(4, 3)
    const first = firstTile(object)
    expect(first).not.toBeNull()

    const tile = mosaicTiles(object).get(first as string)!.structural
    for (const [, other] of mosaicTiles(object)) {
      expect(other.structural.y + other.structural.height).toBeGreaterThan(tile.y)
    }
    // And it is the leftmost of that top row.
    const topRow = [...mosaicTiles(object).values()].filter(
      (t) => Math.abs(t.structural.y - tile.y) < 1,
    )
    expect(Math.min(...topRow.map((t) => t.structural.x))).toBeCloseTo(tile.x, 6)
  })

  it('has an answer even for a mosaic of one tile', () => {
    const object = mosaic(1, 1)
    expect(object.tiles).toHaveLength(1)
    expect(firstTile(object)).toBe(object.tiles[0]!.id)
  })
})

/**
 * Pointing at a tile in the state that is actually on screen.
 *
 * Every state moves the same lines to its own places, so a tile's rectangle is
 * a question about a STATE, not about the mosaic. Answering it from state 0
 * while the canvas draws state 3 means a press lands on whichever tile happens
 * to occupy that spot in the first composition — and a tile that has been
 * squeezed thin in the state on show becomes impossible to click, because the
 * point that looks like it is inside it belongs to its neighbour back in
 * state 0.
 */
describe('the tile under a point, per state', () => {
  /** Squeeze the top row down to a sliver in state 1, leaving state 0 alone. */
  function squeezed(): { object: LetterMosaicObject; line: string } {
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })
    const first = mosaicIn(useDocumentStore.getState().doc, id)
    const line = first.tiles[0]?.bottom as string
    useDocumentStore.getState().setMosaicCoordinates(id, 'y', [{ id: line, value: 0.1 }], 1)
    return { object: mosaicIn(useDocumentStore.getState().doc, id), line }
  }

  it('answers from the state it is asked about', () => {
    const { object } = squeezed()
    const b = object.localBounds
    // A quarter of the way down: still the top row in state 0, but well below
    // the squeezed row in state 1.
    const point = { x: b.x + b.width * 0.25, y: b.y + b.height * 0.25 }

    const inFirst = tileAt(object, point, 0)
    const inSecond = tileAt(object, point, 1)

    expect(inFirst).not.toBeNull()
    expect(inSecond).not.toBeNull()
    expect(inSecond, 'the same point belongs to different tiles in the two states').not.toBe(
      inFirst,
    )
  })

  it('can still reach a tile that the shown state has squeezed thin', () => {
    const { object } = squeezed()
    const b = object.localBounds
    // Inside the sliver the top-left tile has become in state 1.
    const point = { x: b.x + b.width * 0.25, y: b.y + b.height * 0.05 }

    expect(tileAt(object, point, 1)).toBe(object.tiles[0]?.id)
  })

  it('reads the first tile from the state on show too', () => {
    const { object } = squeezed()
    expect(firstTile(object, 1)).not.toBeNull()
  })
})

/**
 * A state index that has outlived its state.
 *
 * Which state is on show lives in ephemeral UI state, so it can name a state
 * that has since been deleted. Every panel showing the number clamps it to the
 * last one; the geometry has to agree, or the canvas draws a composition the
 * picker is not naming and presses land on rectangles nobody can see.
 */
describe('a stale state index', () => {
  it('means the last state, which is what the panels show', () => {
    const object = mosaic(2, 2)
    const store = useDocumentStore.getState()
    // Give the last state something of its own to be recognised by.
    const leaf = object.tiles[0]?.id as string
    store.setMosaicGlyphColour(object.id, object.states.length - 1, [leaf], '#ff0000')
    const after = mosaicIn(useDocumentStore.getState().doc, object.id)
    const last = after.states.length - 1

    expect(activeState(after, 99)).toBe(after.states[last])
    expect(activeState(after, -3), 'and below the start means the first').toBe(after.states[0])
  })

  it('lays the tiles out from that same state', () => {
    const object = mosaic(2, 2)
    const line = object.tiles[0]?.bottom as string
    const last = object.states.length - 1
    useDocumentStore
      .getState()
      .setMosaicCoordinates(object.id, 'y', [{ id: line, value: 0.1 }], last)
    const after = mosaicIn(useDocumentStore.getState().doc, object.id)

    const past = mosaicTiles(after, 99).get(after.tiles[0]?.id as string)
    const real = mosaicTiles(after, last).get(after.tiles[0]?.id as string)

    expect(past?.structural.height).toBeCloseTo(real?.structural.height ?? -1, 6)
  })
})
