/**
 * Where a tooltip goes so that all of it is on screen.
 *
 * A tip is asked for beside its control on a preferred side. Near an edge
 * that side has no room, so the tip is flipped to the opposite side when
 * that one has; and along the other axis it is slid until it clears the
 * edge, keeping a small margin. Pure numbers in, numbers out, so it can be
 * checked without a screen.
 */

export type TipSide = 'top' | 'right' | 'bottom' | 'left'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  side: TipSide
}

/** Between the control and its tip. */
const GAP = 8
/** The least the tip keeps from the edge of the screen. */
const MARGIN = 6

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  preferred: TipSide,
  viewport: { width: number; height: number },
): Placement {
  const centreX = anchor.left + anchor.width / 2
  const centreY = anchor.top + anchor.height / 2
  const below = anchor.top + anchor.height + GAP
  const above = anchor.top - GAP - tip.height
  const after = anchor.left + anchor.width + GAP
  const before = anchor.left - GAP - tip.width
  const fitsBelow = below + tip.height <= viewport.height - MARGIN
  const fitsAbove = above >= MARGIN
  const fitsAfter = after + tip.width <= viewport.width - MARGIN
  const fitsBefore = before >= MARGIN

  // The side: the one asked for, unless it runs off and the other does not.
  let side = preferred
  if (preferred === 'bottom' && !fitsBelow && fitsAbove) side = 'top'
  else if (preferred === 'top' && !fitsAbove && fitsBelow) side = 'bottom'
  else if (preferred === 'right' && !fitsAfter && fitsBefore) side = 'left'
  else if (preferred === 'left' && !fitsBefore && fitsAfter) side = 'right'

  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - tip.width)
  const maxTop = Math.max(MARGIN, viewport.height - MARGIN - tip.height)

  switch (side) {
    case 'bottom':
      return { side, left: clamp(centreX - tip.width / 2, MARGIN, maxLeft), top: clamp(below, MARGIN, maxTop) }
    case 'top':
      return { side, left: clamp(centreX - tip.width / 2, MARGIN, maxLeft), top: clamp(above, MARGIN, maxTop) }
    case 'right':
      return { side, left: clamp(after, MARGIN, maxLeft), top: clamp(centreY - tip.height / 2, MARGIN, maxTop) }
    case 'left':
      return { side, left: clamp(before, MARGIN, maxLeft), top: clamp(centreY - tip.height / 2, MARGIN, maxTop) }
  }
}
