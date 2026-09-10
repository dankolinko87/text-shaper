import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import { deserializeDocument } from '../../src/state/persistence'
import { mosaicIn } from '../fixtures/objects'

/**
 * What a mosaic says, state by state.
 *
 * Letters joined the colours on the state rather than staying on the tiles: a
 * tile is a place in the partition — the one thing every state agrees on — and
 * what is written there is part of the composition. That is what lets a letter
 * change, or go away entirely, between one state and the next.
 */

const store = () => useDocumentStore.getState()

beforeEach(() => {
  store().resetDocument()
})

function make(text = 'ABCD'): string {
  const id = store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 }, text })
  store().commit('Draw mosaic')
  return id
}

const object = (id: string) => mosaicIn(store().doc, id)
const said = (id: string, at: number) => {
  const mosaic = object(id)
  return mosaic.tiles.map((tile) => mosaic.states[at]!.chars[tile.id] ?? '_').join('')
}

describe('writing into one state', () => {
  it('starts with the same text in every state', () => {
    const id = make('ABCD')
    expect([said(id, 0), said(id, 1), said(id, 2)]).toEqual(['ABCD', 'ABCD', 'ABCD'])
  })

  it('carries forward through the states that are still copies', () => {
    const id = make('ABCD')
    const first = object(id).tiles[0]!.id
    store().setMosaicChars(id, 0, { ...object(id).states[0]!.chars, [first]: 'Z' })

    // Typing feels like editing the mosaic, not one frame of it.
    expect([said(id, 0), said(id, 1), said(id, 2)]).toEqual(['ZBCD', 'ZBCD', 'ZBCD'])
  })

  it('stops at a state that says something of its own', () => {
    const id = make('ABCD')
    const first = object(id).tiles[0]!.id
    store().setMosaicChars(id, 2, { ...object(id).states[2]!.chars, [first]: 'Q' })
    store().setMosaicChars(id, 0, { ...object(id).states[0]!.chars, [first]: 'Z' })

    expect([said(id, 0), said(id, 1), said(id, 2)]).toEqual(['ZBCD', 'ZBCD', 'QBCD'])
  })

  it('lets a letter go away in one state and come back in the next', () => {
    const id = make('ABCD')
    const first = object(id).tiles[0]!.id
    const without = { ...object(id).states[1]!.chars }
    delete without[first]
    store().setMosaicChars(id, 1, without)

    expect(said(id, 1)).toBe('_BCD')
    expect(said(id, 2), 'the state after it followed the empty one').toBe('_BCD')
    expect(said(id, 0), 'and the one before is untouched').toBe('ABCD')
  })

  it('refuses letters for tiles that are not there', () => {
    const id = make('ABCD')
    store().setMosaicChars(id, 0, { ...object(id).states[0]!.chars, ghost: 'X' })
    expect(object(id).states[0]!.chars['ghost']).toBeUndefined()
  })

  it('writes an empty string as no entry at all, so nothing has one form', () => {
    const id = make('ABCD')
    const first = object(id).tiles[0]!.id
    store().setMosaicChars(id, 0, { ...object(id).states[0]!.chars, [first]: '' })
    expect(Object.prototype.hasOwnProperty.call(object(id).states[0]!.chars, first)).toBe(false)
  })

  it('makes no change, and so no undo entry, when nothing moves', () => {
    const id = make('ABCD')
    const before = store().doc
    store().setMosaicChars(id, 0, { ...object(id).states[0]!.chars })
    expect(store().doc).toBe(before)
  })
})

describe('a document written before letters moved', () => {
  const atVersion24 = () => ({
    schemaVersion: 24,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -180, y: -180, width: 360, height: 360 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        seed: { columns: 2, rows: 1 },
        // The letters still on the tiles, which is where they used to live.
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [0, 1].map((n) => ({
          id: `s${n}`,
          x: { c_x: 0.5 },
          y: {},
          glyphColour: {},
          tileColour: {},
          holdMs: 0,
          transitionMs: 400,
          easing: 'linear',
          font: { fontId: 'anton', weight: 400, italic: false },
          gap: 6,
          outerPadding: 0,
          glyphInset: 6,
          tileRadius: 0,
          outerRadius: 0,
        })),
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  it('gives every state the letters the tiles were carrying', () => {
    const result = deserializeDocument(JSON.stringify(atVersion24()))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')

    // It loads saying exactly what it said, in both states.
    for (const state of mosaic.states) {
      expect(state.chars).toEqual({ t1: 'A', t2: 'B' })
    }
    expect('char' in (mosaic.tiles[0] as object), 'and the tile no longer carries it').toBe(false)
  })
})
