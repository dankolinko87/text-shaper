import { Canvas, type Group } from 'fabric/node'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { animatingMosaicIds, mosaicMoves } from '../../src/editor/animationPlayback'
import {
  contentBounds,
  syncCanvas,
  windowOffset,
  windowsOf,
  type RenderedObject,
} from '../../src/editor/renderer'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import { registerFont } from '../../src/typography/fontRegistry'
import type { LetterMosaicObject } from '../../src/types/document'
import { mosaicIn } from '../fixtures/objects'

/**
 * A mosaic drawn as a ROW of windows, one per state — `frameSpread.test.ts`
 * for the other thing with states, and deliberately the same questions.
 *
 * The spread is one mechanism for every stated object, so what is pinned here
 * is that the mosaic gets exactly the frame's contract: one window per state
 * and none left behind, the first window where the object is and the rest
 * stood along the row, only the first being the object, every window stamped
 * with whose it is and which state it draws, a window being the mosaic at its
 * state and kept current, no playback into a row, and nothing in the document.
 */

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})
afterEach(() => {
  void canvas.dispose()
})

const store = () => useDocumentStore.getState()

let canvas: Canvas
let rendered = new Map<string, RenderedObject>()
let mosaic: string

const mosaicOf = (): LetterMosaicObject => mosaicIn(store().doc, mosaic)

/** Render, spread or not, with the shown state given. */
const render = (spread: boolean, shown = 0): Map<string, RenderedObject> => {
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
    spread: spread ? mosaic : null,
    mosaicStates: { [mosaic]: shown },
  } as never)
  return rendered
}

/** Every group on the canvas that belongs to the mosaic, windows included. */
const groups = () =>
  canvas.getObjects().filter((o) => (o as { get: (k: string) => unknown }).get('statedId') === mosaic)

/** What a window shows: each tile's fill, each glyph's, and the backdrop. */
const picture = (window: Group) => {
  const tiles: Record<string, string> = {}
  const glyphs: Record<string, string> = {}
  let backdrop = ''
  for (const child of window.getObjects()) {
    const role = child.get('role') as string | undefined
    const leaf = String(child.get('leafId'))
    if (role === 'tile') tiles[leaf] = String(child.fill)
    else if (role === 'glyph') glyphs[leaf] = String(child.fill)
    else if (role === 'extent') backdrop = String(child.fill)
  }
  return { tiles, glyphs, backdrop }
}

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ spread: null, mosaicStates: {}, mosaicPlayback: null, previewObject: null })
  canvas = new Canvas(undefined as never, { width: 2400, height: 900 })
  rendered = new Map()

  mosaic = store().createMosaic({
    columns: 2,
    rows: 2,
    artboardCenter: { x: 300, y: 200 },
    text: 'ABCD',
  })
  // A mosaic is born with three states; make each one tell from its
  // neighbours — a colour, a backdrop, and a gap so that it MOVES.
  const first = mosaicOf().tiles[0]!.id
  store().setMosaicTileColour(mosaic, 1, [first], '#ff0000')
  store().setMosaicBackground(mosaic, 2, '#0000ff')
  store().setMosaicSpacing(mosaic, { gap: 12 }, 2)
})

describe('spreading a mosaic', () => {
  it('draws one window per state, and takes them all away on collapse', () => {
    render(false)
    expect(groups()).toHaveLength(1)
    expect(rendered.get(mosaic)?.windows).toBeUndefined()

    render(true)
    const entry = rendered.get(mosaic)!
    expect(groups()).toHaveLength(mosaicOf().states.length)
    expect(entry.windows).toHaveLength(3)
    expect(entry.windows?.[0]).toBe(entry.group)

    render(false)
    expect(groups(), 'nothing left behind').toHaveLength(1)
    expect(rendered.get(mosaic)?.windows).toBeUndefined()
  })

  it('leaves the first window exactly where the mosaic is, and spaces the rest evenly', () => {
    const before = render(false).get(mosaic)!.group
    const at = { left: before.left, top: before.top }
    const windows = windowsOf(render(true).get(mosaic)!)
    expect(windows[0]!.left).toBeCloseTo(at.left, 6)
    expect(windows[0]!.top).toBeCloseTo(at.top, 6)
    const object = mosaicOf()
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.left - windows[0]!.left).toBeCloseTo(windowOffset(object, i), 6)
      expect(windows[i]!.top).toBeCloseTo(at.top, 6)
    }
    expect(windowOffset(object, 1), 'at least a mosaic apart').toBeGreaterThan(
      object.localBounds.width * object.transform.scaleX,
    )
  })

  it('gives the further windows NO shapeId, and never lets them be dragged as a whole', () => {
    const windows = windowsOf(render(true).get(mosaic)!)
    expect(windows[0]!.get('shapeId')).toBe(mosaic)
    for (const window of windows.slice(1)) {
      expect(window.get('shapeId'), 'not the mosaic').toBeUndefined()
      expect(window.get('statedId'), 'but it knows whose it is').toBe(mosaic)
      expect(window.selectable).toBe(false)
    }
    // And still not after a sync that merely moves the row.
    store().updateObject(mosaic, { transform: { ...mosaicOf().transform, x: 900 } })
    for (const window of windowsOf(render(true).get(mosaic)!).slice(1)) {
      expect(window.selectable, 'the reuse path cannot hand its handles back').toBe(false)
    }
  })

  it('stamps each window with the state it draws', () => {
    windowsOf(render(true).get(mosaic)!).forEach((window, i) => {
      expect(window.get('stateIndex')).toBe(i)
    })
    expect(render(false, 2).get(mosaic)!.group.get('stateIndex'), 'collapsed: the shown one').toBe(2)
  })

  it('shows state 1 first however the shown state moves', () => {
    const windows = windowsOf(render(true, 2).get(mosaic)!)
    expect(windows[0]!.get('stateIndex')).toBe(0)
    expect(windows[2]!.get('stateIndex')).toBe(2)
  })
})

describe('a window is the mosaic at its state', () => {
  it('draws what the collapsed mosaic draws at that state', () => {
    const spread = windowsOf(render(true).get(mosaic)!).map(picture)
    for (let at = 0; at < 3; at++) {
      const collapsed = picture(render(false, at).get(mosaic)!.group)
      expect(spread[at], `state ${at + 1}`).toEqual(collapsed)
    }
    expect(spread[1]!.tiles[mosaicOf().tiles[0]!.id], 'the row shows the differences').toBe('#ff0000')
    expect(spread[2]!.backdrop).toBe('#0000ff')
    expect(spread[0]!.backdrop).not.toBe('#0000ff')
  })

  it('repaints a window when ITS state changes, not only the first', () => {
    render(true)
    const first = mosaicOf().tiles[0]!.id
    store().setMosaicTileColour(mosaic, 2, [first], '#00ff00')
    const windows = windowsOf(render(true).get(mosaic)!)
    expect(picture(windows[2]!).tiles[first]).toBe('#00ff00')
    expect(picture(windows[1]!).tiles[first], 'its neighbour is untouched').toBe('#ff0000')
  })
})

describe('what a spread mosaic will not do', () => {
  it('refuses to animate, because it is showing every keyframe', () => {
    const object = mosaicOf()
    expect(mosaicMoves(object), 'it has something to play').toBe(true)
    const doc = store().doc
    expect(animatingMosaicIds(doc, { playing: true, previewing: null }).ids).toContain(mosaic)
    expect(
      animatingMosaicIds(doc, { playing: true, previewing: null, spread: mosaic }).ids,
    ).not.toContain(mosaic)
    expect(
      animatingMosaicIds(doc, { playing: false, previewing: mosaic, spread: mosaic }).ids,
    ).toEqual([])
  })

  it('never touches the document, so there is nothing to undo', () => {
    const past = store().past.length
    useUiStore.getState().setSpread(mosaic)
    render(true)
    useUiStore.getState().setSpread(null)
    render(false)
    expect(store().past).toHaveLength(past)
  })
})

describe('fitting the view', () => {
  it('frames the whole row, not just the first window', () => {
    const one = contentBounds(render(false))!
    const row = contentBounds(render(true))!
    const object = mosaicOf()
    expect(row.width).toBeGreaterThanOrEqual(one.width + windowOffset(object, 2) - 1)
    expect(row.x).toBeCloseTo(one.x, 3)
  })
})

describe('deleting a spread mosaic', () => {
  it('takes every window off the canvas, not only the first', () => {
    render(true)
    expect(groups()).toHaveLength(3)
    store().deleteObjects([mosaic])
    rendered = syncCanvas({
      canvas,
      doc: store().doc,
      textPaths: {},
      bandPaths: {},
      ribbons: {},
      rendered,
      spread: mosaic,
      mosaicStates: {},
    } as never)
    expect(groups(), 'nothing left behind').toHaveLength(0)
    expect(rendered.has(mosaic)).toBe(false)
  })
})
