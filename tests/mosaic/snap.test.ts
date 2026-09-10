import { describe, expect, it } from 'vitest'

import { MOSAIC_DEFAULT_SNAP, snapPosition, snapWithin, snaps } from '../../src/mosaic/snap'

describe('whether a step does anything', () => {
  it('takes a positive, finite step', () => {
    expect(snaps(MOSAIC_DEFAULT_SNAP)).toBe(true)
    expect(snaps(0.5)).toBe(true)
  })

  it('treats zero, negatives and nonsense as off', () => {
    for (const step of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(snaps(step), `${String(step)} is not a grid`).toBe(false)
    }
  })

  it('leaves a position alone when there is no grid', () => {
    expect(snapPosition(37.4, 0)).toBe(37.4)
    expect(snapWithin(37.4, 0, -100, 100)).toBe(37.4)
  })
})

describe('landing on the grid', () => {
  it('goes to the nearest step, in both directions', () => {
    expect(snapPosition(23, 10)).toBe(20)
    expect(snapPosition(27, 10)).toBe(30)
    expect(snapPosition(-23, 10)).toBe(-20)
    expect(snapPosition(-27, 10)).toBe(-30)
  })

  it('leaves a position that is already on a step exactly where it is', () => {
    expect(snapPosition(120, 10)).toBe(120)
    expect(snapPosition(0, 10)).toBe(0)
  })
})

describe('staying inside the range', () => {
  it('takes the nearest step when the whole neighbourhood is legal', () => {
    expect(snapWithin(23, 10, -100, 100)).toBe(20)
  })

  /*
   * The point of walking inward rather than clamping: a clamped value sits
   * between steps by definition, and one line resting off the grid is the drift
   * this exists to prevent.
   */
  it('steps back inside rather than resting on the limit', () => {
    // 47 is out of bounds; clamping would give 44, which is not a step.
    expect(snapWithin(47, 10, 0, 44)).toBe(40)
    expect(snapWithin(-47, 10, -44, 0)).toBe(-40)
  })

  it('takes the last step before a limit when the limit is exactly on one', () => {
    expect(snapWithin(47, 10, 0, 40)).toBe(40)
  })

  it('allows a step sitting a hair outside the limit through', () => {
    // A range computed in fractions and compared in units lands a few ulps
    // short; refusing that step makes the last one before a limit unreachable.
    expect(snapWithin(40, 10, 0, 40 - 1e-13)).toBe(40)
  })

  it('gives up when the window holds no step at all', () => {
    // Nothing divisible by 10 between 41 and 49.
    expect(snapWithin(45, 10, 41, 49)).toBeNull()
  })

  it('gives up on an empty window', () => {
    expect(snapWithin(45, 10, 50, 40)).toBeNull()
  })

  it('finds the one step in a window that holds exactly one', () => {
    expect(snapWithin(45, 10, 38, 47)).toBe(40)
  })
})
