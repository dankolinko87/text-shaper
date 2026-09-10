import { Canvas } from 'fabric/node'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readMemberTransform } from '../../src/editor/Canvas'
import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { initClipper } from '../../src/geometry/clipper'
import { valuesFor } from '../../src/frame/frame'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Where a gesture on a member lands.
 *
 * The rule: every write derives its target from the Fabric object it acted on.
 * The child's parent group stamps the frame and the STATE it draws, and the
 * write asks there — never the UI store, which is what the bar and the panel
 * are looking at and can lag a press by an event.
 */

beforeAll(async () => {
  await initClipper()
})

const store = () => useDocumentStore.getState()

let canvas: Canvas
let rendered = new Map<string, RenderedObject>()
let frame: string

const frameIn = (): FrameObject => {
  const object = store().doc.objects[frame]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

const inside = (at: number): void => {
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
    insideFrame: frame,
    mosaicStates: { [frame]: at },
  } as never)
}

const child = () => {
  const member = frameIn().members[0]!
  const found = rendered.get(frame)!.group.getObjects().find((o) => o.get('memberId') === member.id)
  if (!found) throw new Error('member child missing')
  return found
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  useUiStore.setState({ insideFrame: null, frameSelection: [], mosaicStates: {} })
  canvas = new Canvas(undefined as never, { width: 1200, height: 900 })
  rendered = new Map()

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
  store().duplicateFrameState(frame, 1)
})

describe('reading a moved member back', () => {
  it('names the frame and the state its parent draws, not what the store shows', () => {
    inside(2)
    // The store is made to disagree: it says state 1 is shown.
    useUiStore.getState().setMosaicState(frame, 0)

    const kid = child()
    kid.set({ left: (kid.left ?? 0) + 80 })
    kid.setCoords()

    const read = readMemberTransform(kid)
    expect(read?.frameId).toBe(frame)
    expect(read?.at, 'the state the group draws').toBe(2)
    expect(read?.transform.x).toBeCloseTo(80, 6)
  })

  it('answers null for a child that is not a member', () => {
    inside(0)
    const plate = rendered.get(frame)!.group.getObjects().find((o) => o.get('role') === 'plate')!
    expect(readMemberTransform(plate)).toBeNull()
  })

  it('lands the write on exactly that state, sparsely', () => {
    inside(2)
    const before = frameIn().states
    const kid = child()
    kid.set({ left: (kid.left ?? 0) + 80 })
    kid.setCoords()
    const read = readMemberTransform(kid)!
    store().setMemberValues(read.frameId, read.at, read.memberId, { transform: read.transform })

    const after = frameIn()
    const member = after.members[0]!
    expect(Object.keys(after.states[2]!.values[member.id] ?? {})).toEqual(['transform'])
    expect(after.states[0], 'state 1 untouched').toBe(before[0])
    expect(after.states[1], 'state 2 untouched').toBe(before[1])
    expect(valuesFor(member, after.states[2]).transform.x).toBeCloseTo(80, 6)
  })
})
