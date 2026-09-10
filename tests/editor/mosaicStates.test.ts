import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteStateAt, duplicateStateAt } from '../../src/editor/mosaicStates'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * Adding and removing states, as the buttons in the state row do it.
 *
 * The store actions underneath are already covered; what is checked here is the
 * part that lives above them — which state you are left looking at afterwards,
 * and that removing one always works.
 *
 * Nothing asks a question first, and the tests say so on purpose. A
 * `window.confirm` used to guard deleting an authored state, and a browser that
 * suppresses dialogs — which Chrome does for the rest of a session once someone
 * ticks the box — turned the button into a no-op with no way to tell why. Undo
 * is the safety net instead.
 */

const store = () => useDocumentStore.getState()

function mosaic(id: string): LetterMosaicObject {
  const object = store().doc.objects[id]
  if (object?.kind !== 'mosaic') throw new Error('expected a mosaic')
  return object
}

function make(): string {
  const id = store().createMosaic({
    columns: 2,
    rows: 2,
    artboardCenter: { x: 0, y: 0 },
    text: 'ABCD',
  })
  store().commit('Draw mosaic')
  return id
}

/** Make a state hold something its neighbours do not. */
function author(id: string, at: number): void {
  const leaf = mosaic(id).tiles[0]?.id as string
  store().setMosaicGlyphColour(id, at, [leaf], '#ff0000')
  store().commit('Colour letters')
}

let confirm: ReturnType<typeof vi.fn>

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ mosaicStates: {}, mosaicPlayback: null })
  // The module asks through `window.confirm`; these tests run without a DOM.
  confirm = vi.fn(() => true)
  vi.stubGlobal('window', { confirm })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('duplicating the state on show', () => {
  it('puts the copy straight after it and goes there', () => {
    const id = make()
    const before = mosaic(id).states.length

    expect(duplicateStateAt(mosaic(id), 0)).toBe(true)

    expect(mosaic(id).states.length).toBe(before + 1)
    // Selected, because duplicating means "another like this, then I change it".
    expect(useUiStore.getState().mosaicStates[id]).toBe(1)
  })

  it('copies what the state holds rather than starting over', () => {
    const id = make()
    author(id, 0)
    const leaf = mosaic(id).tiles[0]?.id as string

    duplicateStateAt(mosaic(id), 0)

    expect(mosaic(id).states[1]?.glyphColour[leaf]).toBe('#ff0000')
  })

  it('never asks a question', () => {
    const id = make()
    author(id, 0)
    duplicateStateAt(mosaic(id), 0)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('deleting the state on show', () => {
  it('removes it and lands on the nearest survivor', () => {
    const id = make()
    const before = mosaic(id).states.length

    expect(deleteStateAt(mosaic(id), 1)).toBe(true)

    expect(mosaic(id).states.length).toBe(before - 1)
    expect(useUiStore.getState().mosaicStates[id]).toBe(1)
  })

  it('removes a state that holds its own composition, without asking', () => {
    const id = make()
    author(id, 1)
    const leaf = mosaic(id).tiles[1]?.id as string
    store().setMosaicGlyphColour(id, 1, [leaf], '#00ff00')
    store().commit('Colour letters')
    const before = mosaic(id).states.length

    expect(deleteStateAt(mosaic(id), 1)).toBe(true)
    expect(mosaic(id).states.length).toBe(before - 1)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('works even where a browser has stopped showing dialogs', () => {
    // A suppressed `confirm` answers false without asking anyone. Nothing here
    // may depend on its answer, or the button dies for the rest of the session.
    confirm.mockReturnValue(false)
    const id = make()
    author(id, 1)
    const before = mosaic(id).states.length

    expect(deleteStateAt(mosaic(id), 1)).toBe(true)
    expect(mosaic(id).states.length).toBe(before - 1)
  })

  it('puts the state back on undo, which is what makes not asking safe', () => {
    const id = make()
    author(id, 1)
    const leaf = mosaic(id).tiles[1]?.id as string
    store().setMosaicGlyphColour(id, 1, [leaf], '#00ff00')
    store().commit('Colour letters')
    const before = mosaic(id).states.map((each) => each.id)

    deleteStateAt(mosaic(id), 1)
    store().undo()

    expect(mosaic(id).states.map((each) => each.id)).toEqual(before)
  })

  it('refuses to take the timeline below two states', () => {
    const id = make()
    store().setMosaicStateCount(id, 2)
    store().commit('Change state count')

    expect(deleteStateAt(mosaic(id), 0)).toBe(false)
    expect(mosaic(id).states.length).toBe(2)
    expect(confirm, 'and does not ask a question it will not act on').not.toHaveBeenCalled()
  })

  it('never leaves the picker pointing past the end', () => {
    const id = make()
    const last = mosaic(id).states.length - 1
    useUiStore.getState().setMosaicState(id, last)

    deleteStateAt(mosaic(id), last)

    const shown = useUiStore.getState().mosaicStates[id] ?? 0
    expect(shown).toBeLessThan(mosaic(id).states.length)
  })
})
