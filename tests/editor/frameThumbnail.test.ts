import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { registerFont } from '../../src/typography/fontRegistry'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { frameStateArtwork } from '../../src/editor/FrameThumbnail'
import { memberAtState, stateShape, valuesFor } from '../../src/frame/frame'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { useDocumentStore } from '../../src/state/documentStore'
import { fitObject, frameAt, pourThrough, stillFrame } from '../../src/typography/objectFit'
import type { FrameObject } from '../../src/types/document'

/**
 * A state's thumbnail draws what the canvas draws for that state.
 *
 * The artwork is built from the same functions — the member as the state has
 * it, the same fit, the same pour through a reshaped outline — so this holds
 * the thumbnail's path data against those functions' own answers. A thumbnail
 * that drew the member at rest, or the type unpoured, would show a state that
 * is not the one on screen.
 */

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})
afterEach(() => resetPaperScope())

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
    pathData: 'M -60 -50 L 60 -50 L 60 50 L -60 50 Z',
    localBounds: { x: -60, y: -50, width: 120, height: 100 },
    artboardCenter: { x: 300, y: 200 },
    name: 'Box',
  })
  store().updateObject(shape, { text: 'HELLO WORLD' })
  const outline = pathToOutline(
    (store().doc.objects[shape] as { currentSourcePath: string }).currentSourcePath,
  )
  if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
  store().addToFrame(frame, [shape])
  store().duplicateFrameState(frame, 1)
})

describe('a state’s thumbnail', () => {
  it('draws the type as the canvas fits it, for a state that says nothing', () => {
    const object = frameIn()
    const member = object.members[0]!
    const [art] = frameStateArtwork(object, object.states[0]!)
    const drawn = memberAtState(member, valuesFor(member, object.states[0]))
    if (drawn.kind !== 'typography') throw new Error('expected type')
    const expected = stillFrame(drawn, fitObject(drawn))
    expect(art!.text, 'some type was drawn').toBeTruthy()
    expect(art!.text).toBe(expected?.path)
    expect(art!.container).toBe(drawn.currentSourcePath)
  })

  it('pours the type through the state’s own outline where the state reshaped it', () => {
    const object = frameIn()
    const member = object.members[0]!
    if (member.object.kind !== 'typography' || !member.object.outline) throw new Error('expected an outlined shape')
    const wider = JSON.parse(JSON.stringify(member.object.outline)) as NonNullable<typeof member.object.outline>
    wider.subpaths[0]!.nodes[1]!.point.x += 60
    wider.subpaths[0]!.nodes[2]!.point.x += 60
    store().setMemberValues(frame, 2, member.id, { nodes: wider })

    const after = frameIn()
    const m = after.members[0]!
    const values = valuesFor(m, after.states[2])
    const drawn = memberAtState(m, values)
    if (drawn.kind !== 'typography') throw new Error('expected type')
    const shape = stateShape(m, values)?.currentSourcePath
    expect(shape, 'the state gives its own shape').toBeTruthy()
    const source = pourThrough(drawn, fitObject(drawn), shape as string)
    const expected = source ? frameAt(drawn, source, 0) : null

    const art = frameStateArtwork(after, after.states[2]!)[0]!
    expect(art.text).toBe(expected?.path)
    expect(art.container, 'and the container is the reshaped one').toBe(shape)
    // And the untouched state still draws the member at rest.
    const rest = frameStateArtwork(after, after.states[0]!)[0]!
    expect(rest.container).toBe(m.object.kind === 'typography' ? m.object.currentSourcePath : '')
    expect(rest.text).not.toBe(art.text)
  })

  it('shows the state’s own colour, position and fade', () => {
    const object = frameIn()
    const member = object.members[0]!
    store().setMemberValues(frame, 1, member.id, {
      appearance: { containerFill: '#ff0000' },
      transform: { ...member.object.transform, x: 70, rotation: 15 },
      opacity: 0.5,
    })
    const after = frameIn()
    const art = frameStateArtwork(after, after.states[1]!)[0]!
    expect(art.containerFill).toBe('#ff0000')
    expect(art.transform.x).toBeCloseTo(70, 6)
    expect(art.transform.rotation).toBeCloseTo(15, 6)
    expect(art.opacity).toBeCloseTo(0.5, 6)
  })
})
