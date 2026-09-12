import { beforeEach, describe, expect, it } from 'vitest'

import { objectById, useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject, LetterMosaicObject } from '../../src/types/document'

const store = () => useDocumentStore.getState()
const frameIn = (id: string): FrameObject => store().doc.objects[id] as FrameObject

let frame: string
let memberObjectId: string

beforeEach(() => {
  store().resetDocument()
  frame = store().createFrame({ box: { x: 0, y: 0, width: 400, height: 300 }, artboardCenter: { x: 0, y: 0 } })
  const mosaic = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
  store().addToFrame(frame, [mosaic])
  memberObjectId = frameIn(frame).members[0]!.object.id
})

const member = (): LetterMosaicObject => objectById(store().doc, memberObjectId) as LetterMosaicObject

describe('a backdrop on a member inside a frame', () => {
  it('per state: lands on the member and leaves the frame alone', () => {
    store().setMosaicBackground(memberObjectId, 0, '#ff0000ff')
    expect(member().states[0]!.background).toBe('#ff0000ff')
    expect(frameIn(frame).states.every((s) => (s.background ?? null) === null)).toBe(true)
  })
  it('every state: lands on the member and leaves the frame alone', () => {
    store().setStatedBackground(memberObjectId, '#00ff00ff')
    expect(member().states.every((s) => s.background === '#00ff00ff')).toBe(true)
    expect(frameIn(frame).states.every((s) => (s.background ?? null) === null)).toBe(true)
  })
})
