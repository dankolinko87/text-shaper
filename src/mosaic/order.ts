import type { Rect, Vec2 } from '../types/document'
import type { MosaicTileLayout } from '../types/mosaic'

/**
 * What the order needs of a tile: where it is and how big. A mosaic's layout
 * answers with its structural rectangle; a mesh's carries a polygon's bounds
 * and centroid. One order for both, because a caret should walk a mesh the
 * way it walks a mosaic.
 */
export interface Placed {
  bounds: Rect
  centre: Vec2
}

type Layout = MosaicTileLayout | Placed

const placed = (tile: Layout): Placed =>
  'bounds' in tile
    ? tile
    : {
        bounds: tile.structural,
        centre: { x: centreX(tile.structural), y: centreY(tile.structural) },
      }

/**
 * The order a mosaic reads in.
 *
 * Worked out from where the tiles ARE, not from where they sit in the partition
 * tree. Tree order follows the branches — a mosaic seeded with a peeled first
 * column reads down that column and then band by band, which is not what anyone
 * looking at a grid of letters expects. And the tree cannot answer it in
 * general: two tiles in the same visual row may live in different branches at
 * different depths.
 *
 * Order is used for the caret and for laying characters in. It has NOTHING to do
 * with which leaf holds which character — pulling a boundary about changes the
 * order tiles are visited in and moves no letter anywhere.
 */

export type ReadingDirection = 'ltr' | 'rtl'

/**
 * How far apart two tiles' centres can sit vertically and still be one row, as a
 * share of the shorter one's height.
 *
 * A share rather than a fixed distance, because a mosaic can be any size and a
 * row of tall tiles is not less of a row than a row of short ones. Two thirds is
 * generous: tiles in the same band line up exactly, and the tolerance is there
 * for the ones that have been pulled out of line, which still read as a row
 * until they have moved most of their own height.
 */
const ROW_TOLERANCE = 0.66

export function readingOrder(
  tiles: ReadonlyMap<string, Layout>,
  direction: ReadingDirection = 'ltr',
): string[] {
  const entries = [...tiles.entries()].map(([id, tile]) => ({ id, ...placed(tile) }))
  if (entries.length === 0) return []

  // Top to bottom first, so a row is built from tiles that have already been
  // seen to start at about the same height.
  entries.sort((a, b) => a.centre.y - b.centre.y || a.bounds.x - b.bounds.x)

  const rows: { id: string; bounds: Rect; centre: Vec2 }[][] = []
  for (const entry of entries) {
    const row = rows[rows.length - 1]
    const last = row?.[0]
    const together =
      last !== undefined &&
      Math.abs(entry.centre.y - last.centre.y) <
        Math.min(entry.bounds.height, last.bounds.height) * ROW_TOLERANCE

    if (together && row) row.push(entry)
    else rows.push([entry])
  }

  const across = direction === 'rtl' ? -1 : 1
  return rows.flatMap((row) =>
    [...row].sort((a, b) => (a.bounds.x - b.bounds.x) * across).map((entry) => entry.id),
  )
}

/** The leaf `steps` along from this one, stopping at either end rather than wrapping. */
export function stepThrough(order: readonly string[], from: string, steps: number): string | null {
  const at = order.indexOf(from)
  if (at === -1) return order[0] ?? null
  /*
   * Clamped, not wrapped. Tab off the last tile of a mosaic and wrapping would
   * take you back to the first, which reads as the caret having jumped rather
   * than as having run out — and typing on from there would overwrite what was
   * typed at the start.
   */
  const next = Math.min(order.length - 1, Math.max(0, at + steps))
  return order[next] ?? null
}

/**
 * The tile an arrow key should move to.
 *
 * Not the reading order: pressing Down on the last tile of a row must go to the
 * tile BELOW it, not to the first tile of the next row, and in an irregular
 * mosaic those are rarely the same. So it is answered geometrically — of the
 * tiles that lie in the direction asked for, the nearest one, measured with the
 * perpendicular offset weighted so that "roughly in line" beats "slightly
 * closer but well off to one side".
 */
export function tileInDirection(
  tiles: ReadonlyMap<string, Layout>,
  from: string,
  direction: 'up' | 'down' | 'left' | 'right',
): string | null {
  const found = tiles.get(from)
  if (!found) return null
  const start = placed(found)

  const origin = start.centre
  const along = direction === 'left' || direction === 'right' ? 'x' : 'y'
  const sign = direction === 'right' || direction === 'down' ? 1 : -1
  /** Off to the side counts for more than distance ahead, so a row is preferred. */
  const SIDEWAYS = 2

  let best: string | null = null
  let bestScore = Infinity

  for (const [id, each] of tiles) {
    if (id === from) continue
    const centre = placed(each).centre
    const ahead = (centre[along] - origin[along]) * sign
    // Half a tile, so a neighbour that only just clears the boundary counts.
    if (ahead <= Math.min(start.bounds.height, start.bounds.width) * 0.1) continue

    const aside = Math.abs(along === 'x' ? centre.y - origin.y : centre.x - origin.x)
    const score = ahead + aside * SIDEWAYS
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }

  return best
}

const centreX = (rect: Rect): number => rect.x + rect.width / 2
const centreY = (rect: Rect): number => rect.y + rect.height / 2
