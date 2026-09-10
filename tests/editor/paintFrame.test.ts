import { shapeIn } from '../fixtures/objects'
import { Canvas } from 'fabric/node'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import {
  paintFrame,
  syncCanvas,
  wordsRideTheirBanner,
  type RenderedObject,
} from '../../src/editor/renderer'
import { useDocumentStore } from '../../src/state/documentStore'
import { defaultConfig } from '../../src/typography/animation'
import { registerFont } from '../../src/typography/fontRegistry'
import { frameAt, prepareFrames, stillFrame } from '../../src/typography/objectFit'

/**
 * Playing a loop, and stopping one.
 *
 * Stopping used to be a hand-written undo of the last frame, and it only put
 * back the pieces whoever wrote it was thinking about — the words and the
 * container. A banner, and every slice of a sliced ribbon but the first, stayed
 * wherever the loop happened to stop, so the artwork was left mid-animation.
 */

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})
afterEach(() => resetPaperScope())

let canvas: Canvas
let rendered: Map<string, RenderedObject>

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
  canvas = new Canvas(undefined as never, { width: 1000, height: 800 })
  rendered = new Map()
})

/** One banded ring with a moving preset, drawn onto the canvas. */
function ring(preset: string, banner: Record<string, unknown> = {}): string {
  const pathData = ELLIPSE.build(400, 340)
  const id = useDocumentStore.getState().createObjectFromGeometry({
    pathData,
    localBounds: pathBounds(pathData),
    artboardCenter: { x: 500, y: 400 },
    open: false,
  })
  // Read AFTER creating: the store is immutable, so the snapshot taken before
  // the call does not have the object in it.
  const store = useDocumentStore.getState()
  const object = shapeIn(store.doc, id)
  store.updateObject(id, {
    text: 'NICE BUT BETTER',
    font: { ...object.font, fontId: 'anton' },
    fittingMode: 'ring',
    run: { ...object.run, turns: 'one', rigid: true, lineHeight: 1.5 },
    appearance: { ...object.appearance, lineFill: '#ffd166', containerFill: null },
    animation: {
      ...object.animation,
      preset: preset as never,
      config: defaultConfig(preset as never),
      ...banner,
    },
  })
  return id
}

/** Everything drawn, as one string, so a frame can be compared to another. */
function drawing(id: string): string {
  return rendered
    .get(id)!
    .group.getObjects()
    .map((child) => `${String(child.get('role'))}:${JSON.stringify((child as never as { path: unknown }).path)}`)
    .join('|')
}

describe('painting frames onto the canvas', () => {
  it('puts every part of the artwork back when the loop stops', () => {
    const id = ring('wave')
    const object = shapeIn(useDocumentStore.getState().doc, id)

    const still = stillFrame(object)!
    const source = prepareFrames(object)!
    rendered = syncCanvas({
      canvas,
      doc: useDocumentStore.getState().doc,
      textPaths: { [id]: still.path },
      bandPaths: { [id]: still.bandPath ?? '' },
      ribbons: { [id]: still.ribbon },
      rendered,
    })

    const atRest = drawing(id)

    // Play a few frames, then stop the way the editor stops.
    for (const phase of [0.1, 0.3, 0.55]) {
      paintFrame(rendered.get(id)!.group, frameAt(object, source, phase), null)
    }
    expect(drawing(id), 'the loop did not move anything').not.toBe(atRest)

    paintFrame(rendered.get(id)!.group, still, null)
    expect(drawing(id)).toBe(atRest)
  })

  it('moves every slice of a ribbon, not just the first', () => {
    const id = ring('wave')
    const object = shapeIn(useDocumentStore.getState().doc, id)
    const still = stillFrame(object)!
    const source = prepareFrames(object)!
    expect(still.ribbon.length, 'this shape should be drawn as a ribbon').toBeGreaterThan(1)

    rendered = syncCanvas({
      canvas,
      doc: useDocumentStore.getState().doc,
      textPaths: { [id]: still.path },
      bandPaths: { [id]: still.bandPath ?? '' },
      ribbons: { [id]: still.ribbon },
      rendered,
    })

    /* The container is drawn too and is holding still; the ribbon is the part
       under test. */
    const inked = (): string[] =>
      rendered
        .get(id)!
        .group.getObjects()
        .filter((c) => c.get('role') !== 'container')
        .map((c) => JSON.stringify((c as never as { path: unknown }).path))

    const before = inked()
    paintFrame(rendered.get(id)!.group, frameAt(object, source, 0.4), null)
    const after = inked()

    // Every slice moved, not merely the first pair.
    expect(before.length).toBeGreaterThan(2)
    expect(before.filter((p, i) => p !== after[i]).length).toBe(before.length)
  })

  /*
   * The ribbon's slices are cut at the letters' RESTING positions, so the whole
   * arrangement assumes the band under a letter is that letter's own band. Two
   * things break that, and they are the same thing from opposite ends: a banner
   * with a loop of its own slides out from under the words, and TRAVEL carries
   * the words out from over their banner.
   *
   * Either way a slice drawn later paints its background across letters that
   * have moved on, and a travelling sentence disappears a slice at a time until
   * only the last one is left. That shipped once already, from the banner's end;
   * this is the rule rather than the two cases.
   */
  it('stops slicing whenever the words and their banner can move apart', () => {
    const together = ring('wave')
    const bannerMoves = ring('wave', {
      bannerPreset: 'wave',
      bannerConfig: defaultConfig('wave'),
    })
    const wordsMove = ring('travel')

    expect(wordsRideTheirBanner(shapeIn(useDocumentStore.getState().doc, together))).toBe(true)
    expect(wordsRideTheirBanner(shapeIn(useDocumentStore.getState().doc, bannerMoves))).toBe(false)
    expect(wordsRideTheirBanner(shapeIn(useDocumentStore.getState().doc, wordsMove))).toBe(false)
  })

  it('draws an independently moving banner as one layer under the words', () => {
    /*
     * The ribbon's interleaving assumes the banner under a letter is that
     * letter's own. Once the banner has a loop of its own it slides out from
     * under the words, and a slice drawn later would paint its background over
     * letters that are no longer standing on it.
     */
    const together = ring('wave')
    const apart = ring('wave', { bannerPreset: 'wave', bannerConfig: defaultConfig('wave') })

    const doc = useDocumentStore.getState().doc
    const frames = Object.fromEntries(
      [together, apart].map((id) => {
        const still = stillFrame(shapeIn(doc, id))!
        return [id, still]
      }),
    )

    rendered = syncCanvas({
      canvas,
      doc,
      textPaths: Object.fromEntries(Object.entries(frames).map(([id, f]) => [id, f.path])),
      bandPaths: Object.fromEntries(
        Object.entries(frames).map(([id, f]) => [id, f.bandPath ?? '']),
      ),
      ribbons: Object.fromEntries(Object.entries(frames).map(([id, f]) => [id, f.ribbon])),
      rendered,
    })

    const roles = (id: string): string[] =>
      rendered
        .get(id)!
        .group.getObjects()
        .map((c) => String(c.get('role')))
        .filter((role) => role !== 'container')

    // Following: sliced, so band and text alternate along the run.
    expect(roles(together).length).toBeGreaterThan(2)
    expect(roles(together).slice(0, 4)).toEqual(['band', 'text', 'band', 'text'])

    // Its own loop: one banner, then all the words on top of it.
    expect(roles(apart)).toEqual(['band', 'text'])
  })
})

describe('changing how the banner is drawn', () => {
  /*
   * The group is REBUILT when a banner stops following the type — sliced into a
   * ribbon or laid down as one layer, which is a different set of children. The
   * group is positioned by the centre of those children's combined bounds, so a
   * rebuild that changed the bounds without correcting for them would slide the
   * whole object across the artboard on a setting that is only about layering.
   */
  it('leaves the object exactly where it is', () => {
    const id = ring('wave')
    const store = () => useDocumentStore.getState()

    const draw = (): void => {
      const doc = store().doc
      const still = stillFrame(shapeIn(doc, id))!
      rendered = syncCanvas({
        canvas,
        doc,
        textPaths: { [id]: still.path },
        bandPaths: { [id]: still.bandPath ?? '' },
        ribbons: { [id]: still.ribbon },
        rendered,
      })
    }

    draw()
    const before = rendered.get(id)!.group
    const at = { x: before.left, y: before.top }
    const sliced = before.getObjects().length

    const object = shapeIn(store().doc, id)
    store().updateObject(id, {
      animation: {
        ...object.animation,
        bannerPreset: 'wave',
        bannerConfig: defaultConfig('wave'),
      },
    })
    draw()

    const after = rendered.get(id)!.group
    // Really rebuilt: one banner under all the words instead of slices.
    expect(after.getObjects().length).toBeLessThan(sliced)
    expect(after.left).toBeCloseTo(at.x, 6)
    expect(after.top).toBeCloseTo(at.y, 6)
    // And the document itself is untouched by a drawing decision.
    expect(shapeIn(store().doc, id).transform).toEqual(object.transform)
  })
})
