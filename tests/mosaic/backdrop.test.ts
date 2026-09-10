import { beforeEach, describe, expect, it } from 'vitest'

import { initialState, sameGeometry, seedMosaic } from '../../src/mosaic/dissection'
import { evaluateMosaicAtTime } from '../../src/mosaic/timeline'
import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import type { LetterMosaicObject, Rect } from '../../src/types/document'
import type { MosaicState } from '../../src/types/mosaic'

/**
 * The colour behind the whole mosaic.
 *
 * Not a property of any tile: it fills the outer padding and the gaps between
 * tiles, which no tile owns. One value per state, interpolated like a tile
 * background — and null means no backdrop at all, which is not the same as a
 * transparent one.
 */

const BOX: Rect = { x: -180, y: -180, width: 360, height: 360 }
const base = seedMosaic(3, 3)

const stateFrom = (patch: Partial<MosaicState> = {}): MosaicState => ({
  ...initialState(base.x, base.y, { fontId: 'anton', weight: 400, italic: false }),
  ...patch,
})

const mosaicWith = (states: MosaicState[]): LetterMosaicObject =>
  ({
    kind: 'mosaic',
    id: 'm1',
    name: 'Mosaic',
    localBounds: BOX,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    tiles: base.tiles,
    seed: { columns: 3, rows: 3 },
    font: { fontId: 'anton', weight: 400 },
    states,
    activeState: 0,
    gap: 6,
    outerPadding: 0,
    glyphInset: 6,
    snapStep: 10,
    loop: true,
    speed: 1,
    opacity: 1,
    visible: true,
    locked: false,
  }) as LetterMosaicObject

describe('a new mosaic', () => {
  it('has no backdrop, which is not the same as a colour', () => {
    expect(stateFrom().background).toBeNull()
  })
})

describe('the backdrop through a transition', () => {
  const timing = { holdMs: 0, transitionMs: 1000, easing: 'linear' as const }

  it('is the state being left at the start and the next one at the end', () => {
    const mosaic = mosaicWith([
      stateFrom({ ...timing, background: '#000000ff' }),
      stateFrom({ ...timing, background: '#ffffffff' }),
    ])

    expect(evaluateMosaicAtTime(mosaic, 0).background).toBe('#000000ff')
    expect(evaluateMosaicAtTime(mosaic, 1000).background).toBe('#ffffffff')
  })

  it('blends between two colours on the way', () => {
    const mosaic = mosaicWith([
      stateFrom({ ...timing, background: '#000000ff' }),
      stateFrom({ ...timing, background: '#ffffffff' }),
    ])

    const half = evaluateMosaicAtTime(mosaic, 500).background
    expect(half).toBeTruthy()
    expect(half).not.toBe('#000000ff')
    expect(half).not.toBe('#ffffffff')
  })

  it('fades IN from nothing rather than through some other colour', () => {
    /*
     * A backdrop arriving where there was none is that colour at zero alpha
     * growing opaque. Blended against an invented opaque default it would sweep
     * through a colour nobody chose — black, most likely, which is exactly the
     * dark edge this avoids.
     */
    const mosaic = mosaicWith([
      stateFrom({ ...timing, background: null }),
      stateFrom({ ...timing, background: '#ff0000ff' }),
    ])

    const half = evaluateMosaicAtTime(mosaic, 500).background as string
    expect(half).toBeTruthy()
    // Still red, only half opaque — the hue never left the colour being reached.
    expect(half.slice(0, 7)).toBe('#ff0000')
    expect(half.slice(7)).not.toBe('ff')
  })

  it('stays nothing when neither state has one', () => {
    const mosaic = mosaicWith([
      stateFrom({ ...timing, background: null }),
      stateFrom({ ...timing, background: null }),
    ])

    expect(evaluateMosaicAtTime(mosaic, 500).background).toBeNull()
  })
})

describe('two states that differ only in their backdrop', () => {
  it('are not copies of each other', () => {
    // Or an edit carrying forward would overwrite the authored one, and deleting
    // it would not think to ask.
    const plain = stateFrom()
    const painted = stateFrom({ background: '#123456ff' })

    expect(sameGeometry(plain, plain)).toBe(true)
    expect(sameGeometry(plain, painted)).toBe(false)
  })
})

describe('setting the backdrop', () => {
  beforeEach(() => {
    useDocumentStore.getState().resetDocument()
  })

  const madeMosaic = (): string =>
    useDocumentStore.getState().createMosaic({
      columns: 3,
      rows: 3,
      artboardCenter: { x: 0, y: 0 },
    })

  it('carries forward through states that are still copies', () => {
    const id = madeMosaic()
    const store = useDocumentStore.getState()
    store.duplicateMosaicState(id, 0)
    store.duplicateMosaicState(id, 0)

    useDocumentStore.getState().setMosaicBackground(id, 0, '#abcdefff')

    const after = mosaicIn(useDocumentStore.getState().doc, id)
    expect(after.states.length).toBeGreaterThan(1)
    for (const state of after.states) expect(state.background).toBe('#abcdefff')
  })

  it('stops at a state that was authored differently', () => {
    const id = madeMosaic()
    useDocumentStore.getState().duplicateMosaicState(id, 0)
    useDocumentStore.getState().setMosaicBackground(id, 1, '#111111ff')

    // State 1 is now authored, so an edit to state 0 must not reach it.
    useDocumentStore.getState().setMosaicBackground(id, 0, '#222222ff')

    const after = mosaicIn(useDocumentStore.getState().doc, id)
    expect(after.states[0]?.background).toBe('#222222ff')
    expect(after.states[1]?.background).toBe('#111111ff')
  })

  it('clears back to nothing rather than to a colour', () => {
    const id = madeMosaic()
    useDocumentStore.getState().setMosaicBackground(id, 0, '#abcdefff')
    useDocumentStore.getState().setMosaicBackground(id, 0, null)

    expect(mosaicIn(useDocumentStore.getState().doc, id).states[0]?.background).toBeNull()
  })

  it('writing the colour already there changes nothing', () => {
    // A picker that lands back where it started must leave no undo entry.
    const id = madeMosaic()
    useDocumentStore.getState().setMosaicBackground(id, 0, '#abcdefff')
    const before = useDocumentStore.getState().doc

    useDocumentStore.getState().setMosaicBackground(id, 0, '#abcdefff')

    expect(useDocumentStore.getState().doc).toBe(before)
  })
})
