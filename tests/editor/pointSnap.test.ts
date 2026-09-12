import { describe, expect, it } from 'vitest'

import { constrainLock, snapPoint } from '../../src/editor/pointSnap'

/**
 * A point near the line another point sits on lands on that line, and says
 * which points it lined up with.
 */
describe('snapping a point to the others', () => {
  const targets = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 300, y: 250 },
  ]

  it('lines up on one axis and names every point on that line', () => {
    const snapped = snapPoint({ x: 150, y: 103 }, targets, 5)
    expect(snapped.point).toEqual({ x: 150, y: 100 })
    expect(snapped.guides).toHaveLength(1)
    expect(snapped.guides[0]!.axis).toBe('y')
    expect(snapped.guides[0]!.at).toBe(100)
    expect(snapped.guides[0]!.through).toEqual([targets[0], targets[1]])
  })

  it('lines up on both axes with two different points at once', () => {
    const snapped = snapPoint({ x: 297, y: 102 }, targets, 5)
    expect(snapped.point).toEqual({ x: 300, y: 100 })
    expect(snapped.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('lands on a point it is within reach of on both axes, whichever axis is nearer', () => {
    const snapped = snapPoint({ x: 203, y: 96 }, targets, 5)
    expect(snapped.point).toEqual({ x: 200, y: 100 })
    expect(snapped.guides).toHaveLength(2)
  })

  it('does nothing out of reach, with no targets, or with no reach', () => {
    expect(snapPoint({ x: 150, y: 110 }, targets, 5).point).toEqual({ x: 150, y: 110 })
    expect(snapPoint({ x: 150, y: 110 }, targets, 5).guides).toHaveLength(0)
    expect(snapPoint({ x: 101, y: 101 }, [], 5).point).toEqual({ x: 101, y: 101 })
    expect(snapPoint({ x: 101, y: 101 }, targets, 0).point).toEqual({ x: 101, y: 101 })
  })

  it('prefers the nearer of two lines within reach', () => {
    const snapped = snapPoint({ x: 150, y: 104 }, [...targets, { x: 0, y: 107 }], 5)
    expect(snapped.point.y, 'three away beats four away').toBe(107)
  })

  it('leaves a Shift-locked coordinate alone and snaps the other', () => {
    // Dragging along x: y is where Shift put it, x may still line up.
    const alongX = snapPoint({ x: 297, y: 104 }, targets, 5, 'x')
    expect(alongX.point).toEqual({ x: 300, y: 104 })
    const alongY = snapPoint({ x: 297, y: 104 }, targets, 5, 'y')
    expect(alongY.point).toEqual({ x: 297, y: 100 })
    const diagonal = snapPoint({ x: 297, y: 104 }, targets, 5, 'diagonal')
    expect(diagonal.point).toEqual({ x: 297, y: 104 })
    expect(diagonal.guides).toHaveLength(0)
  })

  it('returns its own copies, never the targets themselves', () => {
    const snapped = snapPoint({ x: 203, y: 96 }, targets, 5)
    expect(snapped.point).not.toBe(targets[1])
    snapped.point.x = 0
    expect(targets[1]!.x).toBe(200)
  })
})

describe('which way Shift held a drag', () => {
  const from = { x: 10, y: 10 }
  it('reads the axis off the constrained point', () => {
    expect(constrainLock(from, { x: 50, y: 10 })).toBe('x')
    expect(constrainLock(from, { x: 10, y: -30 })).toBe('y')
    expect(constrainLock(from, { x: 40, y: 40 })).toBe('diagonal')
    expect(constrainLock(from, { x: 10, y: 10 })).toBeNull()
  })
})
