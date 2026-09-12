import type { Vec2 } from '../types/document'

/**
 * The resize cursor for a drag along a direction measured on SCREEN.
 *
 * An object can be turned, and a vertical edge in its own space is not
 * vertical on the artboard once it is — naming the axis by its local
 * direction alone would put an east-west cursor on a line running up the
 * screen. So callers pass the drag axis already mapped to the artboard.
 */
export function resizeCursorFor(axis: Vec2): string {
  // Folded into a half turn: a drag axis has an orientation, not a direction.
  const degrees = ((Math.atan2(axis.y, axis.x) * 180) / Math.PI + 180) % 180
  if (degrees < 22.5 || degrees >= 157.5) return 'ew-resize'
  if (degrees < 67.5) return 'nwse-resize'
  if (degrees < 112.5) return 'ns-resize'
  return 'nesw-resize'
}
