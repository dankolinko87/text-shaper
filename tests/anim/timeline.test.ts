import { describe, expect, it } from 'vitest'

import {
  authoredDuration,
  authoredTimeFor,
  formatDuration,
  momentAt,
  playbackDuration,
  segmentsOf,
  type Timed,
} from '../../src/anim/timeline'

/**
 * The timeline, with nothing in it that knows what a state is.
 *
 * These are the rules the mosaic proved and a frame will inherit, tested here
 * against plain `{holdMs, transitionMs}` records so that nothing about a mosaic
 * can be smuggled in.
 */

const state = (holdMs: number, transitionMs: number): Timed => ({ holdMs, transitionMs })

describe('the shape of a timeline', () => {
  it('holds then transitions, for every state, the last one back to the first', () => {
    const segments = segmentsOf([state(100, 200), state(50, 400)])
    expect(segments.map((s) => [s.kind, s.from, s.to, s.durationMs])).toEqual([
      ['hold', 0, 1, 100],
      ['transition', 0, 1, 200],
      ['hold', 1, 0, 50],
      ['transition', 1, 0, 400],
    ])
    // 100 + 200 + 50 + 400 — the last transition is part of the length, which
    // is what makes the end of the loop and time zero the same picture.
    expect(authoredDuration([state(100, 200), state(50, 400)])).toBe(750)
  })

  it('has nothing to say about no states', () => {
    expect(segmentsOf([])).toEqual([])
    expect(authoredDuration([])).toBe(0)
    expect(momentAt([], 0)).toBeNull()
  })

  it('floors a transition at one frame, and a hold at nothing', () => {
    const segments = segmentsOf([state(-50, 0)])
    expect(segments[0]?.durationMs, 'a negative hold is no hold').toBe(0)
    expect(segments[1]?.durationMs, 'a cut is not a transition').toBe(16)
  })

  it('survives numbers that are not numbers', () => {
    const broken = [{ holdMs: NaN, transitionMs: Infinity }]
    expect(authoredDuration(broken)).toBe(16)
    expect(momentAt(broken, NaN)?.from).toBe(0)
  })
})

describe('speed is a rate, applied outside', () => {
  const states = [state(400, 200), state(400, 200)]

  it('divides how long it takes to watch, and never touches the authoring', () => {
    expect(authoredDuration(states)).toBe(1200)
    expect(playbackDuration(states, 2)).toBe(600)
    expect(playbackDuration(states, 0.5)).toBe(2400)
    expect(authoredDuration(states), 'unchanged by any of that').toBe(1200)
  })

  it('turns wall-clock time into authored time', () => {
    expect(authoredTimeFor(2, 300)).toBe(600)
    expect(authoredTimeFor(1, 300)).toBe(300)
  })

  it('refuses a rate that would stop or reverse time', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(playbackDuration(states, bad), `speed ${bad}`).toBe(1200)
      expect(authoredTimeFor(bad, 300)).toBe(300)
    }
  })
})

describe('where the timeline is at a moment', () => {
  const states = [state(100, 200), state(100, 200)]
  // 0..100 hold 0 | 100..300 transition 0→1 | 300..400 hold 1 | 400..600 → 0

  it('lands in the segment the time falls in', () => {
    expect(momentAt(states, 50)).toMatchObject({ kind: 'hold', from: 0, to: 1, progress: 0.5 })
    expect(momentAt(states, 200)).toMatchObject({ kind: 'transition', from: 0, to: 1 })
    expect(momentAt(states, 200)?.progress).toBeCloseTo(0.5, 9)
    expect(momentAt(states, 350)).toMatchObject({ kind: 'hold', from: 1, to: 0 })
    expect(momentAt(states, 500)).toMatchObject({ kind: 'transition', from: 1, to: 0 })
  })

  it('gives the instant a transition completes to the next state, not the last', () => {
    // Strictly-less, so arriving IS the next state's hold rather than the tail
    // of the journey to it.
    expect(momentAt(states, 300)).toMatchObject({ kind: 'hold', from: 1, progress: 0 })
  })

  it('wraps past the end rather than resting there', () => {
    const total = authoredDuration(states)
    for (const laps of [1, 2, 7]) {
      expect(momentAt(states, total * laps), `after ${laps} laps`).toMatchObject({
        kind: 'hold',
        from: 0,
        localTime: 0,
      })
    }
    expect(momentAt(states, total + 50)).toEqual(momentAt(states, 50))
  })

  it('wraps a negative time too, rather than clamping to the start', () => {
    const total = authoredDuration(states)
    expect(momentAt(states, -50)).toEqual(momentAt(states, total - 50))
  })

  it('steps over a hold of nothing rather than landing on it', () => {
    const continuous = [state(0, 200), state(0, 200)]
    expect(momentAt(continuous, 0), 'already moving at time zero').toMatchObject({
      kind: 'transition',
      from: 0,
      progress: 0,
    })
  })

  it('rests on the first state when every segment is zero-length', () => {
    // Not reachable through the UI — a transition has a floor — but a document
    // can arrive saying anything, and the answer must not be "nowhere".
    const nothing = [
      { holdMs: 0, transitionMs: 0 },
      { holdMs: 0, transitionMs: 0 },
    ]
    const segments = segmentsOf(nothing, 0)
    expect(segments.every((s) => s.durationMs === 0)).toBe(true)
    expect(momentAt(nothing, 123, 0)).toMatchObject({ kind: 'hold', from: 0, progress: 0 })
  })
})

describe('a duration as somebody would say it', () => {
  it('uses milliseconds below a second and seconds above', () => {
    expect(formatDuration(600)).toBe('600 ms')
    expect(formatDuration(1200)).toBe('1.2 s')
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(12_000)).toBe('12 s')
  })

  it('says nothing rather than a nonsense', () => {
    expect(formatDuration(NaN)).toBe('0 ms')
    expect(formatDuration(-5)).toBe('0 ms')
  })
})
