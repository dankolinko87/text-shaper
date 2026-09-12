import { beforeEach, describe, expect, it } from 'vitest'

import { meshFromMosaic } from '../../src/mesh/dissection'
import { layoutMesh } from '../../src/mesh/layout'
import { validateMesh } from '../../src/mesh/mesh'
import { layoutMosaic } from '../../src/mosaic/layout'
import { useDocumentStore } from '../../src/state/documentStore'
import type { LetterMosaicObject, Vec2 } from '../../src/types/document'
import { mosaicIn } from '../fixtures/objects'

/**
 * A mosaic as a mesh is the same picture: every tile's three rectangles come
 * out as the same four points, in every state, padding baked in, with a
 * forked line's T-junction as a point on the neighbour's side.
 */

const store = () => useDocumentStore.getState()
let id: string
const mosaic = (): LetterMosaicObject => mosaicIn(store().doc, id)

beforeEach(() => {
  store().resetDocument()
  id = store().createMosaic({ columns: 3, rows: 2, artboardCenter: { x: 0, y: 0 }, text: 'ABCDEF' })
  // Spacing that shows, padding that moves the whole thing inward, a corner.
  store().setMosaicSpacing(id, { gap: 8, outerPadding: 10, glyphInset: 5 }, 0)
  store().setMosaicCorners(id, { tileRadius: 4, outerRadius: 12 }, 0)
  store().setMosaicTileColour(id, 1, [mosaic().tiles[0]!.id], '#ff0000')
})

const corners = (rect: { x: number; y: number; width: number; height: number }): Vec2[] => [
  { x: rect.x, y: rect.y },
  { x: rect.x + rect.width, y: rect.y },
  { x: rect.x + rect.width, y: rect.y + rect.height },
  { x: rect.x, y: rect.y + rect.height },
]

describe('a mosaic converted to a mesh', () => {
  it('is sound, keeps its tile ids, and holds every state', () => {
    const converted = meshFromMosaic(mosaic())
    expect(validateMesh(converted.nodes, converted.tiles, converted.states)).toEqual([])
    expect(converted.tiles.map((tile) => tile.id)).toEqual(mosaic().tiles.map((tile) => tile.id))
    expect(converted.states).toHaveLength(mosaic().states.length)
    expect(converted.states[1]?.tileColour[mosaic().tiles[0]!.id]).toBe('#ff0000')
    expect(converted.nodes).toHaveLength(4 * 3)
  })

  it('places every tile where the mosaic placed it, in every state', () => {
    const source = mosaic()
    const converted = meshFromMosaic(source)
    source.states.forEach((state, at) => {
      const theirs = layoutMosaic(source.tiles, state.x, state.y, source.localBounds, {
        gap: state.gap,
        outerPadding: state.outerPadding,
        glyphInset: state.glyphInset,
      })
      const ours = layoutMesh(converted.tiles, converted.states[at]!.nodes, {
        gap: state.gap,
        glyphInset: state.glyphInset,
      })
      for (const tile of source.tiles) {
        const a = theirs.get(tile.id)!
        const b = ours.get(tile.id)!
        for (const [which, rect, polygon] of [
          ['structural', a.structural, b.structural],
          ['visible', a.visible, b.visible],
          ['glyph', a.glyph, b.glyph],
        ] as const) {
          const want = corners(rect)
          expect(polygon, `${which} of ${tile.id} in state ${at}`).toHaveLength(4)
          polygon.forEach((p, i) => {
            expect(Math.abs(p.x - want[i]!.x), which).toBeLessThan(1e-6)
            expect(Math.abs(p.y - want[i]!.y), which).toBeLessThan(1e-6)
          })
        }
        expect(b.rect, 'a rectangle takes the fast path').not.toBeNull()
      }
    })
  })

  it('turns a forked line into a point on the neighbour’s side', () => {
    const source = mosaic()
    // Split the first tile down the middle: a line the tile below does not have.
    const made = store().splitMosaicTile(id, source.tiles[0]!.id, 'x', 0)
    expect(made).not.toBeNull()
    const converted = meshFromMosaic(mosaic())
    expect(validateMesh(converted.nodes, converted.tiles, converted.states)).toEqual([])
    // The tile below the split gained a point on its top side.
    const first = mosaic().tiles[0]!
    const under = mosaic().tiles.find((tile) => tile.top === first.bottom && tile.left === first.left)!
    const below = converted.tiles.find((tile) => tile.id === under.id)!
    expect(below.ring.length).toBe(5)
    expect(below.corners).toHaveLength(4)
    expect(below.ring.filter((id) => !below.corners.includes(id))).toHaveLength(1)
  })

  it('converts through the store in place, undoably', () => {
    const order = store().doc.objectOrder
    const letters = { ...mosaic().states[0]!.chars }
    const meshId = store().convertMosaicToMesh(id)
    expect(meshId).not.toBeNull()
    expect(store().doc.objectOrder).toEqual(order.map((each) => (each === id ? meshId : each)))
    expect(store().doc.objects[id]).toBeUndefined()
    const mesh = store().doc.objects[meshId as string]
    expect(mesh?.kind).toBe('mesh')
    if (mesh?.kind === 'mesh') {
      expect(validateMesh(mesh.nodes, mesh.tiles, mesh.states)).toEqual([])
      // Tile ids are minted afresh, but the letters travel with them in order.
      expect(Object.values(mesh.states[0]?.chars ?? {}).sort()).toEqual(Object.values(letters).sort())
    }
  })
})
