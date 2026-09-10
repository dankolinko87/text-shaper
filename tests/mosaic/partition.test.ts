import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import { isRim } from '../../src/types/mosaic'
import { moveEdge, selectionEdges } from '../../src/mosaic/boundaries'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * The tiles must always partition the box: no gaps, and above all no overlaps.
 *
 * This is the invariant every other mosaic guarantee rests on. Two tiles
 * claiming the same ground draw on top of each other — a letter printed across
 * its neighbour — and no amount of care in the renderer can fix it, because the
 * renderer is faithfully drawing what it was given.
 *
 * Checked after every operation that changes the SHAPE of the partition, since
 * any of them could leave a tile's edge naming a line that no longer agrees with
 * what is on the other side of it.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

const value = (values: Record<string, number>, id: string): number =>
  isRim(id) ? (id.endsWith('min') ? 0 : 1) : (values[id] ?? Number.NaN)

/** Every pair of tiles that shares ground, in any state, described. */
function overlaps(object: LetterMosaicObject): string[] {
  const found: string[] = []
  object.states.forEach((state, index) => {
    const boxes = object.tiles.map((tile) => ({
      id: tile.id,
      char: state.chars[tile.id] ?? '_',
      x0: value(state.x, tile.left),
      x1: value(state.x, tile.right),
      y0: value(state.y, tile.top),
      y1: value(state.y, tile.bottom),
    }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        if (ox > 1e-9 && oy > 1e-9) {
          found.push(
            `state ${index}: ${a.char} and ${b.char} share ${ox.toFixed(3)} x ${oy.toFixed(3)}`,
          )
        }
      }
    }
  })
  return found
}

function make(columns = 4, rows = 3): string {
  const id = store().createMosaic({
    columns,
    rows,
    artboardCenter: { x: 0, y: 0 },
    text: '123456789ABC',
  })
  store().commit('Draw mosaic')
  return id
}

const object = (id: string) => mosaicIn(store().doc, id)

describe('the tiles partition the box', () => {
  it('as drawn', () => {
    expect(overlaps(object(make()))).toEqual([])
  })

  it('after any single tile is removed', () => {
    for (let index = 0; index < 12; index++) {
      store().resetDocument()
      const id = make()
      const tile = object(id).tiles[index]!.id
      store().removeMosaicTile(id, tile)
      expect(overlaps(object(id)), `removed tile ${index}`).toEqual([])
    }
  })

  it('after several tiles are removed one after another', () => {
    const id = make()
    for (const index of [5, 3, 0]) {
      const tiles = object(id).tiles
      if (!tiles[index]) continue
      store().removeMosaicTile(id, tiles[index]!.id)
      expect(overlaps(object(id)), `after removing index ${index}`).toEqual([])
    }
  })

  it('after a tile is split on either axis', () => {
    for (const axis of ['x', 'y'] as const) {
      store().resetDocument()
      const id = make()
      store().splitMosaicTile(id, object(id).tiles[5]!.id, axis, 0)
      expect(overlaps(object(id)), `split on ${axis}`).toEqual([])
    }
  })

  it('after a tile is removed and then a neighbour is split', () => {
    const id = make()
    store().removeMosaicTile(id, object(id).tiles[5]!.id)
    store().splitMosaicTile(id, object(id).tiles[4]!.id, 'y', 0)
    expect(overlaps(object(id))).toEqual([])
  })

  it('after a grid reset, and after a rebuild', () => {
    const id = make()
    store().removeMosaicTile(id, object(id).tiles[5]!.id)
    store().resetMosaicGrid(id, 0)
    expect(overlaps(object(id)), 'after reset').toEqual([])
    store().rebuildMosaicGrid(id)
    expect(overlaps(object(id)), 'after rebuild').toEqual([])
  })

  it('after two lines are rejoined', () => {
    const id = make()
    const tile = object(id).tiles[5]!
    store().forkMosaicCoordinate(id, 'y', tile.bottom, { from: 0, to: 1 }, 0)
    const forked = object(id).tiles.find((each) => each.id === tile.id)!
    store().mergeMosaicCoordinates(id, 'y', new Set([forked.bottom]))
    expect(overlaps(object(id))).toEqual([])
  })

  it('after a fork in one state is dragged, leaving the others behind', () => {
    // The states share tiles but not values, so a fork made while looking at one
    // state has to leave every other state a partition too.
    const id = make()
    const tile = object(id).tiles[5]!
    store().forkMosaicCoordinate(id, 'y', tile.bottom, { from: 0, to: 1 }, 1)
    const forked = object(id).tiles.find((each) => each.id === tile.id)!
    store().setMosaicCoordinates(id, 'y', [{ id: forked.bottom, value: 0.95 }], 1)
    expect(overlaps(object(id))).toEqual([])
  })

  it('after a line is forked and dragged as far as it will go', () => {
    const id = make()
    const tile = object(id).tiles[5]!
    store().forkMosaicCoordinate(id, 'y', tile.bottom, { from: 0, to: 1 }, 0)
    const forked = object(id).tiles.find((each) => each.id === tile.id)!
    // Straight past the tiles below it — the range is what has to refuse this.
    store().setMosaicCoordinates(id, 'y', [{ id: forked.bottom, value: 0.99 }], 0)
    expect(overlaps(object(id))).toEqual([])
  })
})

/**
 * The multi-tile drag, which is the one path that moves several lines at once.
 *
 * Driven the way the canvas drives it: build the handles for a selection, ask
 * `moveEdge` where a drag of some distance lands, and write exactly what it
 * says. Anything it allows has to leave a partition behind.
 */
describe('dragging a block of tiles', () => {
  const spacingOf = (id: string) => {
    const state = object(id).states[0]!
    return { gap: state.gap, outerPadding: state.outerPadding, glyphInset: state.glyphInset }
  }

  it('never lets a selection’s edge cross the tiles beyond it', () => {
    for (const axis of ['x', 'y'] as const) {
      for (const distance of [40, 200, 5000, -40, -200, -5000]) {
        store().resetDocument()
        const id = make()
        const tiles = object(id).tiles
        // Two tiles that line up, so their shared edge is a block.
        const chosen = [tiles[1]!.id, tiles[5]!.id]
        const current = object(id)
        const handles = selectionEdges(
          current.tiles,
          current.states[0]!.x,
          current.states[0]!.y,
          current.localBounds,
          spacingOf(id),
          chosen,
        )
        const edge = handles.find((each) => each.axis === axis)
        if (!edge) continue

        const result = moveEdge(
          current.tiles,
          current.states[0]!.x,
          current.states[0]!.y,
          current.localBounds,
          spacingOf(id),
          edge.axis,
          edge.id,
          distance,
          edge.block,
          current.snapStep,
        )
        if (!result) continue
        store().setMosaicCoordinates(id, edge.axis, result.updates, 0)

        expect(overlaps(object(id)), `${axis} by ${distance}`).toEqual([])
      }
    }
  })

  it('never lets a single tile’s forked edge cross its neighbours', () => {
    for (const distance of [200, 5000, -200, -5000]) {
      store().resetDocument()
      const id = make()
      const chosen = [object(id).tiles[5]!.id]
      const before = object(id)
      const handles = selectionEdges(
        before.tiles,
        before.states[0]!.x,
        before.states[0]!.y,
        before.localBounds,
        spacingOf(id),
        chosen,
      )
      for (const edge of handles) {
        // The gesture forks first, exactly as the canvas does.
        store().forkMosaicCoordinate(id, edge.axis, edge.id, { from: edge.from, to: edge.to }, 0)
        const now = object(id)
        const fresh = selectionEdges(
          now.tiles,
          now.states[0]!.x,
          now.states[0]!.y,
          now.localBounds,
          spacingOf(id),
          chosen,
        ).find((each) => each.axis === edge.axis)
        if (!fresh) continue
        const result = moveEdge(
          now.tiles,
          now.states[0]!.x,
          now.states[0]!.y,
          now.localBounds,
          spacingOf(id),
          fresh.axis,
          fresh.id,
          distance,
          fresh.block,
          now.snapStep,
        )
        if (!result) continue
        store().setMosaicCoordinates(id, fresh.axis, result.updates, 0)
        expect(overlaps(object(id)), `${fresh.axis} by ${distance}`).toEqual([])
      }
    }
  })
})

/**
 * Dragging a tile that has swallowed a neighbour.
 *
 * This is the shape the invariant actually broke in: a mosaic where tiles had
 * been removed, so one tile spans ground whose far side is divided differently
 * from its own edges. Its edge then has neighbours that do not name the line it
 * is moving, and nothing in the range asks them whether they mind.
 */
describe('dragging after tiles have been absorbed', () => {
  const spacingOf = (id: string) => {
    const state = object(id).states[0]!
    return { gap: state.gap, outerPadding: state.outerPadding, glyphInset: state.glyphInset }
  }

  /** Fork one edge of one tile and shove it as hard as the range allows. */
  const shove = (id: string, tileId: string, distance: number): void => {
    const before = object(id)
    if (!before.tiles.some((each) => each.id === tileId)) return
    const handles = selectionEdges(
      before.tiles,
      before.states[0]!.x,
      before.states[0]!.y,
      before.localBounds,
      spacingOf(id),
      [tileId],
    )
    for (const edge of handles) {
      store().forkMosaicCoordinate(id, edge.axis, edge.id, { from: edge.from, to: edge.to }, 0)
      const now = object(id)
      const fresh = selectionEdges(
        now.tiles,
        now.states[0]!.x,
        now.states[0]!.y,
        now.localBounds,
        spacingOf(id),
        [tileId],
      ).find((each) => each.axis === edge.axis)
      if (!fresh) continue
      const result = moveEdge(
        now.tiles,
        now.states[0]!.x,
        now.states[0]!.y,
        now.localBounds,
        spacingOf(id),
        fresh.axis,
        fresh.id,
        distance,
        fresh.block,
        now.snapStep,
      )
      if (result) store().setMosaicCoordinates(id, fresh.axis, result.updates, 0)
    }
  }

  it('keeps the partition through remove-then-drag, over every tile', () => {
    for (const removeAt of [1, 4, 5, 6, 9]) {
      for (const distance of [400, -400]) {
        store().resetDocument()
        const id = make()
        const doomed = object(id).tiles[removeAt]
        if (!doomed) continue
        store().removeMosaicTile(id, doomed.id)
        expect(overlaps(object(id)), `remove ${removeAt}`).toEqual([])

        for (const tile of object(id).tiles.map((each) => each.id)) {
          shove(id, tile, distance)
          expect(overlaps(object(id)), `remove ${removeAt}, shove ${tile} by ${distance}`).toEqual(
            [],
          )
        }
      }
    }
  })

  it('keeps the partition when two tiles are absorbed before dragging', () => {
    store().resetDocument()
    const id = make()
    store().removeMosaicTile(id, object(id).tiles[5]!.id)
    store().removeMosaicTile(id, object(id).tiles[5]!.id)
    for (const tile of object(id).tiles.map((each) => each.id)) {
      shove(id, tile, 600)
      expect(overlaps(object(id)), `shove ${tile}`).toEqual([])
    }
  })
})
