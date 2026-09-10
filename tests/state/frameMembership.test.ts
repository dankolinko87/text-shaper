import { beforeEach, describe, expect, it } from 'vitest'

import { valuesFor } from '../../src/frame/frame'
import { useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Moving an object into a frame and back out again.
 *
 * The two rules being pinned here are the ones the interaction rests on:
 * membership is STRUCTURAL, so a member joins every state at once; and nothing
 * jumps on the way in or out, because a container that moved your work as a
 * parting gesture would be unusable.
 */

const store = () => useDocumentStore.getState()

const frameAt = (x: number, y: number): string =>
  store().createFrame({
    box: { x: 0, y: 0, width: 200, height: 160 },
    artboardCenter: { x, y },
  })

const dotAt = (x: number, y: number, name = 'Dot'): string =>
  store().createObjectFromGeometry({
    open: false,
    pathData: 'M -25 0 A 25 25 0 1 0 25 0 A 25 25 0 1 0 -25 0 Z',
    localBounds: { x: -25, y: -25, width: 50, height: 50 },
    artboardCenter: { x, y },
    name,
  })

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

beforeEach(() => {
  const doc = store().doc
  useDocumentStore.setState({
    doc: { ...doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
})

describe('moving an object into a frame', () => {
  it('takes it off the artboard and gives it to the frame', () => {
    const frame = frameAt(0, 0)
    const dot = dotAt(40, 20)

    expect(store().addToFrame(frame, [dot])).toBe(true)

    expect(store().doc.objects[dot], 'no longer a top-level object').toBeUndefined()
    expect(store().doc.objectOrder).toEqual([frame])
    expect(frameIn(frame).members).toHaveLength(1)
  })

  it('joins EVERY state, at the same place', () => {
    /*
     * Membership is structural, exactly as a mosaic's tiles are: "a state with
     * its own tile set could not be interpolated with its neighbours." So there
     * is no add-in-state-2 — to make something arrive, fade it in.
     */
    const frame = frameAt(0, 0)
    const dot = dotAt(40, 20)
    store().addToFrame(frame, [dot])

    const object = frameIn(frame)
    const member = object.members[0]!
    expect(object.states.length).toBeGreaterThan(1)
    for (const state of object.states) {
      // Every state answers for it, at the place it joined — from the member's
      // own transform, because the state was told nothing and need not be.
      expect(valuesFor(member, state).transform).toMatchObject({ x: 40, y: 20 })
      expect(valuesFor(member, state).opacity).toBe(1)
      expect(state.values[member.id], 'and nothing looks authored').toBeUndefined()
    }
  })

  it('rebases the transform, so nothing moves on the way in', () => {
    // The frame is not at the origin, so a member that kept an artboard-space
    // transform would jump by the frame's own offset the moment it joined.
    const frame = frameAt(100, 50)
    const dot = dotAt(140, 70)
    store().addToFrame(frame, [dot])

    expect(frameIn(frame).members[0]?.object.transform).toMatchObject({ x: 40, y: 20 })
  })

  it('refuses to swallow another frame, so nesting cannot start', () => {
    const outer = frameAt(0, 0)
    const inner = frameAt(10, 10)
    expect(store().addToFrame(outer, [inner])).toBe(false)
    expect(store().doc.objects[inner], 'still its own object').toBeTruthy()
  })

  it('says so when there was nothing to move', () => {
    const frame = frameAt(0, 0)
    expect(store().addToFrame(frame, [])).toBe(false)
    expect(store().addToFrame(frame, ['no-such-object'])).toBe(false)
  })
})

describe('taking a member back out', () => {
  it('returns it to the artboard where the SHOWN state has it standing', () => {
    /*
     * Not where it rested when it joined. What is on screen is what the state
     * says, and an object that jumped on leaving would be the frame moving
     * somebody's work as a parting gesture.
     */
    const frame = frameAt(100, 50)
    const dot = dotAt(140, 70)
    store().addToFrame(frame, [dot])

    const member = frameIn(frame).members[0]!
    // State 1 keeps it at 40,20; state 2 is authored to put it elsewhere.
    const states = [...frameIn(frame).states]
    states[1] = {
      ...states[1]!,
      values: { ...states[1]!.values, [member.id]: { transform: { ...member.object.transform, x: -60, y: -30 }, opacity: 1 } },
    }
    useDocumentStore.setState({
      doc: {
        ...store().doc,
        objects: { ...store().doc.objects, [frame]: { ...frameIn(frame), states } },
      },
    })

    expect(store().removeFromFrame(frame, [member.id], 1)).toBe(true)

    const freed = store().selection[0] as string
    const object = store().doc.objects[freed]
    // Back into artboard space: the frame's own offset added to the state's.
    expect(object?.transform).toMatchObject({ x: 100 - 60, y: 50 - 30 })
  })

  it('forgets it in every state, not just the one on show', () => {
    const frame = frameAt(0, 0)
    const dot = dotAt(10, 10)
    store().addToFrame(frame, [dot])
    const member = frameIn(frame).members[0]!

    store().removeFromFrame(frame, [member.id], 0)

    const object = frameIn(frame)
    expect(object.members).toHaveLength(0)
    for (const state of object.states) {
      expect(state.values[member.id]).toBeUndefined()
    }
  })

  it('says so when the member is not in this frame', () => {
    const frame = frameAt(0, 0)
    expect(store().removeFromFrame(frame, ['ghost'], 0)).toBe(false)
  })
})

describe('a frame that has been copied', () => {
  it('gets fresh member ids, so the two do not read each other’s arrangements', () => {
    const frame = frameAt(0, 0)
    const dot = dotAt(10, 10)
    store().addToFrame(frame, [dot])
    store().commit('Setup')

    store().duplicateObjects([frame])
    const frames = store()
      .doc.objectOrder.map((id) => store().doc.objects[id])
      .filter((object): object is FrameObject => object?.kind === 'frame')

    expect(frames).toHaveLength(2)
    const [a, b] = frames as [FrameObject, FrameObject]
    expect(a.members[0]?.id).not.toBe(b.members[0]?.id)
    // And each state keys whatever it holds by ITS OWN member's id — never by
    // the other frame's.
    for (const copy of frames) {
      const own = copy.members[0]!
      expect(valuesFor(own, copy.states[0]).transform, 'its own state answers for it').toBeTruthy()
      const other = frames.find((each) => each !== copy)!.members[0]!.id
      for (const state of copy.states) expect(state.values[other]).toBeUndefined()
    }
  })
})

describe('what a member looks like when it leaves', () => {
  it('keeps the colour the SHOWN state gave it, not the colour it joined with', () => {
    /*
     * Leaving hands back the member as the state DRAWS it — its position, and
     * also its look and its shape. Restoring the transform alone returned an
     * object recoloured in that state to the artboard wearing its old colour,
     * which is the frame editing something as a parting gesture.
     */
    const frame = frameAt(0, 0)
    const dot = dotAt(10, 10)
    store().addToFrame(frame, [dot])
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { appearance: { containerFill: '#e0202a' } })

    expect(store().removeFromFrame(frame, [member.id], 1)).toBe(true)
    const freed = store().doc.objects[store().selection[0] as string]
    expect(freed?.kind === 'typography' && freed.appearance.containerFill).toBe('#e0202a')
  })
})
