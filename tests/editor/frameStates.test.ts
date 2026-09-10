import { beforeEach, describe, expect, it } from 'vitest'

import {
  deleteFrameStateAt,
  duplicateFrameStateAt,
  moveFrameStateTo,
  showFrameState,
} from '../../src/editor/frameStates'
import { doublePressOutside, pressOutside, spreadHoldsGround } from '../../src/editor/frameStates'
import { valuesFor } from '../../src/frame/frame'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Adding, removing and moving states, as the panel's list and the bar under
 * the frame do it — `mosaicStates.test.ts`, for the other thing with states.
 *
 * The store actions underneath are covered elsewhere; what is checked here is
 * the part that lives above them: which state you are left looking at
 * afterwards, that playback stops when you choose one, and that the two
 * controls on screen cannot disagree because they share one function.
 */

const store = () => useDocumentStore.getState()
const ui = () => useUiStore.getState()

let frame: string

const frameIn = (): FrameObject => {
  const object = store().doc.objects[frame]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

/** Make a state hold something its neighbours do not. */
const author = (at: number, x: number): void => {
  const member = frameIn().members[0]!
  const t = valuesFor(member, frameIn().states[at]).transform
  store().setMemberValues(frame, at, member.id, { transform: { ...t, x } })
  store().commit('Move')
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  useUiStore.setState({ mosaicStates: {}, mosaicPlayback: null, insideFrame: null, frameSelection: [] })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 300, y: 200 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 300, y: 200 },
    name: 'Box',
  })
  store().addToFrame(frame, [shape])
  store().duplicateFrameState(frame, 1)   // three states
  store().commit('Frame')
})

describe('showing a state', () => {
  it('stops a preview, because a chosen state is not an interpolated one', () => {
    ui().playMosaic(frame)
    showFrameState(frameIn(), 2)
    expect(ui().mosaicPlayback).toBeNull()
    expect(ui().mosaicStates[frame]).toBe(2)
  })

  it('refuses an index it cannot show', () => {
    ui().setMosaicState(frame, 1)
    showFrameState(frameIn(), 99)
    expect(ui().mosaicStates[frame]).toBe(1)
  })
})

describe('duplicating a state', () => {
  it('puts the copy straight after it and goes there', () => {
    const before = frameIn().states.length
    expect(duplicateFrameStateAt(frameIn(), 0)).toBe(true)
    expect(frameIn().states.length).toBe(before + 1)
    // Selected, because duplicating means "another like this, then I change it".
    expect(ui().mosaicStates[frame]).toBe(1)
  })

  it('copies what the state authored, and only that', () => {
    author(0, 120)
    duplicateFrameStateAt(frameIn(), 0)
    const member = frameIn().members[0]!
    expect(Object.keys(frameIn().states[1]!.values[member.id] ?? {})).toEqual(['transform'])
    expect(valuesFor(member, frameIn().states[1]).transform.x).toBeCloseTo(120, 6)
    expect(frameIn().states[1]!.values[member.id], 'its own patch, not a shared one').not.toBe(
      frameIn().states[0]!.values[member.id],
    )
  })

  it('refuses at the limit', () => {
    while (frameIn().states.length < 12) duplicateFrameStateAt(frameIn(), 0)
    expect(duplicateFrameStateAt(frameIn(), 0)).toBe(false)
    expect(frameIn().states.length).toBe(12)
  })
})

describe('deleting a state', () => {
  it('removes it and lands on the nearest survivor', () => {
    ui().setMosaicState(frame, 1)
    expect(deleteFrameStateAt(frameIn(), 1)).toBe(true)
    expect(frameIn().states.length).toBe(2)
    expect(ui().mosaicStates[frame]).toBe(1)
  })

  it('never leaves the picker pointing past the end', () => {
    const last = frameIn().states.length - 1
    ui().setMosaicState(frame, last)
    deleteFrameStateAt(frameIn(), last)
    expect(ui().mosaicStates[frame] ?? 0).toBeLessThan(frameIn().states.length)
  })

  it('refuses to take the timeline below two states', () => {
    deleteFrameStateAt(frameIn(), 2)
    expect(deleteFrameStateAt(frameIn(), 0)).toBe(false)
    expect(frameIn().states.length).toBe(2)
  })

  it('puts the state back on undo, which is what makes not asking safe', () => {
    author(1, 80)
    const before = frameIn().states.map((each) => each.id)
    deleteFrameStateAt(frameIn(), 1)
    store().undo()
    expect(frameIn().states.map((each) => each.id)).toEqual(before)
  })
})

describe('moving a state', () => {
  it('reorders the sequence and follows the state that moved', () => {
    author(0, 10)
    author(1, 20)
    author(2, 30)
    const ids = frameIn().states.map((each) => each.id)
    expect(moveFrameStateTo(frameIn(), 0, 2)).toBe(true)
    expect(frameIn().states.map((each) => each.id)).toEqual([ids[1], ids[2], ids[0]])
    expect(ui().mosaicStates[frame], 'looking at the state that moved').toBe(2)
    const member = frameIn().members[0]!
    expect(valuesFor(member, frameIn().states[2]).transform.x, 'its arrangement went with it').toBeCloseTo(10, 6)
  })

  it('does nothing for a move to where it already is', () => {
    expect(moveFrameStateTo(frameIn(), 1, 1)).toBe(false)
  })

  it('is one undo step', () => {
    const ids = frameIn().states.map((each) => each.id)
    const past = store().past.length
    moveFrameStateTo(frameIn(), 0, 2)
    expect(store().past.length).toBe(past + 1)
    store().undo()
    expect(frameIn().states.map((each) => each.id)).toEqual(ids)
  })
})

describe('the two escape hatches', () => {
  it('apply lays what this state says over every other state, sparsely', () => {
    const member = frameIn().members[0]!
    author(2, 55)                                                       // state 3 authored a position
    store().setMemberValues(frame, 0, member.id, { appearance: { containerFill: '#ff0000' } })
    store().commit('Colour')

    expect(store().applyFrameStateToAll(frame, 0)).toBe(true)
    const keys = (i: number) => Object.keys(frameIn().states[i]!.values[member.id] ?? {}).sort()
    expect(keys(1)).toEqual(['appearance'])
    expect(keys(2), 'state 3 keeps its own position under the colour').toEqual(['appearance', 'transform'])
    expect(valuesFor(member, frameIn().states[2]).transform.x).toBeCloseTo(55, 6)
    expect(valuesFor(member, frameIn().states[2]).appearance?.containerFill).toBe('#ff0000')
  })

  it('apply can be asked for one member alone', () => {
    const member = frameIn().members[0]!
    const made = store().duplicateFrameMember(frame, member.id) as string
    store().setMemberValues(frame, 0, member.id, { opacity: 0.5 })
    store().setMemberValues(frame, 0, made, { opacity: 0.2 })
    expect(store().applyFrameStateToAll(frame, 0, member.id)).toBe(true)
    expect(frameIn().states[1]!.values[member.id]?.opacity).toBeCloseTo(0.5, 6)
    expect(frameIn().states[1]!.values[made], 'the other member untouched').toBeUndefined()
  })

  it('reset forgets what a state authored, so it follows the shape again', () => {
    const member = frameIn().members[0]!
    author(1, 70)
    store().setMemberValues(frame, 1, member.id, { appearance: { containerFill: '#00ff00' } })
    expect(store().resetFrameStateToMember(frame, 1, member.id)).toBe(true)
    expect(frameIn().states[1]!.values[member.id]).toBeUndefined()
    expect(valuesFor(member, frameIn().states[1]).transform.x).toBeCloseTo(member.object.transform.x, 6)
    expect(store().resetFrameStateToMember(frame, 1, member.id), 'nothing left to forget').toBe(false)
  })
})

describe('a press on the ground outside the frame', () => {
  let frame: string

  beforeEach(() => {
    useDocumentStore.setState({
      doc: { ...useDocumentStore.getState().doc, objects: {}, objectOrder: [] },
      past: [],
      future: [],
      selection: [],
    })
    useUiStore.setState({ insideFrame: null, frameSelection: [], spreadFrame: null })
    frame = useDocumentStore.getState().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 0, y: 0 },
    })
  })

  it('leaves a collapsed frame, as it always did', () => {
    useUiStore.setState({ insideFrame: frame, frameSelection: ['m1'] })
    pressOutside(frame)
    expect(useUiStore.getState().insideFrame).toBeNull()
    expect(useUiStore.getState().frameSelection).toEqual([])
    expect(spreadHoldsGround()).toBe(false)
  })

  it('only puts the member down while the frame is spread', () => {
    /*
     * The row is laid out to be compared, and comparing involves clicking
     * about. Folding it on the first click beside it threw the comparison
     * away — so one click keeps the row and the frame, and drops the pick.
     */
    useUiStore.getState().setSpreadFrame(frame)
    useUiStore.setState({ frameSelection: ['m1'] })
    pressOutside(frame)
    expect(useUiStore.getState().spreadFrame, 'still spread').toBe(frame)
    expect(useUiStore.getState().insideFrame, 'still inside').toBe(frame)
    expect(useUiStore.getState().frameSelection).toEqual([])
    expect(spreadHoldsGround(), 'and the canvas keeps the frame selected').toBe(true)
  })

  it('folds the row on a double-click, and stays inside the frame', () => {
    useUiStore.getState().setSpreadFrame(frame)
    expect(doublePressOutside(frame)).toBe(true)
    expect(useUiStore.getState().spreadFrame).toBeNull()
    expect(useUiStore.getState().insideFrame, 'collapsed, not left').toBe(frame)
  })

  it('does nothing on a double-click outside a frame that is not spread', () => {
    useUiStore.setState({ insideFrame: frame })
    expect(doublePressOutside(frame)).toBe(false)
    expect(useUiStore.getState().insideFrame).toBe(frame)
  })
})
