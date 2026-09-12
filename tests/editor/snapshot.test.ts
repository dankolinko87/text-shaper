import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Canvas, Rect } from 'fabric/node'
import opentype from 'opentype.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { liveCanvas, setLiveCanvas, snapshotArtwork, SNAPSHOT_WIDTH } from '../../src/editor/liveCanvas'
import { contentBounds, syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { useDocumentStore } from '../../src/state/documentStore'
import { registerFont } from '../../src/typography/fontRegistry'

/**
 * A project's picture: the artwork alone, cropped to what is drawn, at most
 * a card's worth of pixels wide.
 */

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont('anton', opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
})

let canvas: Canvas
let rendered = new Map<string, RenderedObject>()

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
  canvas = new Canvas(undefined, { width: 1200, height: 900 })
  rendered = new Map()
})

afterEach(() => {
  setLiveCanvas(null)
  void canvas.dispose()
})

const draw = (): void => {
  rendered = syncCanvas({ canvas, doc: useDocumentStore.getState().doc, textPaths: {}, bandPaths: {}, ribbons: {}, rendered })
}

/**
 * Fabric's own PNG writer needs a browser canvas, which node has not got —
 * so the export call is stood in for, and what it is ASKED for is checked:
 * the crop, the scale and which objects it may draw.
 */
interface Asked {
  multiplier?: number
  left?: number
  top?: number
  width?: number
  height?: number
  filter?: (object: { get: (key: string) => unknown }) => boolean
}
function standIn(): { asked: () => Asked | null } {
  let captured: Asked | null = null
  ;(canvas as unknown as { toDataURL: (options: Asked) => string }).toDataURL = (options) => {
    captured = options
    return 'data:image/png;base64,AAAA'
  }
  return { asked: () => captured }
}

describe('a snapshot of the artwork', () => {
  it('is nothing without a canvas, or with nothing drawn', () => {
    expect(snapshotArtwork()).toBeNull()
    setLiveCanvas(canvas, () => rendered)
    expect(liveCanvas()).not.toBeNull()
    draw()
    const stub = standIn()
    expect(snapshotArtwork()).toBeNull()
    expect(stub.asked()).toBeNull()
  })

  it('crops to what is drawn, at the canvas zoom, and leaves the furniture out', () => {
    useDocumentStore.getState().createMosaic({ columns: 3, rows: 2, artboardCenter: { x: 400, y: 300 }, text: 'ABCDEF' })
    canvas.setViewportTransform([0.5, 0, 0, 0.5, 20, 10])
    draw()
    // Furniture: a big overlay rectangle tagged like the editor's, which must be left out.
    const overlay = new Rect({ left: -900, top: -900, width: 3000, height: 3000, fill: '#ff0000' })
    overlay.set('gridRole', 'meshTile')
    canvas.add(overlay)
    setLiveCanvas(canvas, () => rendered)
    const stub = standIn()

    expect(snapshotArtwork()).toMatch(/^data:image\/png;base64,/)
    const asked = stub.asked()!
    // The artwork's box, in artboard units, carried through the viewport to screen pixels.
    const bounds = contentBounds(rendered)!
    expect(asked.left).toBeCloseTo(bounds.x * 0.5 + 20)
    expect(asked.top).toBeCloseTo(bounds.y * 0.5 + 10)
    expect(asked.width).toBeCloseTo(bounds.width * 0.5)
    expect(asked.height).toBeCloseTo(bounds.height * 0.5)
    expect(asked.width! * asked.multiplier!).toBeCloseTo(SNAPSHOT_WIDTH)
    const artwork = canvas.getObjects().find((object) => object.get('shapeId'))!
    expect(asked.filter!(artwork)).toBe(true)
    expect(asked.filter!(overlay)).toBe(false)
  })

  it('brings the picture to the card’s width, scaling up only so far', () => {
    useDocumentStore.getState().createMosaic({ columns: 6, rows: 1, artboardCenter: { x: 600, y: 300 }, text: 'ABCDEF' })
    canvas.setViewportTransform([2, 0, 0, 2, 0, 0])
    draw()
    setLiveCanvas(canvas, () => rendered)
    const stub = standIn()
    snapshotArtwork()
    const zoomedIn = stub.asked()!
    expect(zoomedIn.width! * zoomedIn.multiplier!).toBeCloseTo(SNAPSHOT_WIDTH)

    // Drawn tiny on screen: scaled up, but not past four times.
    canvas.setViewportTransform([0.05, 0, 0, 0.05, 0, 0])
    snapshotArtwork()
    const zoomedOut = stub.asked()!
    expect(zoomedOut.multiplier).toBe(4)
  })
})
