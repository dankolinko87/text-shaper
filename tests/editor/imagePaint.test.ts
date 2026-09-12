import { createCanvas } from 'canvas'
import { Canvas } from 'fabric/node'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { patternTransformOf, placementOf } from '../../src/geometry/imagePlacement'
import { forgetImages, primeImage } from '../../src/editor/imageCache'
import { paintMosaicFrame, glyphReferenceRects } from '../../src/editor/mosaicPlayback'
import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { evaluateMosaicAtTime } from '../../src/mosaic/timeline'
import { mosaicTiles } from '../../src/mosaic/tiles'
import { useDocumentStore } from '../../src/state/documentStore'
import { registerFont } from '../../src/typography/fontRegistry'
import type { LetterMosaicObject } from '../../src/types/document'
import type { ImagePaint } from '../../src/types/paint'

/**
 * A picture on a tile, a letter or a background: a pattern placed to cover
 * its box, that draws nothing until the picture has arrived and is placed
 * again per frame as the crop moves between states.
 */

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont('anton', opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
})

let canvas: Canvas
let rendered: Map<string, RenderedObject>
const store = () => useDocumentStore.getState()
const picture = (asset: string, crop = { scale: 1, x: 0, y: 0 }): ImagePaint => ({ kind: 'image', asset, crop })
const IMAGE = { width: 64, height: 48 }
/** A pattern fill, by its shape: the renderer's Fabric and the test's are two copies of the class. */
type Pattern = { repeat: string; patternTransform?: number[] }
const isPattern = (fill: unknown): fill is Pattern =>
  !!fill && typeof fill === 'object' && (fill as Pattern).repeat === 'no-repeat'

beforeEach(() => {
  store().resetDocument()
  forgetImages()
  canvas = new Canvas(undefined, { width: 800, height: 600 })
  rendered = new Map()
})
afterEach(() => {
  void canvas.dispose()
})

const draw = (): void => {
  rendered = syncCanvas({ canvas, doc: store().doc, textPaths: {}, bandPaths: {}, ribbons: {}, rendered })
}
const mosaic = (id: string): LetterMosaicObject => store().doc.objects[id] as LetterMosaicObject
const child = (id: string, role: string, leaf?: string) =>
  rendered
    .get(id)!
    .group.getObjects()
    .find((o) => o.get('role') === role && (leaf === undefined || o.get('leafId') === leaf))!

describe('a picture on a mosaic', () => {
  it('covers the tile as a pattern, and the whole box as a background', () => {
    primeImage('img_a', createCanvas(IMAGE.width, IMAGE.height) as never)
    const id = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
    const tile = mosaic(id).tiles[0]!.id
    store().setMosaicTileColour(id, 0, [tile], picture('img_a', { scale: 2, x: 0.1, y: 0 }))
    store().setMosaicBackground(id, 0, picture('img_a'))
    draw()

    const rect = child(id, 'tile', tile)
    expect(isPattern(rect.fill)).toBe(true)
    const layout = mosaicTiles(mosaic(id), 0).get(tile)!
    const expected = patternTransformOf(placementOf(layout.visible, IMAGE, { scale: 2, x: 0.1, y: 0 }))
    expect((rect.fill as Pattern).patternTransform).toEqual(expected)
    expect((rect.fill as Pattern).repeat).toBe('no-repeat')

    const extent = child(id, 'extent')
    expect(isPattern(extent.fill)).toBe(true)
    expect((extent.fill as Pattern).patternTransform).toEqual(
      patternTransformOf(placementOf(mosaic(id).localBounds, IMAGE, { scale: 1, x: 0, y: 0 })),
    )
  })

  it('places a letter’s picture over the reference box it was cut for', () => {
    primeImage('img_a', createCanvas(IMAGE.width, IMAGE.height) as never)
    const id = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    const tile = mosaic(id).tiles[0]!.id
    store().setMosaicGlyphColour(id, 0, [tile], picture('img_a'))
    draw()
    const glyph = child(id, 'glyph', tile)
    expect(isPattern(glyph.fill)).toBe(true)
    const reference = glyphReferenceRects(mosaic(id)).get(tile)!
    const ink = glyph.get('inkBox') as { x: number; y: number }
    const place = placementOf(reference, IMAGE, { scale: 1, x: 0, y: 0 })
    const t = (glyph.fill as Pattern).patternTransform!
    expect(t[0]).toBeCloseTo(place.scale, 9)
    expect(t[4]).toBeCloseTo(place.x + (reference.x - ink.x), 6)
    expect(t[5]).toBeCloseTo(place.y + (reference.y - ink.y), 6)
  })

  it('draws nothing until the picture arrives, then rebuilds with it', () => {
    const id = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    store().setMosaicBackground(id, 0, picture('img_late'))
    draw()
    const before = rendered.get(id)!
    expect(child(id, 'extent').fill).toBe('transparent')

    primeImage('img_late', createCanvas(IMAGE.width, IMAGE.height) as never)
    draw()
    expect(rendered.get(id), 'a new group once it can draw').not.toBe(before)
    expect(isPattern(child(id, 'extent').fill)).toBe(true)
  })

  it('moves the picture between two crops as a frame is painted, with its opacity', () => {
    primeImage('img_a', createCanvas(IMAGE.width, IMAGE.height) as never)
    const id = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    store().setMosaicBackground(id, 0, picture('img_a', { scale: 1, x: 0, y: 0 }))
    store().setMosaicBackground(id, 2, { ...picture('img_a', { scale: 3, x: 0.4, y: 0 }), opacity: 0.5 })
    draw()
    const object = mosaic(id)
    const duration = object.states.reduce((sum, s) => sum + s.holdMs + s.transitionMs, 0)
    // Half way through the last transition, into state 3.
    const last = object.states[2]!
    const at = duration - last.transitionMs / 2
    const frame = evaluateMosaicAtTime(object, at)
    expect(frame.background && typeof frame.background === 'object' && frame.background.kind).toBe('image')
    paintMosaicFrame(rendered.get(id)!.group, frame, glyphReferenceRects(object), object.localBounds)
    const extent = child(id, 'extent')
    const crop = (frame.background as ImagePaint).crop
    expect(crop.scale).toBeGreaterThan(1)
    expect(crop.scale).toBeLessThan(3)
    expect((extent.fill as Pattern).patternTransform).toEqual(
      patternTransformOf(placementOf(object.localBounds, IMAGE, crop)),
    )
    expect(extent.opacity).toBeCloseTo((frame.background as ImagePaint).opacity ?? 1, 9)
    expect(extent.opacity).toBeLessThan(1)
  })
})
