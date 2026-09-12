import type { PositionedStroke, Rect, Stroke, StrokePosition } from '../types/document'
import { blendPaint, fadedPaint, samePaint } from '../typography/paint'
import type { StrokePaint } from '../types/paint'

/**
 * The arithmetic a border needs, with nothing that draws.
 *
 * Pure on purpose: everything here is shared by the Fabric canvas, both GIF
 * exporters, the state thumbnails and the timeline evaluator, and three of
 * those five run in places the others cannot. Keeping it DOM-free also keeps it
 * inside `src/geometry/`, which Vitest runs under its `node` environment with no
 * jsdom — see the boundaries in `.oxlintrc.json`.
 */

/**
 * How far a border reaches OUTSIDE the path it follows, in object units.
 *
 * The single source for this. An outside border grows the artwork, and two
 * places have to know by how much or they crop it: the group's bounds on the
 * canvas, and the frame an export is composed into. Neither has to remember the
 * rule, because there is nothing to remember — they call this.
 *
 * Zero for no border at all, and zero for an inside one, which by definition
 * takes its width out of the shape rather than adding to it.
 */
export function strokeReach(stroke: Stroke | PositionedStroke | null): number {
  if (!stroke || !(stroke.width > 0)) return 0
  const position = positionOf(stroke)
  if (position === 'inside') return 0
  return position === 'outside' ? stroke.width : stroke.width / 2
}

/**
 * The width to actually stroke with, and whether the result needs clipping.
 *
 * Inside and outside are one centred stroke at DOUBLE width with half of it
 * clipped away — so this is the whole of the position trick, and the two
 * renderers differ only in how they clip.
 */
export function strokePaint(stroke: Stroke | PositionedStroke): {
  width: number
  clip: 'none' | 'inside' | 'outside'
} {
  const position = positionOf(stroke)
  if (position === 'centre') return { width: stroke.width, clip: 'none' }
  return { width: stroke.width * 2, clip: position }
}

/** A plain `Stroke` has no position of its own, and centre is what it means. */
function positionOf(stroke: Stroke | PositionedStroke): StrokePosition {
  return 'position' in stroke ? stroke.position : 'centre'
}

/**
 * The dash pattern, or null for a solid line.
 *
 * Null rather than an empty array: Fabric and canvas both take null to mean
 * "solid", and an empty array is a pattern with no segments, which some
 * implementations draw as nothing at all.
 */
export function dashArrayFor(stroke: Stroke | null): number[] | null {
  if (!stroke?.dash) return null
  const { length, gap } = stroke.dash
  if (!(length > 0)) return null
  return [length, Math.max(0, gap)]
}

/**
 * One border on the way to another.
 *
 * The care is all in what NULL means, and the answer is the one the backdrop
 * already gives: a border that is not there is not a border of zero width, it
 * is a border of no colour. So a side with none borrows the other's width and
 * fades from or to zero alpha — the edge thins in opacity rather than in size,
 * which is what stops it popping into existence at full weight on the first
 * frame of a transition.
 *
 * The dash pattern is a CUT, like the font and the letters: two rhythms are not
 * two positions of one rhythm, and interpolating them would walk the dashes
 * through lengths nobody chose. The state being left keeps its pattern for the
 * whole transition.
 */
export function blendStroke<T extends Stroke>(a: T | null, b: T | null, t: number): T | null {
  if (!a && !b) return null
  if (a && !b) return { ...a, colour: (blendPaint(a.colour, fadedPaint(a.colour), t) ?? a.colour) as StrokePaint }
  if (!a && b) return { ...b, colour: (blendPaint(fadedPaint(b.colour), b.colour, t) ?? b.colour) as StrokePaint }

  const from = a as T
  const to = b as T
  /*
   * Spread from whichever end the frame is nearer, so everything that CANNOT be
   * interpolated — the dash rhythm, the position — cuts once at the halfway
   * mark rather than crawling for the length of the transition. Two rhythms are
   * not two positions of one rhythm, and there is nothing between inside and
   * outside for a band to be.
   */
  return {
    ...(t < 0.5 ? from : to),
    colour: (blendPaint(from.colour, to.colour, t) ?? from.colour) as StrokePaint,
    width: from.width + (to.width - from.width) * t,
  }
}

/**
 * Two borders are the same border.
 *
 * Every field that changes the drawing, and POSITION is one of them — it was
 * left out while the mosaic had no position to choose, and the omission was
 * quietly load-bearing in two places at once: `setMosaicStroke` refused a
 * position change as "no change at all", and `sameGeometry` would have called
 * two states copies when one bordered inside and the other outside, so an edit
 * carrying forward would have overwritten an authored one.
 */
export function sameStroke(
  a: Stroke | PositionedStroke | null,
  b: Stroke | PositionedStroke | null,
  tolerance = 1e-9,
): boolean {
  if (a === null || b === null) return a === b
  if (!samePaint(a.colour, b.colour)) return false
  if (positionOf(a) !== positionOf(b)) return false
  if (Math.abs(a.width - b.width) > tolerance) return false
  if ((a.dash === null) !== (b.dash === null)) return false
  if (a.dash && b.dash) {
    if (Math.abs(a.dash.length - b.dash.length) > tolerance) return false
    if (Math.abs(a.dash.gap - b.dash.gap) > tolerance) return false
  }
  return true
}

/** What Add gives you: a visible edge you can then adjust, not an invisible one. */
export const DEFAULT_STROKE: PositionedStroke = {
  colour: '#101014ff',
  width: 2,
  position: 'centre',
  dash: null,
}

/**
 * The same for a mosaic, which starts INSIDE.
 *
 * Its silhouette is the shape it is, and a border that grew the object on being
 * added would move it under the pointer. Inside is the answer that changes
 * nothing but the drawing.
 */
export const DEFAULT_OUTLINE: PositionedStroke = {
  colour: '#101014ff',
  width: 2,
  position: 'inside',
  dash: null,
}

/**
 * The band's own rounded rectangle, for a border that follows one.
 *
 * A position is a different RECTANGLE here, not a clipped stroke: inflating a
 * rounded rect by d and its radius by d is exactly the original curve offset
 * outward by d, so the three bands are plain arithmetic and the stroke stays a
 * simple centred one. Exact, and no clip to go wrong.
 */
export function strokeBand(
  box: Rect,
  radius: number,
  stroke: Stroke | PositionedStroke,
): { box: Rect; radius: number } {
  const half = stroke.width / 2
  const shift = positionOf(stroke) === 'inside' ? -half : positionOf(stroke) === 'outside' ? half : 0
  return {
    box: {
      x: box.x - shift,
      y: box.y - shift,
      width: Math.max(0, box.width + shift * 2),
      height: Math.max(0, box.height + shift * 2),
    },
    radius: Math.max(0, radius + shift),
  }
}
