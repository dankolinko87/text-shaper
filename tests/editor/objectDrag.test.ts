import { beforeEach, describe, expect, it } from 'vitest'

import { beginObjectDrag, constrainMove, nudgeSelection } from '../../src/editor/objectDrag'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'

/**
 * A drag by the plate or the name: the object follows the pointer as it
 * goes, the history hears about it once, and Escape puts it back.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ interacting: null, insideFrame: null, frameSelection: [] })
})

const make = (): string => {
  const id = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 100, y: 200 }, text: 'AB' })
  store().commit('Draw')
  return id
}
const at = (id: string) => {
  const t = store().doc.objects[id]!.transform
  return [t.x, t.y]
}

describe('dragging an object by a handle', () => {
  it('moves the object with the pointer and records one entry at the end', () => {
    const id = make()
    const past = store().past.length
    const drag = beginObjectDrag(id, { x: 10, y: 10 })!
    expect(useUiStore.getState().interacting, 'held still while dragged').toBe(id)
    drag.move({ x: 40, y: 15 })
    expect(at(id)).toEqual([130, 205])
    drag.move({ x: 60, y: 60 })
    expect(at(id)).toEqual([150, 250])
    expect(store().past.length, 'nothing recorded mid-drag').toBe(past)
    drag.end()
    expect(store().past.length).toBe(past + 1)
    expect(store().past[past]!.label).toBe('Move')
    expect(useUiStore.getState().interacting).toBeNull()
  })

  it('records nothing for a press that never moved, and puts a cancelled drag back', () => {
    const id = make()
    const past = store().past.length
    beginObjectDrag(id, { x: 0, y: 0 })!.end()
    expect(store().past.length).toBe(past)

    const drag = beginObjectDrag(id, { x: 0, y: 0 })!
    drag.move({ x: 50, y: 50 })
    expect(at(id)).toEqual([150, 250])
    drag.cancel()
    expect(at(id)).toEqual([100, 200])
    expect(store().past.length).toBe(past)
    expect(useUiStore.getState().interacting).toBeNull()
  })

  it('holds a move to its dominant axis while Shift is down, and lets go when it is not', () => {
    expect(constrainMove({ x: 30, y: 10 })).toEqual({ x: 30, y: 0 })
    expect(constrainMove({ x: -4, y: 12 })).toEqual({ x: 0, y: 12 })
    expect(constrainMove({ x: 5, y: -5 }), 'a tie goes to x').toEqual({ x: 5, y: 0 })
    const id = make()
    const drag = beginObjectDrag(id, { x: 0, y: 0 })!
    drag.move({ x: 40, y: 15 }, true)
    expect(at(id)).toEqual([140, 200])
    // The pointer has gone further down now: the axis follows it.
    drag.move({ x: 40, y: 90 }, true)
    expect(at(id)).toEqual([100, 290])
    // Shift let go mid-drag: the pointer's own place.
    drag.move({ x: 40, y: 90 })
    expect(at(id)).toEqual([140, 290])
    drag.end()
  })

  it('refuses a locked object', () => {
    const id = make()
    store().setBase(id, { locked: true })
    expect(beginObjectDrag(id, { x: 0, y: 0 })).toBeNull()
  })
})

describe('nudging the selection with the arrows', () => {
  it('moves every selected object by the offset, one history entry per press', () => {
    const a = make()
    const b = make()
    store().setSelection([a, b])
    const past = store().past.length
    expect(nudgeSelection({ x: 1, y: 0 })).toBe(true)
    expect(at(a)).toEqual([101, 200])
    expect(at(b)).toEqual([101, 200])
    expect(nudgeSelection({ x: 0, y: 10 })).toBe(true)
    expect(at(a)).toEqual([101, 210])
    expect(store().past.length).toBe(past + 2)
    expect(store().past[past]!.label).toBe('Nudge')
  })

  it('moves nothing that is locked, and says so when nothing moved', () => {
    const id = make()
    store().setBase(id, { locked: true })
    store().setSelection([id])
    const past = store().past.length
    expect(nudgeSelection({ x: 5, y: 0 })).toBe(false)
    expect(at(id)).toEqual([100, 200])
    expect(store().past.length).toBe(past)
    store().clearSelection()
    expect(nudgeSelection({ x: 5, y: 0 })).toBe(false)
  })

  it('moves a member picked inside a frame, in the frame’s own space', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 400, height: 300 }, artboardCenter: { x: 0, y: 0 } })
    const inner = make()
    store().addToFrame(frame, [inner])
    const member = (store().doc.objects[frame] as { members: { id: string; object: { transform: { x: number } } }[] }).members[0]!
    const restingX = member.object.transform.x
    useUiStore.setState({ insideFrame: frame, frameSelection: [member.id] })
    expect(nudgeSelection({ x: 4, y: 0 })).toBe(true)
    const state = (store().doc.objects[frame] as { states: { values: Record<string, { transform?: { x: number } }> }[] }).states[0]!
    expect(state.values[member.id]?.transform?.x).toBe(restingX + 4)
    // The frame itself stayed put.
    expect(store().doc.objects[frame]!.transform.x).toBe(0)
  })
})
