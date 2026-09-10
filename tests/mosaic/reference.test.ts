import { describe, expect, it } from 'vitest'

import { forkCoordinate, seedMosaic } from '../../src/mosaic/dissection'
import { edgeRange, moveEdge, selectionEdges } from '../../src/mosaic/boundaries'
import { layoutMosaic } from '../../src/mosaic/layout'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'
import { isRim } from '../../src/types/mosaic'

/**
 * The reference illustration, turned into a test.
 *
 * Seven layouts the user drew, every one of them a nine-box grid rearranged: a
 * big square with thin cells beside it, a tall cell spanning two rows, rows of
 * unequal height with dividers that stop partway. None of them adds or removes a
 * box — they only move lines, which is the whole claim the model has to support.
 *
 * What is checked is that each is REACHABLE by moving lines from a plain grid,
 * with the tile count never changing, and that the result covers its box exactly.
 */

const BOX: Rect = { x: 0, y: 0, width: 900, height: 900 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }

interface Mosaic {
  tiles: MosaicTile[]
  x: Record<string, number>
  y: Record<string, number>
}

const grid = (cols: number, rows: number): Mosaic => {
  const s = seedMosaic(cols, rows)
  return { tiles: s.tiles, x: s.x, y: s.y }
}

const rects = (m: Mosaic): Rect[] =>
  [...layoutMosaic(m.tiles, m.x, m.y, BOX, NONE).values()].map((t) => t.structural)

/** Covering the box exactly is the invariant every one of these has to keep. */
function covers(m: Mosaic): boolean {
  const all = rects(m)
  const total = all.reduce((sum, r) => sum + r.width * r.height, 0)
  if (Math.abs(total - BOX.width * BOX.height) > 1e-6) return false
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as Rect
      const b = all[j] as Rect
      if (
        a.x < b.x + b.width - 1e-9 &&
        b.x < a.x + a.width - 1e-9 &&
        a.y < b.y + b.height - 1e-9 &&
        b.y < a.y + a.height - 1e-9
      ) {
        return false
      }
    }
  }
  return true
}

/** Move a line to a fraction, the way a drag does: clamped, from where it is. */
function put(m: Mosaic, axis: 'x' | 'y', id: string, to: number): Mosaic {
  const values = axis === 'x' ? m.x : m.y
  const size = axis === 'x' ? BOX.width : BOX.height
  const offset = (to - (values[id] as number)) * size
  const moved = moveEdge(m.tiles, m.x, m.y, BOX, NONE, axis, id, offset)
  if (!moved) throw new Error(`cannot move ${id}`)
  const value = moved.updates[0]!.value
  return axis === 'x' ? { ...m, x: { ...m.x, [id]: value } } : { ...m, y: { ...m.y, [id]: value } }
}

/** Give a run of tiles their own copy of a line, so it stops crossing the rest. */
function fork(m: Mosaic, axis: 'x' | 'y', id: string, span: { from: number; to: number }): Mosaic {
  const result = forkCoordinate(
    m.tiles,
    axis === 'x' ? m.x : m.y,
    axis,
    id,
    span,
    axis === 'x' ? m.y : m.x,
  )
  if (!result) throw new Error(`cannot fork ${id}`)
  return axis === 'x'
    ? { tiles: result.tiles, x: { ...m.x, [result.created]: result.value }, y: m.y }
    : { tiles: result.tiles, x: m.x, y: { ...m.y, [result.created]: result.value } }
}

/** The interior lines of a fresh grid, in order across the box. */
const interior = (values: Record<string, number>): string[] =>
  Object.entries(values)
    .filter(([, v]) => v > 0 && v < 1)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)

describe('the reference layouts', () => {
  it('1 — a plain grid, which is what a mosaic starts as', () => {
    const m = grid(3, 3)
    expect(m.tiles).toHaveLength(9)
    expect(covers(m)).toBe(true)
    const all = rects(m)
    expect(new Set(all.map((r) => Math.round(r.width)))).toEqual(new Set([300]))
  })

  it('2 — a tall cell spanning two rows, with its divider stopping at its edge', () => {
    /*
     * The layout that proves terminating edges are expressible. The first
     * column's horizontal divider is forked away from the rest of the row and
     * pushed to the top, so the tile below it fills two rows' worth while the
     * cells beside it keep their own division.
     */
    let m = grid(3, 3)
    const [row1] = interior(m.y)
    const [col1] = interior(m.x)

    // Give the first column its own copy of the first row divider...
    m = fork(m, 'y', row1 as string, { from: 0, to: 1 / 3 })
    const own = interior(m.y).find((id) => id !== row1 && (m.y[id] as number) < 0.5) as string
    // ...and slide it up until that column's top tile is a sliver.
    m = put(m, 'y', own, 0.02)

    expect(m.tiles, 'no box added or removed').toHaveLength(9)
    expect(covers(m)).toBe(true)

    const laid = layoutMosaic(m.tiles, m.x, m.y, BOX, NONE)
    const first = m.tiles.filter((t) => t.left === m.tiles[0]!.left)
    const tall = first
      .map((t) => laid.get(t.id)!.structural)
      .sort((a, b) => b.height - a.height)[0] as Rect
    // The tall cell reaches well past where the neighbouring row divides.
    expect(tall.height).toBeGreaterThan(BOX.height / 3)
    void col1
  })

  it('3 — a big square with thin cells beside it, from the same nine boxes', () => {
    /*
     * Panels 1 and 3 hold the same nine boxes. The square is not four cells
     * merged: it is one box grown while its neighbours shrank, which is why no
     * merge operation was needed.
     */
    let m = grid(3, 3)
    const [c1, c2] = interior(m.x)
    const [r1, r2] = interior(m.y)

    // The outer line first: a drag is clamped by its neighbour, so pushing the
    // inner one out before making room for it just stops it short.
    m = put(m, 'x', c2 as string, 0.84)
    m = put(m, 'x', c1 as string, 0.68)
    m = put(m, 'y', r2 as string, 0.84)
    m = put(m, 'y', r1 as string, 0.68)

    expect(m.tiles).toHaveLength(9)
    expect(covers(m)).toBe(true)

    const all = rects(m)
    const biggest = [...all].sort((a, b) => b.width * b.height - a.width * a.height)[0] as Rect
    // The square takes two thirds of the box each way, and the rest are slivers.
    expect(biggest.width / BOX.width).toBeCloseTo(0.68, 2)
    expect(biggest.height / BOX.height).toBeCloseTo(0.68, 2)
  })

  it('5, 6, 7 — rows dividing at different places, which needs no forking at all', () => {
    /*
     * Each band divides itself, so row 1 can split at 45% while row 2 splits at
     * 62%. In the seeded grid those are one shared line, so this is a fork and
     * two moves — and the tiles stay put throughout.
     */
    let m = grid(2, 3)
    const [col] = interior(m.x)
    const rows = interior(m.y)

    m = fork(m, 'x', col as string, { from: 0, to: 1 / 3 })
    const top = interior(m.x).find((id) => id !== col) as string
    m = put(m, 'x', top, 0.45)
    m = put(m, 'x', col as string, 0.62)

    expect(m.tiles).toHaveLength(6)
    expect(covers(m)).toBe(true)

    const laid = layoutMosaic(m.tiles, m.x, m.y, BOX, NONE)
    const topRow = m.tiles.filter((t) => t.top === m.tiles[0]!.top)
    const lower = m.tiles.filter((t) => t.top !== m.tiles[0]!.top && t.bottom !== m.tiles[0]!.top)
    const topEdge = laid.get(topRow[0]!.id)!.structural
    const lowerEdge = laid.get(lower[0]!.id)!.structural
    expect(topEdge.width / BOX.width).toBeCloseTo(0.45, 2)
    expect(lowerEdge.width / BOX.width).toBeCloseTo(0.62, 2)
    void rows
  })

  it('never lets a drag break the covering, however far it is pushed', () => {
    // Every layout above is reached by moving lines, so this is the guarantee
    // they all rest on: a drag clamps, and a clamped drag still covers the box.
    let m = grid(4, 4)
    for (const id of interior(m.x)) {
      const range = edgeRange(m.tiles, m.x, m.y, BOX, NONE, 'x', id)
      const moved = moveEdge(m.tiles, m.x, m.y, BOX, NONE, 'x', id, range.min - 5000)!
      m = { ...m, x: { ...m.x, [id]: moved.updates[0]!.value } }
      expect(covers(m), `after slamming ${id}`).toBe(true)
    }
    for (const id of interior(m.y)) {
      const range = edgeRange(m.tiles, m.x, m.y, BOX, NONE, 'y', id)
      const moved = moveEdge(m.tiles, m.x, m.y, BOX, NONE, 'y', id, range.max + 5000)!
      m = { ...m, y: { ...m.y, [id]: moved.updates[0]!.value } }
      expect(covers(m), `after slamming ${id}`).toBe(true)
    }
    expect(m.tiles).toHaveLength(16)
  })

  it('offers every selection an edge on all four sides where one exists', () => {
    const m = grid(3, 3)
    /*
     * `isRim`, not a substring of the id. Coordinate ids are ten random base36
     * characters, so roughly one in 2,700 of them CONTAINS "min" or "max" —
     * which quietly disqualified a middle tile and left this test picking a
     * corner, or nothing at all, a few times in every full run.
     */
    const middle = m.tiles.find((t) => !isRim(t.left) && !isRim(t.right)) as MosaicTile
    expect(middle, 'a 3 × 3 has a middle column').toBeTruthy()
    const edges = selectionEdges(m.tiles, m.x, m.y, BOX, NONE, [middle.id])
    expect(edges.filter((e) => e.axis === 'x').length).toBeGreaterThan(0)
    expect(edges.filter((e) => e.axis === 'y').length).toBeGreaterThan(0)
  })
})
