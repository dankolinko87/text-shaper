import { beforeEach, describe, expect, it } from 'vitest'

import { beginObjectDrag } from '../../src/editor/objectDrag'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'

/**
 * A drag by the plate or the name: the object follows the pointer as it
 * goes, the history hears about it once, and Escape puts it back.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ interacting: null })
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

  it('refuses a locked object', () => {
    const id = make()
    store().setBase(id, { locked: true })
    expect(beginObjectDrag(id, { x: 0, y: 0 })).toBeNull()
  })
})
