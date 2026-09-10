import { Canvas } from 'fabric/node'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { initClipper } from '../../src/geometry/clipper'
import { useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Text inside a member of a frame.
 *
 * A frame is redrawn by being REBUILT or not at all, and one string decides
 * which. That string was written out field by field for a member — the shape,
 * the paints, the border — and it had no text path in it, so typing into a
 * member changed nothing the renderer could see and the words never appeared
 * however long you typed.
 *
 * The fix is not another field: a member is now keyed by the very function that
 * keys an ordinary object, so it answers for what would look different in the
 * same terms. A hand-written second list is what went stale.
 *
 * The text path is supplied here rather than fitted, which is what the renderer
 * receives anyway — `useTextPaths` solves the fit and hands the result in. That
 * keeps this about the redraw and away from font loading.
 */

beforeAll(async () => {
  await initClipper()
})

const store = () => useDocumentStore.getState()

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

let canvas: Canvas
let rendered = new Map<string, RenderedObject>()
let frame: string
let memberObjectId: string

/** Render, optionally with a fitted text path for the member. */
const render = (textPath = ''): Map<string, RenderedObject> => {
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: textPath ? { [memberObjectId]: textPath } : {},
    bandPaths: {},
    ribbons: {},
    rendered,
  } as never)
  return rendered
}

/** The roles of the parts the member is actually drawn from. */
const memberParts = (): string[] => {
  const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
  const child = group
    .getObjects()
    .find((o: never) => (o as { get: (k: string) => unknown }).get('memberId')) as never as {
    getObjects: () => never[]
  }
  return child
    .getObjects()
    .map((o: never) => String((o as { get: (k: string) => unknown }).get('role') ?? ''))
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  canvas = new Canvas(undefined, { width: 900, height: 700 })
  rendered = new Map()

  frame = store().createFrame({
    box: { x: 0, y: 0, width: 300, height: 240 },
    artboardCenter: { x: 100, y: 80 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -60 -60 L 60 -60 L 60 60 L -60 60 Z',
    localBounds: { x: -60, y: -60, width: 120, height: 120 },
    artboardCenter: { x: 100, y: 80 },
    name: 'Inner',
  })
  store().addToFrame(frame, [shape])
  memberObjectId = frameIn(frame).members[0]!.object.id
})

const GLYPHS = 'M 0 0 L 10 0 L 10 10 L 0 10 Z'

describe('typing into a member', () => {
  it('writes to the member, which is not a top-level object', () => {
    store().updateObject(memberObjectId, { text: 'HOT' })
    const member = frameIn(frame).members[0]!
    if (member.object.kind !== 'typography') throw new Error('expected a shape')
    expect(member.object.text).toBe('HOT')
    expect(store().doc.objects[memberObjectId], 'still not on the artboard').toBeUndefined()
  })

  it('redraws the frame, so the words actually appear', () => {
    render()
    expect(memberParts(), 'nothing typed yet').not.toContain('text')

    store().updateObject(memberObjectId, { text: 'HOT' })
    render(GLYPHS)

    expect(memberParts(), 'the group was rebuilt with the type in it').toContain('text')
  })

  it('redraws again when the text CHANGES, not only when it arrives', () => {
    store().updateObject(memberObjectId, { text: 'HOT' })
    render(GLYPHS)
    const first = rendered.get(frame)?.contentKey

    store().updateObject(memberObjectId, { text: 'HOT NOW' })
    render('M 0 0 L 40 0 L 40 10 L 0 10 Z')

    expect(rendered.get(frame)?.contentKey).not.toBe(first)
  })

  it('leaves the frame alone when nothing about it changed', () => {
    // The other half of the contract: a key that changes when it should not
    // rebuilds the group on every keystroke anywhere in the document.
    store().updateObject(memberObjectId, { text: 'HOT' })
    render(GLYPHS)
    const group = rendered.get(frame)?.group
    const key = rendered.get(frame)?.contentKey

    render(GLYPHS)
    expect(rendered.get(frame)?.contentKey).toBe(key)
    expect(rendered.get(frame)?.group, 'the very same group object').toBe(group)
  })
})
