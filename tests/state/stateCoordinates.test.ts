import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import type { LetterMosaicObject } from '../../src/types/document'
import { isRim } from '../../src/types/mosaic'

/**
 * Every state must name every coordinate its tiles use.
 *
 * A tile is four coordinate ids, and each state holds the values. When a state
 * is missing one of them `valueOf` hands back a default, so that tile — and only
 * that tile — collapses into a degenerate rectangle while the rest of the mosaic
 * looks fine. It shows up as one squashed letter after switching states, which
 * is nearly impossible to read back to the operation that caused it.
 *
 * So the invariant is checked after every operation that can mint a coordinate,
 * drop one, or add and remove whole states.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

function mosaic(id: string): LetterMosaicObject {
  const object = store().doc.objects[id]
  if (object?.kind !== 'mosaic') throw new Error('expected a mosaic')
  return object
}

/**
 * Every coordinate id the tiles name, per axis.
 *
 * Rim lines are left out: they are the mosaic's own edges, held by the object
 * rather than by any state, and no state is expected to carry a value for them.
 */
function named(object: LetterMosaicObject): { x: Set<string>; y: Set<string> } {
  const x = new Set<string>()
  const y = new Set<string>()
  for (const tile of object.tiles) {
    if (!isRim(tile.left)) x.add(tile.left)
    if (!isRim(tile.right)) x.add(tile.right)
    if (!isRim(tile.top)) y.add(tile.top)
    if (!isRim(tile.bottom)) y.add(tile.bottom)
  }
  return { x, y }
}

/** Names every state that cannot place every tile, and says which lines it lacks. */
function gaps(object: LetterMosaicObject): string[] {
  const { x, y } = named(object)
  const out: string[] = []
  object.states.forEach((state, index) => {
    for (const id of x) {
      if (state.x[id] === undefined) out.push(`state ${index} lacks x:${id}`)
    }
    for (const id of y) {
      if (state.y[id] === undefined) out.push(`state ${index} lacks y:${id}`)
    }
  })
  return out
}

function make(columns = 3, rows = 3): string {
  const id = store().createMosaic({
    columns,
    rows,
    artboardCenter: { x: 0, y: 0 },
    text: 'ABCDEFGHI',
  })
  store().commit('Draw mosaic')
  return id
}

describe('a coordinate every state can place', () => {
  it('holds for a mosaic as drawn', () => {
    expect(gaps(mosaic(make()))).toEqual([])
  })

  it('holds after a line is forked in one state', () => {
    const id = make()
    const object = mosaic(id)
    const line = object.tiles[0]?.right as string
    const before = Object.keys(mosaic(id).states[1]?.x ?? {}).length
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 }, 1)).toBe(true)
    // The fork really happened — otherwise the check below proves nothing.
    expect(Object.keys(mosaic(id).states[1]?.x ?? {}).length).toBeGreaterThan(before)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a tile is split', () => {
    const id = make()
    const tile = mosaic(id).tiles[4]?.id as string
    store().splitMosaicTile(id, tile, 'x', 1)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a tile is removed', () => {
    const id = make()
    const tile = mosaic(id).tiles[4]?.id as string
    store().removeMosaicTile(id, tile)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a state is duplicated', () => {
    const id = make()
    store().duplicateMosaicState(id, 1)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a state is deleted', () => {
    const id = make()
    store().deleteMosaicState(id, 1)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after states are added by raising the count', () => {
    const id = make()
    store().setMosaicStateCount(id, 6)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a fork, and then a state is added', () => {
    // The order that matters: a line minted while there were three states has
    // to reach the fourth as well.
    const id = make()
    const line = mosaic(id).tiles[0]?.right as string
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 }, 1)).toBe(true)
    store().setMosaicStateCount(id, 5)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a split, and then a state is duplicated', () => {
    const id = make()
    const tile = mosaic(id).tiles[4]?.id as string
    store().splitMosaicTile(id, tile, 'y', 2)
    store().duplicateMosaicState(id, 0)
    expect(gaps(mosaic(id))).toEqual([])
  })

  it('holds after a grid reset and after a rebuild', () => {
    const id = make()
    const line = mosaic(id).tiles[0]?.right as string
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 }, 1)).toBe(true)
    store().resetMosaicGrid(id, 1)
    expect(gaps(mosaic(id)), 'after reset').toEqual([])
    store().rebuildMosaicGrid(id)
    expect(gaps(mosaic(id)), 'after rebuild').toEqual([])
  })
})
