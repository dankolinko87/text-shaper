import { valueOf } from './dissection'
import { createId } from '../utils/id'
import type { Coordinate, MosaicTile } from '../types/mosaic'

/**
 * Changing the SHAPE of the mosaic rather than the position of its lines.
 *
 * Two primitives: cut a tile in two, and take an empty tile away. Moving a line
 * is not here — that is `boundaries.ts`, and it is a different kind of thing:
 * it changes numbers, while these change which tiles exist.
 *
 * Both return the new tiles ALONGSIDE whatever coordinate the change introduced
 * or retired, rather than editing one state's numbers themselves. There is one
 * state today and there will be several; a change to the tiles has to reach all
 * of them or the states stop describing the same mosaic.
 */

const tileId = (): string => createId('mt')
const coordId = (): string => createId('mc')

export interface SplitResult {
  tiles: MosaicTile[]
  /** The tile that was added, and the line that now divides the pair. */
  created: { tile: string; coordinate: string }
  axis: 'x' | 'y'
  /** Where the new line goes: halfway across what the tile used to be. */
  value: Coordinate
}

/**
 * Cut one tile in two.
 *
 * The original stays — same id, same character — and keeps the first half.
 * Keeping the id is what makes this non-destructive in every way that matters:
 * the caret stays put, any colour keyed to that tile follows it, and no other
 * state has to be told about it.
 *
 * The new line belongs to these two tiles alone, so dragging it afterwards moves
 * nothing else. That is the difference from the old partition, where a new split
 * inherited the reach of whatever it was nested inside.
 *
 * `axis` is which coordinate the cut introduces: 'x' puts the halves side by
 * side, which is the cut a person calls vertical. The panel says "Split
 * vertically" and passes 'x', because the user is naming the line and the model
 * is naming the axis it lives on.
 */
export function splitTile(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  target: string,
  axis: 'x' | 'y',
): SplitResult | null {
  const tile = tiles.find((each) => each.id === target)
  if (!tile) return null

  const values = axis === 'x' ? x : y
  const startId = axis === 'x' ? tile.left : tile.top
  const endId = axis === 'x' ? tile.right : tile.bottom
  const start = valueOf(values, startId)
  const end = valueOf(values, endId)
  if (!(end > start)) return null

  const created = { tile: tileId(), coordinate: coordId() }
  // Even halves. Anything else would need a reason, and there is none: the tile
  // is being divided, not weighted.
  const value = (start + end) / 2

  const first: MosaicTile =
    axis === 'x' ? { ...tile, right: created.coordinate } : { ...tile, bottom: created.coordinate }
  const second: MosaicTile =
    axis === 'x'
      ? { ...tile, id: created.tile, left: created.coordinate }
      : { ...tile, id: created.tile, top: created.coordinate }

  const out: MosaicTile[] = []
  for (const each of tiles) {
    if (each.id !== target) {
      out.push(each)
      continue
    }
    // The original first, so its character stays where it was drawn and the new
    // tile appears to the right of it, or below it.
    out.push(first, second)
  }

  return { tiles: out, created, axis, value }
}

export interface RemoveResult {
  tiles: MosaicTile[]
  /** Coordinates nothing names any more, to clear from every state. */
  retired: { x: string[]; y: string[] }
  /** The tile that took the space, and where a caret sitting on the removed one goes. */
  absorbedBy: string
}

/**
 * Take an empty tile away and give its space to a neighbour.
 *
 * Only an EMPTY tile, and that is not a safety rail that could be turned off —
 * it is what lets this happen without a confirmation. Nothing is destroyed, so
 * nothing needs to be asked.
 *
 * The neighbour has to line up exactly: the same top and bottom for one beside
 * it, the same left and right for one above or below. Otherwise stretching it
 * over the gap would leave a hole or an overlap, and covering the box exactly is
 * the one invariant the whole layout rests on. When nothing lines up, this
 * refuses rather than approximating — the tile can be split differently first.
 *
 * Preference goes left, then up, then right, then down, so a tile closes up
 * toward the start of the mosaic the way deleting a character does.
 */
export function removeTile(
  tiles: readonly MosaicTile[],
  target: string,
  /**
   * Whether the tile is empty. Asked of the caller rather than read off the
   * tile, because what is written in a tile now belongs to the STATES — and a
   * tile is only removable when it is empty in every one of them. Removing it
   * because the state on show happens to be blank there would take a letter
   * away from a state nobody was looking at.
   */
  empty = true,
): RemoveResult | null {
  const tile = tiles.find((each) => each.id === target)
  // A tile holding a character is not removable at all, and a mosaic of one tile
  // has nothing to remove it into.
  if (!tile || !empty || tiles.length < 2) return null

  const sameRow = (other: MosaicTile): boolean =>
    other.top === tile.top && other.bottom === tile.bottom
  const sameColumn = (other: MosaicTile): boolean =>
    other.left === tile.left && other.right === tile.right

  const candidates: { neighbour: MosaicTile; grow: (n: MosaicTile) => MosaicTile }[] = []
  for (const other of tiles) {
    if (other.id === target) continue
    if (sameRow(other) && other.right === tile.left) {
      candidates.push({ neighbour: other, grow: (n) => ({ ...n, right: tile.right }) })
    } else if (sameColumn(other) && other.bottom === tile.top) {
      candidates.push({ neighbour: other, grow: (n) => ({ ...n, bottom: tile.bottom }) })
    } else if (sameRow(other) && other.left === tile.right) {
      candidates.push({ neighbour: other, grow: (n) => ({ ...n, left: tile.left }) })
    } else if (sameColumn(other) && other.top === tile.bottom) {
      candidates.push({ neighbour: other, grow: (n) => ({ ...n, top: tile.top }) })
    }
  }

  const chosen = candidates[0]
  if (!chosen) return null

  const out = tiles
    .filter((each) => each.id !== target)
    .map((each) => (each.id === chosen.neighbour.id ? chosen.grow(each) : each))

  return { tiles: out, retired: retiredCoordinates(tiles, out), absorbedBy: chosen.neighbour.id }
}

/**
 * Coordinates that were named before and are named no longer.
 *
 * Cleared from every state, so a mosaic does not accumulate numbers for lines
 * that no longer exist — they would be invisible, would survive a save, and
 * would come back to confuse the next person to read a document by hand.
 */
function retiredCoordinates(
  before: readonly MosaicTile[],
  after: readonly MosaicTile[],
): { x: string[]; y: string[] } {
  const used = (tiles: readonly MosaicTile[], axis: 'x' | 'y'): Set<string> => {
    const out = new Set<string>()
    for (const tile of tiles) {
      out.add(axis === 'x' ? tile.left : tile.top)
      out.add(axis === 'x' ? tile.right : tile.bottom)
    }
    return out
  }
  const gone = (axis: 'x' | 'y'): string[] => {
    const now = used(after, axis)
    return [...used(before, axis)].filter((id) => !now.has(id))
  }
  return { x: gone('x'), y: gone('y') }
}
