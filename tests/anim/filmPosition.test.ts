import { describe, expect, it } from 'vitest'

import { authoredDuration, filmPosition } from '../../src/anim/timeline'

/**
 * The strip of state cards runs like film: the state on screen is the one
 * lit, and its bar fills through hold AND transition as one turn.
 */
const states = [
  { holdMs: 1000, transitionMs: 500 },
  { holdMs: 200, transitionMs: 300 },
  { holdMs: 0, transitionMs: 1000 },
]

describe('where the film is', () => {
  it('lights the first state through its hold and its transition alike', () => {
    expect(filmPosition(states, 0)).toEqual({ index: 0, within: 0 })
    expect(filmPosition(states, 500)?.index).toBe(0)
    expect(filmPosition(states, 500)?.within).toBeCloseTo(500 / 1500, 6)
    // Into the transition out: still the first card, further along.
    expect(filmPosition(states, 1250)?.index).toBe(0)
    expect(filmPosition(states, 1250)?.within).toBeCloseTo(1250 / 1500, 6)
  })

  it('moves to the next card exactly when the transition lands', () => {
    expect(filmPosition(states, 1500)).toEqual({ index: 1, within: 0 })
    expect(filmPosition(states, 1750)?.index).toBe(1)
    expect(filmPosition(states, 1750)?.within).toBeCloseTo(0.5, 6)
    expect(filmPosition(states, 2000)?.index).toBe(2)
  })

  it('wraps with the loop, as the evaluators do', () => {
    const total = authoredDuration(states)
    expect(filmPosition(states, total)).toEqual(filmPosition(states, 0))
    expect(filmPosition(states, total + 500)).toEqual(filmPosition(states, 500))
    expect(filmPosition(states, -100)?.index, 'a step before zero is the last card').toBe(2)
  })

  it('has nowhere to be with no states', () => {
    expect(filmPosition([], 100)).toBeNull()
  })
})
