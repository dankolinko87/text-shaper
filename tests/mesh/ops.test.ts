import { describe, expect, it } from 'vitest'

import { initialMeshState } from '../../src/mesh/dissection'
import { edgesOf, isSimple, polygonArea, seedMesh, validateMesh } from '../../src/mesh/mesh'
import {
  addPoint,
  chooseCorners,
  chordAcross,
  cutTile,
  extrudeEdge,
  isBendPoint,
  latticeOf,
  orientCorners,
  removePoint,
  removeTile,
  resetPositions,
  type MeshShape,
} from '../../src/mesh/ops'
import type { Vec2 } from '../../src/types/document'

/**
 * Changing what a mesh is. After every operation: still a mesh (every state
 * names every node, every ring simple and positive, no edge in three tiles),
 * and the thing the operation promised.
 */

const font = { fontId: 'anton', weight: 400, italic: false }

/** A `columns × rows` grid of 100-unit cells with `count` identical states. */
function grid(columns: number, rows: number, count = 2): MeshShape & { nodeNear: (x: number, y: number) => string } {
  const seeded = seedMesh(columns, rows, 100)
  const states = Array.from({ length: count }, () => initialMeshState(seeded.positions, font))
  const nodeNear = (x: number, y: number): string => {
    const found = Object.entries(seeded.positions).find(
      ([, p]) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
    )
    if (!found) throw new Error(`no node at ${x},${y}`)
    return found[0]
  }
  return { nodes: seeded.nodes, tiles: seeded.tiles, states, nodeNear }
}

const sound = (shape: MeshShape): void => {
  expect(validateMesh(shape.nodes, shape.tiles, shape.states)).toEqual([])
  for (const edge of edgesOf(shape.tiles).values()) expect(edge.tiles.length).toBeLessThanOrEqual(2)
  for (const state of shape.states) {
    for (const tile of shape.tiles) {
      const ring = tile.ring.map((id) => state.nodes[id] as Vec2)
      expect(polygonArea(ring)).toBeGreaterThan(0)
      expect(isSimple(ring)).toBe(true)
    }
  }
}

describe('points', () => {
  it('adds a point on an edge, in both tiles and every state, at the same fraction', () => {
    const g = grid(2, 1)
    const a = g.nodeNear(0, -50)
    const b = g.nodeNear(0, 50)
    // The second state has the divider leaning.
    g.states[1]!.nodes[a] = { x: 20, y: -50 }
    const shape = addPoint(g, [a, b], 0.25)
    expect(shape).not.toBeNull()
    if (!shape) return
    sound(shape)
    const made = shape.nodes[shape.nodes.length - 1]!.id
    expect(shape.tiles.every((tile) => tile.ring.includes(made))).toBe(true)
    expect(shape.tiles.every((tile) => !tile.corners.includes(made))).toBe(true)
    expect(shape.states[0]!.nodes[made]).toEqual({ x: 0, y: -25 })
    expect(shape.states[1]!.nodes[made]).toEqual({ x: 15, y: -25 })
    expect(isBendPoint(shape.tiles, made)).toBe(true)
    expect(isBendPoint(shape.tiles, a)).toBe(false)
  })

  it('takes a bend point out everywhere, and refuses a corner', () => {
    const g = grid(2, 1)
    const a = g.nodeNear(0, -50)
    const b = g.nodeNear(0, 50)
    const bent = addPoint(g, [a, b], 0.5)!
    const made = bent.nodes[bent.nodes.length - 1]!.id
    const back = removePoint(bent, made)
    expect(back).not.toBeNull()
    if (!back) return
    sound(back)
    expect(back.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id))
    expect(back.tiles.map((t) => t.ring)).toEqual(g.tiles.map((t) => t.ring))
    expect(back.states.every((state) => state.nodes[made] === undefined)).toBe(true)
    expect(removePoint(bent, a)).toBeNull()
  })
})

describe('corners', () => {
  it('puts the letter the right way up', () => {
    const g = grid(1, 1)
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    const br = g.nodeNear(50, 50)
    const bl = g.nodeNear(-50, 50)
    expect(orientCorners([br, bl, tl, tr], g.states)).toEqual([tl, tr, br, bl])
  })

  it('picks the two extra corners that make the largest convex quad, and a tip for a triangle', () => {
    const g = grid(1, 1)
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    const br = g.nodeNear(50, 50)
    const bl = g.nodeNear(-50, 50)
    const bent = addPoint(g, [tl, tr], 0.5)!
    const mid = bent.nodes[bent.nodes.length - 1]!.id
    const ring = bent.tiles[0]!.ring
    // With the left side fixed, the largest quad ignores the bend on the top.
    const chosen = chooseCorners(ring, [bl, tl], bent.states)
    expect(new Set(chosen)).toEqual(new Set([tl, tr, br, bl]))
    expect(chooseCorners([tl, tr, bl], [tl, tr], g.states)).toEqual([tl, tr, bl, bl])
    expect(mid).toBeTruthy()
  })
})

describe('cutting a tile', () => {
  it('keeps the id, letter and colours on one half and gives the other the colours only', () => {
    const g = grid(1, 1)
    const tile = g.tiles[0]!
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    const br = g.nodeNear(50, 50)
    const bl = g.nodeNear(-50, 50)
    for (const state of g.states) {
      state.chars[tile.id] = 'A'
      state.glyphColour[tile.id] = '#ff0000ff'
      state.tileColour[tile.id] = '#00ff00ff'
    }
    const cut = cutTile(g, tile.id, { edge: [tl, tr], t: 0.5 }, { edge: [br, bl], t: 0.5 })
    expect(cut).not.toBeNull()
    if (!cut) return
    sound(cut)
    expect(cut.tiles).toHaveLength(2)
    expect(cut.nodes).toHaveLength(6)
    const kept = cut.tiles.find((each) => each.id === tile.id)!
    const made = cut.tiles.find((each) => each.id !== tile.id)!
    expect(kept.ring).toHaveLength(4)
    expect(made.ring).toHaveLength(4)
    for (const state of cut.states) {
      expect(state.chars[kept.id]).toBe('A')
      expect(state.chars[made.id]).toBeUndefined()
      expect(state.glyphColour[made.id]).toBe('#ff0000ff')
      expect(state.tileColour[made.id]).toBe('#00ff00ff')
    }
    // The two halves share the cut, and their corners are the cut ends plus two old corners.
    const shared = kept.ring.filter((id) => made.ring.includes(id))
    expect(shared).toHaveLength(2)
    expect(kept.corners.filter((id) => shared.includes(id))).toHaveLength(2)
    expect(new Set(kept.corners).size).toBe(4)
  })

  it('cuts to a triangle when the line runs corner to corner', () => {
    const g = grid(1, 1)
    const tile = g.tiles[0]!
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    const br = g.nodeNear(50, 50)
    const bl = g.nodeNear(-50, 50)
    const cut = cutTile(g, tile.id, { edge: [tl, tr], t: 0 }, { edge: [br, bl], t: 0 })
    expect(cut).not.toBeNull()
    if (!cut) return
    sound(cut)
    expect(cut.nodes, 'no new nodes for a corner-to-corner cut').toHaveLength(4)
    for (const each of cut.tiles) {
      expect(each.ring).toHaveLength(3)
      expect(new Set(each.corners).size).toBe(3)
    }
  })

  it('refuses a cut that starts and ends on the same edge', () => {
    const g = grid(1, 1)
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    expect(cutTile(g, g.tiles[0]!.id, { edge: [tl, tr], t: 0.2 }, { edge: [tr, tl], t: 0.2 })).toBeNull()
  })
})

describe('extruding an edge', () => {
  it('grows one empty tile out of a rim edge, in every state along that state’s own edge', () => {
    const g = grid(1, 1)
    const tl = g.nodeNear(-50, -50)
    const tr = g.nodeNear(50, -50)
    // The second state has the top edge sloping.
    g.states[1]!.nodes[tr] = { x: 50, y: -90 }
    const grown = extrudeEdge(g, [tl, tr], { x: 0, y: -40 }, 0, 10)
    expect(grown).not.toBeNull()
    if (!grown) return
    sound(grown)
    expect(grown.tiles).toHaveLength(2)
    expect(grown.nodes).toHaveLength(6)
    const made = grown.tiles[1]!
    expect(made.ring).toHaveLength(4)
    expect(made.ring).toContain(tl)
    expect(made.ring).toContain(tr)
    const fresh = made.ring.filter((id) => id !== tl && id !== tr)
    // Straight up by forty in the flat state: the ring runs b, a, a', b'.
    expect(grown.states[0]!.nodes[fresh[0]!]).toEqual({ x: -50, y: -90 })
    expect(grown.states[0]!.nodes[fresh[1]!]).toEqual({ x: 50, y: -90 })
    // ...and perpendicular to the sloping edge in the other, forty out.
    const s = grown.states[1]!.nodes
    const out = { x: s[fresh[0]!]!.x - s[tl]!.x, y: s[fresh[0]!]!.y - s[tl]!.y }
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(40)
    const along = { x: s[tr]!.x - s[tl]!.x, y: s[tr]!.y - s[tl]!.y }
    expect(out.x * along.x + out.y * along.y).toBeCloseTo(0)
    // Upright: the new cell's top-left is the far-left new node.
    expect(made.corners[0]).toBe(fresh[0])
    expect(grown.states.every((state) => state.chars[made.id] === undefined)).toBe(true)
  })

  it('refuses an interior edge and goes no thinner than the minimum', () => {
    const g = grid(2, 1)
    const a = g.nodeNear(0, -50)
    const b = g.nodeNear(0, 50)
    expect(extrudeEdge(g, [a, b], { x: 0, y: -40 }, 0, 10)).toBeNull()
    const tl = g.nodeNear(-100, -50)
    const tr = g.nodeNear(0, -50)
    const thin = extrudeEdge(g, [tl, tr], { x: 0, y: 3 }, 0, 10)!
    const fresh = thin.tiles[thin.tiles.length - 1]!.ring.filter((id) => id !== tl && id !== tr)
    expect(thin.states[0]!.nodes[fresh[0]!]!.y).toBe(-60)
  })
})

describe('removing a tile', () => {
  it('leaves a hole and prunes the nodes nothing uses, but never the last tile', () => {
    const g = grid(3, 3)
    const middle = g.tiles[4]!
    const gone = removeTile(g, middle.id)
    expect(gone).not.toBeNull()
    if (!gone) return
    sound(gone)
    expect(gone.tiles).toHaveLength(8)
    expect(gone.nodes, 'every node of the middle tile is shared').toHaveLength(16)
    const corner = removeTile(gone, g.tiles[0]!.id)!
    expect(corner.nodes).toHaveLength(15)
    expect(corner.states.every((state) => Object.keys(state.nodes).length === 15)).toBe(true)
    const one = grid(1, 1)
    expect(removeTile(one, one.tiles[0]!.id)).toBeNull()
  })
})

describe('the lattice', () => {
  it('reads a grid off the corners, bend points and holes notwithstanding', () => {
    const g = grid(3, 2)
    const a = g.nodeNear(-50, -100)
    const b = g.nodeNear(-50, 0)
    const bent = addPoint(g, [a, b], 0.5)!
    const holed = removeTile(bent, bent.tiles[4]!.id)!
    const lattice = latticeOf(holed.tiles)
    expect(lattice).not.toBeNull()
    expect(lattice?.columns).toBe(3)
    expect(lattice?.rows).toBe(2)
    expect(lattice?.at.get(g.nodeNear(-150, -100))).toEqual([0, 0])
    expect(lattice?.at.get(g.nodeNear(150, 100))).toEqual([3, 2])
  })

  it('survives a straight cut and an extrusion, and is gone after a slanted one', () => {
    const g = grid(2, 1)
    const tl = g.nodeNear(-100, -50)
    const tr = g.nodeNear(0, -50)
    const bl = g.nodeNear(-100, 50)
    const br = g.nodeNear(0, 50)
    // Top to bottom: three cells in a row, which is a grid.
    const straight = cutTile(g, g.tiles[0]!.id, { edge: [tl, tr], t: 0.5 }, { edge: [br, bl], t: 0.5 })!
    expect(latticeOf(straight.tiles)?.columns).toBe(3)
    // Top to right side: a triangle and a pentagon, which is not.
    const slanted = cutTile(g, g.tiles[0]!.id, { edge: [tl, tr], t: 0.5 }, { edge: [tr, br], t: 0.5 })!
    expect(latticeOf(slanted.tiles)).toBeNull()
    const grown = extrudeEdge(g, [tl, tr], { x: 0, y: -40 }, 0, 10)!
    expect(latticeOf(grown.tiles)?.rows).toBe(2)
  })

  it('puts every node back on the grid, bend points at their fraction of the side', () => {
    const g = grid(2, 1)
    const a = g.nodeNear(0, -50)
    const b = g.nodeNear(0, 50)
    const bent = addPoint(g, [a, b], 0.25)!
    const mid = bent.nodes[bent.nodes.length - 1]!.id
    const dragged = { ...bent.states[0]!.nodes, [a]: { x: 30, y: -70 }, [mid]: { x: 40, y: -10 } }
    const lattice = latticeOf(bent.tiles)!
    const reset = resetPositions(bent.tiles, lattice, dragged, 100)
    expect(reset[a]).toEqual({ x: 0, y: -50 })
    // The bend's projection onto the dragged side is what it keeps.
    const t = ((40 - 30) * (0 - 30) + (-10 + 70) * (50 + 70)) / ((0 - 30) ** 2 + (50 + 70) ** 2)
    expect(reset[mid]!.x).toBeCloseTo(0)
    expect(reset[mid]!.y).toBeCloseTo(-50 + 100 * t)
  })
})

describe('a chord across a tile', () => {
  it('runs from the crossing behind the start to the one ahead, whichever way the drag went', () => {
    const g = grid(1, 1)
    const ring = g.tiles[0]!.ring
    const positions = g.states[0]!.nodes
    // A short drag from the middle, straight down: top edge to bottom edge.
    const chord = chordAcross(ring, positions, { x: 10, y: 0 }, { x: 10, y: 5 })
    expect(chord).not.toBeNull()
    expect(chord?.a).toEqual({ x: 10, y: -50 })
    expect(chord?.b).toEqual({ x: 10, y: 50 })
    expect(chord?.entry.edge).toEqual([g.nodeNear(-50, -50), g.nodeNear(50, -50)])
    expect(chord?.entry.t).toBeCloseTo(0.6)
    expect(chord?.exit.edge).toEqual([g.nodeNear(50, 50), g.nodeNear(-50, 50)])
    expect(chord?.exit.t).toBeCloseTo(0.4)
    // Started outside: the first two crossings ahead.
    const across = chordAcross(ring, positions, { x: -80, y: 0 }, { x: -70, y: 0 })
    expect(across?.a).toEqual({ x: -50, y: 0 })
    expect(across?.b).toEqual({ x: 50, y: 0 })
    // Along an edge the chord is the edge itself, which is not a cut.
    const along = chordAcross(ring, positions, { x: -50, y: -50 }, { x: 50, y: -50 })
    expect(along === null || cutTile(g, g.tiles[0]!.id, along.entry, along.exit) === null).toBe(true)
  })
})
