import { beforeEach, describe, expect, it } from 'vitest'

import { alignSelection, alignableCount, alignmentForKey } from '../../src/editor/alignment'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Lining the selection up goes through the same two doors a nudge does:
 * objects through their base transform, members through the shown state.
 */
const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ insideFrame: null, frameSelection: [], mosaicStates: {} })
})

const square = (cx: number, cy: number, size: number): string =>
  store().createObjectFromGeometry({
    open: false,
    pathData: `M ${-size / 2} ${-size / 2} L ${size / 2} ${-size / 2} L ${size / 2} ${size / 2} L ${-size / 2} ${size / 2} Z`,
    localBounds: { x: -size / 2, y: -size / 2, width: size, height: size },
    artboardCenter: { x: cx, y: cy },
    name: 'Box',
  })
const x = (id: string) => store().doc.objects[id]!.transform.x

describe('aligning the selection', () => {
  it('lines objects up along their bounds and records one entry', () => {
    const a = square(0, 0, 20)
    const b = square(100, 50, 40)
    store().setSelection([a, b])
    const past = store().past.length
    expect(alignSelection('left')).toBe(true)
    // Left edges: a at -10, b at 80 → both to -10.
    expect(x(a)).toBe(0)
    expect(x(b)).toBe(-10 + 20)
    expect(store().past.length).toBe(past + 1)
    expect(store().past[past]!.label).toBe('Align left')
  })

  it('does nothing for one object, a locked one, or a lined-up pair', () => {
    const a = square(0, 0, 20)
    store().setSelection([a])
    expect(alignSelection('left')).toBe(false)
    const b = square(100, 0, 20)
    store().setBase(b, { locked: true })
    store().setSelection([a, b])
    expect(alignSelection('right'), 'only one movable, nothing to align to').toBe(false)
    store().setBase(b, { locked: false })
    expect(alignSelection('top'), 'already level').toBe(false)
  })

  it('lines members up inside their frame, in the frame’s space, on the shown state', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 400, height: 300 }, artboardCenter: { x: 0, y: 0 } })
    const a = square(50, 50, 20)
    const b = square(200, 120, 40)
    store().addToFrame(frame, [a, b])
    store().duplicateFrameState(frame, 1)
    const members = (store().doc.objects[frame] as FrameObject).members.map((m) => m.id)
    useUiStore.setState({ insideFrame: frame, frameSelection: members, mosaicStates: { [frame]: 1 } })
    expect(alignableCount()).toBe(2)
    expect(alignSelection('middle')).toBe(true)
    const after = store().doc.objects[frame] as FrameObject
    // Tops 40 and 100, bottoms 60 and 140 → the middle of the lot is 90.
    expect(after.states[1]!.values[members[0]!]?.transform?.y).toBe(90)
    expect(after.states[1]!.values[members[1]!]?.transform?.y).toBe(90)
    expect(after.states[0]!.values[members[0]!]?.transform, 'the other state untouched').toBeUndefined()
    expect(after.transform.y, 'the frame stayed put').toBe(0)
  })

  it('reads the ⌥ shortcuts by key position, with ⌃ for distributing', () => {
    const key = (code: string, extra: Partial<KeyboardEvent> = {}) =>
      alignmentForKey({ code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra })?.how
    expect(key('KeyA')).toBe('left')
    expect(key('KeyV')).toBe('middle')
    expect(key('KeyV', { ctrlKey: true })).toBe('distributeVertical')
    expect(key('KeyA', { metaKey: true })).toBeUndefined()
    expect(key('KeyA', { altKey: false })).toBeUndefined()
  })
})
