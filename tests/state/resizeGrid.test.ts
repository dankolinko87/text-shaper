import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import { isRim } from '../../src/types/mosaic'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * Changing how many cells a mosaic has, after it has been drawn.
 *
 * Global rather than per state, and that is a fact about the model rather than a
 * simplification: every state shares one set of tiles, and a frame between two
 * states blends their coordinates tile by tile. Two states with different grids
 * would have no tiles in common to blend, so there would be nothing to
 * interpolate and the letters themselves would come and go.
 *
 * What IS kept per state is where the lines sit on an axis whose count did not
 * change — resizing the columns has nothing to say about the rows.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

function make(columns = 3, rows = 3, text = 'ABCDEFGHI'): string {
  const id = store().createMosaic({ columns, rows, artboardCenter: { x: 0, y: 0 }, text })
  store().commit('Draw mosaic')
  return id
}

const object = (id: string) => mosaicIn(store().doc, id)
const letters = (id: string, at = 0) => {
  const mosaic = object(id)
  return mosaic.tiles.map((tile) => mosaic.states[at]!.chars[tile.id] ?? '_').join('')
}

/** Every tile's rectangle, per state, so overlaps and gaps would show. */
function covers(mosaic: LetterMosaicObject, at: number): boolean {
  const state = mosaic.states[at]!
  const value = (values: Record<string, number>, line: string): number =>
    isRim(line) ? (line.endsWith('min') ? 0 : 1) : (values[line] ?? Number.NaN)
  let area = 0
  for (const tile of mosaic.tiles) {
    const w = value(state.x, tile.right) - value(state.x, tile.left)
    const h = value(state.y, tile.bottom) - value(state.y, tile.top)
    if (!(w > 0) || !(h > 0)) return false
    area += w * h
  }
  return Math.abs(area - 1) < 1e-9
}

describe('resizing the grid', () => {
  it('makes the cells the size that was asked for', () => {
    const id = make(3, 3)
    expect(store().resizeMosaicGrid(id, 5, 2)).toBe(true)
    expect(object(id).tiles.length).toBe(10)
    expect(object(id).seed).toEqual({ columns: 5, rows: 2 })
  })

  it('still partitions the box, in every state', () => {
    const id = make(3, 3)
    store().resizeMosaicGrid(id, 5, 4)
    const after = object(id)
    for (let at = 0; at < after.states.length; at++) {
      expect(covers(after, at), `state ${at}`).toBe(true)
    }
  })

  it('keeps the letters, in reading order, when it grows', () => {
    const id = make(3, 3)
    store().resizeMosaicGrid(id, 4, 3)
    // The nine letters stay where they read; the new cells arrive empty.
    expect(letters(id).slice(0, 9)).toBe('ABCDEFGHI')
    expect(object(id).tiles.length).toBe(12)
  })

  it('keeps the ids the letters live on, so colours follow them', () => {
    const id = make(3, 3)
    const first = object(id).tiles[0]!.id
    store().setMosaicGlyphColour(id, 0, [first], '#ff0000')
    store().commit('Colour letters')

    store().resizeMosaicGrid(id, 4, 4)

    const after = object(id)
    expect(after.tiles[0]!.id, 'the first tile is the same tile').toBe(first)
    expect(after.states[0]!.glyphColour[first]).toBe('#ff0000')
  })

  it('drops the letters that no longer have a cell, and their colours with them', () => {
    const id = make(3, 3)
    const last = object(id).tiles[8]!.id
    store().setMosaicGlyphColour(id, 0, [last], '#00ff00')
    store().commit('Colour letters')

    store().resizeMosaicGrid(id, 2, 2)

    const after = object(id)
    expect(after.tiles.length).toBe(4)
    expect(letters(id)).toBe('ABCD')
    // No entry left pointing at a tile that is gone.
    expect(Object.keys(after.states[0]!.glyphColour)).not.toContain(last)
  })

  it('leaves the untouched axis where each state had put it', () => {
    const id = make(3, 3)
    // Author state 2 with rows in their own places.
    const rows = Object.keys(object(id).states[1]!.y)
    store().setMosaicCoordinates(id, 'y', [{ id: rows[0]!, value: 0.2 }], 1)
    store().commit('Move a line')

    store().resizeMosaicGrid(id, 6, 3)

    // Columns are new and even; the rows kept what state 2 said about them.
    const after = object(id)
    expect(Object.values(after.states[1]!.y).sort()).toEqual([0.2, 2 / 3])
    expect(Object.values(after.states[0]!.y).sort()).toEqual([1 / 3, 2 / 3])
  })

  it('evens out the axis whose count changed', () => {
    const id = make(3, 3)
    const columns = Object.keys(object(id).states[0]!.x)
    store().setMosaicCoordinates(id, 'x', [{ id: columns[0]!, value: 0.1 }], 0)
    store().commit('Move a line')

    store().resizeMosaicGrid(id, 4, 3)

    expect(Object.values(object(id).states[0]!.x).sort()).toEqual([0.25, 0.5, 0.75])
  })

  it('refuses a size it already is, so it is not an undo entry for nothing', () => {
    const id = make(3, 3)
    expect(store().resizeMosaicGrid(id, 3, 3)).toBe(false)
  })

  it('holds a side to at least one cell, and to a sane ceiling', () => {
    const id = make(3, 3)
    store().resizeMosaicGrid(id, 0, -4)
    expect(object(id).seed).toEqual({ columns: 1, rows: 1 })

    store().resizeMosaicGrid(id, 9999, 2)
    expect(object(id).seed.columns).toBeLessThanOrEqual(20)
  })

  it('keeps every state, and their timing, through a resize', () => {
    const id = make(3, 3)
    store().setMosaicStateTiming(id, 0, { holdMs: 250, transitionMs: 900 })
    store().commit('Change timing')

    store().resizeMosaicGrid(id, 4, 2)

    const after = object(id)
    expect(after.states.length).toBe(3)
    expect(after.states[0]!.holdMs).toBe(250)
    expect(after.states[0]!.transitionMs).toBe(900)
  })
})
