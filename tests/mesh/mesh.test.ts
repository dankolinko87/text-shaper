import { describe, expect, it } from 'vitest'

import { evaluatePatch } from '../../src/geometry/patch'
import {
  bilinearQuad,
  cellMap,
  collinearChain,
  distanceToSegment,
  edgesOf,
  insetPolygon,
  interiorOf,
  isConvex,
  isSimple,
  meshBounds,
  patchFromPolygon,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  rectangleOf,
  rimLoops,
  roundedPolygonCommands,
  seedMesh,
  tileLayout,
  validateMesh,
} from '../../src/mesh/mesh'
import { layoutMesh } from '../../src/mesh/layout'
import { readingOrder } from '../../src/mosaic/order'
import type { Vec2 } from '../../src/types/document'

/**
 * The geometry of a mesh, asked directly: rings, insets, the cell map, the
 * rim, the chains. The rule every answer rests on — a ring is positive signed
 * area with y pointing down, clockwise on screen — is pinned first.
 */

const square = (size = 100, at: Vec2 = { x: 0, y: 0 }): Vec2[] => [
  { x: at.x, y: at.y },
  { x: at.x + size, y: at.y },
  { x: at.x + size, y: at.y + size },
  { x: at.x, y: at.y + size },
]

const near = (p: Vec2, q: Vec2, tolerance = 1e-6): void => {
  expect(Math.abs(p.x - q.x)).toBeLessThan(tolerance)
  expect(Math.abs(p.y - q.y)).toBeLessThan(tolerance)
}

describe('rings', () => {
  it('walks clockwise on screen, which is positive area', () => {
    expect(polygonArea(square())).toBe(100 * 100)
    expect(polygonArea([...square()].reverse())).toBe(-100 * 100)
  })

  it('seeds a grid whose tiles read row by row and share their corners', () => {
    const seeded = seedMesh(3, 2, 100)
    expect(seeded.nodes).toHaveLength(4 * 3)
    expect(seeded.tiles).toHaveLength(6)
    for (const tile of seeded.tiles) {
      const ring = tile.ring.map((id) => seeded.positions[id] as Vec2)
      expect(polygonArea(ring)).toBeCloseTo(100 * 100, 6)
      expect(tile.corners).toEqual(tile.ring)
    }
    // Centred on the origin.
    const box = meshBounds([{ nodes: seeded.positions }])
    expect(box).toEqual({ x: -150, y: -100, width: 300, height: 200 })
    // The first tile's top-right is the second tile's top-left.
    expect(seeded.tiles[0]?.ring[1]).toBe(seeded.tiles[1]?.ring[0])
    // Row-major is reading order.
    const layouts = layoutMesh(seeded.tiles, seeded.positions, { gap: 0, glyphInset: 0 })
    expect(readingOrder(layouts)).toEqual(seeded.tiles.map((tile) => tile.id))
    expect(validateMesh(seeded.nodes, seeded.tiles, [{ id: 's', nodes: seeded.positions }])).toEqual([])
  })

  it('knows a point inside from one outside, and a simple ring from a crossed one', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square())).toBe(true)
    expect(pointInPolygon({ x: 150, y: 50 }, square())).toBe(false)
    expect(isSimple(square())).toBe(true)
    const bowtie: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ]
    expect(isSimple(bowtie)).toBe(false)
    expect(isConvex(square())).toBe(true)
    near(polygonCentroid(square()), { x: 50, y: 50 })
  })

  it('finds every problem a broken mesh has', () => {
    const seeded = seedMesh(2, 1, 100)
    const crossed = { ...seeded.positions }
    const tile = seeded.tiles[0]!
    // Swap two corners: the ring crosses itself.
    const [a, b] = [tile.ring[0]!, tile.ring[1]!]
    crossed[a] = seeded.positions[b] as Vec2
    crossed[b] = seeded.positions[a] as Vec2
    const problems = validateMesh(seeded.nodes, seeded.tiles, [{ id: 's', nodes: crossed }])
    expect(problems.some((p) => p.includes('crosses itself') || p.includes('no area'))).toBe(true)
    const missing = validateMesh(seeded.nodes, seeded.tiles, [{ id: 's', nodes: {} }])
    expect(missing.some((p) => p.includes('does not place'))).toBe(true)
  })
})

describe('insets', () => {
  it('insets a rectangle side by side exactly as the mosaic insets its visible rect', () => {
    // Top and bottom are interior (half a gap of 3), the sides are the rim.
    const out = insetPolygon(square(100), [3, 0, 3, 0])!
    expect(out).toHaveLength(4)
    near(out[0]!, { x: 0, y: 3 })
    near(out[1]!, { x: 100, y: 3 })
    near(out[2]!, { x: 100, y: 97 })
    near(out[3]!, { x: 0, y: 97 })
  })

  it('projects a bend point on a straight side by the mean inset', () => {
    const ring: Vec2[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ]
    const out = insetPolygon(ring, ring.map(() => 5))!
    near(out[1]!, { x: 50, y: 5 })
    near(out[0]!, { x: 5, y: 5 })
  })

  it('handles a reflex corner, which moves inward too', () => {
    const ell: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 100 },
    ]
    const out = insetPolygon(ell, ell.map(() => 5))!
    near(out[3]!, { x: 45, y: 45 })
    expect(polygonArea(out)).toBeGreaterThan(0)
  })

  it('clamps a mitre at a sharp corner', () => {
    const spike: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 4 },
      { x: 0, y: 4 },
    ]
    // A very thin slab: the sides are 4 apart, so an inset of 1 fits and the
    // mitre at a right angle is within the limit.
    const out = insetPolygon(spike, spike.map(() => 1))!
    near(out[0]!, { x: 1, y: 1 })
    const needle: Vec2[] = [
      { x: 0, y: 0 },
      { x: 200, y: 2 },
      { x: 0, y: 4 },
    ]
    const clamped = insetPolygon(needle, needle.map(() => 0.5))
    // The tip's mitre would reach far; clamped it stays within four insets.
    if (clamped) {
      const tip = clamped[1]!
      expect(Math.hypot(tip.x - 200, tip.y - 2)).toBeLessThanOrEqual(0.5 * 4 + 1e-9)
    }
  })

  it('swallows a side shorter than the inset instead of voiding the polygon', () => {
    // A thin cell whose tip is two nodes five units apart: the tips of two
    // cut cells, or a point added beside a corner. Half a gap of ten runs
    // through that side and out the other end.
    const tip = { x: 443, y: 510 }
    const ring: Vec2[] = [{ x: 385, y: 320 }, { x: 500, y: 320 }, { x: tip.x + 4, y: tip.y - 3 }, tip]
    const out = insetPolygon(ring, [0, 10, 10, 10])
    expect(out, 'the tile is still there').not.toBeNull()
    expect(out).toHaveLength(4)
    // Both ends of the swallowed side sit on one point: where the two long
    // sides' inset lines meet, ten in from each, inside the cell.
    near(out![2]!, out![3]!)
    expect(polygonArea(out!)).toBeGreaterThan(0)
    expect(isSimple(out!.slice(0, 3))).toBe(true)
    const merged = out![3]!
    expect(distanceToSegment(merged, ring[1]!, ring[2]!)).toBeCloseTo(10, 3)
    expect(distanceToSegment(merged, ring[3]!, ring[0]!)).toBeCloseTo(10, 3)
    expect(merged.y).toBeLessThan(tip.y)
    expect(merged.y).toBeGreaterThan(320)
    // A whole tile lays out with a visible face at a gap that used to hide it.
    const tile = { id: 't', ring: ['a', 'b', 'c', 'd'], corners: ['a', 'b', 'c', 'd'] as [string, string, string, string] }
    const positions = { a: ring[0]!, b: ring[1]!, c: ring[2]!, d: ring[3]! }
    const interior = (p: string, q: string) => !((p === 'a' && q === 'b') || (p === 'b' && q === 'a'))
    const layout = tileLayout(tile, positions, { gap: 20.5, glyphInset: 6, outerPadding: 0 }, interior)
    expect(polygonArea(layout.visible)).toBeGreaterThan(1000)
  })

  it('collapses rather than inverting', () => {
    expect(insetPolygon(square(4), [3, 3, 3, 3])).toBeNull()
    expect(insetPolygon(square(4), [1, 1, 1, 1])).not.toBeNull()
  })
})

describe('cells', () => {
  it('lays out a seeded tile as the mosaic would: rect fast path, insets exact', () => {
    const seeded = seedMesh(2, 1, 100)
    const layouts = layoutMesh(seeded.tiles, seeded.positions, { gap: 6, glyphInset: 6 })
    const first = layouts.get(seeded.tiles[0]!.id)!
    // Left tile: the shared side is inset by half the gap, the rim is not.
    expect(first.rect).not.toBeNull()
    expect(first.rect).toEqual({ x: -100 + 6, y: -50 + 6, width: 100 - 3 - 12, height: 100 - 12 })
    expect(first.patch).toBeNull()
    near(first.visible[1]!, { x: -3, y: -50 })
    const map = cellMap(first)!
    near(map(0, 0), { x: first.rect!.x, y: first.rect!.y })
    near(map(1, 1), { x: first.rect!.x + first.rect!.width, y: first.rect!.y + first.rect!.height })
  })

  it('maps a sheared quad bilinearly, corners to corners', () => {
    const tile = { id: 't', ring: ['a', 'b', 'c', 'd'], corners: ['a', 'b', 'c', 'd'] as [string, string, string, string] }
    const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 20 }, c: { x: 120, y: 120 }, d: { x: 10, y: 100 } }
    const layout = tileLayout(tile, positions, { gap: 0, glyphInset: 0 }, () => false)
    expect(layout.rect).toBeNull()
    expect(layout.patch).toBeNull()
    const map = cellMap(layout)!
    near(map(0, 0), positions.a)
    near(map(1, 0), positions.b)
    near(map(1, 1), positions.c)
    near(map(0, 1), positions.d)
    near(map(0.5, 0.5), bilinearQuad(positions.a, positions.b, positions.c, positions.d, 0.5, 0.5))
  })

  it('builds a patch through a bend point, and the side passes through it', () => {
    const ring: Vec2[] = [
      { x: 0, y: 0 },
      { x: 50, y: -20 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]
    const patch = patchFromPolygon(ring, [0, 2, 3, 4])
    near(evaluatePatch(patch, 0, 0), ring[0]!)
    near(evaluatePatch(patch, 1, 0), ring[2]!)
    near(evaluatePatch(patch, 1, 1), ring[3]!)
    near(evaluatePatch(patch, 0, 1), ring[4]!)
    // Half way along the top by arc length is the bend.
    near(evaluatePatch(patch, 0.5, 0), ring[1]!, 1e-3)
    // The bottom is straight, so its middle is its middle.
    near(evaluatePatch(patch, 0.5, 1), { x: 50, y: 100 }, 1e-3)
  })

  it('maps the visible face as well as the glyph, and remembers the tiers', () => {
    const seeded = seedMesh(2, 1, 100)
    const layouts = layoutMesh(seeded.tiles, seeded.positions, { gap: 6, glyphInset: 6 })
    const first = layouts.get(seeded.tiles[0]!.id)!
    const face = cellMap(first, 'visible')!
    near(face(0, 0), { x: -100, y: -50 })
    near(face(1, 1), { x: -3, y: 50 })
    expect(first.visibleRect).toEqual({ x: -100, y: -50, width: 97, height: 100 })
    // The glyph map is the inset one, untouched.
    near(cellMap(first)!(0, 0), { x: first.rect!.x, y: first.rect!.y })

    const tile = { id: 't', ring: ['a', 'b', 'c', 'd'], corners: ['a', 'b', 'c', 'd'] as [string, string, string, string] }
    const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 20 }, c: { x: 120, y: 120 }, d: { x: 10, y: 100 } }
    const sheared = tileLayout(tile, positions, { gap: 0, glyphInset: 10 }, () => false)
    const shearedFace = cellMap(sheared, 'visible')!
    near(shearedFace(0, 0), positions.a)
    near(shearedFace(1, 1), positions.c)
    expect(sheared.visibleRect).toBeNull()
    expect(sheared.visiblePatch).toBeNull()
    // The glyph is inset, so its map lands inside the face.
    const inner = cellMap(sheared)!(0, 0)
    expect(inner.x).toBeGreaterThan(positions.a.x)
    expect(inner.y).toBeGreaterThan(positions.a.y)
  })

  it('is a rectangle only in the expected corner order', () => {
    expect(rectangleOf(square())).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    const turned = [square()[1]!, square()[2]!, square()[3]!, square()[0]!]
    expect(rectangleOf(turned)).toBeNull()
  })
})

describe('the rim and the chains', () => {
  it('walks one loop round a grid, and a hole the other way', () => {
    const seeded = seedMesh(3, 3, 100)
    const loops = rimLoops(seeded.tiles)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(12)
    expect(polygonArea(loops[0]!.map((id) => seeded.positions[id] as Vec2))).toBeGreaterThan(0)

    const holed = seeded.tiles.filter((_, i) => i !== 4)
    const withHole = rimLoops(holed)
    expect(withHole).toHaveLength(2)
    const areas = withHole.map((loop) => polygonArea(loop.map((id) => seeded.positions[id] as Vec2)))
    expect(areas.filter((a) => a > 0)).toHaveLength(1)
    expect(areas.filter((a) => a < 0)).toHaveLength(1)
    expect(Math.abs(areas.find((a) => a < 0)!)).toBeCloseTo(100 * 100, 6)
  })

  it('tells interior edges from rim edges', () => {
    const seeded = seedMesh(2, 1, 100)
    const edges = edgesOf(seeded.tiles)
    const interior = interiorOf(edges)
    const [left, right] = seeded.tiles as [typeof seeded.tiles[0], typeof seeded.tiles[0]]
    expect(interior(left.ring[1]!, left.ring[2]!)).toBe(true)
    expect(interior(left.ring[0]!, left.ring[1]!)).toBe(false)
    expect(right.ring[0]).toBe(left.ring[1])
  })

  it('follows a straight divider across a fresh grid and stops where it bends', () => {
    const seeded = seedMesh(3, 3, 100)
    // The vertical edge between the middle row's first and second tiles.
    const middleLeft = seeded.tiles[3]!
    const edge: [string, string] = [middleLeft.ring[1]!, middleLeft.ring[2]!]
    const chain = collinearChain(seeded.tiles, seeded.positions, edge)
    expect(chain).toHaveLength(3)

    const bent = { ...seeded.positions }
    const top = seeded.tiles[0]!.ring[1]!
    bent[top] = { x: (bent[top] as Vec2).x + 40, y: (bent[top] as Vec2).y }
    expect(collinearChain(seeded.tiles, bent, edge)).toHaveLength(2)
  })
})

describe('paths', () => {
  it('rounds a polygon with a fixed number of commands, whatever the radius', () => {
    const sharp = roundedPolygonCommands(square(), 0)
    const round = roundedPolygonCommands(square(), 10)
    expect(sharp).toHaveLength(2 * 4 + 1)
    expect(round).toHaveLength(2 * 4 + 1)
    expect(sharp[0]).toEqual(['M', 0, 0])
    // The first arc starts ten units before the corner along the last side.
    expect(round[0]).toEqual(['M', 0, 10])
    expect(round[1]).toEqual(['Q', 0, 0, 10, 0])
    // A radius bigger than the side is fitted to half of it.
    const pill = roundedPolygonCommands(square(20), 100)
    expect(pill[0]).toEqual(['M', 0, 10])
  })
})
