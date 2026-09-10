import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../../src/state/uiStore'

/**
 * Which tiles are being worked on, and where the next letter goes, are two
 * different questions.
 *
 * They were one for a while, because entering a mosaic normally means putting a
 * caret in a tile, and the tile the caret is in is the tile you are working on.
 * The Colour tab broke that: colouring is about which tiles, and has no caret at
 * all. Dropping the caret there must not throw away the selection with it — that
 * is what made Shift-click unable to add a second tile, since every press
 * emptied the selection before the press could extend it.
 */
describe('the caret and the tile selection', () => {
  beforeEach(() => {
    useUiStore.setState({ typing: null, mosaicSelection: [] })
  })

  it('keeps the chosen tiles when the caret is dropped', () => {
    useUiStore.getState().setMosaicSelection(['a', 'b'])
    useUiStore.getState().setTyping({ object: 'o', leaf: 'a' })

    useUiStore.getState().setTyping(null)

    expect(useUiStore.getState().typing).toBeNull()
    expect(useUiStore.getState().mosaicSelection).toEqual(['a', 'b'])
  })

  it('lets a second tile be added to the first, as Shift-click does it', () => {
    // Exactly the order the layer performs: the press drops the caret, then the
    // tile under it is toggled in, then the caret follows the tile just added.
    useUiStore.getState().setMosaicSelection(['a'])
    useUiStore.getState().setTyping({ object: 'o', leaf: 'a' })

    useUiStore.getState().setTyping(null)
    useUiStore.getState().toggleMosaicSelection('b')
    useUiStore.getState().setTyping({ object: 'o', leaf: 'b' })

    expect(useUiStore.getState().mosaicSelection).toEqual(['a', 'b'])
  })

  it('still moves the working tile when the caret lands somewhere unselected', () => {
    useUiStore.getState().setMosaicSelection(['a'])

    useUiStore.getState().setTyping({ object: 'o', leaf: 'c' })

    expect(useUiStore.getState().mosaicSelection).toEqual(['c'])
  })
})
