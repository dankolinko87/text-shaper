import { beforeEach, describe, expect, it } from 'vitest'

import { validateMesh } from '../../src/mesh/mesh'
import { useDocumentStore } from '../../src/state/documentStore'
import { meshIn, mosaicIn } from '../fixtures/objects'

/**
 * Where a mesh's nodes are, state by state — and that every state names every
 * node after everything the store can do to a mesh.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

function make(text = 'ABCD'): string {
  const id = store().createMesh({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 }, text })
  store().commit('Draw mesh')
  return id
}

const object = (id: string) => meshIn(store().doc, id)
const complete = (id: string): void => {
  const mesh = object(id)
  expect(validateMesh(mesh.nodes, mesh.tiles, mesh.states)).toEqual([])
}
/** The node at a grid crossing in state 0. */
const nodeAt = (id: string, x: number, y: number): string => {
  const found = Object.entries(object(id).states[0]!.nodes).find(
    ([, p]) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
  )
  if (!found) throw new Error(`no node at ${x},${y}`)
  return found[0]
}

describe('moving nodes', () => {
  it('carries forward through the states that are still copies, and stops at one of its own', () => {
    const id = make()
    const centre = nodeAt(id, 0, 0)
    store().setMeshNodes(id, 2, [{ id: centre, at: { x: 5, y: 5 } }])
    store().setMeshNodes(id, 0, [{ id: centre, at: { x: 20, y: -10 } }])
    const seen = object(id).states.map((state) => state.nodes[centre])
    expect(seen).toEqual([
      { x: 20, y: -10 },
      { x: 20, y: -10 },
      { x: 5, y: 5 },
    ])
    complete(id)
  })

  it('grows the bounds with a rim node and never shrinks them below any state', () => {
    const id = make()
    const before = object(id).localBounds
    const corner = nodeAt(id, -120, -120)
    store().setMeshNodes(id, 0, [{ id: corner, at: { x: -150, y: -160 } }])
    expect(object(id).localBounds).toEqual({
      x: -150,
      y: -160,
      width: before.width + 30,
      height: before.height + 40,
    })
    // State 2 reaches further, and is its own; pulling state 0 back cannot shrink the box past it.
    store().setMeshNodes(id, 2, [{ id: corner, at: { x: -170, y: -160 } }])
    store().setMeshNodes(id, 0, [{ id: corner, at: { x: -120, y: -120 } }])
    expect(object(id).states[1]!.nodes[corner], 'state 1 still follows state 0').toEqual({ x: -120, y: -120 })
    expect(object(id).localBounds.x).toBe(-170)
  })

  it('ignores a node it has not got and a position it cannot draw', () => {
    const id = make()
    const was = object(id)
    store().setMeshNodes(id, 0, [
      { id: 'nobody', at: { x: 1, y: 1 } },
      { id: nodeAt(id, 0, 0), at: { x: Number.NaN, y: 0 } },
    ])
    expect(object(id)).toBe(was)
  })
})

describe('every state names every node', () => {
  it('after reseeding the grid', () => {
    const id = make('ABCD')
    expect(store().resizeMeshGrid(id, 3, 2)).toBe(true)
    expect(object(id).tiles).toHaveLength(6)
    expect(object(id).seed).toEqual({ columns: 3, rows: 2 })
    // Letters carry in reading order.
    const chars = object(id).tiles.map((tile) => object(id).states[0]!.chars[tile.id] ?? '_')
    expect(chars.join('')).toBe('ABCD__')
    complete(id)
  })

  it('after duplicating and deleting states', () => {
    const id = make()
    store().duplicateMosaicState(id, 1)
    expect(object(id).states).toHaveLength(4)
    complete(id)
    store().deleteMosaicState(id, 0)
    complete(id)
  })

  it('after a mosaic becomes a mesh', () => {
    const mosaicId = store().createMosaic({ columns: 3, rows: 2, artboardCenter: { x: 50, y: 50 }, text: 'ABCDEF' })
    store().commit('Draw mosaic')
    const mosaic = mosaicIn(store().doc, mosaicId)
    const meshId = store().convertMosaicToMesh(mosaicId)
    expect(meshId).toBeTruthy()
    if (!meshId) return
    store().commit('Convert to mesh')
    expect(store().doc.objects[mosaicId], 'the mosaic is gone').toBeUndefined()
    const mesh = object(meshId)
    expect(mesh.transform).toEqual(mosaic.transform)
    // Fresh ids, so converting twice cannot collide — but tile for tile, the same letters.
    expect(mesh.tiles).toHaveLength(mosaic.tiles.length)
    expect(mesh.tiles.map((tile) => mesh.states[0]!.chars[tile.id] ?? '_').join('')).toBe('ABCDEF')
    complete(meshId)
    // Undo brings the mosaic back.
    store().undo()
    expect(store().doc.objects[mosaicId]?.kind).toBe('mosaic')
  })
})

describe('changing what the mesh is', () => {
  const edgeOf = (id: string, ax: number, ay: number, bx: number, by: number): [string, string] => [
    nodeAt(id, ax, ay),
    nodeAt(id, bx, by),
  ]

  it('adds a point, moves it, and takes it out again, every state following', () => {
    const id = make()
    const made = store().addMeshPoint(id, edgeOf(id, 0, -120, 0, 0), 0.5)
    expect(made).toBeTruthy()
    if (!made) return
    complete(id)
    expect(object(id).states.map((state) => state.nodes[made])).toEqual([
      { x: 0, y: -60 },
      { x: 0, y: -60 },
      { x: 0, y: -60 },
    ])
    store().setMeshNodes(id, 0, [{ id: made, at: { x: 10, y: -60 } }])
    expect(object(id).states[2]!.nodes[made]).toEqual({ x: 10, y: -60 })
    expect(store().removeMeshPoint(id, made)).toBe(true)
    complete(id)
    expect(store().removeMeshPoint(id, nodeAt(id, 0, 0)), 'a corner stays').toBe(false)
  })

  it('cuts, extrudes and removes tiles, and stays a mesh throughout', () => {
    const id = make('ABCD')
    const first = object(id).tiles[0]!.id
    const cut = store().cutMeshTile(
      id,
      first,
      { edge: edgeOf(id, -120, -120, 0, -120), t: 0.5 },
      { edge: edgeOf(id, 0, 0, -120, 0), t: 0.5 },
    )
    expect(cut).toBeTruthy()
    complete(id)
    expect(object(id).tiles).toHaveLength(5)
    expect(object(id).states[0]!.chars[first]).toBe('A')

    const grown = store().extrudeMeshEdge(id, edgeOf(id, 0, -120, 120, -120), { x: 0, y: -50 }, 0)
    expect(grown).toBeTruthy()
    complete(id)
    expect(object(id).tiles).toHaveLength(6)
    expect(object(id).localBounds.y).toBe(-170)

    expect(store().removeMeshTiles(id, [grown as string, cut as string])).toBe(true)
    complete(id)
    expect(object(id).tiles).toHaveLength(4)
    expect(object(id).localBounds.y, 'the bounds shrink back').toBe(-120)
    // Never the last tile.
    const rest = object(id).tiles.map((tile) => tile.id)
    expect(store().removeMeshTiles(id, rest)).toBe(true)
    expect(object(id).tiles).toHaveLength(1)
  })

  it('resets one state to the grid its tiles still form, and refuses once they do not', () => {
    const id = make()
    const centre = nodeAt(id, 0, 0)
    store().setMeshNodes(id, 1, [{ id: centre, at: { x: 30, y: 40 } }])
    expect(store().resetMeshGrid(id, 1)).toBe(true)
    expect(object(id).states[1]!.nodes[centre]).toEqual({ x: 0, y: 0 })
    expect(object(id).states[0]!.nodes[centre]).toEqual({ x: 0, y: 0 })
    expect(store().resetMeshGrid(id, 1), 'nothing to do').toBe(false)
    // A slanted cut breaks the lattice.
    const first = object(id).tiles[0]!.id
    store().cutMeshTile(
      id,
      first,
      { edge: edgeOf(id, -120, -120, 0, -120), t: 0.5 },
      { edge: edgeOf(id, 0, -120, 0, 0), t: 0.5 },
    )
    store().setMeshNodes(id, 0, [{ id: centre, at: { x: 30, y: 40 } }])
    expect(store().resetMeshGrid(id, 0)).toBe(false)
    // Rebuild puts every state back on the seed.
    expect(store().rebuildMeshGrid(id)).toBe(true)
    complete(id)
    expect(object(id).tiles).toHaveLength(4)
    expect(object(id).states.every((state) => Object.keys(state.nodes).length === 9)).toBe(true)
  })
})
