import { describe, expect, it } from 'vitest'

import { alignmentShifts, hullOf } from '../../src/geometry/align'
import type { Rect } from '../../src/types/document'

/**
 * Lining boxes up is relative to the boxes themselves: the outermost edge,
 * the centre of the lot. Distributing keeps the two outer boxes still and
 * spaces the rest evenly between them.
 */
const boxes: Rect[] = [
  { x: 0, y: 0, width: 10, height: 10 },
  { x: 40, y: 20, width: 20, height: 40 },
  { x: 100, y: 5, width: 10, height: 30 },
]
const moved = (how: Parameters<typeof alignmentShifts>[1]): Rect[] =>
  alignmentShifts(boxes, how).map((d, i) => ({ ...boxes[i]!, x: boxes[i]!.x + d.x, y: boxes[i]!.y + d.y }))

describe('aligning boxes', () => {
  it('measures the hull round all of them', () => {
    expect(hullOf(boxes)).toEqual({ x: 0, y: 0, width: 110, height: 60 })
  })

  it('brings edges to the outermost edge, on one axis only', () => {
    expect(moved('left').map((b) => b.x)).toEqual([0, 0, 0])
    expect(moved('right').map((b) => b.x + b.width)).toEqual([110, 110, 110])
    expect(moved('top').map((b) => b.y)).toEqual([0, 0, 0])
    expect(moved('bottom').map((b) => b.y + b.height)).toEqual([60, 60, 60])
    expect(moved('left').map((b) => b.y), 'the other axis untouched').toEqual([0, 20, 5])
    expect(moved('top').map((b) => b.x)).toEqual([0, 40, 100])
  })

  it('brings centres to the centre of the lot', () => {
    expect(moved('centre').map((b) => b.x + b.width / 2)).toEqual([55, 55, 55])
    expect(moved('middle').map((b) => b.y + b.height / 2)).toEqual([30, 30, 30])
  })

  it('distributes with equal gaps, the outer two kept still', () => {
    const across = moved('distributeHorizontal')
    expect(across[0]!.x).toBe(0)
    expect(across[2]!.x).toBe(100)
    // Span 110, filled 40, two gaps of 35: the middle box starts at 10 + 35.
    expect(across[1]!.x).toBe(45)
    // Down the page the order is different: the tall box starts last (20),
    // so it is the one kept still, and the third box is spaced between —
    // here the boxes are taller than the span, so the "gap" is −10.
    const down = moved('distributeVertical')
    expect(down[0]!.y).toBe(0)
    expect(down[1]!.y).toBe(20)
    expect(down[2]!.y).toBe(10 - 10)
  })

  it('moves nothing when there is nothing between to space', () => {
    expect(alignmentShifts(boxes.slice(0, 2), 'distributeHorizontal')).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
    expect(alignmentShifts([], 'left')).toEqual([])
  })
})
