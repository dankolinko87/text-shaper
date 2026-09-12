import { describe, expect, it } from 'vitest'

import {
  dragNodes,
  edgeAt,
  handleAt,
  legal,
  nodeAt,
  nodesMovedBy,
  thicknessFloor,
} from '../../src/mesh/edit'
import { MINIMUM_VISIBLE, isSimple, polygonArea, seedMesh } from '../../src/mesh/mesh'
import type { Vec2 } from '../../src/types/document'

/**
 * Reshaping by hand: what is under the pointer, what a drag moves, and the
 * line a node may not be dragged across.
 */

const spacing = { gap: 6, glyphInset: 6 }
const tolerance = { x: 4, y: 4 }

/** A `columns × rows` grid of 100-unit cells, with a way to find the node at a grid crossing. */
function grid(columns: number, rows: number) {
  const seeded = seedMesh(columns, rows, 100)
  const nodeNear = (x: number, y: number): string => {
    const found = Object.entries(seeded.positions).find(
      ([, p]) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
    )
    if (!found) throw new Error(`no node at ${x},${y}`)
    return found[0]
  }
  return { ...seeded, nodeNear }
}

describe('hit tests', () => {
  it('finds the nearest node within reach, and nothing beyond it', () => {
    const { positions, tiles, nodeNear } = grid(2, 1)
    const ids = Object.keys(positions)
    const corner = positions[nodeNear(-100, -50)] as Vec2
    expect(nodeAt(positions, ids, { x: corner.x + 2, y: corner.y - 2 }, tolerance)).toBe(
      nodeNear(-100, -50),
    )
    expect(nodeAt(positions, ids, { x: corner.x + 10, y: corner.y }, tolerance)).toBeNull()
    // Between two nodes, the nearer wins.
    const middle = positions[nodeNear(0, -50)] as Vec2
    expect(nodeAt(positions, ids, { x: middle.x - 3, y: middle.y }, tolerance)).toBe(nodeNear(0, -50))
    expect(handleAt(tiles, positions, { x: middle.x - 3, y: middle.y }, tolerance)).toEqual({
      kind: 'node',
      id: nodeNear(0, -50),
    })
  })

  it('finds an edge by distance to the segment, measured per axis', () => {
    const { positions, tiles, nodeNear } = grid(2, 1)
    // The divider runs from (0, -50) to (0, 50); a point beside its middle is on it.
    const edges = [[nodeNear(0, -50), nodeNear(0, 50)] as const]
    expect(edgeAt(positions, edges, { x: 3, y: 0 }, tolerance)).toEqual([
      nodeNear(0, -50),
      nodeNear(0, 50),
    ])
    expect(edgeAt(positions, edges, { x: 5, y: 0 }, tolerance)).toBeNull()
    // A squashed tolerance reaches further along the loose axis.
    expect(edgeAt(positions, edges, { x: 5, y: 0 }, { x: 6, y: 1 })).not.toBeNull()
    // Through the tiles, a node beats the edge it ends.
    expect(handleAt(tiles, positions, { x: 1, y: -49 }, tolerance)?.kind).toBe('node')
    expect(handleAt(tiles, positions, { x: 1, y: 0 }, tolerance)?.kind).toBe('edge')
  })
})

describe('what a drag moves', () => {
  it('moves a node alone, or the picked group it belongs to', () => {
    const { positions, tiles, nodeNear } = grid(2, 2)
    const centre = nodeNear(0, 0)
    const corner = nodeNear(-100, -100)
    expect(nodesMovedBy(tiles, positions, { kind: 'node', id: centre })).toEqual([centre])
    expect(
      nodesMovedBy(tiles, positions, { kind: 'node', id: centre }, { picked: [centre, corner] }),
    ).toEqual([centre, corner])
    // Not picked: the group is not its business.
    expect(
      nodesMovedBy(tiles, positions, { kind: 'node', id: corner }, { picked: [centre] }),
    ).toEqual([corner])
  })

  it('moves a divider as one run, or its own segment when asked', () => {
    const { positions, tiles, nodeNear } = grid(2, 3)
    const a = nodeNear(0, -50)
    const b = nodeNear(0, 50)
    const whole = nodesMovedBy(tiles, positions, { kind: 'edge', a, b })
    expect(new Set(whole)).toEqual(
      new Set([nodeNear(0, -150), a, b, nodeNear(0, 150)]),
    )
    expect(nodesMovedBy(tiles, positions, { kind: 'edge', a, b }, { segmentOnly: true })).toEqual([
      a,
      b,
    ])
  })
})

describe('legality', () => {
  it('lets a corner shear and refuses a fold', () => {
    const { positions, tiles, nodeNear } = grid(1, 1)
    const floor = thicknessFloor(spacing)
    const topLeft = nodeNear(-50, -50)
    const sheared = { ...positions, [topLeft]: { x: -20, y: -50 } }
    expect(legal(tiles, sheared, new Set([topLeft]), floor)).toBe(true)
    // Past the opposite corner: the ring turns inside out.
    const folded = { ...positions, [topLeft]: { x: 80, y: 80 } }
    expect(legal(tiles, folded, new Set([topLeft]), floor)).toBe(false)
    // Thinner than the insets need.
    const thin = { ...positions, [topLeft]: { x: -50, y: 50 - floor + 1 } }
    expect(legal(tiles, thin, new Set([topLeft]), floor)).toBe(false)
  })

  it('refuses an edge dragged across a neighbouring tile', () => {
    const { positions, tiles, nodeNear } = grid(2, 1)
    const floor = thicknessFloor(spacing)
    const top = nodeNear(0, -50)
    const bottom = nodeNear(0, 50)
    // The divider walks right, into the second tile, which is fine.
    const shifted = { ...positions, [top]: { x: 40, y: -50 }, [bottom]: { x: 40, y: 50 } }
    expect(legal(tiles, shifted, new Set([top, bottom]), floor)).toBe(true)
    // The divider's top crosses the second tile's right side.
    const crossed = { ...positions, [top]: { x: 130, y: -50 } }
    expect(legal(tiles, crossed, new Set([top]), floor)).toBe(false)
  })
})

describe('dragNodes', () => {
  it('moves rigidly, snapped by the primary node, and reports nothing clamped', () => {
    const { positions, tiles, nodeNear } = grid(2, 3)
    const a = nodeNear(0, -50)
    const b = nodeNear(0, 50)
    const moved = [nodeNear(0, -150), a, b, nodeNear(0, 150)]
    const result = dragNodes(tiles, positions, moved, a, { x: 13, y: 2 }, { snapStep: 10, spacing })
    expect(result.clamped).toBe(false)
    expect(result.moved).toBe(true)
    expect(result.updates).toHaveLength(4)
    for (const update of result.updates) {
      const was = positions[update.id] as Vec2
      expect(update.at).toEqual({ x: was.x + 10, y: was.y })
    }
    // Free of the grid with no step.
    const free = dragNodes(tiles, positions, moved, a, { x: 13, y: 2 }, { snapStep: 0, spacing })
    expect(free.updates.find((u) => u.id === a)?.at).toEqual({ x: 13, y: -48 })
  })

  it('holds a node back at the last legal point and says so', () => {
    const { positions, tiles, nodeNear } = grid(1, 1)
    const topLeft = nodeNear(-50, -50)
    const result = dragNodes(tiles, positions, [topLeft], topLeft, { x: 200, y: 200 }, { spacing })
    expect(result.clamped).toBe(true)
    const at = result.updates[0]?.at as Vec2
    const ring = tiles[0]!.ring.map((id) => (id === topLeft ? at : (positions[id] as Vec2)))
    expect(polygonArea(ring)).toBeGreaterThan(0)
    expect(isSimple(ring)).toBe(true)
    // It went SOMEWHERE — a clamp is not a refusal.
    expect(at.x).toBeGreaterThan(-50)
    expect(legal(tiles, { ...positions, [topLeft]: at }, new Set([topLeft]), thicknessFloor(spacing))).toBe(true)
  })

  it('still reshapes a cell that is already thinner than the floor, down to the visible minimum', () => {
    // A 100-unit cell whose spacing asks for more thickness than it has —
    // the gap and inset were raised after the cell was made. Every node on
    // it used to be frozen, the drag clamped to nothing and drawn as such.
    const { positions, tiles, nodeNear } = grid(1, 1)
    const wide = { gap: 60, glyphInset: 40 }
    expect(thicknessFloor(wide)).toBeGreaterThan(100)
    const topLeft = nodeNear(-50, -50)
    const out = dragNodes(tiles, positions, [topLeft], topLeft, { x: -30, y: -30 }, { spacing: wide })
    expect(out.clamped).toBe(false)
    expect(out.updates[0]?.at).toEqual({ x: -80, y: -80 })
    const inward = dragNodes(tiles, positions, [topLeft], topLeft, { x: 0, y: 30 }, { spacing: wide })
    expect(inward.clamped).toBe(false)
    expect(inward.updates[0]?.at).toEqual({ x: -50, y: -20 })
    // But never to nothing: pulled past the far side it is held where the cell still stands.
    const through = dragNodes(tiles, positions, [topLeft], topLeft, { x: 0, y: 200 }, { spacing: wide })
    expect(through.clamped).toBe(true)
    const at = through.updates[0]?.at as Vec2
    expect(at.y).toBeLessThan(50 - MINIMUM_VISIBLE + 1e-6)
    expect(at.y).toBeGreaterThan(-50)
    // A cell that meets the floor is still held to it.
    const floor = thicknessFloor(spacing)
    const held = dragNodes(tiles, positions, [topLeft], topLeft, { x: 0, y: 200 }, { spacing })
    const ring = tiles[0]!.ring.map((id) => (id === topLeft ? (held.updates[0]!.at as Vec2) : (positions[id] as Vec2)))
    expect(legal(tiles, Object.fromEntries(tiles[0]!.ring.map((id, i) => [id, ring[i]!])), new Set([topLeft]), floor)).toBe(true)
  })

  it('returns every moved node even when the pointer is back where it began', () => {
    const { positions, tiles, nodeNear } = grid(1, 1)
    const topLeft = nodeNear(-50, -50)
    const result = dragNodes(tiles, positions, [topLeft], topLeft, { x: 0, y: 0 }, { spacing })
    expect(result.moved).toBe(false)
    expect(result.updates).toEqual([{ id: topLeft, at: positions[topLeft] }])
  })
})
