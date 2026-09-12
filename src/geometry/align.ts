import type { Rect, Vec2 } from '../types/document'

/**
 * Lining things up: what each of a set of boxes has to move by.
 *
 * Aligning is relative to the boxes themselves — the leftmost edge, the
 * centre of the lot, the lowest bottom — as it is in Figma when more than one
 * thing is selected. Distributing keeps the outermost two where they are and
 * spaces the rest so that every gap between neighbours is the same.
 *
 * Pure: boxes in, offsets out, one per box in the same order. Whose boxes
 * they are — objects on the artboard, members of a frame — is the caller's
 * business, as is writing the offsets back.
 */
export type Alignment =
  | 'left'
  | 'centre'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  | 'distributeHorizontal'
  | 'distributeVertical'

/** The smallest box round all of them. */
export function hullOf(boxes: readonly Rect[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function alignmentShifts(boxes: readonly Rect[], how: Alignment): Vec2[] {
  if (boxes.length === 0) return []
  if (how === 'distributeHorizontal' || how === 'distributeVertical') {
    return distributionShifts(boxes, how === 'distributeHorizontal' ? 'x' : 'y')
  }
  const hull = hullOf(boxes)
  return boxes.map((b) => {
    switch (how) {
      case 'left':
        return { x: hull.x - b.x, y: 0 }
      case 'centre':
        return { x: hull.x + hull.width / 2 - (b.x + b.width / 2), y: 0 }
      case 'right':
        return { x: hull.x + hull.width - (b.x + b.width), y: 0 }
      case 'top':
        return { x: 0, y: hull.y - b.y }
      case 'middle':
        return { x: 0, y: hull.y + hull.height / 2 - (b.y + b.height / 2) }
      case 'bottom':
        return { x: 0, y: hull.y + hull.height - (b.y + b.height) }
    }
  })
}

/**
 * Equal gaps along one axis. Sorted by where each box starts; the first and
 * the last stay put and the rest are laid between them. Fewer than three
 * boxes have nothing between them to space, so nothing moves.
 */
function distributionShifts(boxes: readonly Rect[], axis: 'x' | 'y'): Vec2[] {
  const still = boxes.map(() => ({ x: 0, y: 0 }))
  if (boxes.length < 3) return still
  const size = axis === 'x' ? 'width' : 'height'
  const order = boxes.map((_, i) => i).sort((i, j) => boxes[i]![axis] - boxes[j]![axis])
  const first = boxes[order[0]!]!
  const last = boxes[order[order.length - 1]!]!
  const span = last[axis] + last[size] - first[axis]
  const filled = boxes.reduce((sum, b) => sum + b[size], 0)
  const gap = (span - filled) / (boxes.length - 1)
  let cursor = first[axis] + first[size] + gap
  for (const i of order.slice(1, -1)) {
    const b = boxes[i]!
    still[i]![axis] = cursor - b[axis]
    cursor += b[size] + gap
  }
  return still
}
