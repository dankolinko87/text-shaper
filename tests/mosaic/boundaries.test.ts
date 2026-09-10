import { describe, expect, it } from 'vitest'

import {
  canReshape,
  collateral,
  reachesBeyond,
  edgeAt,
  edgeRange,
  moveEdge,
  selectionEdges,
  selectionRuns,
  type MosaicEdge,
} from '../../src/mosaic/boundaries'
import { forkCoordinate, mergeCoordinates, seedMosaic } from '../../src/mosaic/dissection'
import { tileAt } from '../../src/mosaic/tiles'
import { splitTile } from '../../src/mosaic/topology'
import { layoutMosaic } from '../../src/mosaic/layout'
import { MINIMUM_VISIBLE } from '../../src/mosaic/spacing'
import {
  pointArtboardToObject,
  pointObjectToArtboard,
  vectorObjectToArtboard,
} from '../../src/geometry/objectSpace'
import type { Rect, Transform2D } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'
import { isRim } from '../../src/types/mosaic'

/**
 * Dragging the lines between tiles.
 *
 * The property four rounds of bug reports were about: moving a line changes
 * exactly the tiles that name it, and no others. Under the old partition tree
 * that could not be stated, let alone tested — an edge was not a thing, and how
 * much moved depended on the order the cuts had been made.
 */

const BOX: Rect = { x: -300, y: -300, width: 600, height: 600 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }
const spacing = (patch: Partial<MosaicSpacing> = {}): MosaicSpacing => ({ ...NONE, ...patch })

interface Fixture {
  list: MosaicTile[]
  x: Record<string, number>
  y: Record<string, number>
}

const grid = (cols: number, rows: number): Fixture => {
  const s = seedMosaic(cols, rows)
  return { list: s.tiles, x: s.x, y: s.y }
}

const TOL = { x: 8, y: 8 }

const rectsOf = (f: Fixture, space: MosaicSpacing = NONE, box: Rect = BOX): Map<string, Rect> =>
  new Map(
    [...layoutMosaic(f.list, f.x, f.y, box, space).entries()].map(([id, t]) => [id, t.structural]),
  )

const edgesFor = (f: Fixture, selection: string[], space: MosaicSpacing = NONE): MosaicEdge[] =>
  selectionEdges(f.list, f.x, f.y, BOX, space, selection)

/** A tile with all four edges inside the mosaic, so it has four lines to grab. */
function middleTile(f: Fixture): { id: string; rect: Rect } {
  for (const tile of f.list) {
    if (!isRim(tile.left) && !isRim(tile.right) && !isRim(tile.top) && !isRim(tile.bottom)) {
      return { id: tile.id, rect: rectsOf(f).get(tile.id) as Rect }
    }
  }
  throw new Error('no tile with four inside edges')
}

describe('which lines a selection offers', () => {
  it('offers nothing when nothing is selected', () => {
    expect(edgesFor(grid(3, 3), [])).toHaveLength(0)
  })

  it('offers a middle tile all four of its sides', () => {
    const f = grid(3, 3)
    const middle = middleTile(f)
    const edges = edgesFor(f, [middle.id])

    expect(edges.filter((e) => e.axis === 'x')).toHaveLength(2)
    expect(edges.filter((e) => e.axis === 'y')).toHaveLength(2)

    const r = middle.rect
    for (const edge of edges) {
      const sides = edge.axis === 'x' ? [r.x, r.x + r.width] : [r.y, r.y + r.height]
      expect(sides.some((s) => Math.abs(s - edge.position) < 1e-6)).toBe(true)
    }
  })

  it('offers nothing on the rim, which is the object’s own size', () => {
    const f = grid(3, 3)
    const rects = rectsOf(f)
    const corner = [...rects.entries()].sort((a, b) => a[1].x + a[1].y - (b[1].x + b[1].y))[0]!
    for (const edge of edgesFor(f, [corner[0]])) {
      expect(Math.abs(edge.position - BOX.x)).toBeGreaterThan(1)
      expect(Math.abs(edge.position - BOX.y)).toBeGreaterThan(1)
    }
  })

  it('draws each line along the selection, not along everything that names it', () => {
    /*
     * Reported from the app: one selected tile sprouted handles several times its
     * own size. The line may be shared far beyond the selection — that is what
     * `moves` is for — but the thing you grab sits on the tiles you picked.
     */
    const f = grid(4, 4)
    const middle = middleTile(f)
    const r = middle.rect
    for (const edge of edgesFor(f, [middle.id])) {
      const [low, high] = edge.axis === 'x' ? [r.y, r.y + r.height] : [r.x, r.x + r.width]
      expect(edge.from).toBeGreaterThanOrEqual(low - 1e-6)
      expect(edge.to).toBeLessThanOrEqual(high + 1e-6)
    }
  })
})

describe('what a drag moves', () => {
  it('moves exactly the tiles that name the line, and no others', () => {
    /*
     * THE property. Four rounds of reports were this: dragging one tile's edge
     * resized tiles that had never been selected, in numbers that depended on
     * where in the tree the tile happened to sit.
     */
    const f = grid(4, 4)
    const middle = middleTile(f)
    const edge = edgesFor(f, [middle.id]).find((e) => e.axis === 'x') as MosaicEdge

    const before = rectsOf(f)
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, 25)!
    const after = rectsOf({ ...f, x: { ...f.x, [edge.id]: moved.updates[0]!.value } })

    const changed = [...before.keys()].filter((id) => {
      const a = before.get(id) as Rect
      const b = after.get(id) as Rect
      return Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.width - b.width) > 1e-9
    })

    expect(new Set(changed)).toEqual(new Set(edge.moves))
    // And every tile that moved really does name that line.
    for (const id of changed) {
      const tile = f.list.find((t) => t.id === id) as MosaicTile
      expect(tile.left === edge.id || tile.right === edge.id, id).toBe(true)
    }
  })

  it('gives a tile’s own edge a reach of two, on every side', () => {
    /*
     * The 2/6/6/16 measurement that motivated the rewrite, taken again. In a
     * fresh grid every line is shared down its column or across its row, so a
     * single tile's edges move a column; forking is what makes them its own.
     * What matters here is that the number is the COLUMN, not something that
     * varies with tree position — and that it is 2 once the line is its own.
     */
    const f = grid(4, 4)
    const middle = middleTile(f)
    for (const edge of edgesFor(f, [middle.id])) {
      // A column of four, or a row of four: the tiles either side of the line.
      expect(edge.moves.length, `${edge.axis} reach`).toBe(8)
    }

    /*
     * Now fork each of its four lines for that tile alone, through the real
     * operation, and every side moves exactly two tiles: the tile and the one
     * opposite giving up the space. That is the answer the whole rewrite was
     * for, and it is the same on all four sides.
     */
    let own: Fixture = { list: f.list, x: { ...f.x }, y: { ...f.y } }
    for (const axis of ['x', 'y'] as const) {
      for (const side of axis === 'x' ? (['left', 'right'] as const) : (['top', 'bottom'] as const)) {
        const tile = own.list.find((t) => t.id === middle.id) as MosaicTile
        const perpendicular = axis === 'x' ? own.y : own.x
        const lowId = axis === 'x' ? tile.top : tile.left
        const highId = axis === 'x' ? tile.bottom : tile.right
        const forked = forkCoordinate(
          own.list,
          axis === 'x' ? own.x : own.y,
          axis,
          tile[side],
          { from: perpendicular[lowId] ?? 0, to: perpendicular[highId] ?? 1 },
          perpendicular,
        )
        expect(forked, `${side} forks`).toBeTruthy()
        if (!forked) continue
        own = {
          list: forked.tiles,
          x: axis === 'x' ? { ...own.x, [forked.created]: forked.value } : own.x,
          y: axis === 'y' ? { ...own.y, [forked.created]: forked.value } : own.y,
        }
      }
    }

    for (const edge of edgesFor(own, [middle.id])) {
      expect(edge.moves.length, `${edge.axis} once it is its own`).toBe(2)
    }
  })

  it('holds the line under the pointer until it reaches a limit', () => {
    const f = grid(3, 1)
    const edge = edgesFor(f, [f.list[0]!.id])[0] as MosaicEdge

    for (const offset of [-40, -5, 12, 60]) {
      const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, offset)!
      expect(moved.clamped, `offset ${offset}`).toBe(false)
      const after = edgesFor({ ...f, x: { ...f.x, [edge.id]: moved.updates[0]!.value } }, [f.list[0]!.id])[0]!
      expect(after.position, `offset ${offset}`).toBeCloseTo(edge.position + offset, 6)
    }
  })

  it('stops at the limit, stays live, and comes back when the drag reverses', () => {
    const f = grid(3, 1)
    const edge = edgesFor(f, [f.list[0]!.id])[0] as MosaicEdge
    const range = edgeRange(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id)

    const past = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, range.max + 500)!
    expect(past.clamped, 'says it was held back').toBe(true)
    const atLimit = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, range.max)!
    expect(past.updates[0]!.value).toBeCloseTo(atLimit.updates[0]!.value, 12)

    // Reversing works straight away, from the original value.
    const back = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, 0)!
    expect(back.updates[0]!.value).toBeCloseTo(f.x[edge.id] as number, 12)
  })

  it('does not drift when a drag is replayed frame by frame', () => {
    /*
     * Every frame is computed from the value captured at pointer-down, so a long
     * drag lands where a single jump to its end does. Applying each frame to the
     * result of the last would round sixty times a second and the line would
     * slowly part company with the pointer.
     */
    const f = grid(3, 1)
    const edge = edgesFor(f, [f.list[0]!.id])[0] as MosaicEdge

    let last = 0
    for (let i = 1; i <= 200; i++) {
      last = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, i * 0.35)!.updates[0]!.value
    }
    const direct = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, 70)!.updates[0]!.value
    expect(last).toBe(direct)
  })

  it('never lets a tile go below the minimum, with the gap and inset counted', () => {
    for (const space of [NONE, spacing({ gap: 30 }), spacing({ gap: 10, glyphInset: 20 })]) {
      const f = grid(4, 2)
      const edge = edgesFor(f, [f.list[0]!.id], space).find((e) => e.axis === 'x') as MosaicEdge
      const range = edgeRange(f.list, f.x, f.y, BOX, space, edge.axis, edge.id)

      for (const offset of [range.min, range.max]) {
        const moved = moveEdge(f.list, f.x, f.y, BOX, space, edge.axis, edge.id, offset)!
        const after = layoutMosaic(f.list, { ...f.x, [edge.id]: moved.updates[0]!.value }, f.y, BOX, space)
        for (const tile of after.values()) {
          expect(tile.visible.width).toBeGreaterThanOrEqual(MINIMUM_VISIBLE - 1e-6)
          expect(tile.glyph.width).toBeGreaterThanOrEqual(-1e-6)
        }
      }
    }
  })

  it('refuses to move the rim', () => {
    const f = grid(2, 2)
    const rim = f.list[0]!.left
    expect(isRim(rim)).toBe(true)
    expect(moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', rim, 20)).toBeNull()
    expect(edgeRange(f.list, f.x, f.y, BOX, NONE, 'x', rim)).toEqual({ min: 0, max: 0 })
  })
})

describe('finding the line under the pointer', () => {
  it('hits from within the tolerance and misses from beyond it', () => {
    const f = grid(2, 1)
    const edges = edgesFor(f, [f.list[0]!.id])
    const only = edges[0] as MosaicEdge
    expect(edgeAt(edges, { x: only.position + 3, y: 0 }, TOL)).toBeTruthy()
    expect(edgeAt(edges, { x: only.position + 40, y: 0 }, TOL)).toBeNull()
  })

  it('keeps the same reach on screen however far the view is zoomed', () => {
    const f = grid(2, 1)
    const edges = edgesFor(f, [f.list[0]!.id])
    const line = (edges[0] as MosaicEdge).position

    for (const zoom of [0.25, 1, 4]) {
      const local = { x: 8 / zoom, y: 8 / zoom }
      expect(edgeAt(edges, { x: line + 5 / zoom, y: 0 }, local), `zoom ${zoom}`).toBeTruthy()
      expect(edgeAt(edges, { x: line + 14 / zoom, y: 0 }, local), `zoom ${zoom}`).toBeNull()
    }
  })

  /*
   * Found while trying to drive a 2×2 block by hand: aiming at the middle of its
   * right edge grabbed the divider running through it instead, and the drag then
   * went nowhere because the pointer was moving along that divider's own axis.
   *
   * The reach is the same for anyone using it — on a 2×2 block the divider lies
   * exactly at the midpoint of the outer edge, which is where a hand goes.
   */
  it('prefers the block’s own edge to a divider crossing it at the midpoint', () => {
    const f = grid(4, 4)
    const rects = rectsOf(f)
    // Four tiles: the two-by-two in the top-left quarter.
    const quarter = [...rects.entries()]
      .filter(([, r]) => r.x < BOX.x + BOX.width / 2 - 1 && r.y < BOX.y + BOX.height / 2 - 1)
      .map(([id]) => id)
    expect(quarter).toHaveLength(4)

    const edges = edgesFor(f, quarter)
    const right = edges
      .filter((e) => e.axis === 'x' && e.block)
      .sort((a, b) => b.position - a.position)[0] as MosaicEdge
    expect(right, 'the block has a right edge').toBeTruthy()

    // Its midpoint, which is exactly where the horizontal divider crosses.
    const midpoint = { x: right.position, y: (right.from + right.to) / 2 }
    const divider = edges.find(
      (e) => e.axis === 'y' && !e.block && Math.abs(e.position - midpoint.y) < 1e-6,
    )
    expect(divider, 'and a divider crosses it there').toBeTruthy()

    const hit = edgeAt(edges, midpoint, TOL) as MosaicEdge
    expect(hit.axis, 'the block’s edge answers').toBe('x')
    expect(hit.id).toBe(right.id)
    expect(hit.block, 'and it still knows its block').toBeTruthy()
  })

  it('will not be grabbed from off the end of its own run', () => {
    const f = grid(2, 2)
    const edge = edgesFor(f, [f.list[0]!.id]).find((e) => e.axis === 'x') as MosaicEdge
    expect(edgeAt([edge], { x: edge.position, y: edge.to + 200 }, TOL)).toBeNull()
  })

  it('prefers the line that disturbs less where two meet at a corner', () => {
    const f = grid(3, 3)
    const middle = middleTile(f)
    const edges = edgesFor(f, [middle.id])
    const corner = { x: middle.rect.x + middle.rect.width, y: middle.rect.y }
    const picked = edgeAt(edges, corner, { x: 10, y: 10 })
    expect(picked).toBeTruthy()
    const others = edges.filter((e) => e !== picked)
    for (const other of others) {
      if (Math.abs(other.position - corner.x) < 10 || Math.abs(other.position - corner.y) < 10) {
        expect(picked!.moves.length).toBeLessThanOrEqual(other.moves.length)
      }
    }
  })
})

describe('after the mosaic has been moved about', () => {
  const transforms: [string, Transform2D][] = [
    ['at rest', { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }],
    ['moved', { x: 420, y: -90, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }],
    ['scaled evenly', { x: 40, y: 40, scaleX: 2, scaleY: 2, rotation: 0, flipX: false, flipY: false }],
    [
      'scaled unevenly',
      { x: -30, y: 15, scaleX: 3, scaleY: 0.4, rotation: 0, flipX: false, flipY: false },
    ],
    ['turned', { x: 12, y: 8, scaleX: 1, scaleY: 1, rotation: 37, flipX: false, flipY: false }],
    [
      'turned and stretched',
      { x: 200, y: 120, scaleX: 1.8, scaleY: 0.6, rotation: -115, flipX: false, flipY: false },
    ],
  ]

  it.each(transforms)('moves the line by the same amount when %s', (_name, transform) => {
    const f = grid(3, 1)
    const edge = edgesFor(f, [f.list[0]!.id])[0] as MosaicEdge

    const startScene = pointObjectToArtboard(transform, { x: edge.position, y: 0 })
    const endScene = pointObjectToArtboard(transform, { x: edge.position + 40, y: 0 })
    const from = pointArtboardToObject(transform, startScene)
    const to = pointArtboardToObject(transform, endScene)
    expect(to.x - from.x).toBeCloseTo(40, 9)

    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, edge.axis, edge.id, to.x - from.x)!
    const after = edgesFor({ ...f, x: { ...f.x, [edge.id]: moved.updates[0]!.value } }, [f.list[0]!.id])[0]!
    expect(after.position).toBeCloseTo(edge.position + 40, 6)
  })

  it('measures the hover reach per axis when the mosaic is stretched', () => {
    const transform = transforms[3]![1]
    const ex = vectorObjectToArtboard(transform, { x: 1, y: 0 })
    const ey = vectorObjectToArtboard(transform, { x: 0, y: 1 })
    const tolerance = { x: 8 / Math.hypot(ex.x, ex.y), y: 8 / Math.hypot(ey.x, ey.y) }
    expect(tolerance.y).toBeGreaterThan(tolerance.x * 3)

    const f = grid(3, 3)
    const middle = middleTile(f)
    const edges = edgesFor(f, [middle.id])
    const vertical = edges.find((e) => e.axis === 'x') as MosaicEdge
    const horizontal = edges.find((e) => e.axis === 'y') as MosaicEdge

    const offX = 7 / Math.hypot(ex.x, ex.y)
    const offY = 7 / Math.hypot(ey.x, ey.y)
    const midV = (vertical.from + vertical.to) / 2
    const midH = (horizontal.from + horizontal.to) / 2
    expect(edgeAt([vertical], { x: vertical.position + offX, y: midV }, tolerance)).toBeTruthy()
    expect(edgeAt([horizontal], { x: midH, y: horizontal.position + offY }, tolerance)).toBeTruthy()
  })
})

describe('whether a mosaic can be reshaped at all', () => {
  it('says yes for a normal one', () => {
    const f = grid(3, 4)
    expect(canReshape(f.list, f.x, f.y, BOX, spacing({ gap: 6, glyphInset: 6 }))).toBe(true)
  })

  it('says no when the spacing has already used up the room', () => {
    const f = grid(4, 4)
    const tiny: Rect = { x: 0, y: 0, width: 20, height: 20 }
    expect(canReshape(f.list, f.x, f.y, tiny, spacing({ gap: 4 }))).toBe(false)
  })

  it('still says yes after a line has been dragged to its limit', () => {
    /*
     * Sitting exactly ON the floor is where a drag that reached its limit leaves
     * a tile. Compared strictly, the last unit in the last place would decide
     * whether reshaping is still offered — about an edit just permitted.
     */
    const f = grid(7, 6)
    const box: Rect = { x: -420, y: -360, width: 840, height: 720 }
    const space = spacing({ gap: 6, glyphInset: 6 })
    const edge = selectionEdges(f.list, f.x, f.y, box, space, [f.list[0]!.id]).find(
      (e) => e.axis === 'x',
    ) as MosaicEdge
    const range = edgeRange(f.list, f.x, f.y, box, space, edge.axis, edge.id)
    const moved = moveEdge(f.list, f.x, f.y, box, space, edge.axis, edge.id, range.min)!
    const after = { ...f, x: { ...f.x, [edge.id]: moved.updates[0]!.value } }

    expect(canReshape(after.list, after.x, after.y, box, space)).toBe(true)
    expect(
      edgeRange(after.list, after.x, after.y, box, space, edge.axis, edge.id).max,
    ).toBeGreaterThan(0)
  })
})

describe('how far a line reaches beyond the selection', () => {
  it('counts the tiles that move but were not chosen', () => {
    const f = grid(3, 3)
    const middle = middleTile(f)
    const edge = edgesFor(f, [middle.id])[0] as MosaicEdge
    expect(collateral(edge, [middle.id])).toBe(edge.moves.length - 1)
  })

  it('drops to the two opposite tiles once the whole run is selected', () => {
    // A whole column selected: the line between it and the next column moves
    // that column and the one beside it, and nothing beyond.
    const f = grid(3, 3)
    const rects = rectsOf(f)
    const first = f.list[0] as MosaicTile
    const column = f.list.filter((t) => t.left === first.left).map((t) => t.id)
    const edge = edgesFor(f, column).find((e) => e.axis === 'x') as MosaicEdge
    void rects
    for (const id of column) expect(edge.moves).toContain(id)
    expect(collateral(edge, column)).toBe(column.length)
  })
})

describe('resizing a run of tiles as one block', () => {
  /*
   * Reported from the app with a picture: A, B and S selected across a row, the
   * block's right edge dragged outward, and only S grew. A selection has an
   * outside and an inside — dragging its outer edge has to scale the whole run
   * in proportion, not just the tile that happens to touch the line.
   */
  const row = (f: Fixture): [string, Rect][] => {
    const rects = rectsOf(f)
    const top = Math.min(...[...rects.values()].map((r) => r.y))
    return [...rects.entries()]
      .filter(([, r]) => Math.abs(r.y - top) < 1e-6)
      .sort((a, b) => a[1].x - b[1].x)
  }

  it('grows all three when their right-hand edge is dragged out', () => {
    const f = grid(5, 3)
    const tiles = row(f)
    const three = tiles.slice(0, 3)
    const selection = three.map(([id]) => id)

    const edge = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (three[2]![1].x + three[2]![1].width)) < 1e-6,
    ) as MosaicEdge
    expect(edge, 'the run has an outer edge').toBeTruthy()
    expect(edge.block, 'and it knows the block it bounds').toBeTruthy()
    expect(edge.block!.interior, 'with the two lines inside it').toHaveLength(2)

    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, 60, edge.block)!
    expect(moved.clamped).toBe(false)
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    const after = rectsOf({ ...f, x })

    let gained = 0
    for (const [id, before] of three) {
      const now = after.get(id) as Rect
      expect(now.width, `${id} grew`).toBeGreaterThan(before.width + 1)
      gained += now.width - before.width
    }
    expect(gained, 'together they took exactly what the edge moved').toBeCloseTo(60, 6)

    // Equal tiles gain equally, and the block's far edge did not move.
    const gains = three.map(([id, before]) => (after.get(id) as Rect).width - before.width)
    expect(gains[0]).toBeCloseTo(gains[2] as number, 6)
    expect((after.get(three[0]![0]) as Rect).x).toBeCloseTo(three[0]![1].x, 6)
    // And the tile outside gave it up.
    expect((after.get(tiles[3]![0]) as Rect).width).toBeCloseTo(tiles[3]![1].width - 60, 6)
  })

  it('shrinks them all when the same edge is pushed back', () => {
    const f = grid(5, 3)
    const tiles = row(f)
    const three = tiles.slice(0, 3)
    const selection = three.map(([id]) => id)
    const edge = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (three[2]![1].x + three[2]![1].width)) < 1e-6,
    ) as MosaicEdge

    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, -45, edge.block)!
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    const after = rectsOf({ ...f, x })

    for (const [id, before] of three) {
      expect((after.get(id) as Rect).width, `${id} shrank`).toBeLessThan(before.width - 1)
    }
    expect((after.get(tiles[3]![0]) as Rect).width).toBeCloseTo(tiles[3]![1].width + 45, 6)
  })

  it('stops when the tightest tile inside the block reaches its minimum', () => {
    const f = grid(5, 3)
    const tiles = row(f)
    const three = tiles.slice(0, 3)
    const selection = three.map(([id]) => id)
    const edge = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (three[2]![1].x + three[2]![1].width)) < 1e-6,
    ) as MosaicEdge

    const range = edgeRange(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, edge.block)
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, range.min - 400, edge.block)!
    expect(moved.clamped).toBe(true)

    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    for (const rect of rectsOf({ ...f, x }).values()) {
      expect(rect.width).toBeGreaterThanOrEqual(MINIMUM_VISIBLE - 1e-6)
    }
  })

  it('leaves a single tile alone — one line is the whole of its resize', () => {
    const f = grid(4, 3)
    const one = row(f)[1]!
    for (const edge of edgesFor(f, [one[0]])) {
      expect(edge.block, 'nothing inside a single tile').toBeNull()
    }
  })

  /*
   * Reported from the app: a block could be dragged from its bottom and right,
   * but its top and left did nothing at all.
   *
   * Which way a block GROWS depends on which of its sides is held. The right
   * edge grows forward; the left edge grows backward — dragging it further left
   * makes the block wider. Both were folded into one signed expression, which
   * got the low side exactly backwards. Because a range is clamped to
   * [min ≤ 0, max ≥ 0], the two wrong answers cancelled to a range of zero, so
   * the edge was live, took the pointer, and refused every offset in silence.
   */
  it('grows the block from its low side as well as its high one', () => {
    const f = grid(5, 3)
    const tiles = row(f)
    const three = tiles.slice(1, 4)
    const selection = three.map(([id]) => id)

    const left = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - three[0]![1].x) < 1e-6,
    ) as MosaicEdge
    expect(left.block, 'the run bounds a block on its left too').toBeTruthy()

    const range = edgeRange(f.list, f.x, f.y, BOX, NONE, 'x', left.id, left.block)
    expect(range.min, 'there is room to grow leftward').toBeLessThan(-1)
    expect(range.max, 'and room to shrink back').toBeGreaterThan(1)

    // Growing means moving the left edge OUT, which is a negative offset.
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', left.id, -60, left.block)!
    expect(moved.clamped).toBe(false)
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    const after = rectsOf({ ...f, x })

    let gained = 0
    for (const [id, before] of three) {
      const now = after.get(id) as Rect
      expect(now.width, `${id} grew`).toBeGreaterThan(before.width + 1)
      gained += now.width - before.width
    }
    expect(gained, 'together they took exactly what the edge moved').toBeCloseTo(60, 6)
    // The block's far edge stayed put, and the tile to its left gave up the space.
    const last = three[2]!
    expect((after.get(last[0]) as Rect).x + (after.get(last[0]) as Rect).width).toBeCloseTo(
      last[1].x + last[1].width,
      6,
    )
    expect((after.get(tiles[0]![0]) as Rect).width).toBeCloseTo(tiles[0]![1].width - 60, 6)
  })

  it('treats a line INSIDE the selection as dividing it, not resizing it', () => {
    // Dragging the line between two selected tiles moves that line alone: it
    // shares space between them rather than growing the pair.
    const f = grid(4, 3)
    const tiles = row(f)
    const pair = [tiles[0]![0], tiles[1]![0]]
    const inner = edgesFor(f, pair).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (tiles[0]![1].x + tiles[0]![1].width)) < 1e-6,
    ) as MosaicEdge
    expect(inner.block).toBeNull()
  })
})

describe('a block whose interior line is shared with tiles outside it', () => {
  /*
   * Reported from the app with a picture: a 2×2 block selected, its edge
   * dragged, and the row below moved with it.
   *
   * The cause was counting rather than measuring. `collateral` cannot tell an
   * outer edge shared with the two tiles that legitimately give up the space
   * from an interior line shared with two tiles somewhere else entirely — both
   * come to two. So a line inside the block went undetached and carried the row
   * below along with it.
   */
  const setup = () => {
    // Three columns, three rows; then the middle-left tile split so the block is
    // 2 wide and 2 tall, with its interior line still shared down the mosaic.
    const f = grid(3, 3)
    const rects = rectsOf(f)
    const middleLeft = [...rects.entries()].find(
      ([, r]) => Math.abs(r.x - BOX.x) < 1e-6 && r.y > BOX.y + 1 && r.y < BOX.y + BOX.height - 1,
    ) as [string, Rect]
    const middleNext = [...rects.entries()].find(
      ([, r]) =>
        Math.abs(r.y - middleLeft[1].y) < 1e-6 && Math.abs(r.x - (BOX.x + BOX.width / 3)) < 1e-6,
    ) as [string, Rect]

    let list = f.list
    let y = { ...f.y }
    for (const [id] of [middleLeft, middleNext]) {
      const result = splitTile(list, f.x, y, id, 'y')!
      list = result.tiles
      y = { ...y, [result.created.coordinate]: result.value }
    }
    const m: Fixture = { list, x: { ...f.x }, y }

    // The four tiles of the block: the two originals and the two halves made.
    const after = rectsOf(m)
    const block = [...after.entries()]
      .filter(([, r]) => r.x < BOX.x + (2 * BOX.width) / 3 - 1 && r.y > BOX.y + 1 && r.y < BOX.y + (2 * BOX.height) / 3 - 1)
      .map(([id]) => id)
    return { m, block, after }
  }

  it('leaves every tile outside the block exactly where it was', () => {
    const { m, block, after } = setup()
    expect(block.length).toBe(4)

    const edges = edgesFor(m, block)
    const outer = edges
      .filter((e) => e.axis === 'x')
      .sort((a, b) => b.position - a.position)[0] as MosaicEdge
    expect(outer.block, 'the block has an inside').toBeTruthy()

    /*
     * The span the drag would detach over: the block's own extent. Every line it
     * moves has to stop there, or tiles nobody selected come along.
     */
    const span = {
      from: Math.min(...block.map((id) => (after.get(id) as Rect).y - BOX.y)) / BOX.height,
      to: Math.max(...block.map((id) => {
        const r = after.get(id) as Rect
        return r.y + r.height - BOX.y
      })) / BOX.height,
    }

    // Every line the drag touches reaches past the block, so every one of them
    // has to be detached — including the interior one, which counting missed.
    const lines = [outer.id, ...(outer.block?.interior ?? [])]
    let list = m.list
    let x = { ...m.x }
    for (const line of lines) {
      const current: Fixture = { list, x, y: m.y }
      const edge = edgesFor(current, block).find((e) => e.axis === 'x' && e.id === line)
      if (!edge) continue
      if (!reachesBeyond(edge, list, x, m.y, span)) continue
      const forked = forkCoordinate(list, x, 'x', line, span, m.y)!
      list = forked.tiles
      x = { ...x, [forked.created]: forked.value }
    }

    const detached: Fixture = { list, x, y: m.y }
    const fresh = edgesFor(detached, block)
      .filter((e) => e.axis === 'x')
      .sort((a, b) => b.position - a.position)[0] as MosaicEdge

    const moved = moveEdge(list, x, m.y, BOX, NONE, 'x', fresh.id, 40, fresh.block)!
    for (const update of moved.updates) x[update.id] = update.value

    const result = rectsOf({ list, x, y: m.y })
    const chosen = new Set(block)
    for (const [id, before] of after) {
      if (chosen.has(id)) continue
      const now = result.get(id) as Rect
      // Tiles beside the block give up the space, so their width may change —
      // but nothing outside the block's own rows may MOVE.
      const sameRows = Math.abs(before.y - now.y) < 1e-6 && Math.abs(before.height - now.height) < 1e-6
      expect(sameRows, `${id} kept its rows`).toBe(true)
      const inBlockRows =
        before.y >= (span.from * BOX.height + BOX.y) - 1e-6 &&
        before.y + before.height <= (span.to * BOX.height + BOX.y) + 1e-6
      if (!inBlockRows) {
        expect(now.x, `${id} did not slide`).toBeCloseTo(before.x, 6)
        expect(now.width, `${id} did not resize`).toBeCloseTo(before.width, 6)
      }
    }
  })

  it('tells an interior line apart from an outer one, which counting could not', () => {
    const { m, block, after } = setup()
    const span = {
      from: Math.min(...block.map((id) => (after.get(id) as Rect).y - BOX.y)) / BOX.height,
      to: Math.max(...block.map((id) => {
        const r = after.get(id) as Rect
        return r.y + r.height - BOX.y
      })) / BOX.height,
    }
    const edges = edgesFor(m, block).filter((e) => e.axis === 'x')
    const outer = [...edges].sort((a, b) => b.position - a.position)[0] as MosaicEdge
    const interior = edges.find((e) => e.id === outer.block?.interior[0]) as MosaicEdge
    expect(interior, 'there is a line inside the block').toBeTruthy()

    /*
     * The line INSIDE the block reaches past it — it runs the whole height of
     * the mosaic — so a drag must detach it before scaling it. That is the case
     * a fixed threshold on `collateral` could not express: the number it yields
     * for an interior line and for a legitimate outer edge overlap, so no cutoff
     * separates them. Where the tiles are does.
     */
    expect(reachesBeyond(interior, m.list, m.x, m.y, span)).toBe(true)

    // And once detached, it stops at the block and needs no further detaching.
    const forked = forkCoordinate(m.list, m.x, 'x', interior.id, span, m.y)!
    const after2: Fixture = { list: forked.tiles, x: { ...m.x, [forked.created]: forked.value }, y: m.y }
    const now = edgesFor(after2, block).find(
      (e) => e.axis === 'x' && Math.abs(e.position - interior.position) < 1e-6,
    ) as MosaicEdge
    expect(reachesBeyond(now, after2.list, after2.x, after2.y, span), 'detached').toBe(false)
  })

  /*
   * The other half of the same report: with the block's own lines detached, the
   * only tiles left that may change are the ones it presses against, and all
   * they may do is give up the space. A neighbour whose top is pushed down has
   * moved — that is what shrinking from one side looks like — but a tile the
   * block does not touch may not move at all.
   */
  it('takes space only from the tiles the block presses against', () => {
    const { m, block, after } = setup()
    const span = {
      from: Math.min(...block.map((id) => (after.get(id) as Rect).x - BOX.x)) / BOX.width,
      to:
        Math.max(
          ...block.map((id) => {
            const r = after.get(id) as Rect
            return r.x + r.width - BOX.x
          }),
        ) / BOX.width,
    }

    // The block's BOTTOM edge — a high edge on y, dragged outward.
    const grabbed = edgesFor(m, block)
      .filter((e) => e.axis === 'y' && e.block)
      .sort((a, b) => b.position - a.position)[0] as MosaicEdge
    expect(grabbed, 'the block has a bottom edge').toBeTruthy()

    let list = m.list
    let y = { ...m.y }
    for (const line of [grabbed.id, ...(grabbed.block?.interior ?? [])]) {
      const current: Fixture = { list, x: m.x, y }
      const edge = edgesFor(current, block).find((e) => e.axis === 'y' && e.id === line)
      if (!edge) continue
      if (!reachesBeyond(edge, list, m.x, y, span)) continue
      const forked = forkCoordinate(list, y, 'y', line, span, m.x)!
      list = forked.tiles
      y = { ...y, [forked.created]: forked.value }
    }

    const before = rectsOf({ list, x: m.x, y })
    const fresh = edgesFor({ list, x: m.x, y }, block)
      .filter((e) => e.axis === 'y' && e.block)
      .sort((a, b) => b.position - a.position)[0] as MosaicEdge
    const range = edgeRange(list, m.x, y, BOX, NONE, 'y', fresh.id, fresh.block)
    expect(range.max, 'the block can grow downward').toBeGreaterThan(1)

    const moved = moveEdge(list, m.x, y, BOX, NONE, 'y', fresh.id, 40, fresh.block)!
    for (const update of moved.updates) y[update.id] = update.value
    const result = rectsOf({ list, x: m.x, y })

    const chosen = new Set(block)
    const bottom = Math.max(
      ...block.map((id) => {
        const r = before.get(id) as Rect
        return r.y + r.height
      }),
    )
    const left = Math.min(...block.map((id) => (before.get(id) as Rect).x))
    const right = Math.max(
      ...block.map((id) => {
        const r = before.get(id) as Rect
        return r.x + r.width
      }),
    )

    for (const [id, was] of before) {
      if (chosen.has(id)) continue
      const now = result.get(id) as Rect
      const beneath =
        was.y >= bottom - 1e-6 && was.x >= left - 1e-6 && was.x + was.width <= right + 1e-6
      if (beneath) {
        expect(now.height, `${id} gave up space`).toBeCloseTo(was.height - 40, 6)
        expect(now.y, `${id} was pushed down by exactly that`).toBeCloseTo(was.y + 40, 6)
      } else {
        expect(now.x, `${id} did not move`).toBeCloseTo(was.x, 6)
        expect(now.y, `${id} did not move`).toBeCloseTo(was.y, 6)
        expect(now.width, `${id} did not resize`).toBeCloseTo(was.width, 6)
        expect(now.height, `${id} did not resize`).toBeCloseTo(was.height, 6)
      }
    }
  })
})

describe('dragging onto a grid', () => {
  const STEP = 40
  /** The mosaic's top row, left to right. */
  const row = (f: Fixture): [string, Rect][] => {
    const rects = rectsOf(f)
    const top = Math.min(...[...rects.values()].map((r) => r.y))
    return [...rects.entries()]
      .filter(([, r]) => Math.abs(r.y - top) < 1e-6)
      .sort((a, b) => a[1].x - b[1].x)
  }
  /** Where a line sits, in units from the content box's origin. */
  const positionOf = (f: Fixture, id: string, axis: 'x' | 'y' = 'x'): number =>
    ((axis === 'x' ? f.x : f.y)[id] as number) * (axis === 'x' ? BOX.width : BOX.height)
  const onGrid = (units: number): boolean => Math.abs(units / STEP - Math.round(units / STEP)) < 1e-9

  const dragged = (f: Fixture, id: string, offset: number, step: number | undefined) => {
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', id, offset, null, step)
    if (!moved) throw new Error('the fixture expects this line to be movable')
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    return { fixture: { ...f, x } as Fixture, moved }
  }

  it('comes to rest on a step rather than under the pointer', () => {
    const f = grid(4, 4)
    const line = (row(f)[1] as [string, Rect])[0]
    const id = (f.list.find((t) => t.id === line) as MosaicTile).left

    const free = dragged(f, id, 23, undefined)
    expect(onGrid(positionOf(free.fixture, id)), 'without a grid it lands anywhere').toBe(false)

    const snapped = dragged(f, id, 23, STEP)
    expect(onGrid(positionOf(snapped.fixture, id)), 'with one it lands on a step').toBe(true)
  })

  /*
   * Snapping is applied to where the pointer ASKED to go and then kept inside
   * the range. Clamping first and snapping after would round a value already at
   * its limit straight past it, which is how a grid quietly breaks a layout.
   */
  it('never rounds past the limit, however hard the drag pushes', () => {
    const f = grid(4, 4)
    const line = (row(f)[1] as [string, Rect])[0]
    const id = (f.list.find((t) => t.id === line) as MosaicTile).left
    const range = edgeRange(f.list, f.x, f.y, BOX, NONE, 'x', id, null)
    const before = positionOf(f, id)

    for (const offset of [10_000, -10_000]) {
      const { fixture } = dragged(f, id, offset, STEP)
      const after = positionOf(fixture, id)
      expect(onGrid(after), `${offset} landed on a step`).toBe(true)
      expect(after - before).toBeLessThanOrEqual(range.max + 1e-9)
      expect(after - before).toBeGreaterThanOrEqual(range.min - 1e-9)
      // And the layout it produced is one the tool would still let you reshape.
      expect(canReshape(fixture.list, fixture.x, fixture.y, BOX, NONE)).toBe(true)
    }
  })

  it('drags freely again when the step is zero', () => {
    const f = grid(4, 4)
    const line = (row(f)[1] as [string, Rect])[0]
    const id = (f.list.find((t) => t.id === line) as MosaicTile).left
    const { fixture } = dragged(f, id, 23, 0)
    expect(positionOf(fixture, id) - positionOf(f, id)).toBeCloseTo(23, 9)
  })

  it('puts a block’s inside lines on the grid too, not just the edge it holds', () => {
    const f = grid(5, 3)
    const three = row(f).slice(0, 3)
    const selection = three.map(([id]) => id)
    const edge = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (three[2]![1].x + three[2]![1].width)) < 1e-6,
    ) as MosaicEdge
    expect(edge.block?.interior, 'two lines run through the block').toHaveLength(2)

    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, 37, edge.block, STEP)!
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value

    for (const update of moved.updates) {
      const units = update.value * BOX.width
      expect(onGrid(units), `${update.id} landed on a step`).toBe(true)
    }
    // Whatever the grid did to it, the result is still a legal mosaic.
    expect(canReshape(f.list, x, f.y, BOX, NONE)).toBe(true)
  })

  /*
   * Snapping several lines at once can squeeze the tile between two of them. A
   * legal layout matters more than a tidy one, so the proportional values stand
   * whenever the snapped set would not survive.
   */
  it('keeps the proportional lines when the grid would collapse a tile', () => {
    const f = grid(5, 3)
    const three = row(f).slice(0, 3)
    const selection = three.map(([id]) => id)
    const edge = edgesFor(f, selection).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (three[2]![1].x + three[2]![1].width)) < 1e-6,
    ) as MosaicEdge

    // A step so coarse that rounding the inside lines would stack them.
    const coarse = BOX.width / 2
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', edge.id, 10, edge.block, coarse)!
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    expect(canReshape(f.list, x, f.y, BOX, NONE), 'it refused to break the mosaic').toBe(true)
  })
})

describe('a forked line finding its way home', () => {
  /*
   * The whole reason the grid exists, end to end.
   *
   * Dragging one tile's edge forks the line it sits on, so the rest of the
   * column stays put. That happens silently on almost every drag and used to be
   * permanent: two lines a fraction of a unit apart look level, and can never
   * move together again. On a grid, a line dragged back to where it came from
   * holds the SAME number as the line it left — and two coordinates with one
   * value are one line, so they can be joined and move as one from then on.
   */
  const STEP = 50

  const setup = () => {
    const f = grid(4, 4)
    const rects = rectsOf(f)
    // The line down the middle, and the tiles in the top half that name it.
    const shared = (f.list.find((t) => {
      const r = rects.get(t.id) as Rect
      return Math.abs(r.x - BOX.x) < 1e-6 && Math.abs(r.y - BOX.y) < 1e-6
    }) as MosaicTile).right

    const forked = forkCoordinate(f.list, f.x, 'x', shared, { from: 0, to: 0.5 }, f.y)
    if (!forked) throw new Error('the fixture expects this fork to be possible')
    return {
      f,
      shared,
      fork: forked.created,
      after: { list: forked.tiles, x: { ...f.x, [forked.created]: forked.value }, y: f.y } as Fixture,
    }
  }

  const move = (f: Fixture, id: string, offset: number): Fixture => {
    const moved = moveEdge(f.list, f.x, f.y, BOX, NONE, 'x', id, offset, null, STEP)
    if (!moved) throw new Error('expected the line to move')
    const x = { ...f.x }
    for (const update of moved.updates) x[update.id] = update.value
    return { ...f, x }
  }

  it('parts, comes back to the same number, and becomes one line again', () => {
    const { shared, fork, after } = setup()
    expect(after.x[fork]).toBeCloseTo(after.x[shared] as number, 12)

    // Forked but not yet moved, the two are already mergeable — which is what
    // makes a drag that goes nowhere leave no trace behind it.
    expect(mergeCoordinates(after.list, [after.x], 'x', new Set([fork]))).toBeTruthy()

    // Drag the fork away, by an amount that does not divide the grid — and back
    // by a different one. Nothing about 47 out and 53 back cancels; only landing
    // on steps does.
    const apart = move(after, fork, 47)
    expect(apart.x[fork]).not.toBeCloseTo(apart.x[shared] as number, 6)
    expect(mergeCoordinates(apart.list, [apart.x], 'x', new Set([fork]))).toBeNull()

    // ...and back. On the grid, "back" is the very same number, not merely near.
    const home = move(apart, fork, -53)
    expect(home.x[fork], 'the same number, not merely near it').toBe(home.x[shared])

    const merged = mergeCoordinates(home.list, [home.x], 'x', new Set([fork]))
    expect(merged, 'they are one line again').toBeTruthy()
    expect(merged?.retired, 'and it is the fork that goes').toEqual([fork])
  })

  it('leaves every rectangle untouched when it rejoins', () => {
    const { fork, after } = setup()
    const home = move(move(after, fork, 47), fork, -53)
    const before = layoutMosaic(home.list, home.x, home.y, BOX, NONE)

    const merged = mergeCoordinates(home.list, [home.x], 'x', new Set([fork])) as {
      tiles: MosaicTile[]
      retired: string[]
    }
    const kept = { ...home.x }
    for (const id of merged.retired) delete kept[id]
    const now = layoutMosaic(merged.tiles, kept, home.y, BOX, NONE)

    for (const [id, was] of before) {
      const rect = now.get(id)?.structural as Rect
      expect(rect.x).toBeCloseTo(was.structural.x, 12)
      expect(rect.width).toBeCloseTo(was.structural.width, 12)
    }
  })

  it('moves the whole column together once more, which is the point of it', () => {
    const { shared, fork, after } = setup()
    const home = move(move(after, fork, 47), fork, -53)

    // While forked, the line moves only the tiles in the half that forked it.
    const stillForked = move(home, fork, 50)
    const partial = layoutMosaic(stillForked.list, stillForked.x, stillForked.y, BOX, NONE)
    const base = layoutMosaic(home.list, home.x, home.y, BOX, NONE)
    const movedWhileForked = home.list.filter((t) => {
      const a = base.get(t.id)?.structural as Rect
      const b = partial.get(t.id)?.structural as Rect
      return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.width - b.width) > 1e-6
    }).length

    // Rejoined, the same drag reaches the tiles on both sides of the mosaic.
    const merged = mergeCoordinates(home.list, [home.x], 'x', new Set([fork])) as {
      tiles: MosaicTile[]
      retired: string[]
    }
    const kept = { ...home.x }
    for (const id of merged.retired) delete kept[id]
    const rejoined: Fixture = { list: merged.tiles, x: kept, y: home.y }
    const whole = move(rejoined, shared, 50)
    const after2 = layoutMosaic(whole.list, whole.x, whole.y, BOX, NONE)
    const baseline = layoutMosaic(rejoined.list, rejoined.x, rejoined.y, BOX, NONE)
    const movedRejoined = rejoined.list.filter((t) => {
      const a = baseline.get(t.id)?.structural as Rect
      const b = after2.get(t.id)?.structural as Rect
      return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.width - b.width) > 1e-6
    }).length

    expect(movedWhileForked, 'forked, it moves the two rows that forked it').toBe(4)
    expect(movedRejoined, 'rejoined, it moves all four rows').toBe(8)
  })
})

describe('a press that lands in two places at once', () => {
  /*
   * Reported from the app: tiles next to the selected one were hard to click.
   *
   * A handle reaches seven screen pixels either side of its line, and the outer
   * half of that lies inside the NEIGHBOURING tile. So a press meant to select
   * the tile next door is, geometrically, also a press on the selected tile's
   * edge — and the press used to resolve that immediately, in favour of the
   * edge, leaving the tile unselectable from that strip.
   *
   * The reach cannot simply be narrowed: it is how an edge gets grabbed at all.
   * What this test pins down is that the two readings genuinely overlap, which
   * is why the press has to wait for movement before choosing between them.
   */
  it('is on the edge and on the next tile both', () => {
    const f = grid(4, 4)
    const rects = rectsOf(f)
    const chosen = [...rects.entries()].find(
      ([, r]) => Math.abs(r.x - BOX.x) < 1e-6 && Math.abs(r.y - BOX.y) < 1e-6,
    ) as [string, Rect]

    const edge = edgesFor(f, [chosen[0]]).find(
      (e) => e.axis === 'x' && Math.abs(e.position - (chosen[1].x + chosen[1].width)) < 1e-6,
    ) as MosaicEdge
    expect(edge, 'the selected tile has a right edge').toBeTruthy()

    // A point just PAST that edge — inside the tile next door, and well within
    // the handle's reach.
    const beyond = { x: edge.position + TOL.x / 2, y: (edge.from + edge.to) / 2 }

    const hit = edgeAt(edgesFor(f, [chosen[0]]), beyond, TOL)
    expect(hit, 'the handle answers here').toBeTruthy()
    expect(hit?.id).toBe(edge.id)

    const under = tileAt(
      {
        tiles: f.list,
        localBounds: BOX,
        states: [{ x: f.x, y: f.y }],
        gap: NONE.gap,
        outerPadding: NONE.outerPadding,
        glyphInset: NONE.glyphInset,
      } as never,
      beyond,
    )
    expect(under, 'and so does a tile').toBeTruthy()
    expect(under, 'a DIFFERENT tile from the selected one').not.toBe(chosen[0])
  })
})

/**
 * Resizing a selection with a hole in it.
 *
 * Reported from the app: picking the two end glyphs of a row and dragging their
 * shared line resized the unselected glyph between them as well. Detachment was
 * described by ONE bounding range, so the hole fell inside it, the middle tile
 * was repointed at the new line along with the rest, and it followed the drag.
 */
describe('a selection with a gap in it', () => {
  /** The tile at a grid position, found by its rectangle. */
  const tileAtGrid = (f: Fixture, col: number, row: number): string => {
    const all = [...rectsOf(f).entries()]
    const xs = [...new Set(all.map(([, r]) => Math.round(r.x)))].sort((a, b) => a - b)
    const ys = [...new Set(all.map(([, r]) => Math.round(r.y)))].sort((a, b) => a - b)
    const found = all.find(
      ([, r]) => Math.round(r.x) === xs[col] && Math.round(r.y) === ys[row],
    )
    if (!found) throw new Error(`no tile at ${col},${row}`)
    return found[0]
  }
  const heightOf = (f: Fixture, id: string): number => (rectsOf(f).get(id) as Rect).height

  it('comes back as separate runs, not one range spanning the hole', () => {
    const f = grid(3, 3)
    const runs = selectionRuns(f.list, f.x, f.y, 'y', [
      tileAtGrid(f, 0, 0),
      tileAtGrid(f, 2, 0),
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0]?.to).toBeLessThan(runs[1]?.from as number)
  })

  it('merges a contiguous selection back into one run', () => {
    const f = grid(3, 3)
    const runs = selectionRuns(f.list, f.x, f.y, 'y', [
      tileAtGrid(f, 0, 0),
      tileAtGrid(f, 1, 0),
      tileAtGrid(f, 2, 0),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0]?.from).toBeCloseTo(0, 9)
    expect(runs[0]?.to).toBeCloseTo(1, 9)
  })

  it('says the shared line reaches past a gapped selection', () => {
    const f = grid(3, 3)
    const selection = [tileAtGrid(f, 0, 0), tileAtGrid(f, 2, 0)]
    const edge = edgesFor(f, selection).find((e) => e.axis === 'y') as MosaicEdge
    const runs = selectionRuns(f.list, f.x, f.y, 'y', selection)

    // The middle tile names this line and sits in none of the runs, so the line
    // has to be detached before the drag may move it.
    expect(reachesBeyond(edge, f.list, f.x, f.y, runs)).toBe(true)
  })

  it('resizes the two selected tiles and leaves the one between them alone', () => {
    const f = grid(3, 3)
    const left = tileAtGrid(f, 0, 0)
    const right = tileAtGrid(f, 2, 0)
    const middle = tileAtGrid(f, 1, 0)
    const selection = [left, right]
    const before = { left: heightOf(f, left), middle: heightOf(f, middle) }

    const edge = edgesFor(f, selection).find((e) => e.axis === 'y') as MosaicEdge
    const runs = selectionRuns(f.list, f.x, f.y, 'y', selection)
    expect(reachesBeyond(edge, f.list, f.x, f.y, runs)).toBe(true)

    const forked = forkCoordinate(f.list, f.y, 'y', edge.id, runs, f.x)
    expect(forked).toBeTruthy()
    const list = forked!.tiles
    let y: Record<string, number> = { ...f.y, [forked!.created]: forked!.value }

    // The detached line sits where the old one did, so the same press finds it.
    const fresh = selectionEdges(list, f.x, y, BOX, NONE, selection).find(
      (e) => e.axis === 'y' && Math.abs(e.position - edge.position) < 1e-6,
    ) as MosaicEdge
    expect(fresh).toBeTruthy()

    const moved = moveEdge(list, f.x, y, BOX, NONE, 'y', fresh.id, 60, fresh.block, 0)
    expect(moved).toBeTruthy()
    for (const update of moved!.updates) y = { ...y, [update.id]: update.value }

    const after = { list, x: f.x, y }
    expect(heightOf(after, left), 'the selected tile resized').not.toBeCloseTo(before.left, 3)
    expect(heightOf(after, middle), 'the tile in the gap did not').toBeCloseTo(before.middle, 3)
  })

  it('still moves BOTH selected tiles, on one line', () => {
    // The runs must share a single new coordinate: two forks would leave two
    // coincident lines and a drag would take hold of only one of them.
    const f = grid(3, 3)
    const selection = [tileAtGrid(f, 0, 0), tileAtGrid(f, 2, 0)]
    const edge = edgesFor(f, selection).find((e) => e.axis === 'y') as MosaicEdge
    const runs = selectionRuns(f.list, f.x, f.y, 'y', selection)

    const forked = forkCoordinate(f.list, f.y, 'y', edge.id, runs, f.x) as NonNullable<
      ReturnType<typeof forkCoordinate>
    >
    const named = forked.tiles.filter((t) => t.top === forked.created || t.bottom === forked.created)

    // Both selected tiles, plus the one directly below each — the space has to
    // come from somewhere. Never the middle column.
    expect(named.map((t) => t.id)).toContain(selection[0])
    expect(named.map((t) => t.id)).toContain(selection[1])
    expect(named.map((t) => t.id)).not.toContain(tileAtGrid(f, 1, 0))
    expect(named.map((t) => t.id)).not.toContain(tileAtGrid(f, 1, 1))
  })
})
