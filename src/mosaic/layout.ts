import { valueOf } from './dissection'
import type { Rect } from '../types/document'
import type { Coordinate, MosaicSpacing, MosaicTile, MosaicTileLayout } from '../types/mosaic'

/**
 * From coordinates to the rectangles on screen.
 *
 * Three rectangles per tile, each derived from the one before it, and the ORDER
 * they are derived in is the whole of what makes the spacing behave:
 *
 *   contentBounds  = localBounds inset by outerPadding
 *   structural     = the tile's four coordinates, read across contentBounds
 *   visible        = structural inset by half a gap on every interior edge
 *   glyph          = visible inset by glyphInset
 *
 * Padding is applied BEFORE the coordinates are read, not after. Reading them
 * across the whole box and then insetting the outside tiles would shrink those
 * tiles alone; padding has to move the whole mosaic inward, which makes it a
 * property of the box the coordinates are read across rather than of the tiles
 * that come out.
 *
 * An edge is interior when its coordinate is not the rim — asked of the model
 * rather than measured. Under the old partition this had to be decided
 * geometrically, by testing whether an edge lay on the content box, because the
 * tree did not name its own outside.
 */

export function layoutMosaic(
  tiles: readonly MosaicTile[],
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  localBounds: Rect,
  spacing: MosaicSpacing,
): Map<string, MosaicTileLayout> {
  const content = contentBounds(localBounds, spacing.outerPadding)
  const half = Math.max(0, spacing.gap) / 2
  const minimum = Math.max(0, spacing.minimumVisibleSize ?? 0)
  const out = new Map<string, MosaicTileLayout>()

  for (const tile of tiles) {
    const left = valueOf(x, tile.left)
    const right = valueOf(x, tile.right)
    const top = valueOf(y, tile.top)
    const bottom = valueOf(y, tile.bottom)

    const structural: Rect = {
      x: content.x + left * content.width,
      y: content.y + top * content.height,
      width: (right - left) * content.width,
      height: (bottom - top) * content.height,
    }

    // The rim is the outside of the mosaic, and the outside is what
    // `outerPadding` already answered for.
    const insetLeft = isEdge(x, tile.left, 0) ? 0 : half
    const insetRight = isEdge(x, tile.right, 1) ? 0 : half
    const insetTop = isEdge(y, tile.top, 0) ? 0 : half
    const insetBottom = isEdge(y, tile.bottom, 1) ? 0 : half

    const visible = clampRect(
      {
        x: structural.x + insetLeft,
        y: structural.y + insetTop,
        width: structural.width - insetLeft - insetRight,
        height: structural.height - insetTop - insetBottom,
      },
      minimum,
    )

    out.set(tile.id, {
      structural,
      visible,
      /*
       * The inset, cut down to what THIS tile can take.
       *
       * One inset for the whole mosaic is the point of the control, and it is
       * honoured wherever it fits. But a mosaic can hold tiles of wildly
       * different sizes — a line dragged hard leaves slivers — and an inset that
       * suits the big ones would inset a sliver out of existence. Rather than
       * let one small tile decide the inset for the other ninety-nine, or let a
       * letter silently disappear, each tile takes as much of the inset as it
       * has room for.
       */
      glyph: insetRect(visible, fittingInset(visible, spacing.glyphInset, minimum), minimum),
    })
  }

  return out
}

/**
 * Whether this coordinate sits on the rim.
 *
 * By VALUE rather than by id, so a coordinate that has been forked off the rim —
 * or a hand-edited document — still reads as the outside when it is at the
 * outside. Half a gap taken off the true edge of the mosaic would show as a
 * mysterious sliver of padding nobody asked for.
 */
const isEdge = (values: Record<string, Coordinate>, id: string, at: 0 | 1): boolean =>
  Math.abs(valueOf(values, id) - at) < 1e-9

/** The box the coordinates are read across: the object's bounds, inset by padding. */
export function contentBounds(localBounds: Rect, outerPadding: number): Rect {
  return insetRect(localBounds, outerPadding)
}

/**
 * As much of an inset as a rectangle has room for.
 *
 * Half the shorter side, less whatever must survive: past that the inset would
 * eat the rectangle. Never negative, so a rectangle already at nothing is left
 * alone rather than pushed outwards.
 */
function fittingInset(rect: Rect, by: number, minimum: number): number {
  if (!(by > 0)) return 0
  const room = (Math.min(rect.width, rect.height) - minimum) / 2
  return Math.max(0, Math.min(by, room))
}

function insetRect(rect: Rect, by: number, minimum = 0): Rect {
  return clampRect(
    {
      x: rect.x + by,
      y: rect.y + by,
      width: rect.width - by * 2,
      height: rect.height - by * 2,
    },
    minimum,
  )
}

/**
 * A rectangle that has been inset past nothing.
 *
 * Collapsed to zero rather than allowed to go negative: a negative width is a
 * rectangle turned inside out, and it would draw as one. The controls clamp
 * spacing so this should not arise, but a document can be edited by hand and a
 * mosaic scaled very small is a real thing to do.
 *
 * `minimum` collapses a surviving SLIVER for the same reason — a tile a
 * thousandth of a unit wide is not a tile. Zero by default, so a caller that has
 * not said what counts as too small gets exactly the untouched answer.
 */
function clampRect(rect: Rect, minimum = 0): Rect {
  const width = rect.width >= minimum ? Math.max(0, rect.width) : 0
  const height = rect.height >= minimum ? Math.max(0, rect.height) : 0
  return { x: rect.x, y: rect.y, width, height }
}
