import { beforeEach, describe, expect, it } from 'vitest'

import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { objectById, typographyById, useDocumentStore } from '../../src/state/documentStore'
import { updateShape } from '../../src/editor/memberEdits'
import { useUiStore } from '../../src/state/uiStore'
import type { FrameObject, TypographyObject } from '../../src/types/document'

/**
 * Editing a shape that lives inside a frame.
 *
 * A member is an object in every sense except that it is not in `doc.objects`,
 * and the panel's controls all READ before they write — they merge onto what the
 * store holds now rather than onto what their render saw, so that picking an
 * effect and immediately dragging its slider does not undo the pick. A lookup
 * that could not see members therefore made every one of them a silent no-op:
 * the read found nothing and the control returned before writing.
 *
 * "Colour of the shapes not changing" was that, and colour was only the one that
 * got noticed — run settings, the animation controls and the outline editor all
 * go through the same door.
 */

const store = () => useDocumentStore.getState()

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

let frame: string
let memberObjectId: string

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })

  frame = store().createFrame({
    box: { x: 0, y: 0, width: 300, height: 240 },
    artboardCenter: { x: 100, y: 80 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 100, y: 80 },
    name: 'Inner',
  })
  store().addToFrame(frame, [shape])
  memberObjectId = frameIn(frame).members[0]!.object.id
})

/** The member's own object, read back out of the frame. */
const member = (): TypographyObject => {
  const object = frameIn(frame).members[0]?.object
  if (!object || object.kind !== 'typography') throw new Error('expected a shape')
  return object
}

describe('finding an object that lives inside a frame', () => {
  it('answers for a member, not only for the artboard', () => {
    expect(store().doc.objects[memberObjectId], 'not a top-level object').toBeUndefined()
    expect(objectById(store().doc, memberObjectId)?.id).toBe(memberObjectId)
    expect(typographyById(memberObjectId)?.id).toBe(memberObjectId)
  })

  it('still answers for an ordinary object, and for neither when there is none', () => {
    const loose = store().createObjectFromGeometry({
      open: false,
      pathData: 'M 0 0 L 10 0 L 10 10 Z',
      localBounds: { x: 0, y: 0, width: 10, height: 10 },
      artboardCenter: { x: 0, y: 0 },
      name: 'Loose',
    })
    expect(objectById(store().doc, loose)?.id).toBe(loose)
    expect(objectById(store().doc, 'nothing-by-that-name')).toBeUndefined()
    expect(typographyById('nothing-by-that-name')).toBeUndefined()
  })

  it('does not mistake the frame itself for one of its members', () => {
    expect(objectById(store().doc, frame)?.kind).toBe('frame')
    expect(typographyById(frame), 'a frame is not typography').toBeUndefined()
  })
})

describe('a control that reads before it writes', () => {
  /*
   * These go through `updateObject`, exactly as the panel's own helpers do —
   * read the current value, merge the patch, write it back. The read is the step
   * that used to fail.
   */
  const merge = (patch: Partial<TypographyObject['appearance']>): void => {
    const current = typographyById(memberObjectId)?.appearance
    if (!current) return
    store().updateObject(memberObjectId, { appearance: { ...current, ...patch } })
  }

  it('changes the member’s colour', () => {
    expect(member().appearance.containerFill).not.toBe('#e0202a')
    merge({ containerFill: '#e0202a' })
    expect(member().appearance.containerFill).toBe('#e0202a')
  })

  it('keeps everything it did not name', () => {
    const before = member().appearance
    merge({ containerFill: '#123456' })
    const after = member().appearance
    expect(after.textFill).toBe(before.textFill)
    expect(after.opacity).toBe(before.opacity)
  })

  it('leaves the frame’s own states alone — appearance is structural', () => {
    /*
     * A member's structure is shared by every state; only what a state
     * explicitly holds is per-arrangement. Writing a colour must not quietly
     * author one of the states.
     */
    const before = frameIn(frame).states.map((state) => JSON.stringify(state.values))
    merge({ containerFill: '#00ff00' })
    expect(frameIn(frame).states.map((state) => JSON.stringify(state.values))).toEqual(before)
  })

  it('is undoable as one step', () => {
    store().commit('Setup')
    merge({ containerFill: '#abcdef' })
    store().commit('Change colour')
    expect(member().appearance.containerFill).toBe('#abcdef')

    store().undo()
    expect(member().appearance.containerFill).not.toBe('#abcdef')
  })
})

describe('reshaping a member', () => {
  const outlineOf = (path: string) => {
    const outline = pathToOutline(path)
    if (!outline) throw new Error('expected an outline')
    return outline
  }

  it('reaches the member through setGeometry, wherever it lives', () => {
    // It used to look only in `doc.objects`, and a member is not there — so a
    // reshape of a member was a silent no-op.
    const outline = outlineOf('M -50 -50 L 50 -50 L 50 50 L -50 50 Z')
    const revision = member().geometryRevision
    store().setGeometry(memberObjectId, { path: outlineToPath(outline), outline })

    expect(member().localBounds.width).toBeCloseTo(100, 3)
    expect(member().outline).toBeTruthy()
    expect(member().geometryRevision, 'the fit has to run again').toBe(revision + 1)
  })

  it('drops every state’s own nodes when the TOPOLOGY changes, and only then', () => {
    /*
     * A state's nodes are positions for the member's points, blended point
     * against point — well defined only while every state has the same points.
     * Once the member has a different number of them, the old per-state lists
     * describe a shape that no longer exists.
     */
    const four = outlineOf('M -40 -40 L 40 -40 L 40 40 L -40 40 Z')
    store().setGeometry(memberObjectId, { path: outlineToPath(four), outline: four })
    const memberId = frameIn(frame).members[0]!.id

    const moved = JSON.parse(JSON.stringify(four)) as typeof four
    moved.subpaths[0]!.nodes[0]!.point.x = -60
    store().setMemberValues(frame, 1, memberId, { nodes: moved })
    expect(frameIn(frame).states[1]!.values[memberId]?.nodes).toBeTruthy()

    const same = JSON.parse(JSON.stringify(four)) as typeof four
    same.subpaths[0]!.nodes[1]!.point.x = 60
    store().setGeometry(memberObjectId, { path: outlineToPath(same), outline: same })
    expect(frameIn(frame).states[1]!.values[memberId]?.nodes, 'same points: kept').toBeTruthy()

    const three = outlineOf('M -40 -40 L 40 -40 L 0 40 Z')
    store().setGeometry(memberObjectId, { path: outlineToPath(three), outline: three })
    expect(
      frameIn(frame).states[1]!.values[memberId]?.nodes,
      'different points: dropped, so the state follows the new shape',
    ).toBeUndefined()
  })
})

describe('the panel’s writer for type settings', () => {
  it('records only the cut keys it was handed, in the state on show', () => {
    /*
     * The writer used to read the RESOLVED settings, merge one field in and
     * write all six back — so a change of text froze the font, the fitting
     * mode, the flow, the typography and the run into that state, and it could
     * never follow the member for any of them again.
     */
    const memberId = frameIn(frame).members[0]!.id
    const ui = useUiStore.getState()
    ui.setInsideFrame(frame)
    ui.setFrameSelection([memberId])
    ui.setMosaicState(frame, 1)
    try {
      updateShape(memberObjectId, { text: 'BYE' })
    } finally {
      useUiStore.getState().setInsideFrame(null)
    }

    const patch = frameIn(frame).states[1]!.values[memberId]!
    expect(Object.keys(patch)).toEqual(['typeSettings'])
    expect(Object.keys(patch.typeSettings ?? {})).toEqual(['text'])
    expect(frameIn(frame).states[0]!.values[memberId], 'the state not on show').toBeUndefined()
  })
})
