import { describe, expect, it } from 'vitest'

import {
  blendTransform,
  evaluateFrameAtTime,
  frameDuration,
  emptyState,
  sameArrangement,
  valuesFor,
} from '../../src/frame/frame'
import type { FrameObject, Transform2D } from '../../src/types/document'
import type { FrameMember, FrameState } from '../../src/types/frame'

/**
 * A frame's blending — the part that is NOT shared with the mosaic.
 *
 * The timeline underneath is tested in `tests/anim/timeline.test.ts`; what is
 * here is what a frame state MEANS, which is where the two genuinely differ.
 */

const at = (x: number, y: number, over: Partial<Transform2D> = {}): Transform2D => ({
  x,
  y,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
  ...over,
})

const member = (id: string, transform = at(0, 0)): FrameMember =>
  ({
    id,
    object: {
      kind: 'typography',
      id: `o_${id}`,
      name: id,
      transform,
      localBounds: { x: -50, y: -50, width: 100, height: 100 },
      visible: true,
      locked: false,
    },
  }) as unknown as FrameMember

const state = (values: FrameState['values'], over: Partial<FrameState> = {}): FrameState => ({
  id: `s_${Math.random()}`,
  values,
  holdMs: 0,
  transitionMs: 1000,
  easing: 'linear',
  ...over,
})

const frameOf = (members: FrameMember[], states: FrameState[]): FrameObject =>
  ({
    kind: 'frame',
    id: 'f1',
    name: 'Frame',
    localBounds: { x: -200, y: -200, width: 400, height: 400 },
    transform: at(0, 0),
    members,
    states,
    speed: 1,
    clip: false,
    opacity: 1,
    visible: true,
    locked: false,
  }) as FrameObject

describe('what a state says about a member', () => {
  it('falls back to the member’s own value for anything it does not mention', () => {
    /*
     * A state holds a PATCH, and this is what makes that worth doing: a new
     * animatable property needs no migration and no rewrite of the states
     * written before it existed.
     */
    const one = member('m1', at(30, 40))
    expect(valuesFor(one, state({})).transform).toEqual(at(30, 40))
    expect(valuesFor(one, state({ m1: { opacity: 0.5 } })).transform).toEqual(at(30, 40))
    expect(valuesFor(one, state({ m1: { opacity: 0.5 } })).opacity).toBe(0.5)
  })

  it('is fully present for a member the state has never heard of', () => {
    expect(valuesFor(member('ghost', at(7, 8)), undefined)).toMatchObject({
      transform: at(7, 8),
      opacity: 1,
    })
  })
})

describe('one transform on the way to another', () => {
  it('blends position and scale straight', () => {
    const half = blendTransform(at(0, 0), at(100, 50, { scaleX: 3 }), 0.5)
    expect([half.x, half.y, half.scaleX]).toEqual([50, 25, 2])
  })

  it('turns the short way round', () => {
    /*
     * 350° to 10° is twenty degrees, not three hundred and forty. Without this
     * a member set a hair either side of zero spins most of a turn to get
     * nowhere, which reads as a bug rather than a choice.
     */
    const quarter = blendTransform(at(0, 0, { rotation: 350 }), at(0, 0, { rotation: 10 }), 0.5)
    expect(quarter.rotation).toBe(360)

    const back = blendTransform(at(0, 0, { rotation: 10 }), at(0, 0, { rotation: 350 }), 0.5)
    expect(back.rotation).toBe(0)
  })

  it('cuts the flips rather than easing through a shape of no width', () => {
    const from = at(0, 0, { flipX: false })
    const to = at(0, 0, { flipX: true })
    expect(blendTransform(from, to, 0.4).flipX).toBe(false)
    expect(blendTransform(from, to, 0.6).flipX).toBe(true)
  })
})

describe('evaluating a frame', () => {
  const m = member('m1')
  const frame = frameOf(
    [m],
    [
      state({ m1: { transform: at(0, 0), opacity: 0 } }),
      state({ m1: { transform: at(200, 0), opacity: 1 } }),
    ],
  )

  it('rests on exactly what a state authored', () => {
    // Holds are zero here, so time 0 is already the first frame of the move.
    const start = evaluateFrameAtTime(frame, 0)
    expect(start.members['m1']?.transform.x).toBe(0)
    expect(start.members['m1']?.opacity).toBe(0)
  })

  it('carries a member across, and fades it in on the way', () => {
    const half = evaluateFrameAtTime(frame, 500)
    expect(half.segment).toBe('transition')
    expect(half.members['m1']?.transform.x).toBe(100)
    // Opacity 0 → 1 is how a member ARRIVES; there is no add-in-state-2.
    expect(half.members['m1']?.opacity).toBe(0.5)
  })

  it('wraps rather than resting at the end', () => {
    const total = frameDuration(frame)
    expect(evaluateFrameAtTime(frame, total).members['m1']?.transform.x).toBe(
      evaluateFrameAtTime(frame, 0).members['m1']?.transform.x,
    )
  })

  it('answers for a frame with no members at all', () => {
    const empty = frameOf([], [state({}), state({})])
    expect(evaluateFrameAtTime(empty, 100).members).toEqual({})
  })
})

describe('two states that say the same thing', () => {
  const m = member('m1', at(10, 10))

  it('give the frame nothing to play between them', () => {
    expect(sameArrangement(state({}), state({}), [m])).toBe(true)
    expect(
      sameArrangement(state({ m1: { transform: at(10, 10) } }), state({}), [m]),
      'a patch that matches the resting value is still the resting value',
    ).toBe(true)
  })

  it('are not, once one has been authored', () => {
    expect(sameArrangement(state({ m1: { transform: at(99, 10) } }), state({}), [m])).toBe(false)
    expect(sameArrangement(state({ m1: { opacity: 0 } }), state({}), [m])).toBe(false)
    expect(
      sameArrangement(state({ m1: { transform: at(10, 10, { flipX: true }) } }), state({}), [m]),
    ).toBe(false)
  })
})

describe('a new state', () => {
  it('says nothing, and every member answers with its own resting values', () => {
    /*
     * Born EMPTY. A state used to be written with each member's position and
     * opacity from the start, which resolved identically and made every state
     * look authored — so the document could not say which states a gesture had
     * touched. Now the patch's keys are exactly that answer.
     */
    const fresh = emptyState()
    expect(fresh.values).toEqual({})
    const a = member('a', at(1, 2))
    expect(valuesFor(a, fresh).transform).toEqual(at(1, 2))
    expect(valuesFor(a, fresh).opacity).toBe(1)
  })
})
