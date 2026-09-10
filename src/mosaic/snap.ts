/**
 * A discrete grid for the lines of a mosaic.
 *
 * Coordinates are exact already — they are fractions, and the layout is a pure
 * function of them — so snapping is not about knowing where a line is. It is
 * about two lines being able to land on the SAME number.
 *
 * That matters because forking is silent and one-way. Dragging one tile's edge
 * detaches the line it sits on so the rest of the column stays put, which mints
 * a second coordinate at the same value. Drag both halves afterwards and they
 * come to rest a third of a unit apart: level to the eye, unequal to the model,
 * and unable to move together ever again. Every drag adds another, so a mosaic
 * drifts out of alignment one gesture at a time.
 *
 * On a grid, two lines dragged to the same place hold the same value — which is
 * what lets `mergeCoordinates` put them back together. Snapping is the enabler;
 * rejoining is the point.
 *
 * The grid is anchored at the content box's own origin and measured in the
 * object's units, the same units as the gap and the padding, so it scales with
 * the object rather than with the viewport.
 */

/** Grid for a new mosaic, in object-local units. Zero means no snapping. */
export const MOSAIC_DEFAULT_SNAP = 10

/** Below this a step is treated as off, rather than as an absurd number of lines. */
const SMALLEST_STEP = 1e-6

/** Whether a step will actually do anything. */
export function snaps(step: number | undefined): step is number {
  return typeof step === 'number' && Number.isFinite(step) && step > SMALLEST_STEP
}

/**
 * The nearest grid position to `position`, both in object-local units measured
 * from the content box's origin.
 */
export function snapPosition(position: number, step: number): number {
  if (!snaps(step)) return position
  return Math.round(position / step) * step
}

/**
 * The nearest grid position that is still inside `[low, high]`.
 *
 * Walks inward a step at a time rather than clamping to the limit, because a
 * clamped value is off the grid by definition — and one line resting between
 * steps is exactly the drift this exists to prevent. Returns null when the
 * window is too narrow to hold any step at all, which leaves the caller to fall
 * back to the unsnapped value rather than refuse the drag.
 */
export function snapWithin(
  position: number,
  step: number,
  low: number,
  high: number,
): number | null {
  if (!snaps(step)) return position
  if (!(high >= low)) return null

  // A hair of slack: a limit computed in fractions and compared in units lands
  // a few ulps short of the step that is genuinely legal, and refusing that step
  // makes the last one before a limit unreachable.
  const slack = Math.abs(step) * 1e-9
  const first = Math.ceil((low - slack) / step)
  const last = Math.floor((high + slack) / step)
  if (first > last) return null

  const wanted = Math.round(position / step)
  return Math.min(last, Math.max(first, wanted)) * step
}
