import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import type { ImageAsset, ImagePaint } from '../../src/types/paint'

/**
 * The pictures a document carries: kept once each, dropped when nothing
 * refers to them, and travelling with a paste.
 */

const store = () => useDocumentStore.getState()
const asset = (id: string): ImageAsset => ({ id, src: `data:image/png;base64,${id}`, width: 8, height: 8 })
const picture = (id: string): ImagePaint => ({ kind: 'image', asset: id, crop: { scale: 1, x: 0, y: 0 } })

beforeEach(() => {
  store().resetDocument()
})

describe('the document’s pictures', () => {
  it('keeps a picture once, however many times it is added', () => {
    expect(store().addAsset(asset('img_a'))).toBe('img_a')
    const before = store().doc
    store().addAsset(asset('img_a'))
    expect(store().doc, 'the same picture again changes nothing').toBe(before)
    expect(Object.keys(store().doc.assets)).toEqual(['img_a'])
  })

  it('drops pictures nothing refers to, and keeps the ones something does', () => {
    store().addAsset(asset('img_used'))
    store().addAsset(asset('img_lost'))
    const id = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
    const tile = store().doc.objects[id]!.kind === 'mosaic' ? (store().doc.objects[id] as { tiles: { id: string }[] }).tiles[0]!.id : ''
    store().setMosaicTileColour(id, 0, [tile], picture('img_used'))
    store().sweepAssets()
    expect(Object.keys(store().doc.assets)).toEqual(['img_used'])
    const swept = store().doc
    store().sweepAssets()
    expect(store().doc, 'nothing to drop, nothing changes').toBe(swept)
  })

  it('travel with a paste, and a picture already here is not added again', () => {
    const id = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    const tile = (store().doc.objects[id] as { tiles: { id: string }[] }).tiles[0]!.id
    store().setMosaicBackground(id, 0, picture('img_p'))
    store().setMosaicTileColour(id, 0, [tile], picture('img_q'))
    const copied = [store().doc.objects[id]!]
    store().addAsset(asset('img_q'))
    const made = store().pasteObjects(copied, { img_p: asset('img_p'), img_q: { ...asset('img_q'), width: 99 } })
    expect(made).toHaveLength(1)
    expect(store().doc.assets['img_p']).toEqual(asset('img_p'))
    expect(store().doc.assets['img_q']!.width, 'the one already here wins').toBe(8)
    const pasted = store().doc.objects[made[0]!]
    expect(pasted?.kind === 'mosaic' && pasted.states[0]!.background).toEqual(picture('img_p'))
  })
})
