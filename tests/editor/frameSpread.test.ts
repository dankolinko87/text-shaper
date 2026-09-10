import { Canvas, type Group } from 'fabric/node'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { animatingFrameIds } from '../../src/editor/animationPlayback'
import { readMemberTransform } from '../../src/editor/Canvas'
import {
  contentBounds,
  settleFrame,
  syncCanvas,
  windowsOf,
  type RenderedObject,
} from '../../src/editor/renderer'
import { initClipper } from '../../src/geometry/clipper'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { valuesFor, withTypeSettings } from '../../src/frame/frame'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import { registerFont } from '../../src/typography/fontRegistry'
import { fitObject } from '../../src/typography/objectFit'
import type { FitOutcome } from '../../src/typography/fit'
import type { FrameObject } from '../../src/types/document'

/**
 * A frame drawn as a ROW of windows, one per state.
 *
 * A view and nothing more: the document never learns about it, so there is
 * nothing to undo and collapsing gives back exactly what was there. What the
 * tests below pin is the part that is not free — that a window is the frame at
 * ITS state and nothing else (one builder, one settle), that only the first
 * window is the frame, that a write asks the window it happened in, and that
 * collapsing takes every window away again.
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
afterEach(() => {
  // A canvas per test, disposed with it — or each one's render timer outlives
  // the test that made it and fires into a window that is no longer there.
  void canvas.dispose()
  resetPaperScope()
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

/** Every state's fit for every member, as `useTextPaths` hands the canvas. */
const fitsFor = (object: FrameObject): Record<string, (FitOutcome | null)[]> => {
  const fits: Record<string, (FitOutcome | null)[]> = {}
  for (const member of object.members) {
    const own = member.object
    if (own.kind !== 'typography') continue
    fits[own.id] = object.states.map((state) => {
      const solved = fitObject(withTypeSettings(own, valuesFor(member, state).typeSettings))
      return solved.ok ? solved : null
    })
  }
  return fits
}

/** Render, spread or not, with the shown state given; every window settled. */
const render = (spread: boolean, shown = 0): Map<string, RenderedObject> => {
  // The shown state's fit, as `useTextPaths` hands the renderer: the builder
  // needs a text child to exist before a settle can paint each window's own.
  const member = frameIn().members[0]!
  const fitted =
    member.object.kind === 'typography'
      ? fitObject(withTypeSettings(member.object, valuesFor(member, frameIn().states[shown]).typeSettings))
      : null
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: fitted?.ok ? { [member.object.id]: fitted.path } : {},
    bandPaths: fitted?.ok && fitted.band ? { [member.object.id]: fitted.band } : {},
    ribbons: {},
    rendered,
    spreadFrame: spread ? frame : null,
    insideFrame: frame,
    mosaicStates: { [frame]: shown },
  } as never)
  const object = frameIn()
  const entry = rendered.get(frame)!
  windowsOf(entry).forEach((window, i) => settleFrame(window, object, spread ? i : shown, fitsFor(object)))
  return rendered
}

/** Every group on the canvas that belongs to the frame, windows included. */
const groups = () =>
  canvas.getObjects().filter((o) => (o as { get: (k: string) => unknown }).get('frameId') === frame)

const childOf = (window: RenderedObject['group']): Group => {
  const member = frameIn().members[0]!
  const found = window.getObjects().find((o) => o.get('memberId') === member.id)
  if (!found) throw new Error('member child missing')
  return found as unknown as Group
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  useUiStore.setState({ insideFrame: null, spreadFrame: null, frameSelection: [], mosaicStates: {} })
  canvas = new Canvas(undefined as never, { width: 2400, height: 900 })
  rendered = new Map()

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
  // A third state, so a row is plainly a row rather than a pair — and each
  // state arranged differently, so a window can be told from its neighbours.
  store().duplicateFrameState(frame, 1)
  const member = frameIn().members[0]!
  store().setMemberValues(frame, 1, member.id, { transform: { ...member.object.transform, x: 70 } })
  store().setMemberValues(frame, 2, member.id, {
    transform: { ...member.object.transform, x: 140 },
    appearance: { containerFill: '#ff0000' },
    typeSettings: { text: 'BYE' },
  })
  store().setFrameStateBackground(frame, 2, '#0000ff')
})

describe('spreading a frame', () => {
  it('draws one window per state, and takes them all away on collapse', () => {
    render(false)
    expect(groups(), 'one group when collapsed').toHaveLength(1)

    render(true)
    expect(groups(), 'one per state').toHaveLength(3)
    expect(windowsOf(rendered.get(frame)!)).toHaveLength(3)

    render(false)
    expect(groups(), 'nothing left behind').toHaveLength(1)
    expect(rendered.get(frame)!.windows, 'and nothing still tracked').toBeUndefined()
  })

  it('leaves the first window exactly where the frame is, and spaces the rest evenly', () => {
    render(false)
    const alone = rendered.get(frame)!.group.left

    render(true)
    const lefts = windowsOf(rendered.get(frame)!).map((g) => g.left)
    expect(lefts[0], 'nothing jumps on opening').toBe(alone)
    expect(lefts[1]!).toBeGreaterThan(lefts[0]!)
    expect(lefts[2]! - lefts[1]!, 'one step, repeated').toBeCloseTo(lefts[1]! - lefts[0]!, 6)
    expect(lefts[1]! - lefts[0]!, 'at least a frame apart').toBeGreaterThanOrEqual(400)
  })

  it('gives the further windows NO shapeId, and never lets them be dragged as a whole', () => {
    /*
     * The hazard this feature is built around: `shapeId` would enrol a window
     * in every first-match lookup at once, and which group each returned would
     * be add-order luck.
     */
    render(true)
    const [first, ...rest] = windowsOf(rendered.get(frame)!)
    expect(first!.get('shapeId'), 'the first one IS the frame').toBe(frame)
    for (const window of rest) {
      expect(window.get('shapeId')).toBeUndefined()
      expect(window.get('frameId'), 'but it knows whose it is').toBe(frame)
      expect(window.selectable).toBe(false)
    }
  })

  it('stamps each window with the state it draws', () => {
    render(true)
    expect(windowsOf(rendered.get(frame)!).map((g) => g.get('stateIndex'))).toEqual([0, 1, 2])
  })

  it('shows state 1 first however the shown state moves', () => {
    render(true, 0)
    const atZero = rendered.get(frame)!.group.left
    render(true, 2)
    expect(rendered.get(frame)!.group.left, 'the row held still').toBe(atZero)
    expect(rendered.get(frame)!.group.get('stateIndex'), 'and still starts at state 1').toBe(0)
  })
})

describe('a window is the frame at its state', () => {
  /*
   * I1 — one builder, one settle. Whatever a window shows must be exactly what
   * the collapsed frame shows when that state is on show: where the member
   * stands, how it is filled, what the backdrop is, and what the type says.
   */
  const picture = (window: RenderedObject['group'], offset: number) => {
    const child = childOf(window)
    child.setCoords()
    const centre = child.getCenterPoint()
    const container = child.getObjects().find((o) => o.get('role') === 'container')
    const text = child.getObjects().find((o) => o.get('role') === 'text') as { path?: unknown } | undefined
    const plate = window.getObjects().find((o) => o.get('role') === 'plate')
    return {
      x: +(centre.x - offset).toFixed(3),
      y: +centre.y.toFixed(3),
      fill: String(container?.fill),
      plate: String(plate?.fill),
      text: text?.path ? JSON.stringify(text.path) : null,
    }
  }

  it('draws what the collapsed frame draws at that state', () => {
    const collapsed = [0, 1, 2].map((i) => {
      render(false, i)
      return picture(rendered.get(frame)!.group, 0)
    })

    render(true)
    const windows = windowsOf(rendered.get(frame)!)
    for (const i of [0, 1, 2]) {
      const offset = windows[i]!.left - windows[0]!.left
      expect(picture(windows[i]!, offset), `window ${i + 1}`).toEqual(collapsed[i])
    }
    expect(collapsed[2]!.fill).toBe('#ff0000')
    expect(collapsed[2]!.plate).toBe('#0000ff')
    expect(collapsed[2]!.text, 'the type was fitted').toBeTruthy()
    expect(collapsed[2]!.text, 'and says what state 3 says').not.toBe(collapsed[0]!.text)
  })
})

describe('a window is a picture of ITS state, kept current', () => {
  it('repaints a window when ITS state changes, not only the first', () => {
    /*
     * The bug that read as half a dozen faults at once. A frame is rebuilt only
     * when its content key changes, and the key used to describe the state in
     * the FIRST window — so a colour authored in state 3 changed nothing the
     * key could see, nothing was rebuilt, and window 3 went on showing what it
     * showed before.
     */
    render(true)
    const keyBefore = rendered.get(frame)!.contentKey
    store().setFrameStateBackground(frame, 1, '#00ff00')
    const member = frameIn().members[0]!
    store().setMemberValues(frame, 1, member.id, { transform: { ...member.object.transform, x: 70, y: 40 } })
    render(true)

    /*
     * The KEY has to see it, not only the settle that runs after every sync:
     * the settle repaints what it knows how to repaint, and the key is what
     * rebuilds a window for everything else.
     */
    expect(rendered.get(frame)!.contentKey, 'the key describes every window').not.toBe(keyBefore)
    const window = windowsOf(rendered.get(frame)!)[1]!
    expect(String(window.getObjects().find((o) => o.get('role') === 'plate')?.fill)).toBe('#00ff00')
    const child = childOf(window)
    child.setCoords()
    expect(child.getCenterPoint().y, 'and the member moved with its state').toBeCloseTo(200 + 40, 0)
  })
})

describe('where a gesture in a window lands', () => {
  /*
   * I3 — every write derives its target from the Fabric object it acted on.
   * The store is made to disagree on purpose: it shows state 1 while the drag
   * happens in window 3.
   */
  it('reads the window’s state off the child’s parent, whatever the store shows', () => {
    render(true, 0)
    const windows = windowsOf(rendered.get(frame)!)
    const child = childOf(windows[2]!)
    child.set({ left: (child.left ?? 0) + 25 })
    child.setCoords()

    const read = readMemberTransform(child)
    expect(read?.frameId).toBe(frame)
    expect(read?.at, 'the state that window draws').toBe(2)
    expect(read?.transform.x).toBeCloseTo(140 + 25, 6)
  })

  it('writes that state and only that state, three windows in a row', () => {
    render(true, 0)
    const windows = windowsOf(rendered.get(frame)!)
    for (const i of [1, 2, 0]) {
      const before = frameIn().states
      const child = childOf(windows[i]!)
      child.set({ left: (child.left ?? 0) + 10 })
      child.setCoords()
      const read = readMemberTransform(child)!
      store().setMemberValues(read.frameId, read.at, read.memberId, { transform: read.transform })

      const after = frameIn().states
      const changed = after.map((state, j) => state !== before[j])
      expect(changed, `only window ${i + 1}'s state changed`).toEqual([0, 1, 2].map((j) => j === i))
    }
  })
})

describe('what a spread frame will not do', () => {
  it('refuses to animate, because it is showing every keyframe', () => {
    const doc = store().doc
    expect(animatingFrameIds(doc, { playing: true, previewing: null }).ids).toContain(frame)
    expect(
      animatingFrameIds(doc, { playing: true, previewing: null, spread: frame }).ids,
    ).not.toContain(frame)
    expect(animatingFrameIds(doc, { playing: false, previewing: frame, spread: frame }).ids).toEqual(
      [],
    )
  })

  it('never touches the document, so there is nothing to undo', () => {
    const past = store().past.length
    useUiStore.getState().setSpreadFrame(frame)
    render(true)
    useUiStore.getState().setSpreadFrame(null)
    render(false)
    expect(store().past.length).toBe(past)
  })
})

describe('fitting the view', () => {
  it('frames the whole row, not just the first window', () => {
    render(false)
    const alone = contentBounds(rendered)!
    render(true)
    const row = contentBounds(rendered)!
    expect(row.width, 'wide enough for three').toBeGreaterThan(alone.width * 2.5)
    expect(row.x, 'and still starts where the frame does').toBeCloseTo(alone.x, 0)
  })
})
