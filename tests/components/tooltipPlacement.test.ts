import { describe, expect, it } from 'vitest'

import { placeTip } from '../../src/components/tooltipPlacement'

/**
 * A tip is never cut off: flipped to the other side when its own has no
 * room, slid along the edge when it would run past it.
 */

const viewport = { width: 1000, height: 600 }
const tip = { width: 120, height: 28 }

describe('placing a tooltip', () => {
  it('sits centred below its control when there is room', () => {
    const placed = placeTip({ left: 400, top: 100, width: 40, height: 32 }, tip, 'bottom', viewport)
    expect(placed).toEqual({ side: 'bottom', left: 360, top: 140 })
  })

  it('slides in from the left and right edges rather than running off', () => {
    const left = placeTip({ left: 4, top: 100, width: 32, height: 32 }, tip, 'bottom', viewport)
    expect(left.left).toBe(6)
    const right = placeTip({ left: 970, top: 100, width: 24, height: 32 }, tip, 'bottom', viewport)
    expect(right.left + tip.width).toBe(viewport.width - 6)
  })

  it('flips above when there is no room below, and below when there is none above', () => {
    const low = placeTip({ left: 400, top: 560, width: 40, height: 32 }, tip, 'bottom', viewport)
    expect(low.side).toBe('top')
    expect(low.top + tip.height).toBe(560 - 8)
    const high = placeTip({ left: 400, top: 2, width: 40, height: 32 }, tip, 'top', viewport)
    expect(high.side).toBe('bottom')
    expect(high.top).toBe(2 + 32 + 8)
  })

  it('flips a side tip to the other side at the right edge, and keeps it on screen vertically', () => {
    const placed = placeTip({ left: 950, top: 590, width: 40, height: 32 }, tip, 'right', viewport)
    expect(placed.side).toBe('left')
    expect(placed.left + tip.width).toBe(950 - 8)
    expect(placed.top + tip.height).toBeLessThanOrEqual(viewport.height - 6)
  })

  it('stays inside even when neither side fits', () => {
    const tiny = { width: 200, height: 100 }
    const placed = placeTip({ left: 90, top: 40, width: 20, height: 20 }, tip, 'bottom', tiny)
    expect(placed.left).toBeGreaterThanOrEqual(6)
    expect(placed.top).toBeGreaterThanOrEqual(6)
    expect(placed.left + tip.width).toBeLessThanOrEqual(tiny.width - 6)
    expect(placed.top + tip.height).toBeLessThanOrEqual(tiny.height - 6)
  })
})
