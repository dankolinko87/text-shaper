import { beforeEach, describe, expect, it } from 'vitest'

import { allTiles, colourTargets, mosaicTiles } from '../../src/mosaic/tiles'
import { readingOrder } from '../../src/mosaic/order'
import { useDocumentStore } from '../../src/state/documentStore'
import { mosaicIn } from '../fixtures/objects'
import type { LetterMosaicObject } from '../../src/types/document'

/**
 * What a colour edit writes to when no tiles have been picked out.
 *
 * Selecting the mosaic and opening the Colour tab is already a complete
 * request — colour this thing. The panel used to answer it by disabling both
 * fields until tiles were swept, so painting every glyph meant selecting the
 * whole mosaic twice over: once as an object, then again as tiles.
 */

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
})

function mosaic(columns = 4, rows = 3): LetterMosaicObject {
  const id = useDocumentStore.getState().createMosaic({
    columns,
    rows,
    artboardCenter: { x: 0, y: 0 },
  })
  return mosaicIn(useDocumentStore.getState().doc, id)
}

describe('every tile', () => {
  it('is each leaf exactly once', () => {
    const object = mosaic(4, 3)
    const all = allTiles(object)

    expect(all).toHaveLength(12)
    expect(new Set(all).size).toBe(12)
    // The same leaves the layout produces, not a separately-built list.
    expect(new Set(all)).toEqual(new Set(mosaicTiles(object).keys()))
  })

  it('is in reading order, so a write walks the mosaic the way the caret does', () => {
    const object = mosaic(4, 3)

    expect(allTiles(object)).toEqual(readingOrder(mosaicTiles(object)))
  })
})

describe('the tiles a colour edit writes to', () => {
  it('is the whole mosaic when none are picked out', () => {
    const object = mosaic(3, 3)

    expect(colourTargets(object, 0, [])).toEqual(allTiles(object, 0))
  })

  it('is exactly the ones picked out when some are', () => {
    const object = mosaic(3, 3)
    const some = allTiles(object).slice(2, 5)

    expect(colourTargets(object, 0, some)).toEqual(some)
  })

  it('never widens a selection of one to the whole mosaic', () => {
    // The failure that would matter most: one tile picked, every tile painted.
    const object = mosaic(3, 3)
    const one = [allTiles(object)[4] as string]

    expect(colourTargets(object, 0, one)).toEqual(one)
    expect(colourTargets(object, 0, one)).toHaveLength(1)
  })

  it('asks the state on show, because tiles belong to a state', () => {
    const object = mosaic(3, 3)
    const at = object.states.length - 1

    expect(colourTargets(object, at, [])).toEqual(allTiles(object, at))
  })

  it('hands back a copy, so a caller cannot write through it into the selection', () => {
    const object = mosaic(2, 2)
    const selection = allTiles(object).slice(0, 2)
    const targets = colourTargets(object, 0, selection)

    targets.push('mt_intruder')

    expect(selection).toHaveLength(2)
  })
})
