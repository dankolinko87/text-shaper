import { valueOf, type Span } from './dissection'
import { contentBounds } from './layout'
import { MINIMUM_VISIBLE } from './spacing'
import { snapPosition, snapWithin, snaps } from './snap'
import type { Rect, Vec2 } from '../types/document'
import type { Coordinate, MosaicSpacing, MosaicTile } from '../types/mosaic'
import { isRim } from '../types/mosaic'

/**
 * The lines between a mosaic's tiles: finding the one under the pointer, and how
 * far it may be pushed.
 *
 * Everything here is pure: no canvas, no store, no React. The layer above turns
 * pointers into the mosaic's own coordinates and hands them over.
 *
 * Dragging is ONE operation — change one number — and that is the whole reason
 * the model was rewritten. Under the old partition tree an edge was not a thing:
 * there were fractions on split nodes, and which tiles a line belonged to
 * depended on the order the cuts had been made, so "move this edge" sometimes
 * meant two tiles and sometimes a whole row. Here a line has an identity, the
 * tiles naming it respond, and the tiles that do not, do not.
 */

export type Axis = 'x' | 'y'

/** A line the user can grab, in the mosaic's own units. */
export interface MosaicEdge {
  axis: Axis
  /** The coordinate it moves. */
  id: string
  /** Where it is, in local units. */
  position: number
  /** How far it runs, along the other axis — the span of the tiles that name it. */
  from: number
  to: number
  /** The tiles it will resize: those naming it on either side. */
  moves: string[]
  /**
   * The block this edge bounds, when the selection reaches further than one tile.
   *
   * `anchor` is the coordinate at the far end, which stays put; `interior` are
   * the lines between them that the selection names. Dragging the edge scales
   * the whole block: the interior lines move in proportion, so three selected
   * tiles all grow rather than only the one touching the line.
   *
   * Null when there is nothing inside — a single tile has no interior, and one
   * number is the whole of its resize.
   */
  block: { anchor: string; interior: string[] } | null
}

/** Screen-space distance, per axis, converted into the mosaic's own units. */
export interface HoverTolerance {
  x: number
  y: number
}

/** How far a line may travel, in local units, measured from where it is. */
export interface EdgeRange {
  /** Never positive. */
  min: number
  /** Never negative. */
  max: number
}

/**
 * Every line the selected tiles are bounded by.
 *
 * Only the selection's own edges, because offering every line in the mosaic at
 * once meant one lit up wherever the pointer happened to be, with no way to tell
 * which of dozens was about to move.
 *
 * A line is drawn along the span of the SELECTED tiles that name it, not along
 * everything that names it — a handle several times the size of the tile you
 * picked reads as though something much bigger were selected. What it will
 * actually resize is in `moves`.
 */
export function selectionEdges(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
  selection: readonly string[],
): MosaicEdge[] {
  if (selection.length === 0) return []
  const chosen = new Set(selection)
  const content = contentBounds(localBounds, spacing.outerPadding)

  const edges = new Map<string, Omit<MosaicEdge, 'block'>>()

  const note = (axis: Axis, id: string, tile: MosaicTile, selected: boolean): void => {
    // The rim is the object's own size, not a division of it: resizing there is
    // what the object's handles are for.
    if (isRim(id)) return

    const values = axis === 'x' ? x : y
    const across = axis === 'x' ? content.x + valueOf(x, id) * content.width
                                : content.y + valueOf(y, id) * content.height
    const lowId = axis === 'x' ? tile.top : tile.left
    const highId = axis === 'x' ? tile.bottom : tile.right
    const perp = axis === 'x' ? y : x
    const origin = axis === 'x' ? content.y : content.x
    const size = axis === 'x' ? content.height : content.width
    const from = origin + valueOf(perp, lowId) * size
    const to = origin + valueOf(perp, highId) * size
    void values

    const key = `${axis}:${id}`
    const existing = edges.get(key)
    if (!existing) {
      edges.set(key, {
        axis,
        id,
        position: across,
        from: selected ? from : Infinity,
        to: selected ? to : -Infinity,
        moves: [tile.id],
      })
      return
    }
    if (selected) {
      existing.from = Math.min(existing.from, from)
      existing.to = Math.max(existing.to, to)
    }
    if (!existing.moves.includes(tile.id)) existing.moves.push(tile.id)
  }

  /*
   * Two passes. The first finds which lines the selection names; the second
   * gathers every tile that names them, because those are the tiles that will
   * move and the overlay has to be able to say so.
   */
  const wanted = new Set<string>()
  /** Every line the selection names, per axis, with where it sits. */
  const named: Record<Axis, Map<string, number>> = { x: new Map(), y: new Map() }
  for (const tile of tiles) {
    if (!chosen.has(tile.id)) continue
    named.x.set(tile.left, valueOf(x, tile.left))
    named.x.set(tile.right, valueOf(x, tile.right))
    named.y.set(tile.top, valueOf(y, tile.top))
    named.y.set(tile.bottom, valueOf(y, tile.bottom))
    if (!isRim(tile.left)) wanted.add(`x:${tile.left}`)
    if (!isRim(tile.right)) wanted.add(`x:${tile.right}`)
    if (!isRim(tile.top)) wanted.add(`y:${tile.top}`)
    if (!isRim(tile.bottom)) wanted.add(`y:${tile.bottom}`)
  }

  for (const tile of tiles) {
    const selected = chosen.has(tile.id)
    if (wanted.has(`x:${tile.left}`)) note('x', tile.left, tile, selected)
    if (wanted.has(`x:${tile.right}`)) note('x', tile.right, tile, selected)
    if (wanted.has(`y:${tile.top}`)) note('y', tile.top, tile, selected)
    if (wanted.has(`y:${tile.bottom}`)) note('y', tile.bottom, tile, selected)
  }

  /*
   * Give each edge the block it bounds.
   *
   * A selection spanning several tiles has an outside and an inside: dragging
   * its outer edge should grow the whole run in proportion, not just the tile
   * against the line. The anchor is the far end, which does not move; the
   * interior lines are what scale with it.
   */
  const out: MosaicEdge[] = []
  for (const edge of edges.values()) {
    if (edge.to <= edge.from) continue
    const lines = [...named[edge.axis].entries()].sort((a, b) => a[1] - b[1])
    const low = lines[0]
    const high = lines[lines.length - 1]
    if (!low || !high || lines.length <= 2) {
      out.push({ ...edge, block: null })
      continue
    }

    const atLow = edge.id === low[0]
    const atHigh = edge.id === high[0]
    if (!atLow && !atHigh) {
      // A line INSIDE the selection: dragging it divides the block rather than
      // resizing it, which is a different and perfectly good thing to want.
      out.push({ ...edge, block: null })
      continue
    }

    out.push({
      ...edge,
      block: {
        anchor: atLow ? (high[0] as string) : (low[0] as string),
        interior: lines.slice(1, -1).map(([id]) => id),
      },
    })
  }
  return out
}

/**
 * How far this line may be dragged.
 *
 * Read straight off the tiles that name it, because validity is a set of linear
 * inequalities: every tile at least `floor` across. A tile whose LEFT is this
 * line is squeezed by moving it forward; one whose RIGHT is this line is
 * squeezed by moving it back. The tightest of each decides, and there is nothing
 * to search for.
 *
 * `floor` is the visible minimum plus what the gap and the glyph inset take out
 * of the tile, so a line stops before a tile becomes unusable rather than before
 * it becomes invisible.
 */
export function edgeRange(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
  axis: Axis,
  id: string,
  block?: { anchor: string; interior: string[] } | null,
): EdgeRange {
  if (isRim(id)) return { min: 0, max: 0 }
  if (block) return blockRange(tiles, x, y, localBounds, spacing, axis, id, block)

  const content = contentBounds(localBounds, spacing.outerPadding)
  const size = axis === 'x' ? content.width : content.height
  if (!(size > 0)) return { min: 0, max: 0 }

  const values = axis === 'x' ? x : y
  const here = valueOf(values, id)
  const half = Math.max(0, spacing.gap) / 2
  const bare = Math.max(MINIMUM_VISIBLE, 2 * Math.max(0, spacing.glyphInset))

  let low = 0
  let high = 1

  for (const tile of tiles) {
    const startId = axis === 'x' ? tile.left : tile.top
    const endId = axis === 'x' ? tile.right : tile.bottom
    if (startId !== id && endId !== id) continue

    // What this tile has to keep, as a fraction of the content box.
    const interior =
      (isEdgeValue(values, startId, 0) ? 0 : half) + (isEdgeValue(values, endId, 1) ? 0 : half)
    const needed = (bare + interior) / size

    if (startId === id) {
      // Moving forward squeezes it against its far edge.
      high = Math.min(high, valueOf(values, endId) - needed)
    } else {
      low = Math.max(low, valueOf(values, startId) + needed)
    }
  }

  if (low > high) return { min: 0, max: 0 }
  return { min: Math.min(0, (low - here) * size), max: Math.max(0, (high - here) * size) }
}

const isEdgeValue = (values: Record<string, Coordinate>, id: string, at: 0 | 1): boolean =>
  Math.abs(valueOf(values, id) - at) < 1e-9

/**
 * Where a line ends up, for a drag of `offset` local units.
 *
 * Always computed from the values captured when the gesture STARTED, never from
 * wherever the last frame left them. Accumulating a delta per frame drifts —
 * sixty small roundings a second — and the line slowly parts company with the
 * pointer over a long drag.
 */
export function moveEdge(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
  axis: Axis,
  id: string,
  offset: number,
  block?: { anchor: string; interior: string[] } | null,
  /** Grid to land on, in object-local units. Zero or absent drags freely. */
  snapStep?: number,
): { updates: { id: string; value: Coordinate }[]; clamped: boolean } | null {
  if (isRim(id)) return null
  const content = contentBounds(localBounds, spacing.outerPadding)
  const size = axis === 'x' ? content.width : content.height
  if (!(size > 0)) return null

  const values = axis === 'x' ? x : y
  const range = edgeRange(tiles, x, y, localBounds, spacing, axis, id, block)
  const allowed = Math.min(range.max, Math.max(range.min, offset))
  const here = valueOf(values, id)
  // The limit light means the RANGE stopped the drag. Rounding to a step is not
  // being stopped, and flashing it every step would make the signal worthless.
  const clamped = allowed !== offset

  /*
   * Snap where the pointer ASKED to go, then keep that inside the range — never
   * the other way round. Rounding a value that already sits at the limit would
   * round it straight past, and the fall back to `allowed` is for a window too
   * narrow to hold any step at all: better an unsnapped drag than a dead edge.
   */
  const from = here * size
  const landed = snaps(snapStep)
    ? (snapWithin(from + offset, snapStep, from + range.min, from + range.max) ?? from + allowed)
    : from + allowed
  const moved = landed / size

  if (!block) return { updates: [{ id, value: moved }], clamped }

  /*
   * The block scales about its anchor. Every line inside keeps its share of the
   * span, so three selected tiles grow together and in proportion — which is the
   * difference between resizing a selection and resizing the one tile that
   * happens to touch the line.
   */
  const anchor = valueOf(values, block.anchor)
  const span = here - anchor
  if (!(Math.abs(span) > 1e-12)) return { updates: [{ id, value: moved }], clamped }
  const factor = (moved - anchor) / span

  const scaled = block.interior.map((inside) => ({
    id: inside,
    value: anchor + (valueOf(values, inside) - anchor) * factor,
  }))
  if (!snaps(snapStep)) return { updates: [{ id, value: moved }, ...scaled], clamped }

  /*
   * The lines INSIDE the block land on the grid as well, or a drag would leave
   * half of what it writes between steps and the block could never rejoin
   * anything. Proportion gives way to the grid — but only where the grid leaves
   * every tile above its minimum. Snapping several lines at once can squeeze one
   * of them, and a legal layout matters more than a tidy one, so the scaled
   * values stand whenever the snapped set would not survive.
   */
  const snapped = scaled.map((u) => ({
    id: u.id,
    value: snapPosition(u.value * size, snapStep) / size,
  }))
  const candidate: Record<string, Coordinate> = { ...values, [id]: moved }
  for (const update of snapped) candidate[update.id] = update.value
  const legal =
    axis === 'x'
      ? canReshape(tiles, candidate, y, localBounds, spacing)
      : canReshape(tiles, x, candidate, localBounds, spacing)

  return { updates: [{ id, value: moved }, ...(legal ? snapped : scaled)], clamped }
}

/**
 * How far a block's outer edge may travel.
 *
 * Two constraints, and they are the same shape as the single-line case. Every
 * tile INSIDE the block scales by the same factor, so the tightest of them
 * decides how far the block may shrink. Every tile OUTSIDE that names the edge
 * gives up or takes back what the block gains, so the tightest of those decides
 * how far it may grow.
 */
function blockRange(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
  axis: Axis,
  id: string,
  block: { anchor: string; interior: string[] },
): EdgeRange {
  const content = contentBounds(localBounds, spacing.outerPadding)
  const size = axis === 'x' ? content.width : content.height
  if (!(size > 0)) return { min: 0, max: 0 }

  const values = axis === 'x' ? x : y
  const here = valueOf(values, id)
  const anchor = valueOf(values, block.anchor)
  const span = here - anchor
  if (!(Math.abs(span) > 1e-12)) return { min: 0, max: 0 }

  const half = Math.max(0, spacing.gap) / 2
  const bare = Math.max(MINIMUM_VISIBLE, 2 * Math.max(0, spacing.glyphInset))
  const low = Math.min(anchor, here)
  const high = Math.max(anchor, here)

  /** The smallest factor the block may scale to before one of its tiles dies. */
  let smallest = 0
  /** How much the block may grow before a tile outside runs out. */
  let outside = Infinity

  for (const tile of tiles) {
    const startId = axis === 'x' ? tile.left : tile.top
    const endId = axis === 'x' ? tile.right : tile.bottom
    const start = valueOf(values, startId)
    const end = valueOf(values, endId)
    const interior =
      (isEdgeValue(values, startId, 0) ? 0 : half) + (isEdgeValue(values, endId, 1) ? 0 : half)
    const needed = (bare + interior) / size
    const width = end - start

    const inBlock = start >= low - 1e-12 && end <= high + 1e-12
    if (inBlock) {
      if (width > 0) smallest = Math.max(smallest, needed / width)
      continue
    }
    // Outside, and touching the line that moves: it absorbs the difference.
    if (startId === id || endId === id) {
      outside = Math.min(outside, width - needed)
    }
  }

  const grow = Number.isFinite(outside) ? Math.max(0, outside) : Math.max(0, 1 - Math.abs(span))
  const shrink = Math.max(0, Math.abs(span) * (1 - smallest))

  /*
   * Which way growing pushes depends on which side of the block this edge is.
   *
   * A HIGH edge — the block's right or bottom — grows forward and shrinks back.
   * A LOW edge grows BACKWARD: dragging the left edge further left makes the
   * block wider. Folding both into one signed expression got the low side
   * exactly backwards, and since a range is clamped to [min ≤ 0, max ≥ 0] the
   * two wrong answers cancelled to zero — so a block's top and left edges could
   * not be dragged at all, in either direction, with nothing to say why.
   */
  const forward = span > 0
  return {
    min: -(forward ? shrink : grow) * size,
    max: (forward ? grow : shrink) * size,
  }
}

/**
 * The line under a point, or null.
 *
 * Distances are measured in units of the TOLERANCE rather than in local units,
 * which is what makes this behave under a non-uniform scale: a mosaic squashed
 * flat has a much larger local tolerance vertically than horizontally, and
 * comparing raw local distances would make its horizontal lines almost
 * impossible to miss and its vertical ones almost impossible to hit.
 */
export function edgeAt(
  edges: readonly MosaicEdge[],
  point: Vec2,
  tolerance: HoverTolerance,
): MosaicEdge | null {
  let best: MosaicEdge | null = null
  let bestScore = Infinity

  for (const edge of edges) {
    const vertical = edge.axis === 'x'
    const across = vertical ? point.x - edge.position : point.y - edge.position
    const along = vertical ? point.y : point.x
    // Past the end of the line counts against the hit, so a line is not grabbable
    // from halfway across the mosaic on the strength of one coordinate.
    const overshoot = Math.max(edge.from - along, along - edge.to, 0)
    const tolAcross = vertical ? tolerance.x : tolerance.y
    const tolAlong = vertical ? tolerance.y : tolerance.x
    if (!(tolAcross > 0) || !(tolAlong > 0)) continue

    const score = Math.hypot(across / tolAcross, overshoot / tolAlong)
    if (score > 1) continue

    /*
     * Closest wins, but a near-tie goes to the line that disturbs LESS. Two
     * lines meet at every corner of a tile, and the one moving fewer tiles is
     * nearly always what was meant.
     *
     * Except against a line that bounds the BLOCK, which wins the tie outright.
     * An outer edge moves the whole selection and an interior divider moves two
     * tiles, so counting alone hands every tie to the divider — and on a 2×2
     * block the divider sits exactly at the midpoint of the outer edge, which is
     * where anyone reaches to grab it. Choosing several tiles says the block is
     * the subject; its own edges answer for it first.
     */
    const closer = score < bestScore - 0.2
    const tie = best !== null && Math.abs(score - bestScore) <= 0.2
    const beats =
      best !== null &&
      (Boolean(edge.block) !== Boolean(best.block)
        ? Boolean(edge.block)
        : edge.moves.length < best.moves.length)
    if (best === null || closer || (tie && beats)) {
      best = edge
      bestScore = Math.min(bestScore, score)
    }
  }

  return best
}

/**
 * How many tiles this line moves that were not selected.
 *
 * One per side is the unavoidable minimum — the space has to come from
 * somewhere. More than that means the line is shared with tiles the selection
 * did not ask about, which is alignment doing its job and worth showing.
 */
export function collateral(edge: MosaicEdge, selection: readonly string[]): number {
  const chosen = new Set(selection)
  return edge.moves.filter((id) => !chosen.has(id)).length
}

/**
 * The stretches of an axis that the selection actually covers.
 *
 * Measured along the axis PERPENDICULAR to `axis`, because that is the direction
 * a line runs: for a vertical line (`axis === 'x'`) the runs are vertical
 * extents, and they say which parts of that line belong to the selection.
 *
 * A list, not one bounding range. A selection can have holes — picking the two
 * end tiles of a row and leaving the middle one is the ordinary case — and a
 * single range from the first edge to the last swallows the hole. Everything
 * inside was then treated as selected: the line was detached for the middle tile
 * as well, so resizing the two ends resized the tile between them, which is
 * exactly what it was not meant to do.
 *
 * Touching runs are merged, so a contiguous selection still comes back as one.
 */
export function selectionRuns(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  axis: Axis,
  selection: readonly string[],
): Span[] {
  const values = axis === 'x' ? y : x
  const chosen = new Set(selection)

  const runs: Span[] = []
  for (const tile of tiles) {
    if (!chosen.has(tile.id)) continue
    const from = valueOf(values, axis === 'x' ? tile.top : tile.left)
    const to = valueOf(values, axis === 'x' ? tile.bottom : tile.right)
    if (to > from) runs.push({ from, to })
  }
  if (runs.length === 0) return []

  const tolerance = 1e-9
  runs.sort((a, b) => a.from - b.from)
  const merged: Span[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run.from <= last.to + tolerance) last.to = Math.max(last.to, run.to)
    else merged.push({ ...run })
  }
  return merged
}

/**
 * Whether this line reaches past the selection, and so has to be detached before
 * a drag may move it.
 *
 * Asked GEOMETRICALLY rather than by counting tiles. Counting was wrong in a way
 * that only showed on certain layouts: a line inside the selection shared with
 * exactly two tiles elsewhere looked the same as an outer edge shared with the
 * two tiles that legitimately give up the space, so the leak slipped through and
 * the row below moved along with the block.
 *
 * The honest question is where the tiles ARE. A tile naming this line and lying
 * within one of the selection's runs is either selected or directly opposite it,
 * and either way it is meant to respond. A tile in none of them is not.
 *
 * RUNS, not one bounding range. A selection can have gaps — the two end tiles of
 * a row, say — and a bounding range swallows the tile between them, which then
 * reads as inside the selection and follows the drag. That was the bug: resizing
 * two tiles resized the unselected one between them.
 */
export function reachesBeyond(
  edge: MosaicEdge,
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  spans: Span | readonly Span[],
): boolean {
  const tolerance = 1e-9
  const perpendicular = edge.axis === 'x' ? y : x
  const naming = new Set(edge.moves)
  const runs = Array.isArray(spans) ? spans : [spans as Span]

  for (const tile of tiles) {
    if (!naming.has(tile.id)) continue
    const low = valueOf(perpendicular, edge.axis === 'x' ? tile.top : tile.left)
    const high = valueOf(perpendicular, edge.axis === 'x' ? tile.bottom : tile.right)
    const inside = runs.some(
      (run) => low >= run.from - tolerance && high <= run.to + tolerance,
    )
    if (!inside) return true
  }
  return false
}

/**
 * Whether this mosaic can be reshaped at all.
 *
 * A document can arrive with spacing that leaves no room — hand-edited, or
 * written by an older version — and the layout renders it rather than refusing
 * to. Dragging such a mosaic would pin every line at zero, which reads as a
 * broken tool rather than as a document that needs its spacing fixed.
 */
export function canReshape(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
): boolean {
  const content = contentBounds(localBounds, spacing.outerPadding)
  if (!(content.width > 0) || !(content.height > 0)) return false

  const half = Math.max(0, spacing.gap) / 2
  const bare = Math.max(MINIMUM_VISIBLE, 2 * Math.max(0, spacing.glyphInset))
  /*
   * Sitting exactly ON the floor is legal, and it is where a drag that reached
   * its limit leaves a tile. Compared strictly, the last unit in the last place
   * decides whether reshaping is still offered.
   */
  const slack = Math.max(content.width, content.height, 1) * 1e-9

  for (const tile of tiles) {
    const width = (valueOf(x, tile.right) - valueOf(x, tile.left)) * content.width
    const height = (valueOf(y, tile.bottom) - valueOf(y, tile.top)) * content.height
    const acrossGap =
      (isEdgeValue(x, tile.left, 0) ? 0 : half) + (isEdgeValue(x, tile.right, 1) ? 0 : half)
    const downGap =
      (isEdgeValue(y, tile.top, 0) ? 0 : half) + (isEdgeValue(y, tile.bottom, 1) ? 0 : half)
    if (width - acrossGap < bare - slack) return false
    if (height - downGap < bare - slack) return false
  }
  return true
}
