import { beforeEach, describe, expect, it } from 'vitest'

import { selectedObject } from '../../src/editor/selection'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'

/**
 * "What is selected" has one answer, and these are its cases.
 *
 * The rail opens for the OUTER object — a member picked inside a frame keeps
 * the frame's states on show — while the panel edits the INNER one, as the
 * shown state draws it. Both come from the same call, so they cannot drift.
 */

const store = () => useDocumentStore.getState()

const ask = () => {
  const ui = useUiStore.getState()
  return selectedObject(store().selection, store().doc.objects, {
    insideFrame: ui.insideFrame,
    frameSelection: ui.frameSelection,
    mosaicStates: ui.mosaicStates,
  })
}

let frame: string
let shape: string

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  useUiStore.setState({ insideFrame: null, frameSelection: [], mosaicStates: {} })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 0, y: 0 },
  })
  shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 20, y: 10 },
    name: 'Box',
  })
  // Creating selects, as it does in the editor; each case says what it selects.
  useDocumentStore.setState({ selection: [] })
})

describe('what is selected', () => {
  it('is nothing when nothing, or more than one thing, is selected', () => {
    expect(ask().selected).toBeUndefined()
    expect(ask().stated).toBeUndefined()

    useDocumentStore.setState({ selection: [frame, shape] })
    expect(ask().selected, 'two things is no one thing').toBeUndefined()
    expect(ask().object).toBeUndefined()
  })

  it('is the shape itself, with no states, for a plain shape', () => {
    useDocumentStore.setState({ selection: [shape] })
    const got = ask()
    expect(got.selected?.id).toBe(shape)
    expect(got.object).toBe(got.selected)
    expect(got.id).toBe(shape)
    expect(got.member).toBeUndefined()
    expect(got.stated, 'a shape has no states to show').toBeUndefined()
  })

  it('is the frame, with its states, for a frame', () => {
    useDocumentStore.setState({ selection: [frame] })
    const got = ask()
    expect(got.selected?.id).toBe(frame)
    expect(got.stated?.id).toBe(frame)
    expect(got.object).toBe(got.selected)
  })

  it('keeps the frame as the stated object while a member is picked inside it', () => {
    store().addToFrame(frame, [shape])
    const object = store().doc.objects[frame]
    if (object?.kind !== 'frame') throw new Error('expected a frame')
    const member = object.members[0]!
    store().setMemberValues(frame, 1, member.id, { appearance: { containerFill: '#ff0000' } })

    useDocumentStore.setState({ selection: [frame] })
    useUiStore.setState({
      insideFrame: frame,
      frameSelection: [member.id],
      mosaicStates: { [frame]: 1 },
    })

    const got = ask()
    expect(got.selected?.id, 'the selection is still the frame').toBe(frame)
    expect(got.stated?.id, 'so its states stay on show').toBe(frame)
    expect(got.member?.id).toBe(member.id)
    expect(got.id, 'edits go to the member').toBe(member.object.id)
    expect(
      got.object?.kind === 'typography' && got.object.appearance.containerFill,
      'as the shown state draws it',
    ).toBe('#ff0000')
  })

  it('is the frame alone when several members are picked', () => {
    store().addToFrame(frame, [shape])
    const object = store().doc.objects[frame]
    if (object?.kind !== 'frame') throw new Error('expected a frame')
    store().duplicateFrameMember(frame, object.members[0]!.id)
    const members = (store().doc.objects[frame] as typeof object).members.map((m) => m.id)

    useDocumentStore.setState({ selection: [frame] })
    useUiStore.setState({ insideFrame: frame, frameSelection: members })

    const got = ask()
    expect(got.member).toBeUndefined()
    expect(got.object?.id).toBe(frame)
    expect(got.stated?.id).toBe(frame)
  })
})
