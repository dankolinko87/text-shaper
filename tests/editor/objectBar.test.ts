import { beforeEach, describe, expect, it } from 'vitest'

import { valuesFor } from '../../src/frame/frame'
import {
  addState,
  moves,
  plateBounds,
  playing,
  spreadBounds,
  togglePlay,
  toggleSpread,
} from '../../src/editor/objectBarActions'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { FrameObject } from '../../src/types/document'

/**
 * The rules behind the bar under a selected object, called as the bar calls
 * them — against the real stores, so a change to what "play" or "add" means
 * fails here before it fails on screen.
 */

const store = () => useDocumentStore.getState()
const ui = () => useUiStore.getState()

let frame: string
let shape: string

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
  useUiStore.setState({
    insideFrame: null,
    frameSelection: [],
    spreadFrame: null,
    mosaicStates: {},
    mosaicPlayback: null,
    previewObject: null,
  })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 0, y: 0 },
  })
  shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 20, y: 10 },
    name: 'Box',
  })
})

describe('whether there is anything to play', () => {
  it('is nothing for a plain shape, or a frame whose states are still copies', () => {
    expect(moves(store().doc.objects[shape]!)).toBe(false)
    expect(moves(frameIn())).toBe(false)
  })

  it('is something once one state differs', () => {
    store().addToFrame(frame, [shape])
    const member = frameIn().members[0]!
    const at = valuesFor(member, frameIn().states[1]).transform
    store().setMemberValues(frame, 1, member.id, { transform: { ...at, x: at.x + 50 } })
    expect(moves(frameIn())).toBe(true)
  })
})

describe('play', () => {
  it('starts a frame, and a second press stops it rather than pausing', () => {
    togglePlay(frameIn())
    expect(playing(frameIn(), ui())).toBe(true)
    expect(ui().mosaicPlayback).toMatchObject({ object: frame, playing: true })

    togglePlay(frameIn())
    expect(playing(frameIn(), ui())).toBe(false)
    expect(ui().mosaicPlayback, 'stopped, not paused').toBeNull()
  })

  it('folds a spread frame back to one window and plays it, in one press', () => {
    ui().setSpreadFrame(frame)
    expect(ui().spreadFrame).toBe(frame)

    togglePlay(frameIn())
    expect(ui().spreadFrame, 'the row is gone').toBeNull()
    expect(ui().mosaicPlayback).toMatchObject({ object: frame, playing: true })
  })

  it('previews a shape on its own switch', () => {
    const object = store().doc.objects[shape]!
    togglePlay(object)
    expect(ui().previewObject).toBe(shape)
    expect(playing(object, ui())).toBe(true)
    togglePlay(object)
    expect(ui().previewObject).toBeNull()
  })
})

describe('adding a state', () => {
  it('copies the one on show and goes to the copy', () => {
    ui().setMosaicState(frame, 0)
    expect(addState(frameIn(), 0)).toBe(true)
    expect(frameIn().states).toHaveLength(3)
    expect(ui().mosaicStates[frame], 'the copy, straight after the original').toBe(1)
  })

  it('copies the LAST one while spread, so the row grows at its end', () => {
    ui().setSpreadFrame(frame)
    ui().setMosaicState(frame, 0)
    expect(addState(frameIn(), 0)).toBe(true)
    expect(frameIn().states).toHaveLength(3)
    expect(ui().mosaicStates[frame], 'the new last window').toBe(2)
  })
})

describe('the spread', () => {
  it('opens with nothing playing, and closes', () => {
    togglePlay(frameIn())
    toggleSpread(frameIn())
    expect(ui().spreadFrame).toBe(frame)
    expect(ui().mosaicPlayback, 'nothing plays into a spread').toBeNull()
    toggleSpread(frameIn())
    expect(ui().spreadFrame).toBeNull()
  })

  it('hangs its bar from the whole row, whatever the frame’s scale', () => {
    const object = frameIn()
    const one = spreadBounds(object)
    expect(one.x).toBe(object.localBounds.x)
    expect(one.width).toBeGreaterThan(object.localBounds.width * object.states.length)

    const scaled = { ...object, transform: { ...object.transform, scaleX: 2 } }
    expect(spreadBounds(scaled).width, 'in the frame’s own units, so scale cancels').toBeCloseTo(
      one.width,
      6,
    )
  })
})

describe('the plate behind a held frame', () => {
  it('pads a collapsed frame evenly, with no room on top for chips it does not have', () => {
    const object = frameIn()
    const plate = plateBounds(object, false, 1)
    const box = object.localBounds
    const side = box.x - plate.x
    expect(side).toBeGreaterThan(0)
    expect(plate.width - box.width, 'the same on both sides').toBeCloseTo(side * 2, 6)
    expect(box.y - plate.y, 'and on top').toBeCloseTo(side, 6)
    expect(plate.height - box.height, 'and below').toBeCloseTo(side * 2, 6)
  })

  it('makes screen-sized room for the number chips above a spread row', () => {
    const object = frameIn()
    const row = spreadBounds(object)
    const wide = plateBounds(object, true, 1)
    const side = row.x - wide.x
    expect(wide.width - row.width).toBeCloseTo(side * 2, 6)
    expect(row.y - wide.y, 'at least the side padding').toBeGreaterThanOrEqual(side)

    // Zoomed out, the chips are the same size on screen, so they need more of
    // the frame's own units above the row.
    const far = plateBounds(object, true, 0.25)
    expect(row.y - far.y).toBeGreaterThan(row.y - wide.y)
  })
})
