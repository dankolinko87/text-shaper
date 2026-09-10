import { beforeEach, describe, expect, it } from 'vitest'

import { sameGeometry } from '../../src/mosaic/dissection'
import { evaluateMosaicAtTime } from '../../src/mosaic/timeline'
import { mosaicCorners } from '../../src/mosaic/tiles'
import { fittedRadius } from '../../src/editor/mosaicPlayback'
import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * Rounded corners: one radius for each tile, one for the whole outline.
 *
 * Both are paint-only — they never enter the layout — so unlike spacing they
 * carry no legality argument and can be blended on their own terms. What has to
 * hold is that they belong to a STATE, animate with everything else, and are cut
 * down to the shape they are drawn on rather than folding through it.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

function make(): LetterMosaicObject {
  const id = store().createMosaic({
    columns: 2,
    rows: 2,
    artboardCenter: { x: 0, y: 0 },
    text: 'ABCD',
  })
  store().commit('Draw mosaic')
  return mosaicIn(store().doc, id)
}

describe('fitting a radius to what it is drawn on', () => {
  it('leaves a radius that fits alone', () => {
    expect(fittedRadius(8, 100, 60)).toBe(8)
  })

  it('takes it down to half the shorter side, which is a full curve', () => {
    expect(fittedRadius(90, 100, 60)).toBe(30)
    expect(fittedRadius(90, 40, 200)).toBe(20)
  })

  it('treats nothing and nonsense as square', () => {
    expect(fittedRadius(0, 100, 100)).toBe(0)
    expect(fittedRadius(-5, 100, 100)).toBe(0)
    expect(fittedRadius(Number.NaN, 100, 100)).toBe(0)
  })

  it('is square on a rectangle with no size, rather than negative', () => {
    expect(fittedRadius(10, 0, 0)).toBe(0)
    expect(fittedRadius(10, -20, 50)).toBe(0)
  })
})

describe('corners on a state', () => {
  it('starts square, so nothing that already exists changes shape', () => {
    const object = make()
    expect(mosaicCorners(object, 0)).toEqual({ tileRadius: 0, outerRadius: 0 })
  })

  it('writes to the state being edited', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 12 }, 1)
    const after = mosaicIn(store().doc, object.id)

    expect(after.states[1]?.tileRadius).toBe(12)
  })

  it('carries forward through the states that are still copies', () => {
    const object = make()
    store().setMosaicCorners(object.id, { outerRadius: 20 }, 0)
    const after = mosaicIn(store().doc, object.id)

    expect(after.states.map((each) => each.outerRadius)).toEqual([20, 20, 20])
  })

  it('stops at a state that has been authored', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 30 }, 2)
    store().setMosaicCorners(object.id, { tileRadius: 6 }, 0)
    const after = mosaicIn(store().doc, object.id)

    expect(after.states.map((each) => each.tileRadius)).toEqual([6, 6, 30])
  })

  it('leaves a field it was not asked about alone', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 9, outerRadius: 4 }, 0)
    store().setMosaicCorners(object.id, { tileRadius: 2 }, 0)
    const after = mosaicIn(store().doc, object.id)

    expect(after.states[0]?.outerRadius).toBe(4)
  })

  it('refuses a negative radius, which is not a small one', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: -30 }, 0)
    expect(mosaicIn(store().doc, object.id).states[0]?.tileRadius).toBe(0)
  })

  it('keeps a radius larger than the tile, for when the tile grows', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 5000 }, 0)
    // Stored as asked; cut down only when it is drawn.
    expect(mosaicIn(store().doc, object.id).states[0]?.tileRadius).toBe(5000)
  })

  it('makes no change, and so no undo entry, when nothing moves', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 7 }, 0)
    store().commit('Round tiles')
    const before = store().doc

    store().setMosaicCorners(object.id, { tileRadius: 7 }, 0)

    expect(store().doc).toBe(before)
  })

  it('counts as a difference between two states', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 14 }, 1)
    const after = mosaicIn(store().doc, object.id)
    const [first, second] = after.states

    // Otherwise a state rounded differently would read as an untouched copy: the
    // next edit would overwrite it and deleting it would not think to ask.
    expect(sameGeometry(first!, second!)).toBe(false)
  })
})

describe('corners through a transition', () => {
  function rounded(): LetterMosaicObject {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 0, outerRadius: 0 }, 0)
    store().setMosaicCorners(object.id, { tileRadius: 40, outerRadius: 100 }, 1)
    store().setMosaicStateTiming(object.id, 0, { holdMs: 0, transitionMs: 1000 })
    return mosaicIn(store().doc, object.id)
  }

  it('is exactly what was authored at each end', () => {
    const object = rounded()
    expect(evaluateMosaicAtTime(object, 0).corners).toEqual({ tileRadius: 0, outerRadius: 0 })
    expect(evaluateMosaicAtTime(object, 1000).corners).toEqual({
      tileRadius: 40,
      outerRadius: 100,
    })
  })

  it('moves between them rather than cutting', () => {
    const object = rounded()
    const half = evaluateMosaicAtTime(object, 500).corners

    expect(half.tileRadius).toBeGreaterThan(0)
    expect(half.tileRadius).toBeLessThan(40)
    expect(half.outerRadius).toBeGreaterThan(0)
    expect(half.outerRadius).toBeLessThan(100)
  })

  it('never rounds further than either end asks for', () => {
    const object = rounded()
    for (let t = 0; t <= 1000; t += 50) {
      const { tileRadius, outerRadius } = evaluateMosaicAtTime(object, t).corners
      expect(tileRadius, `t=${t}`).toBeGreaterThanOrEqual(0)
      expect(tileRadius, `t=${t}`).toBeLessThanOrEqual(40)
      expect(outerRadius, `t=${t}`).toBeLessThanOrEqual(100)
    }
  })

  it('holds its own radius while a state is resting', () => {
    const object = make()
    store().setMosaicCorners(object.id, { tileRadius: 25 }, 0)
    store().setMosaicStateTiming(object.id, 0, { holdMs: 400, transitionMs: 1000 })
    const after = mosaicIn(store().doc, object.id)

    expect(evaluateMosaicAtTime(after, 200).corners.tileRadius).toBe(25)
  })
})
