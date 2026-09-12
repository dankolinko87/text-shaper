import { beforeEach, describe, expect, it } from 'vitest'

import { pointObjectToArtboard } from '../../src/geometry/objectSpace'
import { windowOffset } from '../../src/editor/renderer'
import {
  addState,
  changeStateCount,
  deleteStateAt,
  doublePressOutside,
  duplicateStateAt,
  kindOf,
  moveStateTo,
  plateBounds,
  pressOutside,
  showState,
  shownWindow,
  spreadBounds,
  spreadHoldsGround,
  togglePlay,
  toggleSpread,
  windowIndexAt,
  windowTransform,
} from '../../src/editor/stated'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { Stated } from '../../src/types/document'
import { isStated } from '../../src/types/document'

/**
 * One mechanism for every object with states, asked the same questions of
 * each kind in turn.
 *
 * The point of `stated.ts` is that a change to what "show", "duplicate",
 * "spread" or "a press beside the row" means changes every kind together. So
 * the spec runs once per kind: whatever is asserted of a mosaic is asserted of
 * a frame with the same words, and a kind that joins them is a third row here.
 */

const store = () => useDocumentStore.getState()
const ui = () => useUiStore.getState()

const reset = (): void => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  useUiStore.setState({
    insideFrame: null,
    frameSelection: [],
    spread: null,
    mosaicStates: {},
    mosaicPlayback: null,
    previewObject: null,
    playing: false,
  })
}

/** A mosaic is born with three states. */
const makeMosaic = (): string =>
  store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 300, y: 200 }, text: 'ABCD' })

/** A frame is born with two; a third makes a row plainly a row. */
const makeFrame = (): string => {
  const id = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 300, y: 200 },
  })
  store().duplicateFrameState(id, 1)
  store().commit('Duplicate state')
  return id
}

/** A mesh is born with three states, like the mosaic it grew out of. */
const makeMesh = (): string =>
  store().createMesh({ columns: 2, rows: 2, artboardCenter: { x: 300, y: 200 }, text: 'ABCD' })

describe.each([
  ['mosaic', makeMosaic],
  ['frame', makeFrame],
  ['mesh', makeMesh],
])('an object with states: the %s', (kindName, make) => {
  let id: string
  const object = (): Stated => {
    const found = store().doc.objects[id]
    if (!found || !isStated(found)) throw new Error(`expected a ${kindName}`)
    return found
  }

  beforeEach(() => {
    reset()
    id = make()
    store().setSelection([id])
  })

  it('knows its kind, its floor and its ceiling', () => {
    const kind = kindOf(object())
    expect(kind.noun).toBe(kindName)
    expect(kind.min).toBe(2)
    expect(kind.max).toBe(12)
    expect(object().states).toHaveLength(3)
  })

  it('shows a state and stops any preview, and refuses an index it has not got', () => {
    ui().playMosaic(id)
    showState(object(), 2)
    expect(ui().mosaicStates[id]).toBe(2)
    expect(ui().mosaicPlayback, 'choosing a state is asking to see it exactly').toBeNull()
    showState(object(), 9)
    expect(ui().mosaicStates[id], 'out of range is ignored').toBe(2)
  })

  it('duplicates a state to the slot after it and goes there, undoably', () => {
    const past = store().past.length
    expect(duplicateStateAt(object(), 1)).toBe(true)
    expect(object().states).toHaveLength(4)
    expect(ui().mosaicStates[id], 'the copy is what you are looking at').toBe(2)
    expect(store().past.length).toBe(past + 1)
  })

  it('refuses to duplicate past the ceiling', () => {
    while (object().states.length < kindOf(object()).max) duplicateStateAt(object(), 0)
    expect(object().states).toHaveLength(12)
    expect(duplicateStateAt(object(), 0)).toBe(false)
  })

  it('takes one backdrop for every state at once, and clears it from every state', () => {
    store().setStatedBackground(id, '#ff8800ff')
    expect(object().states.map((state) => state.background ?? null)).toEqual(
      object().states.map(() => '#ff8800ff'),
    )
    // Writing the same colour again is not a change.
    const before = store().doc
    store().setStatedBackground(id, '#ff8800ff')
    expect(store().doc).toBe(before)
    store().setStatedBackground(id, null)
    expect(object().states.every((state) => (state.background ?? null) === null)).toBe(true)
  })

  it('deletes a state and lands on the nearest survivor, down to the floor', () => {
    showState(object(), 2)
    expect(deleteStateAt(object(), 2)).toBe(true)
    expect(object().states).toHaveLength(2)
    expect(ui().mosaicStates[id]).toBe(1)
    expect(deleteStateAt(object(), 0), 'two is the floor').toBe(false)
    expect(object().states).toHaveLength(2)
  })

  it('moves a state and follows the one that moved', () => {
    const first = object().states[0]!.id
    expect(moveStateTo(object(), 0, 2)).toBe(true)
    expect(object().states[2]!.id).toBe(first)
    expect(ui().mosaicStates[id], 'dragging something is holding on to it').toBe(2)
  })

  it('offers a count only where the kind is born with states', () => {
    showState(object(), 2)
    const changed = changeStateCount(object(), 2)
    if (kindOf(object()).setCount) {
      expect(changed).toBe(true)
      expect(object().states).toHaveLength(2)
      expect(ui().mosaicStates[id], 'the cursor steps back to the last state').toBe(1)
    } else {
      expect(changed).toBe(false)
      expect(object().states).toHaveLength(3)
    }
  })

  describe('the spread', () => {
    it('opens with nothing playing, and closes', () => {
      ui().playMosaic(id)
      toggleSpread(object())
      expect(ui().spread).toBe(id)
      expect(ui().mosaicPlayback, 'nothing plays into a row').toBeNull()
      expect(spreadHoldsGround()).toBe(true)
      toggleSpread(object())
      expect(ui().spread).toBeNull()
      expect(spreadHoldsGround()).toBe(false)
    })

    it('enters a frame, whose windows are for picking members in, and nothing else', () => {
      toggleSpread(object())
      expect(ui().insideFrame).toBe(kindName === 'frame' ? id : null)
    })

    it('folds and plays in one press of play', () => {
      toggleSpread(object())
      togglePlay(object())
      expect(ui().spread).toBeNull()
      expect(ui().mosaicPlayback).toMatchObject({ object: id, playing: true })
    })

    it('adds a copy of the LAST state while spread, so the row grows at its end', () => {
      showState(object(), 0)
      expect(addState(object(), 0)).toBe(true)
      expect(ui().mosaicStates[id], 'collapsed: after the one on show').toBe(1)
      toggleSpread(object())
      showState(object(), 0)
      expect(addState(object(), 0)).toBe(true)
      expect(object().states).toHaveLength(5)
      expect(ui().mosaicStates[id], 'spread: the new last window').toBe(4)
    })

    it('keeps the row through a single press outside, and folds on a double', () => {
      toggleSpread(object())
      useUiStore.setState({ frameSelection: ['m1'] })
      pressOutside(id)
      expect(ui().spread, 'one press only puts the pick down').toBe(id)
      expect(ui().frameSelection).toEqual([])
      expect(doublePressOutside(id)).toBe(true)
      expect(ui().spread).toBeNull()
      expect(doublePressOutside(id), 'nothing to fold').toBe(false)
    })

    it('says which window the shown state is in', () => {
      showState(object(), 2)
      expect(shownWindow(object(), ui()), 'collapsed: the only window').toBe(0)
      toggleSpread(object())
      expect(shownWindow(object(), ui())).toBe(2)
      useUiStore.setState({ mosaicStates: { [id]: 40 } })
      expect(shownWindow(object(), ui()), 'clamped').toBe(2)
    })

    it('stands a transform along the row', () => {
      const o = object()
      expect(windowTransform(o, 0)).toBe(o.transform)
      expect(windowTransform(o, 2).x).toBeCloseTo(o.transform.x + windowOffset(o, 2), 9)
      expect(windowTransform(o, 2).y).toBe(o.transform.y)
    })

    it('hangs its bar from the whole row, whatever the scale, and pads the plate', () => {
      // Pure geometry: a scaled copy is as good as a scaled object.
      const o: Stated = { ...object(), transform: { ...object().transform, scaleX: 2 } }
      const row = spreadBounds(o)
      expect(row.width).toBeCloseTo(o.localBounds.width + windowOffset(o, 2) / 2, 6)
      const one = plateBounds(o, false, 1)
      const all = plateBounds(o, true, 1)
      expect(all.width).toBeGreaterThan(one.width)
      expect(all.x).toBeCloseTo(one.x, 9)
      expect(all.y, 'room for the chips').toBeLessThanOrEqual(one.y)
    })

    it('finds the window under a point, and no window in a gap or off the row', () => {
      const o: Stated = {
        ...object(),
        transform: { ...object().transform, x: 100, y: 50, scaleX: 2, scaleY: 1 },
      }
      const box = o.localBounds
      const step = windowOffset(o, 1) / o.transform.scaleX
      const gap = step - box.width
      const at = (x: number, y: number) => windowIndexAt(o, pointObjectToArtboard(o.transform, { x, y }))
      const mid = box.y + box.height / 2
      expect(at(box.x + box.width / 2, mid)).toBe(0)
      expect(at(box.x + box.width / 2 + step * 2, mid)).toBe(2)
      expect(at(box.x + box.width + gap / 2, mid), 'in the gap').toBeNull()
      expect(at(box.x + box.width / 2, box.y - 1), 'above the row').toBeNull()
      expect(at(box.x + box.width / 2 + step * 3, mid), 'past the last window').toBeNull()
      expect(at(box.x - 1, mid), 'before the first').toBeNull()
    })
  })
})
