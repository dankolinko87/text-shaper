import { beforeEach, describe, expect, it } from 'vitest'

import { animatingFrameIds } from '../../src/editor/animationPlayback'
import { valuesFor } from '../../src/frame/frame'
import { useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject } from '../../src/types/document'

/**
 * A frame with a member under the pointer holds still.
 *
 * The rule a shape under direct manipulation already follows, extended to the
 * frame that holds the member: otherwise the clock repaints the member from a
 * moment that belongs to no state while it is being dragged, and the gesture
 * ends by measuring against a picture that was never the arrangement.
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
  // Something to play: state 2 puts the member somewhere else.
  const member = frameIn().members[0]!
  const at = valuesFor(member, frameIn().states[1]).transform
  store().setMemberValues(frame, 1, member.id, { transform: { ...at, x: at.x + 120 } })
})

describe('a frame being edited', () => {
  it('plays under the global play button when nothing holds it', () => {
    const doc = store().doc
    expect(animatingFrameIds(doc, { playing: true, previewing: null }).ids).toContain(frame)
  })

  it('is left out of the global play while a member of it is under the pointer', () => {
    const doc = store().doc
    expect(
      animatingFrameIds(doc, { playing: true, previewing: null, interacting: frame }).ids,
    ).not.toContain(frame)
  })

  it('refuses to preview itself while a member of it is under the pointer', () => {
    const doc = store().doc
    expect(animatingFrameIds(doc, { playing: false, previewing: frame }).ids).toEqual([frame])
    expect(
      animatingFrameIds(doc, { playing: false, previewing: frame, interacting: frame }).ids,
    ).toEqual([])
  })

  it('leaves other frames playing', () => {
    const other = store().createFrame({
      box: { x: 0, y: 0, width: 200, height: 200 },
      artboardCenter: { x: 900, y: 200 },
    })
    const shape = store().createObjectFromGeometry({
      open: false,
      pathData: 'M -20 -20 L 20 -20 L 20 20 L -20 20 Z',
      localBounds: { x: -20, y: -20, width: 40, height: 40 },
      artboardCenter: { x: 900, y: 200 },
      name: 'Dot',
    })
    store().addToFrame(other, [shape])
    const object = store().doc.objects[other] as FrameObject
    const member = object.members[0]!
    store().setMemberValues(other, 1, member.id, {
      transform: { ...member.object.transform, y: 50 },
    })

    const ids = animatingFrameIds(store().doc, { playing: true, previewing: null, interacting: frame }).ids
    expect(ids).toContain(other)
    expect(ids).not.toContain(frame)
  })
})
