import { beforeEach, describe, expect, it } from 'vitest'

import { evaluateFrameAtTime, valuesFor } from '../../src/frame/frame'
import { frameMoves } from '../../src/editor/animationPlayback'
import { useDocumentStore } from '../../src/state/documentStore'
import { alphaOf, parseHex } from '../../src/typography/colour'
import type { FrameObject } from '../../src/types/document'

/**
 * The gestures and settings a frame grew once it had states worth arranging:
 * duplicating a member inside one, and a backdrop that belongs to the state.
 */

const store = () => useDocumentStore.getState()

let frame: string

const frameIn = (): FrameObject => {
  const object = store().doc.objects[frame]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 0, y: 0 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 20, y: 10 },
    name: 'Box',
  })
  store().addToFrame(frame, [shape])
})

describe('duplicating a member inside its frame', () => {
  it('joins EVERY state, as membership always does', () => {
    const source = frameIn().members[0]!
    const made = store().duplicateFrameMember(frame, source.id)
    expect(made).toBeTruthy()

    const object = frameIn()
    expect(object.members).toHaveLength(2)
    const copy = object.members.find((each) => each.id === made)!
    for (const state of object.states) {
      // Membership is structural: every state answers for the copy — from the
      // copy's own object where the original was silent, as a patch does.
      expect(valuesFor(copy, state).transform, 'every state answers for it').toBeTruthy()
    }
  })

  it('copies what the original has in EACH state, not one value everywhere', () => {
    /*
     * A copy of a member that already animates has to arrive animating with it.
     * Taking one transform and writing it into every state would flatten the
     * duplicate to a still object that only starts moving once each state is
     * visited by hand.
     */
    const source = frameIn().members[0]!
    const at1 = valuesFor(source, frameIn().states[1]).transform
    store().setMemberValues(frame, 1, source.id, { transform: { ...at1, x: at1.x + 120 } })

    const made = store().duplicateFrameMember(frame, source.id) as string
    const object = frameIn()
    const copy = object.members.find((each) => each.id === made)!

    expect(valuesFor(copy, object.states[0]).transform.x).toBeCloseTo(
      valuesFor(object.members[0]!, object.states[0]).transform.x,
      6,
    )
    expect(valuesFor(copy, object.states[1]).transform.x).toBeCloseTo(at1.x + 120, 6)
  })

  it('gets fresh ids, so the two do not read each other’s values', () => {
    const source = frameIn().members[0]!
    const made = store().duplicateFrameMember(frame, source.id) as string
    const copy = frameIn().members.find((each) => each.id === made)!

    expect(copy.id).not.toBe(source.id)
    expect(copy.object.id).not.toBe(source.object.id)
  })

  it('says so when there is no such member', () => {
    expect(store().duplicateFrameMember(frame, 'ghost')).toBeNull()
  })
})

describe('a frame’s background', () => {
  it('belongs to the state, not to the frame', () => {
    store().setFrameStateBackground(frame, 1, '#1f8f4e')
    expect(frameIn().states[1]?.background).toBe('#1f8f4e')
    expect(frameIn().states[0]?.background ?? null, 'state 1 untouched').toBeNull()
  })

  it('lands on the state you coloured, and on no other', () => {
    /*
     * The rule a member's values follow, so that "what does this edit touch"
     * has one answer in a frame rather than one per property. Colouring the
     * first state of a fresh frame is therefore a colour animation from that
     * state to the next — which is what authoring a keyframe means.
     */
    store().setFrameStateBackground(frame, 0, '#dcdcd8')
    expect(frameIn().states[0]?.background).toBe('#dcdcd8')
    expect(frameIn().states.slice(1).every((state) => (state.background ?? null) === null)).toBe(
      true,
    )
  })

  it('makes the frame worth playing, though it belongs to no member', () => {
    expect(frameMoves(frameIn())).toBe(false)
    store().setFrameStateBackground(frame, 1, '#1f8f4e')
    expect(frameMoves(frameIn())).toBe(true)
  })

  it('blends across the transition', () => {
    store().setFrameStateBackground(frame, 0, '#000000')
    store().setFrameStateBackground(frame, 1, '#ffffff')

    const object = frameIn()
    const half = object.states[0]!.holdMs + object.states[0]!.transitionMs / 2
    const mid = evaluateFrameAtTime(object, half).background as string
    const [r] = parseHex(mid) as [number, number, number, number]
    expect(r).toBeGreaterThan(60)
    expect(r).toBeLessThan(195)
  })

  it('fades in from nothing without going through black', () => {
    // The same rule every other colour in this app follows.
    store().setFrameStateBackground(frame, 1, '#ff0000')
    const object = frameIn()
    const half = object.states[0]!.holdMs + object.states[0]!.transitionMs / 2
    const mid = evaluateFrameAtTime(object, half).background as string

    const [r, g, b] = parseHex(mid) as [number, number, number, number]
    expect(r, 'still the red it is becoming').toBeGreaterThan(200)
    expect(g).toBeLessThan(40)
    expect(b).toBeLessThan(40)
    expect(alphaOf(mid)).toBeGreaterThan(0.3)
    expect(alphaOf(mid)).toBeLessThan(0.7)
  })

  it('gives back both ends exactly, null included', () => {
    store().setFrameStateBackground(frame, 1, '#ff0000')
    const object = frameIn()
    expect(evaluateFrameAtTime(object, 0).background).toBeNull()
    const arrived = object.states[0]!.holdMs + object.states[0]!.transitionMs + 1
    expect(evaluateFrameAtTime(object, arrived).background).toBe('#ff0000')
  })
})
