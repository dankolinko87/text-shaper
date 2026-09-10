import { contentBounds } from './layout'
import { valueOf } from './dissection'
import type { Rect } from '../types/document'
import type { Coordinate, MosaicSpacing, MosaicTile } from '../types/mosaic'

/**
 * How much spacing a mosaic can take before it stops being one.
 *
 * The layout pipeline tolerates any numbers at all — a rectangle inset past
 * nothing collapses rather than turning inside out — but tolerating is not
 * staying legal. A gap wider than the narrowest tile leaves tiles with no width
 * that still occupy their place in the mosaic and still take the caret, which
 * looks like the mosaic has lost a column rather than like a number is too big.
 *
 * So each of the three values has a maximum, and each is computed HOLDING THE
 * OTHER TWO at their current values. That is the whole design and the reason the
 * controls are non-destructive: raising the padding shrinks the gap's RANGE
 * rather than rewriting the gap, so nothing the user set is silently lost and no
 * order of adjustment can reach an illegal layout.
 *
 * Every maximum here is a closed form rather than a search: a tile's size is a
 * fraction of the content box, and the content box shrinks linearly with the
 * padding, so each constraint inverts in one step.
 */

/** Below this, a tile is not a tile. Object-local units. */
export const MINIMUM_VISIBLE = 2

/**
 * How far short of the true limit each maximum stops.
 *
 * Relative to the mosaic, and far too small to see — a ten-millionth of a unit
 * on a box six hundred across. It is here because the arithmetic that finds a
 * maximum and the arithmetic that lays the tiles out are not the same
 * expression, so the exact limit can land a few ulps on the wrong side: a 6×6
 * grid at its computed maximum padding produced a tile 1.9999999999999996 wide
 * against a floor of 2, and the control then offered a value it would itself
 * call illegal. Stopping a hair early makes the maximum a value that IS legal,
 * which is what a maximum has to be.
 */
const conservative = (limit: number, box: Rect): number =>
  Math.max(0, limit - Math.max(box.width, box.height, 1) * 1e-9)

/**
 * The coordinate sets to check.
 *
 * A list rather than one set, because a mosaic will soon have several states and
 * a value legal in the one on show may not be legal in the next. Each maximum is
 * the minimum across the list, so the answer holds for every state. Today the
 * panel passes the active state alone; step 5 passes all of them and nothing
 * here changes.
 */
export interface CoordinateSet {
  x: Record<string, Coordinate>
  y: Record<string, Coordinate>
}

interface Limits {
  minimumVisibleSize?: number
}

/**
 * What a tile's visible rectangle has to keep, given what will be taken out of
 * it afterwards.
 *
 * The glyph inset is downstream of both the gap and the padding, so bounding
 * those two against the bare minimum alone would let either of them eat the room
 * an inset already occupies — and then pushing the gap to its "maximum" would
 * quietly make the inset illegal. Folding the inset in here is what makes the
 * three maxima mutually consistent, which is what lets the controls be touched
 * in any order.
 */
const floorFor = (minimum: number, glyphInset: number): number =>
  minimum + 2 * Math.max(0, glyphInset)

/** How many half-gaps a tile loses on each axis, and its size as a fraction. */
function measure(tile: MosaicTile, set: CoordinateSet) {
  const left = valueOf(set.x, tile.left)
  const right = valueOf(set.x, tile.right)
  const top = valueOf(set.y, tile.top)
  const bottom = valueOf(set.y, tile.bottom)
  const on = (v: number, at: 0 | 1): boolean => Math.abs(v - at) < 1e-9
  return {
    width: right - left,
    height: bottom - top,
    acrossGaps: (on(left, 0) ? 0 : 1) + (on(right, 1) ? 0 : 1),
    downGaps: (on(top, 0) ? 0 : 1) + (on(bottom, 1) ? 0 : 1),
  }
}

/**
 * The widest gap that leaves every tile at least `minimumVisibleSize` across.
 *
 * A tile keeps `fraction · content − halves · gap/2`, and which edges are
 * interior does not move with the gap, so this inverts directly.
 */
export function maximumGap(
  tiles: readonly MosaicTile[],
  sets: readonly CoordinateSet[],
  localBounds: Rect,
  options: Limits & { outerPadding: number; glyphInset?: number },
): number {
  const floor = floorFor(options.minimumVisibleSize ?? MINIMUM_VISIBLE, options.glyphInset ?? 0)
  const content = contentBounds(localBounds, options.outerPadding)

  const limit = leastOver(sets, (set) => {
    let smallest = Infinity
    for (const tile of tiles) {
      const m = measure(tile, set)
      if (m.acrossGaps > 0) {
        smallest = Math.min(smallest, (2 * (m.width * content.width - floor)) / m.acrossGaps)
      }
      if (m.downGaps > 0) {
        smallest = Math.min(smallest, (2 * (m.height * content.height - floor)) / m.downGaps)
      }
    }
    return smallest
  })

  // A mosaic of one tile has no interior edge anywhere, so nothing above bounds
  // it. A gap wider than the box it is drawn in means nothing either way.
  return conservative(
    Math.min(limit, Math.max(0, Math.min(content.width, content.height) - floor)),
    localBounds,
  )
}

/**
 * The largest padding that still leaves every tile legal at the current gap.
 *
 * Every tile keeps the same FRACTION of the content box however far it is inset,
 * so `fraction · (W − 2p) − halves·gap/2 ≥ floor` solves for `p` in one step.
 * This is also why increasing the padding shrinks the whole mosaic proportionally
 * rather than trimming only the outer tiles.
 */
export function maximumOuterPadding(
  tiles: readonly MosaicTile[],
  sets: readonly CoordinateSet[],
  localBounds: Rect,
  options: Limits & { gap: number; glyphInset?: number },
): number {
  const floor = floorFor(options.minimumVisibleSize ?? MINIMUM_VISIBLE, options.glyphInset ?? 0)
  const half = Math.max(0, options.gap) / 2
  const { width: W, height: H } = localBounds

  const limit = leastOver(sets, (set) => {
    let smallest = Infinity
    for (const tile of tiles) {
      const m = measure(tile, set)
      if (m.width > 0) smallest = Math.min(smallest, (W - (floor + m.acrossGaps * half) / m.width) / 2)
      if (m.height > 0) smallest = Math.min(smallest, (H - (floor + m.downGaps * half) / m.height) / 2)
    }
    return smallest
  })

  // The content box itself must survive, even for a mosaic of one tile.
  return conservative(Math.min(limit, (Math.min(W, H) - floor) / 2), localBounds)
}

/**
 * The deepest inset that leaves every glyph rectangle drawable.
 *
 * Measured across EVERY tile, empty ones included. An empty tile can be typed
 * into at any moment, and a maximum that jumped the instant a letter was added
 * would be a stranger control than one that is occasionally a little
 * conservative.
 */
export function maximumGlyphInset(
  tiles: readonly MosaicTile[],
  sets: readonly CoordinateSet[],
  localBounds: Rect,
  options: Limits & { gap: number; outerPadding: number },
): number {
  const minimum = options.minimumVisibleSize ?? MINIMUM_VISIBLE
  const content = contentBounds(localBounds, options.outerPadding)
  const half = Math.max(0, options.gap) / 2

  return conservative(
    leastOver(sets, (set) => {
      let smallest = Infinity
      for (const tile of tiles) {
        const m = measure(tile, set)
        const width = m.width * content.width - m.acrossGaps * half
        const height = m.height * content.height - m.downGaps * half
        smallest = Math.min(smallest, (width - minimum) / 2, (height - minimum) / 2)
      }
      return smallest
    }),
    localBounds,
  )
}

/**
 * All three at once, made legal.
 *
 * In dependency order, because the order is the meaning: the padding decides how
 * much room the tiles have, the gap eats into what is left, and the inset eats
 * into what the gap leaves.
 *
 * Note the padding is bounded here as though the gap were zero, which the PANEL
 * deliberately does not do. The difference is the job: the panel is protecting a
 * value the user chose, so it would rather narrow a range than overwrite
 * anything. This is repairing three values that are already illegal, where
 * something has to give.
 */
export function clampSpacing(
  tiles: readonly MosaicTile[],
  sets: readonly CoordinateSet[],
  localBounds: Rect,
  spacing: MosaicSpacing,
): MosaicSpacing {
  const minimumVisibleSize = spacing.minimumVisibleSize ?? MINIMUM_VISIBLE
  const limits = { minimumVisibleSize }

  const outerPadding = clampTo(
    spacing.outerPadding,
    maximumOuterPadding(tiles, sets, localBounds, { ...limits, gap: 0 }),
  )
  const gap = clampTo(spacing.gap, maximumGap(tiles, sets, localBounds, { ...limits, outerPadding }))
  const glyphInset = clampTo(
    spacing.glyphInset,
    maximumGlyphInset(tiles, sets, localBounds, { ...limits, gap, outerPadding }),
  )

  return { ...spacing, gap, outerPadding, glyphInset }
}

/** Whether a rectangle is too small to be worth drawing. */
export function isDegenerate(rect: Rect, minimum: number = MINIMUM_VISIBLE): boolean {
  return !(rect.width >= minimum) || !(rect.height >= minimum)
}

/** The strictest answer across every state, never below zero. */
function leastOver(sets: readonly CoordinateSet[], of: (set: CoordinateSet) => number): number {
  const all = sets.length > 0 ? sets : [{ x: {}, y: {} }]
  let limit = Infinity
  for (const set of all) limit = Math.min(limit, of(set))
  return Math.max(0, limit)
}

/**
 * A requested value made legal: never negative, never above the maximum.
 *
 * Non-finite becomes zero rather than being passed along. A `NaN` compares false
 * against everything, so it would slip through `Math.min` untouched and reach
 * the layout, where it turns every rectangle it touches into `NaN` and the
 * mosaic disappears without an error anywhere.
 */
export function clampTo(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(value, maximum)
}
