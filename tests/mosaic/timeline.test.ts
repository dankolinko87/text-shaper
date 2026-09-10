import { describe, expect, it } from 'vitest'

import { canReshape } from '../../src/mosaic/boundaries'
import { EASING_PRESETS, ease } from '../../src/anim/easing'
import { initialState, seedMosaic } from '../../src/mosaic/dissection'
import {
  authoredDuration,
  authoredTimeFor,
  evaluateMosaicAtTime,
  formatDuration,
  playbackDuration,
} from '../../src/mosaic/timeline'
import type { LetterMosaicObject, Rect } from '../../src/types/document'
import type { MosaicState } from '../../src/types/mosaic'

/**
 * The timeline, evaluated.
 *
 * The property everything else rests on: validity is a set of linear
 * inequalities between coordinates, so any blend of two legal states is legal.
 * That holds only while every coordinate moves by the SAME factor and that
 * factor stays inside [0,1] — which is what the easing presets guarantee and
 * what these tests check rather than assume.
 */

const BOX: Rect = { x: -180, y: -180, width: 360, height: 360 }

const base = seedMosaic(3, 3)

const stateFrom = (patch: Partial<MosaicState> = {}): MosaicState => ({
  ...initialState(base.x, base.y, { fontId: 'anton', weight: 400, italic: false }),
  ...patch,
})

const mosaicWith = (
  states: MosaicState[],
  patch: Partial<LetterMosaicObject> = {},
): LetterMosaicObject =>
  ({
    kind: 'mosaic',
    id: 'm1',
    name: 'Mosaic',
    localBounds: BOX,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    tiles: base.tiles,
    seed: { columns: 3, rows: 3 },
    font: { fontId: 'anton', weight: 400 },
    states,
    activeState: 0,
    gap: 6,
    outerPadding: 0,
    glyphInset: 6,
    snapStep: 10,
    loop: true,
    speed: 1,
    opacity: 1,
    visible: true,
    locked: false,
    ...patch,
  }) as LetterMosaicObject

/** The two interior lines on each axis, which is what a 3 × 3 has. */
const linesOf = (state: MosaicState) => Object.keys(state.x)

/** A state with its vertical lines pushed somewhere legal but different. */
const shifted = (from: MosaicState, by: number): MosaicState => {
  const x = { ...from.x }
  for (const key of Object.keys(x)) x[key] = (x[key] as number) + by
  return { ...from, x }
}

describe('the shape of the timeline', () => {
  it('holds then transitions, for every state', () => {
    const m = mosaicWith(
      [stateFrom({ holdMs: 100, transitionMs: 200 }), stateFrom({ holdMs: 50, transitionMs: 400 })],
      { loop: true },
    )
    // 100 + 200 + 50 + 400 — the last transition goes back to the first state
    // and is part of the length, which is what makes the loop close.
    expect(authoredDuration(m)).toBe(750)
  })

  it('counts the last transition whatever a stored `loop` says', () => {
    /*
     * `loop` is no longer read. A document written before it was retired can
     * still carry `loop: false`, and it now loops like everything else — which
     * is the intended change, and the reason this asserts the SAME length for
     * both values rather than deleting the case.
     */
    const states = [
      stateFrom({ holdMs: 100, transitionMs: 200 }),
      stateFrom({ holdMs: 50, transitionMs: 400 }),
    ]
    expect(authoredDuration(mosaicWith(states, { loop: false }))).toBe(750)
    expect(authoredDuration(mosaicWith(states, { loop: true }))).toBe(750)
  })

  it('keeps the final state’s authored transition, and uses it', () => {
    const states = [
      stateFrom({ holdMs: 0, transitionMs: 200 }),
      stateFrom({ holdMs: 0, transitionMs: 999 }),
    ]
    const m = mosaicWith(states, { loop: false })
    expect(m.states[1]?.transitionMs).toBe(999)
    expect(authoredDuration(m)).toBe(1199)
  })
})

describe('evaluating a moment', () => {
  const two = () => {
    const first = stateFrom({ holdMs: 100, transitionMs: 200, easing: 'linear' })
    const second = shifted(stateFrom({ holdMs: 100, transitionMs: 200, easing: 'linear' }), 0.1)
    return { first, second, m: mosaicWith([first, second], { loop: false }) }
  }

  it('is exactly the state itself throughout a hold', () => {
    const { first, m } = two()
    for (const t of [0, 1, 50, 99.9]) {
      const frame = evaluateMosaicAtTime(m, t)
      expect(frame.segment, `t=${t}`).toBe('hold')
      expect(frame.stateIndex).toBe(0)
      expect(frame.easedProgress, 'a held state is itself, not a blend').toBe(0)
      for (const key of linesOf(first)) {
        expect(frame.coordinateValues[key]).toBe(first.x[key])
      }
    }
  })

  it('is exactly the first state at the transition’s start', () => {
    const { first, m } = two()
    const frame = evaluateMosaicAtTime(m, 100)
    expect(frame.segment).toBe('transition')
    expect(frame.progress).toBe(0)
    for (const key of linesOf(first)) expect(frame.coordinateValues[key]).toBe(first.x[key])
  })

  it('is exactly halfway at the transition’s midpoint', () => {
    const { first, second, m } = two()
    const frame = evaluateMosaicAtTime(m, 200)
    expect(frame.progress).toBeCloseTo(0.5, 12)
    for (const key of linesOf(first)) {
      const expected = ((first.x[key] as number) + (second.x[key] as number)) / 2
      expect(frame.coordinateValues[key]).toBeCloseTo(expected, 12)
    }
  })

  it('is exactly the second state at the transition’s end', () => {
    const { second, m } = two()
    // The instant the transition completes is the second state's hold.
    const frame = evaluateMosaicAtTime(m, 300)
    expect(frame.stateIndex).toBe(1)
    expect(frame.segment).toBe('hold')
    for (const key of linesOf(second)) expect(frame.coordinateValues[key]).toBe(second.x[key])
  })

  it('wraps past the end rather than resting on the last state', () => {
    const { first, m } = two()
    const total = authoredDuration(m)
    // The end of the loop IS time zero, so the total and a multiple of it land
    // on the same picture the timeline started with.
    for (const t of [total, total * 2, total * 7]) {
      const frame = evaluateMosaicAtTime(m, t)
      expect(frame.stateIndex, `t=${t}`).toBe(0)
      expect(frame.segment).toBe('hold')
      for (const key of linesOf(first)) expect(frame.coordinateValues[key]).toBe(first.x[key])
    }
    // And a moment inside a later lap is the same as that moment in the first.
    expect(evaluateMosaicAtTime(m, total + 50).coordinateValues).toEqual(
      evaluateMosaicAtTime(m, 50).coordinateValues,
    )
  })

  it('steps straight over a hold of zero', () => {
    const first = stateFrom({ holdMs: 0, transitionMs: 200, easing: 'linear' })
    const second = shifted(stateFrom({ holdMs: 0, transitionMs: 200 }), 0.1)
    const m = mosaicWith([first, second], { loop: false })
    const frame = evaluateMosaicAtTime(m, 0)
    expect(frame.segment, 'nothing to hold, so it is already moving').toBe('transition')
    expect(frame.progress).toBe(0)
  })
})

describe('looping', () => {
  it('makes the end of the loop and time zero the same picture', () => {
    const first = stateFrom({ holdMs: 40, transitionMs: 160 })
    const second = shifted(stateFrom({ holdMs: 40, transitionMs: 160 }), 0.12)
    const m = mosaicWith([first, second], { loop: true })
    const total = authoredDuration(m)

    const start = evaluateMosaicAtTime(m, 0)
    const end = evaluateMosaicAtTime(m, total)
    expect(Object.keys(end.coordinateValues).length).toBeGreaterThan(0)
    for (const [key, value] of Object.entries(start.coordinateValues)) {
      expect(end.coordinateValues[key], `${key} closes the loop`).toBeCloseTo(value, 12)
    }
  })

  it('carries the final state back to the first', () => {
    const first = stateFrom({ holdMs: 0, transitionMs: 100, easing: 'linear' })
    const second = shifted(stateFrom({ holdMs: 0, transitionMs: 100, easing: 'linear' }), 0.1)
    const m = mosaicWith([first, second], { loop: true })

    // 0..100 is 0→1; 100..200 is 1→0.
    const back = evaluateMosaicAtTime(m, 150)
    expect(back.stateIndex).toBe(1)
    expect(back.nextStateIndex).toBe(0)
    for (const key of linesOf(first)) {
      const expected = ((second.x[key] as number) + (first.x[key] as number)) / 2
      expect(back.coordinateValues[key]).toBeCloseTo(expected, 12)
    }
  })

  it('keeps repeating rather than running out', () => {
    const m = mosaicWith(
      [stateFrom({ holdMs: 0, transitionMs: 100 }), shifted(stateFrom({ holdMs: 0, transitionMs: 100 }), 0.1)],
      { loop: true },
    )
    const once = evaluateMosaicAtTime(m, 50)
    const later = evaluateMosaicAtTime(m, 50 + 200 * 7)
    for (const [key, value] of Object.entries(once.coordinateValues)) {
      expect(later.coordinateValues[key]).toBeCloseTo(value, 12)
    }
  })
})

describe('what the evaluator refuses to do', () => {
  it('does not touch the document', () => {
    const first = stateFrom({ holdMs: 10, transitionMs: 100 })
    const second = shifted(stateFrom({ holdMs: 10, transitionMs: 100 }), 0.1)
    const m = mosaicWith([first, second])
    const before = JSON.stringify(m)
    for (const t of [0, 5, 55, 110, 160, 1000]) evaluateMosaicAtTime(m, t)
    expect(JSON.stringify(m), 'a preview is a reading, not a write').toBe(before)
  })

  it('does not apply playback speed — that is the clock’s job', () => {
    const m = mosaicWith(
      [stateFrom({ holdMs: 0, transitionMs: 200, easing: 'linear' }), shifted(stateFrom({ holdMs: 0, transitionMs: 200 }), 0.1)],
      { speed: 4 },
    )
    const slow = evaluateMosaicAtTime(m, 100)
    const fast = evaluateMosaicAtTime(mosaicWith(m.states, { speed: 1 }), 100)
    expect(fast.progress, 'the same authored time is the same frame').toBe(slow.progress)

    // Speed lives in the conversion from wall time, and in the watching length.
    expect(authoredTimeFor(m, 100)).toBe(400)
    expect(playbackDuration(m)).toBe(authoredDuration(m) / 4)
  })
})

describe('one factor for the whole layout', () => {
  it('moves every coordinate by the same fraction of its own journey', () => {
    const first = stateFrom({ holdMs: 0, transitionMs: 100, easing: 'ease-in-out' })
    const second: MosaicState = { ...first, x: { ...first.x }, y: { ...first.y } }
    // Each line travels a DIFFERENT distance, so a shared factor is visible.
    const keys = Object.keys(second.x)
    keys.forEach((key, at) => {
      second.x[key] = (second.x[key] as number) + 0.02 * (at + 1)
    })
    const m = mosaicWith([first, second], { loop: false })

    const frame = evaluateMosaicAtTime(m, 37)
    const factors = keys.map((key) => {
      const from = first.x[key] as number
      const to = second.x[key] as number
      return ((frame.coordinateValues[key] as number) - from) / (to - from)
    })
    for (const factor of factors) {
      expect(factor, 'every line is at the same point in the transition').toBeCloseTo(
        factors[0] as number,
        12,
      )
    }
    expect(factors[0]).toBeCloseTo(frame.easedProgress, 12)
  })

  /*
   * The invariant the whole design rests on. Validity is a set of linear
   * inequalities between coordinates, so a blend of two legal states is legal —
   * but only for a genuine convex combination, which is why no preset is allowed
   * to overshoot.
   */
  it('gives a valid frame at every moment when both ends are valid', () => {
    const seed = stateFrom({ holdMs: 0, transitionMs: 1000 })
    const first: MosaicState = { ...seed, x: { ...seed.x }, y: { ...seed.y } }
    const second: MosaicState = { ...seed, x: { ...seed.x }, y: { ...seed.y } }
    const xs = Object.keys(second.x)
    const ys = Object.keys(second.y)
    /*
     * Both ends pressed right up against the limit, and in OPPOSITE directions.
     * With gap 6 and inset 6 on a 360 box a column cannot go below 0.05, so
     * these two are legal by a hair — and any factor straying outside [0,1]
     * pushes a column through the floor immediately. Endpoints with slack would
     * let an overshooting curve pass this test, which is worth nothing.
     */
    first.x[xs[0] as string] = 0.05
    first.x[xs[1] as string] = 0.1
    first.y[ys[0] as string] = 0.05
    first.y[ys[1] as string] = 0.1
    second.x[xs[0] as string] = 0.9
    second.x[xs[1] as string] = 0.95
    second.y[ys[0] as string] = 0.9
    second.y[ys[1] as string] = 0.95

    const spacing = { gap: 6, outerPadding: 0, glyphInset: 6 }
    expect(canReshape(base.tiles, first.x, first.y, BOX, spacing), 'first end valid').toBe(true)
    expect(canReshape(base.tiles, second.x, second.y, BOX, spacing), 'second end valid').toBe(true)

    for (const easing of EASING_PRESETS) {
      const m = mosaicWith([{ ...first, easing }, second], { loop: false })
      for (let step = 0; step <= 60; step++) {
        const frame = evaluateMosaicAtTime(m, (step / 60) * 1000)
        const x: Record<string, number> = {}
        const y: Record<string, number> = {}
        for (const key of xs) x[key] = frame.coordinateValues[key] as number
        for (const key of ys) y[key] = frame.coordinateValues[key] as number
        expect(
          canReshape(base.tiles, x, y, BOX, spacing),
          `${easing} at ${step}/60 stays legal`,
        ).toBe(true)
      }
    }
  })
})

describe('the easing presets', () => {
  it('start at nothing and end at everything', () => {
    for (const preset of EASING_PRESETS) {
      expect(ease(preset, 0), `${preset} at 0`).toBe(0)
      expect(ease(preset, 1), `${preset} at 1`).toBe(1)
    }
  })

  it('never leave the range in between, and never go backwards', () => {
    for (const preset of EASING_PRESETS) {
      let previous = 0
      for (let step = 0; step <= 200; step++) {
        const value = ease(preset, step / 200)
        expect(value, `${preset} stays in range`).toBeGreaterThanOrEqual(0)
        expect(value, `${preset} stays in range`).toBeLessThanOrEqual(1)
        expect(value, `${preset} never goes backwards`).toBeGreaterThanOrEqual(previous - 1e-12)
        previous = value
      }
    }
  })

  it('clamps a progress that arrives outside the transition', () => {
    for (const preset of EASING_PRESETS) {
      expect(ease(preset, -0.5)).toBe(0)
      expect(ease(preset, 1.5)).toBe(1)
      expect(ease(preset, Number.NaN)).toBe(0)
    }
  })
})

describe('saying a duration out loud', () => {
  it('uses milliseconds below a second and seconds above', () => {
    expect(formatDuration(200)).toBe('200 ms')
    expect(formatDuration(600)).toBe('600 ms')
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(1200)).toBe('1.2 s')
    expect(formatDuration(12_000)).toBe('12 s')
  })

  it('never says a fraction of a millisecond for a whole one', () => {
    // The mistake this exists to prevent: 200 milliseconds shown as "0.200 ms".
    expect(formatDuration(200)).not.toContain('0.2')
    expect(formatDuration(0)).toBe('0 ms')
  })
})

describe('spacing and font across a transition', () => {
  const spaced = (patch: Partial<MosaicState>): MosaicState => stateFrom(patch)

  it('interpolates gap, padding and inset', () => {
    const a = spaced({ holdMs: 0, transitionMs: 100, easing: 'linear', gap: 4, outerPadding: 0, glyphInset: 2 })
    const b = spaced({ gap: 20, outerPadding: 30, glyphInset: 10 })
    const m = mosaicWith([a, b], { loop: false })

    const half = evaluateMosaicAtTime(m, 50)
    expect(half.spacing.gap).toBeCloseTo(12, 9)
    expect(half.spacing.outerPadding).toBeCloseTo(15, 9)
    expect(half.spacing.glyphInset).toBeCloseTo(6, 9)

    // And the ends are exactly what was authored.
    expect(evaluateMosaicAtTime(m, 0).spacing).toEqual({ gap: 4, outerPadding: 0, glyphInset: 2 })
    expect(evaluateMosaicAtTime(m, 100).spacing).toEqual({ gap: 20, outerPadding: 30, glyphInset: 10 })
  })

  /*
   * A font cannot be blended — two typefaces' outlines are different shapes, not
   * two positions of one shape — so it cuts, and the cut lands on ARRIVAL. The
   * state being left keeps its font for the whole transition; the new one
   * appears the instant the movement finishes.
   */
  it('keeps the old font for the whole transition and cuts on arrival', () => {
    const a = spaced({ holdMs: 0, transitionMs: 100, font: { fontId: 'anton', weight: 400, italic: false } })
    const b = spaced({ holdMs: 40, font: { fontId: 'pirata-one', weight: 400, italic: false } })
    const m = mosaicWith([a, b], { loop: false })

    for (const t of [0, 25, 50, 99.9]) {
      expect(evaluateMosaicAtTime(m, t).font.fontId, `t=${t} still the old face`).toBe('anton')
    }
    expect(evaluateMosaicAtTime(m, 100).font.fontId, 'arrived').toBe('pirata-one')
  })

  /*
   * The reason coordinates are blended in ABSOLUTE units rather than as
   * fractions. A tile's width is a coordinate difference times the content box,
   * so blending fractions while the padding moves makes it a product of two
   * changing numbers — quadratic in time, and free to dip below the minimum in
   * the middle even though both ends are legal.
   */
  it('stays legal at every moment while the padding moves too', () => {
    const seed = stateFrom({ holdMs: 0, transitionMs: 1000, easing: 'linear' })
    const first: MosaicState = { ...seed, x: { ...seed.x }, y: { ...seed.y }, outerPadding: 0 }
    const second: MosaicState = { ...seed, x: { ...seed.x }, y: { ...seed.y }, outerPadding: 96 }
    const xs = Object.keys(first.x)
    const ys = Object.keys(first.y)
    // Both ends pressed hard against the limit, and in opposite directions.
    first.x[xs[0] as string] = 0.06
    first.x[xs[1] as string] = 0.12
    second.x[xs[0] as string] = 0.75
    second.x[xs[1] as string] = 0.875
    first.y[ys[0] as string] = 0.06
    first.y[ys[1] as string] = 0.12
    second.y[ys[0] as string] = 0.75
    second.y[ys[1] as string] = 0.875

    const m = mosaicWith([first, second], { loop: false })
    const legal = (state: MosaicState) =>
      canReshape(base.tiles, state.x, state.y, BOX, {
        gap: state.gap,
        outerPadding: state.outerPadding,
        glyphInset: state.glyphInset,
      })
    expect(legal(first), 'first end valid').toBe(true)
    expect(legal(second), 'second end valid').toBe(true)

    for (let step = 0; step <= 80; step++) {
      const frame = evaluateMosaicAtTime(m, (step / 80) * 1000)
      const x: Record<string, number> = {}
      const y: Record<string, number> = {}
      for (const key of xs) x[key] = frame.coordinateValues[key] as number
      for (const key of ys) y[key] = frame.coordinateValues[key] as number
      expect(canReshape(base.tiles, x, y, BOX, frame.spacing), `frame ${step}/80 stays legal`).toBe(
        true,
      )
    }
  })

  /*
   * What the absolute blend actually buys, stated directly.
   *
   * A tile's width in units stays LINEAR in time even while the padding moves.
   * That is the whole guarantee: the slack against the minimum is then a linear
   * function minus a convex one, which is concave, and a concave function's
   * minimum over an interval is at one of its ends — so two legal endpoints
   * cannot enclose an illegal middle.
   *
   * Blending fractions instead makes the width a PRODUCT of two moving numbers.
   * In practice that is nearly always fine — searching 400,000 random pairs on a
   * real 3 × 3 found no illegal frame, because every other tile is constrained
   * too — so this is not a bug being fixed. It is an empirical "we could not
   * break it" being replaced by something provable, at no cost: with the padding
   * held still the two are identical arithmetic.
   */
  it('keeps a tile’s width linear in time while the padding moves', () => {
    const seed = stateFrom({ holdMs: 0, transitionMs: 1000, easing: 'linear' })
    const xs = Object.keys(seed.x)
    const first: MosaicState = { ...seed, x: { ...seed.x }, outerPadding: 0 }
    const second: MosaicState = { ...seed, x: { ...seed.x }, outerPadding: 120 }
    first.x[xs[0] as string] = 0.2
    first.x[xs[1] as string] = 0.45
    second.x[xs[0] as string] = 0.1
    second.x[xs[1] as string] = 0.8
    const m = mosaicWith([first, second], { loop: false })

    const widthAt = (t: number): number => {
      const frame = evaluateMosaicAtTime(m, t * 1000)
      const size = BOX.width - 2 * frame.spacing.outerPadding
      const left = frame.coordinateValues[xs[0] as string] as number
      const right = frame.coordinateValues[xs[1] as string] as number
      return (right - left) * size
    }

    const a = widthAt(0)
    const b = widthAt(1)
    for (let step = 0; step <= 40; step++) {
      const t = step / 40
      // Linear means every sample sits exactly on the line between the ends.
      expect(widthAt(t), `width at ${t} is on the line`).toBeCloseTo(a + (b - a) * t, 6)
    }
  })

  it('is unchanged by the absolute blend when the padding holds still', () => {
    // The two are the same arithmetic then, so nothing is paid for the safety.
    const a = stateFrom({ holdMs: 0, transitionMs: 100, easing: 'linear', outerPadding: 12 })
    const b: MosaicState = { ...a, x: { ...a.x }, outerPadding: 12 }
    for (const key of Object.keys(b.x)) b.x[key] = (b.x[key] as number) + 0.17
    const m = mosaicWith([a, b], { loop: false })

    const frame = evaluateMosaicAtTime(m, 50)
    for (const key of Object.keys(a.x)) {
      const expected = ((a.x[key] as number) + (b.x[key] as number)) / 2
      expect(frame.coordinateValues[key]).toBeCloseTo(expected, 12)
    }
  })
})

describe('colour across a transition', () => {
  const RED = '#ff0000ff'
  const BLUE = '#0000ffff'

  const coloured = (
    patch: Partial<MosaicState>,
    glyph: Record<string, string> = {},
    tile: Record<string, string | null> = {},
  ): MosaicState => ({ ...stateFrom(patch), glyphColour: glyph, tileColour: tile })

  const leaf = () => base.tiles[0]!.id

  it('blends two concrete colours by the same factor as the geometry', () => {
    const id = leaf()
    const a = coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, { [id]: RED })
    const b = coloured({}, { [id]: BLUE })
    const m = mosaicWith([a, b], { loop: false })

    const half = evaluateMosaicAtTime(m, 50)
    expect(half.easedProgress).toBeCloseTo(0.5, 9)
    // Halfway between red and blue. A fully opaque colour is written without its
    // alpha, which is what `formatHex` has always done.
    expect(half.glyphColours[id]).toBe('#800080')
  })

  it('carries alpha through the blend', () => {
    const id = leaf()
    const a = coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, { [id]: '#ff000000' })
    const b = coloured({}, { [id]: '#ff0000ff' })
    const m = mosaicWith([a, b], { loop: false })
    expect(evaluateMosaicAtTime(m, 50).glyphColours[id]).toBe('#ff000080')
  })

  it('gives back exactly what was authored at either end', () => {
    const id = leaf()
    const a = coloured({ holdMs: 10, transitionMs: 100 }, { [id]: RED }, { [id]: BLUE })
    const b = coloured({ holdMs: 10 }, { [id]: BLUE }, { [id]: null })
    const m = mosaicWith([a, b], { loop: false })

    expect(evaluateMosaicAtTime(m, 0).glyphColours[id]).toBe(RED)
    expect(evaluateMosaicAtTime(m, 0).tileColours[id]).toBe(BLUE)
    const arrived = evaluateMosaicAtTime(m, 110)
    expect(arrived.glyphColours[id]).toBe(BLUE)
    expect(arrived.tileColours[id], 'null comes back as null, not as a colour').toBeNull()
  })

  /*
   * The care here is entirely in what `null` means. A tile with no background is
   * not a transparent BLACK one — blend towards black and a fade picks up a dark
   * edge on its way out, which is visible, wrong, and hard to name once you are
   * looking at it.
   */
  it('stays nothing when neither state has a background', () => {
    const id = leaf()
    const m = mosaicWith(
      [coloured({ holdMs: 0, transitionMs: 100 }, {}, { [id]: null }), coloured({}, {}, { [id]: null })],
      { loop: false },
    )
    expect(evaluateMosaicAtTime(m, 50).tileColours[id]).toBeNull()
  })

  it('fades a background in from a transparent version of ITS OWN colour', () => {
    const id = leaf()
    const m = mosaicWith(
      [
        coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, {}, { [id]: null }),
        coloured({}, {}, { [id]: RED }),
      ],
      { loop: false },
    )
    const half = evaluateMosaicAtTime(m, 50).tileColours[id] as string
    // Red all the way through — only the alpha moves. Never a muddy dark edge.
    expect(half.slice(0, 7)).toBe('#ff0000')
    expect(half).toBe('#ff000080')
  })

  it('fades a background out through a transparent version of the colour it was', () => {
    const id = leaf()
    const m = mosaicWith(
      [
        coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, {}, { [id]: BLUE }),
        coloured({}, {}, { [id]: null }),
      ],
      { loop: false },
    )
    const half = evaluateMosaicAtTime(m, 50).tileColours[id] as string
    expect(half.slice(0, 7)).toBe('#0000ff')
    expect(half).toBe('#0000ff80')
  })

  it('reaches its target on the same frame the geometry does', () => {
    const id = leaf()
    const a = coloured({ holdMs: 0, transitionMs: 100, easing: 'ease-in-out' }, { [id]: RED })
    const b: MosaicState = { ...coloured({}, { [id]: BLUE }), x: { ...a.x } }
    for (const key of Object.keys(b.x)) b.x[key] = (b.x[key] as number) + 0.1
    const m = mosaicWith([a, b], { loop: false })

    // One frame short of the end, neither has arrived; at the end, both have.
    const nearly = evaluateMosaicAtTime(m, 99)
    expect(nearly.glyphColours[id]).not.toBe(BLUE)
    const done = evaluateMosaicAtTime(m, 100)
    expect(done.glyphColours[id]).toBe(BLUE)
    for (const key of Object.keys(b.x)) {
      expect(done.coordinateValues[key]).toBeCloseTo(b.x[key] as number, 12)
    }
  })

  it(`carries the last state’s colours back to the first when it loops`, () => {
    const id = leaf()
    const m = mosaicWith(
      [
        coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, { [id]: RED }),
        coloured({ holdMs: 0, transitionMs: 100, easing: 'linear' }, { [id]: BLUE }),
      ],
      { loop: true },
    )
    // 0..100 red to blue; 100..200 blue back to red.
    expect(evaluateMosaicAtTime(m, 150).glyphColours[id]).toBe('#800080')
    expect(evaluateMosaicAtTime(m, 200).glyphColours[id], 'the loop closes').toBe(RED)
  })

  it('carries colours round the loop as well, past the end', () => {
    const id = leaf()
    const m = mosaicWith(
      [
        coloured({ holdMs: 0, transitionMs: 100 }, { [id]: RED }, { [id]: RED }),
        coloured({ holdMs: 0, transitionMs: 100 }, { [id]: BLUE }, { [id]: null }),
      ],
      { loop: false },
    )
    const total = authoredDuration(m)
    // A whole number of laps later is the composition it started on.
    expect(evaluateMosaicAtTime(m, total * 3).glyphColours[id]).toBe(RED)
    // And the second state's own colours are still reached exactly, on arrival.
    const arrived = evaluateMosaicAtTime(m, 100)
    expect(arrived.glyphColours[id]).toBe(BLUE)
    expect(arrived.tileColours[id]).toBeNull()
  })

  it('gives a tile with no colour of its own the default', () => {
    const id = leaf()
    const m = mosaicWith([coloured({ holdMs: 10 }), coloured({})], { loop: false })
    // Absent rather than written out: the default is applied where it is read.
    expect(evaluateMosaicAtTime(m, 0).glyphColours[id]).toBeUndefined()
  })
})
