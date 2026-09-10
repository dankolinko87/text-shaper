import { Canvas } from 'fabric/node'
import { evaluateMosaicAtTime } from '../../src/mosaic/timeline'
import { glyphReferenceRects, paintMosaicFrame } from '../../src/editor/mosaicPlayback'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'

import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { mosaicTiles } from '../../src/mosaic/tiles'
import { setCharacter } from '../../src/mosaic/typing'
import { useDocumentStore } from '../../src/state/documentStore'
import { clearFontCaches, registerFont } from '../../src/typography/fontRegistry'
import { mosaicIn } from '../fixtures/objects'

/**
 * A mosaic on the canvas: where it lands, and when its letters turn up.
 *
 * Both of these were reported from the app before they were caught here. A
 * mosaic drew its letters in one place and put its selection box in another, and
 * it came back from a reload empty — reappearing only once something was typed
 * into it.
 */

const FONT_ID = 'anton'

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})

let canvas: Canvas
let rendered: Map<string, RenderedObject>

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
  canvas = new Canvas(undefined, { width: 1200, height: 900 })
  rendered = new Map()
})

afterEach(() => {
  void canvas.dispose()
})

/** Put the same letter in every tile, so the mosaic is fully inked. */
function fill(id: string): void {
  const object = mosaicIn(useDocumentStore.getState().doc, id)
  let written = object.states[0]?.chars ?? {}
  for (const tile of object.tiles) written = setCharacter(written, tile.id, 'W')
  // Every state, so the mosaic reads the same wherever the timeline is.
  object.states.forEach((_, at) => useDocumentStore.getState().setMosaicChars(id, at, written))
}

/** A mosaic with a letter in every tile, placed away from the origin. */
function mosaic(columns = 3, rows = 4, at = { x: 400, y: 300 }): string {
  const id = useDocumentStore.getState().createMosaic({ columns, rows, artboardCenter: at })
  fill(id)
  return id
}

const draw = (): void => {
  rendered = syncCanvas({
    canvas,
    doc: useDocumentStore.getState().doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
  })
}

describe('where a mosaic lands', () => {
  it('draws its letters inside its own bounding box', () => {
    /*
     * The fault this catches: the letters were drawn in one place and the
     * selection box sat somewhere else entirely, so the handles could not be
     * grabbed and the object could not be moved or turned.
     *
     * Fabric's box is the union of the group's children, so this is really
     * asking whether every child is where the layout says it should be.
     */
    const id = mosaic()
    draw()

    const group = rendered.get(id)?.group
    expect(group, 'the mosaic was drawn').toBeTruthy()
    if (!group) return

    const box = group.getBoundingRect()
    for (const child of group.getObjects()) {
      const rect = child.getBoundingRect()
      expect(rect.left, `${child.get('role')} left`).toBeGreaterThanOrEqual(box.left - 1)
      expect(rect.top, `${child.get('role')} top`).toBeGreaterThanOrEqual(box.top - 1)
      expect(rect.left + rect.width, `${child.get('role')} right`).toBeLessThanOrEqual(
        box.left + box.width + 1,
      )
      expect(rect.top + rect.height, `${child.get('role')} bottom`).toBeLessThanOrEqual(
        box.top + box.height + 1,
      )
    }
  })

  it('puts that box where the document says the object is', () => {
    // `transform.x/y` is the object's local origin in artboard space, and the
    // local origin of a mosaic is the middle of its own box.
    const id = mosaic(3, 4, { x: 400, y: 300 })
    draw()

    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const box = rendered.get(id)!.group.getBoundingRect()

    expect(box.width).toBeCloseTo(object.localBounds.width, 0)
    expect(box.height).toBeCloseTo(object.localBounds.height, 0)
    expect(box.left + box.width / 2, 'centred on its origin').toBeCloseTo(400, 0)
    expect(box.top + box.height / 2).toBeCloseTo(300, 0)
  })

  it('keeps the box the same size whether or not the letters have arrived', () => {
    /*
     * A mosaic occupies its rectangle whether anything is inked in it or not.
     * Without its own extent the group would be the bounds of whatever happened
     * to be drawn, so an empty mosaic would have no size and one with empty
     * outer tiles would be smaller than it is.
     */
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 3, rows: 4, artboardCenter: { x: 400, y: 300 } })
    draw()
    const empty = rendered.get(id)!.group.getBoundingRect()

    fill(id)
    draw()
    const full = rendered.get(id)!.group.getBoundingRect()

    expect(full.width).toBeCloseTo(empty.width, 0)
    expect(full.height).toBeCloseTo(empty.height, 0)
    expect(full.left).toBeCloseTo(empty.left, 0)
  })

  it('draws a glyph in every tile that has one', () => {
    const id = mosaic(3, 4)
    draw()
    const glyphs = rendered
      .get(id)!
      .group.getObjects()
      .filter((child) => child.get('role') === 'glyph')
    expect(glyphs).toHaveLength(12)
  })
})

describe('when the font is not there yet', () => {
  /*
   * The reported fault: a mosaic came back from a reload empty and only
   * reappeared once something was typed into it.
   *
   * The renderer runs before the font has loaded — every page load — and a glyph
   * cannot be drawn without one. The group built during that wait has no
   * letters, which is correct; what was wrong is that it was never rebuilt once
   * the font arrived, because the key that decides a rebuild said nothing about
   * whether the font was there. `fitKey` carries a `fontReady` argument for
   * exactly this reason, and its own comment says why.
   */
  it('rebuilds the mosaic once the font arrives', () => {
    const id = mosaic()
    clearFontCaches()
    // Nothing registered: this is the state every page load starts in.
    const store = useDocumentStore.getState()
    store.resetDocument()
    const fresh = store.createMosaic({ columns: 3, rows: 4, artboardCenter: { x: 0, y: 0 } })
    fill(fresh)
    void id

    // Drawn with no font: tiles, no letters.
    draw()
    const before = rendered.get(fresh)!
    expect(
      before.group.getObjects().filter((c) => c.get('role') === 'glyph'),
      'nothing to draw yet',
    ).toHaveLength(0)

    // The font lands. The document has not changed at all.
    const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
    const bytes = readFileSync(path)
    registerFont(
      FONT_ID,
      opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    )

    draw()
    expect(
      rendered.get(fresh)!.group.getObjects().filter((c) => c.get('role') === 'glyph'),
      'the letters turn up without anything being edited',
    ).toHaveLength(12)
  })
})

describe('spacing and the font', () => {
  /** Every glyph child's box, left to right. */
  const glyphBoxes = (id: string) =>
    rendered
      .get(id)!
      .group.getObjects()
      .filter((child) => child.get('role') === 'glyph')
      .map((child) => child.getBoundingRect())
      .sort((a, b) => a.left - b.left)

  it('redraws when the spacing changes, without moving a single character', () => {
    /*
     * Spacing moves rectangles and nothing else. The caret is a leaf id, so a
     * tile that changed identity under a spacing change would take the caret
     * somewhere else with it — and an animation would lose track of which tile
     * becomes which.
     */
    const id = mosaic()
    draw()
    const before = rendered.get(id)!
    const beforeLeaves = mosaicIn(useDocumentStore.getState().doc, id).tiles
    const beforeWidth = glyphBoxes(id)[0]!.width

    useDocumentStore.getState().setMosaicSpacing(id, { gap: 30, glyphInset: 2 })
    draw()
    const after = rendered.get(id)!

    expect(after.contentKey, 'the group was rebuilt').not.toBe(before.contentKey)
    expect(
      mosaicIn(useDocumentStore.getState().doc, id).tiles.map((l) => l.id),
      'same tiles',
    ).toEqual(beforeLeaves.map((l) => l.id))
    // A wider gap takes room from every tile, so every letter is drawn smaller.
    expect(glyphBoxes(id)[0]!.width).toBeLessThan(beforeWidth)
  })

  it('opens a real space between the letters when the gap grows', () => {
    const id = mosaic(3, 1)
    useDocumentStore.getState().setMosaicSpacing(id, { gap: 0, glyphInset: 0 })
    draw()
    const tight = glyphBoxes(id)
    const touching = tight[1]!.left - (tight[0]!.left + tight[0]!.width)

    useDocumentStore.getState().setMosaicSpacing(id, { gap: 24, glyphInset: 0 })
    draw()
    const loose = glyphBoxes(id)
    const spaced = loose[1]!.left - (loose[0]!.left + loose[0]!.width)

    expect(touching).toBeCloseTo(0, 1)
    expect(spaced).toBeCloseTo(24, 1)
  })

  it('scales its spacing with the object, because the scale stays on the transform', () => {
    /*
     * A mosaic does not bake its scale into its geometry the way a shape does —
     * `collectTransforms` says so explicitly. That is what makes scaling one to
     * 200% double its gaps rather than leaving them at their old size while the
     * tiles grow around them.
     */
    const id = mosaic(3, 1)
    useDocumentStore.getState().setMosaicSpacing(id, { gap: 20, glyphInset: 0 })
    draw()
    const plain = glyphBoxes(id)
    const before = plain[1]!.left - (plain[0]!.left + plain[0]!.width)

    const object = mosaicIn(useDocumentStore.getState().doc, id)
    useDocumentStore
      .getState()
      .setBase(id, { transform: { ...object.transform, scaleX: 2, scaleY: 2 } })
    draw()
    const scaled = glyphBoxes(id)
    const after = scaled[1]!.left - (scaled[0]!.left + scaled[0]!.width)

    expect(after).toBeCloseTo(before * 2, 1)
  })

  it('redraws every letter when the font changes', () => {
    const id = mosaic(2, 1)
    draw()
    const before = rendered
      .get(id)!
      .group.getObjects()
      .filter((c) => c.get('role') === 'glyph')
      .map((c) => (c as unknown as { path: unknown[] }).path.length)

    const path = fileURLToPath(new URL('../../src/fonts/files/BebasNeue-Regular.ttf', import.meta.url))
    const bytes = readFileSync(path)
    registerFont(
      'bebas-neue',
      opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    )
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    // The font belongs to the state now, along with the spacing.
    useDocumentStore
      .getState()
      .setMosaicFont(id, { ...object.states[0]!.font, fontId: 'bebas-neue' }, 0)
    draw()

    const after = rendered
      .get(id)!
      .group.getObjects()
      .filter((c) => c.get('role') === 'glyph')
      .map((c) => (c as unknown as { path: unknown[] }).path.length)

    expect(after).toHaveLength(before.length)
    // A different typeface is a different outline: same letters, new geometry.
    expect(after).not.toEqual(before)
  })

  it('draws nothing but artwork — no editing overlay ever reaches a group', () => {
    /*
     * The tile outlines and the caret are an editing affordance. They are added
     * straight to the canvas carrying `gridRole`, never into an object's group,
     * which is what keeps them out of anything rendered from the document.
     *
     * `renderGif` still refuses a mosaic outright until animated export lands,
     * so this is the honest form of "overlays are excluded from export": what a
     * mosaic's group contains, and what it does not.
     */
    const id = mosaic()
    useDocumentStore.getState().setSelection([id])
    draw()

    for (const child of rendered.get(id)!.group.getObjects()) {
      expect(child.get('gridRole'), 'an overlay shape got into the artwork').toBeUndefined()
      // `outline` is the composition's own border — artwork like the rest, and
      // always attached so playback can adjust it without rebuilding the group.
      expect(['extent', 'tile', 'glyph', 'outline']).toContain(child.get('role'))
    }
  })
})

describe('a tile the font cannot draw', () => {
  it('shows a box rather than nothing at all', () => {
    // Anton has no emoji. Left alone the tile would draw the font's own
    // `.notdef`, which some fonts ink and some do not — so the same character
    // was a box in one font and an empty tile in the next.
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 } })
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const leaves = object.tiles
    let written = setCharacter(object.states[0]!.chars, leaves[0]!.id, 'A')
    written = setCharacter(written, leaves[1]!.id, '😀')
    useDocumentStore.getState().setMosaicChars(id, 0, written)
    draw()

    const glyphs = rendered
      .get(id)!
      .group.getObjects()
      .filter((c) => c.get('role') === 'glyph')
    // Both tiles draw something: the letter, and the box standing in for what
    // the font cannot give.
    expect(glyphs).toHaveLength(2)
  })
})

describe('the tiles a mosaic is made of', () => {
  it('lays every tile inside the object, in its own space', () => {
    const id = mosaic()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const b = object.localBounds
    for (const [leaf, tile] of mosaicTiles(object)) {
      expect(tile.structural.x, leaf).toBeGreaterThanOrEqual(b.x - 1e-6)
      expect(tile.structural.y, leaf).toBeGreaterThanOrEqual(b.y - 1e-6)
      expect(tile.structural.x + tile.structural.width, leaf).toBeLessThanOrEqual(
        b.x + b.width + 1e-6,
      )
      expect(tile.structural.y + tile.structural.height, leaf).toBeLessThanOrEqual(
        b.y + b.height + 1e-6,
      )
    }
  })
})

describe('a mosaic whose states differ', () => {
  /*
   * Reported from the app, with a picture: once a mosaic had been animated its
   * glyphs sat outside their tiles, dragging one edge slid the WHOLE mosaic, and
   * the object could no longer be clicked at all.
   *
   * One cause behind all three. Each glyph's outline is built for the largest
   * rectangle its tile reaches across every state and then scaled down to the
   * state on show — that is what lets playback move it with a transform instead
   * of writing a new path every frame. The group's centre was measured from
   * `child.width`, the size BEFORE that scale, so every glyph counted at its
   * largest. While the states were identical the two were the same number and
   * nothing showed; the moment a second state was authored the centre jumped,
   * and the group's position and hit area went with it.
   */
  const spread = (id: string): void => {
    const store = useDocumentStore.getState()
    const object = mosaicIn(store.doc, id)
    const xs = Object.keys(object.states[0]!.x)
    /*
     * State 1 makes the LEFT column nearly the whole mosaic, which is what it
     * takes to expose this. The reference rectangle for that tile is then far
     * wider than the rectangle state 0 shows it at — and because it is drawn
     * centred on a narrow left-hand tile, its unscaled bounds reach out past the
     * mosaic's own box. A fixture that widened a MIDDLE column would not do it:
     * an oversized reference in the middle still lands inside the box, and the
     * bug stays invisible.
     */
    store.setMosaicCoordinates(
      id,
      'x',
      xs.map((line, at) => ({ id: line, value: at === 0 ? 0.8 : 0.9 })),
      1,
    )
  }

  it('keeps its centre on its own box, whatever the other states hold', () => {
    const id = mosaic(3, 3)
    draw()
    const before = rendered.get(id)?.group?.get('localCentre') as { x: number; y: number }

    spread(id)
    draw()
    const after = rendered.get(id)?.group?.get('localCentre') as { x: number; y: number }

    // Nothing about the state being SHOWN changed, so nothing about where the
    // mosaic sits may change either.
    expect(after.x, 'the mosaic did not slide sideways').toBeCloseTo(before.x, 6)
    expect(after.y, 'nor up or down').toBeCloseTo(before.y, 6)

    // And that centre is the centre of the mosaic's own box: a mosaic occupies
    // its rectangle, and nothing inside it may stick out.
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    expect(after.x).toBeCloseTo(object.localBounds.x + object.localBounds.width / 2, 6)
    expect(after.y).toBeCloseTo(object.localBounds.y + object.localBounds.height / 2, 6)
  })

  it('draws every glyph inside the tile it belongs to', () => {
    const id = mosaic(3, 3)
    spread(id)
    draw()

    const group = rendered.get(id)?.group
    expect(group).toBeTruthy()
    if (!group) return

    const layout = mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id), 0)
    let checked = 0
    for (const child of group.getObjects()) {
      if (child.get('role') !== 'glyph') continue
      const leafId = child.get('leafId') as string
      const tile = layout.get(leafId)
      if (!tile) continue
      checked++

      const width = child.width * (child.scaleX ?? 1)
      const height = child.height * (child.scaleY ?? 1)
      // A glyph fills its glyph rectangle exactly — that is the whole point of
      // the fitting — so its drawn size must be that rectangle's size.
      expect(width, `${leafId} width`).toBeCloseTo(tile.glyph.width, 3)
      expect(height, `${leafId} height`).toBeCloseTo(tile.glyph.height, 3)
    }
    expect(checked, 'there were glyphs to check').toBeGreaterThan(0)
  })
})

describe('a background for every tile', () => {
  /*
   * Built only for coloured tiles, a tile that is bare in the state on show has
   * no object at all — so it can never fade in, and arriving at a coloured state
   * would mean rebuilding the group in the middle of the transition. Every leaf
   * gets one, invisible until it is given a colour.
   */
  const backgrounds = (id: string) =>
    (rendered.get(id)?.group.getObjects() ?? []).filter((c) => c.get('role') === 'tile')

  it('gives one to every leaf, coloured or not', () => {
    const id = mosaic(3, 3)
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    expect(backgrounds(id)).toHaveLength(object.tiles.length)
  })

  it('paints a bare one with nothing at all', () => {
    const id = mosaic(2, 2)
    draw()
    for (const rect of backgrounds(id)) expect(rect.fill).toBe('transparent')
  })

  it('paints a coloured one with its colour', () => {
    const id = mosaic(2, 2)
    const first = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
    useDocumentStore.getState().setMosaicTileColour(id, 0, [first], '#ff8800')
    draw()
    const rect = backgrounds(id).find((c) => c.get('leafId') === first)
    expect(rect?.fill).toBe('#ff8800')
  })

  it('keeps the object when a colour is cleared, ready to take another', () => {
    const id = mosaic(2, 2)
    const first = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
    const store = useDocumentStore.getState()
    store.setMosaicTileColour(id, 0, [first], '#ff8800')
    draw()
    store.setMosaicTileColour(id, 0, [first], null)
    draw()

    const rect = backgrounds(id).find((c) => c.get('leafId') === first)
    expect(rect, 'still there').toBeTruthy()
    expect(rect?.fill).toBe('transparent')
  })

  it('never takes a press — the letters and the object own that', () => {
    const id = mosaic(2, 2)
    draw()
    for (const rect of backgrounds(id)) expect(rect.evented).toBe(false)
  })

  it('does not move the mosaic off its own box', () => {
    // The rects sit inside the extent child, so they cannot pull the group's
    // centre about — the fault a wrongly-measured child caused once before.
    const id = mosaic(3, 3)
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const centre = rendered.get(id)?.group.get('localCentre') as { x: number; y: number }
    expect(centre.x).toBeCloseTo(object.localBounds.x + object.localBounds.width / 2, 6)
    expect(centre.y).toBeCloseTo(object.localBounds.y + object.localBounds.height / 2, 6)
  })
})

describe('painting a colour frame', () => {
  /*
   * A colour-only change is a fill and nothing else. Rebuilding the group, or
   * writing the glyph paths again, would be sixty needless serialisations a
   * second — and the outlines are the expensive part.
   */
  it('changes fills without touching a single path', () => {
    const id = mosaic(3, 3)
    const store = useDocumentStore.getState()
    const object = mosaicIn(store.doc, id)
    const first = object.tiles[0]!.id

    // Two states differing only in colour.
    store.setMosaicGlyphColour(id, 1, [first], '#ff0000')
    store.setMosaicTileColour(id, 1, [first], '#00ff00')
    draw()

    const group = rendered.get(id)!.group
    const glyph = group.getObjects().find((c) => c.get('role') === 'glyph' && c.get('leafId') === first)
    const rect = group.getObjects().find((c) => c.get('role') === 'tile' && c.get('leafId') === first)
    expect(glyph, 'the tile has a letter').toBeTruthy()

    const pathBefore = JSON.stringify((glyph as unknown as { path: unknown }).path)
    const fresh = mosaicIn(useDocumentStore.getState().doc, id)
    const frame = evaluateMosaicAtTime(fresh, 0)
    paintMosaicFrame(group as never, frame, glyphReferenceRects(fresh), fresh.localBounds)

    expect(
      JSON.stringify((glyph as unknown as { path: unknown }).path),
      'the outline is the same object it was',
    ).toBe(pathBefore)
    expect(rect?.fill, 'and the fill came from the frame').toBeDefined()
  })

  it('fades a background in without the object ever going away', () => {
    const id = mosaic(2, 2)
    const store = useDocumentStore.getState()
    const first = mosaicIn(store.doc, id).tiles[0]!.id
    // Bare in state 1, coloured in state 2, with no hold so the move starts at once.
    store.setMosaicTileColour(id, 1, [first], '#ff0000')
    store.setMosaicStateTiming(id, 0, { holdMs: 0, transitionMs: 100 })
    draw()

    const group = rendered.get(id)!.group
    const rect = group.getObjects().find((c) => c.get('role') === 'tile' && c.get('leafId') === first)
    const fresh = mosaicIn(useDocumentStore.getState().doc, id)
    const refs = glyphReferenceRects(fresh)

    paintMosaicFrame(group as never, evaluateMosaicAtTime(fresh, 50), refs, fresh.localBounds)
    const half = rect?.fill as string
    // Halfway in: the destination's colour at half alpha, never a dark edge.
    expect(half.slice(0, 7)).toBe('#ff0000')
    expect(half).not.toBe('transparent')

    paintMosaicFrame(group as never, evaluateMosaicAtTime(fresh, 100), refs, fresh.localBounds)
    expect(rect?.fill, 'arrived').toBe('#ff0000')
  })
})

/**
 * Rounded corners, as they reach the canvas.
 *
 * Two different mechanisms, and the reason for the difference is what the tests
 * are really pinning: a tile rounds its own rectangle, while the outline is a
 * clip over everything — so a letter reaching the edge is cut by the same curve
 * its background is, and the corners round whether or not a tile sits in them.
 */
describe('rounded corners on the canvas', () => {
  const tilesOf = (id: string) =>
    rendered
      .get(id)!
      .group.getObjects()
      .filter((child) => child.get('role') === 'tile')

  it('draws square by default, so nothing that exists changes shape', () => {
    const id = mosaic(2, 2)
    draw()
    for (const tile of tilesOf(id)) {
      expect(tile.get('rx')).toBe(0)
      expect(tile.get('ry')).toBe(0)
    }
  })

  it('rounds every tile by the state’s radius', () => {
    const id = mosaic(2, 2)
    useDocumentStore.getState().setMosaicCorners(id, { tileRadius: 9 }, 0)
    draw()
    for (const tile of tilesOf(id)) {
      expect(tile.get('rx')).toBe(9)
      expect(tile.get('ry')).toBe(9)
    }
  })

  it('never rounds a tile further than half of itself', () => {
    const id = mosaic(2, 2)
    useDocumentStore.getState().setMosaicCorners(id, { tileRadius: 100000 }, 0)
    draw()
    for (const tile of tilesOf(id)) {
      const rx = tile.get('rx') as number
      // A full pill, not a shape folded through itself.
      expect(rx).toBeCloseTo(Math.min(tile.width, tile.height) / 2, 6)
    }
  })

  it('clips the whole group to the outline, sized to the mosaic’s own box', () => {
    const id = mosaic(2, 2)
    useDocumentStore.getState().setMosaicCorners(id, { outerRadius: 30 }, 0)
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const clip = rendered.get(id)!.group.clipPath!

    expect(clip.get('rx')).toBe(30)
    expect(clip.width).toBeCloseTo(object.localBounds.width, 6)
    expect(clip.height).toBeCloseTo(object.localBounds.height, 6)
  })

  it('keeps the clip attached at radius zero, so a transition never rebuilds', () => {
    const id = mosaic(2, 2)
    draw()
    // Present but rounding nothing: attaching and detaching it as an animated
    // radius crossed zero would tear the group down mid-transition.
    expect(rendered.get(id)!.group.clipPath).toBeTruthy()
    expect(rendered.get(id)!.group.clipPath!.get('rx')).toBe(0)
  })

  it('moves both radii on a painted frame, without rebuilding anything', () => {
    const id = mosaic(2, 2)
    const store = useDocumentStore.getState()
    store.setMosaicCorners(id, { tileRadius: 0, outerRadius: 0 }, 0)
    store.setMosaicCorners(id, { tileRadius: 20, outerRadius: 60 }, 1)
    store.setMosaicStateTiming(id, 0, { holdMs: 0, transitionMs: 1000 })
    draw()

    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const group = rendered.get(id)!.group
    const references = glyphReferenceRects(object)

    paintMosaicFrame(group, evaluateMosaicAtTime(object, 500), references, object.localBounds)
    const midTile = tilesOf(id)[0]!.get('rx') as number
    const midClip = group.clipPath!.get('rx') as number

    expect(midTile).toBeGreaterThan(0)
    expect(midTile).toBeLessThan(20)
    expect(midClip).toBeGreaterThan(0)
    expect(midClip).toBeLessThan(60)

    // And lands exactly on what was authored.
    paintMosaicFrame(group, evaluateMosaicAtTime(object, 1000), references, object.localBounds)
    expect(group.clipPath!.get('rx')).toBe(60)
  })
})

/**
 * The font changing on arrival, during playback.
 *
 * A font is the one thing in a state that cannot be interpolated — two
 * typefaces' outlines are different shapes, not two positions of one shape — so
 * it is a cut, taken the instant a transition finishes. The evaluator has always
 * said which font a frame is in; nothing on the canvas ever acted on it, so a
 * mosaic animated between two typefaces stayed in whichever one its group
 * happened to be built with.
 *
 * Painting cannot re-cut an outline — that is the serialisation the whole
 * playback path exists to avoid — so every font a mosaic uses is built up front
 * and a frame chooses between them.
 */
describe('a font that changes between states', () => {
  const SECOND = 'bebas'

  beforeAll(() => {
    const path = fileURLToPath(new URL('../../src/fonts/files/BebasNeue-Regular.ttf', import.meta.url))
    const bytes = readFileSync(path)
    registerFont(
      SECOND,
      opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    )
  })

  /** A mosaic set in one font, animating to another. */
  function twoFonts(): string {
    const id = mosaic(2, 2)
    const store = useDocumentStore.getState()
    store.setMosaicFont(id, { fontId: SECOND, weight: 400, italic: false }, 1)
    store.setMosaicStateTiming(id, 0, { holdMs: 0, transitionMs: 1000 })
    return id
  }

  const glyphsOf = (id: string) =>
    rendered
      .get(id)!
      .group.getObjects()
      .filter((child) => child.get('role') === 'glyph')

  const shown = (id: string) => glyphsOf(id).filter((child) => child.visible)

  it('builds an outline for every font the states use', () => {
    const id = twoFonts()
    draw()
    // Keyed by letter AND font now, so one set per font means one key per font
    // for a mosaic that says the same thing in both.
    const keys = new Set(glyphsOf(id).map((child) => child.get('glyphKey')))
    expect(keys.size, 'one set of outlines per font').toBe(2)
  })

  it('shows exactly one outline per tile at any moment', () => {
    const id = twoFonts()
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const references = glyphReferenceRects(object)

    for (const t of [0, 250, 500, 999, 1000]) {
      paintMosaicFrame(rendered.get(id)!.group, evaluateMosaicAtTime(object, t), references, object.localBounds)
      const perTile = new Map<string, number>()
      for (const child of shown(id)) {
        const leaf = child.get('leafId') as string
        perTile.set(leaf, (perTile.get(leaf) ?? 0) + 1)
      }
      for (const [leaf, count] of perTile) {
        expect(count, `t=${t}, tile ${leaf}`).toBe(1)
      }
      expect(perTile.size, `t=${t}: every tile still has a letter`).toBe(object.tiles.length)
    }
  })

  it('keeps the first font for the whole transition, and cuts on arrival', () => {
    const id = twoFonts()
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const references = glyphReferenceRects(object)
    const group = rendered.get(id)!.group

    const fontAt = (t: number): string => {
      paintMosaicFrame(group, evaluateMosaicAtTime(object, t), references, object.localBounds)
      return shown(id)[0]!.get('glyphKey') as string
    }

    const start = fontAt(0)
    // Part-way through the movement it is still the font being LEFT: a cut
    // half-way would change the letters while they were still moving.
    expect(fontAt(500), 'mid-transition').toBe(start)
    expect(fontAt(999), 'just before arrival').toBe(start)
    expect(fontAt(1000), 'on arrival').not.toBe(start)
  })
})

/**
 * A state naming a font whose outlines are not there.
 *
 * A font can fail to load, or a document can name one this build does not have.
 * The tile then has no outline cut in that font, and showing "the one for this
 * frame" would show nothing at all — a mosaic that empties itself part-way
 * through its own animation. It keeps the outline it has instead.
 */
describe('a font that could not be cut', () => {
  it('keeps the letters on screen rather than emptying the tile', () => {
    const id = mosaic(2, 2)
    const store = useDocumentStore.getState()
    store.setMosaicFont(id, { fontId: 'not-a-font', weight: 400, italic: false }, 1)
    store.setMosaicStateTiming(id, 0, { holdMs: 0, transitionMs: 1000 })
    draw()

    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const references = glyphReferenceRects(object)
    const group = rendered.get(id)!.group

    // On arrival at the state whose font does not exist.
    paintMosaicFrame(group, evaluateMosaicAtTime(object, 1000), references, object.localBounds)

    const visible = group
      .getObjects()
      .filter((child) => child.get('role') === 'glyph' && child.visible)
    expect(visible.length).toBe(object.tiles.length)
  })
})

/**
 * Letters that change, and letters that go away, between states.
 *
 * A letter cannot be interpolated any more than a typeface can — 'A' and 'B' are
 * different shapes, not two positions of one shape — so a change of writing is a
 * cut taken on arrival, and the outlines for every letter a tile ever shows are
 * cut up front exactly as the fonts are.
 *
 * An empty tile in one state is the same mechanism with nothing chosen: the tile
 * keeps its rectangle, its background and its place in the reading order, and
 * simply draws no outline.
 */
describe('writing that changes between states', () => {
  /** Says A in state 1, B in state 2, and nothing at all in state 3. */
  function changing(): string {
    const id = mosaic(2, 2)
    const store = useDocumentStore.getState()
    const object = mosaicIn(store.doc, id)
    const first = object.tiles[0]!.id
    store.setMosaicChars(id, 0, { ...object.states[0]!.chars, [first]: 'A' })
    store.setMosaicChars(id, 1, { ...object.states[1]!.chars, [first]: 'B' })
    const without = { ...mosaicIn(store.doc, id).states[2]!.chars }
    delete without[first]
    store.setMosaicChars(id, 2, without)
    store.setMosaicStateTiming(id, 0, { holdMs: 0, transitionMs: 1000 })
    store.setMosaicStateTiming(id, 1, { holdMs: 0, transitionMs: 1000 })
    return id
  }

  const glyphsFor = (id: string, leaf: string) =>
    rendered
      .get(id)!
      .group.getObjects()
      .filter((child) => child.get('role') === 'glyph' && child.get('leafId') === leaf)

  it('cuts an outline for every letter a tile ever shows', () => {
    const id = changing()
    draw()
    const first = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
    const letters = new Set(
      glyphsFor(id, first).map((child) => String(child.get('glyphKey')).split('|')[0]),
    )
    expect(letters).toEqual(new Set(['A', 'B']))
  })

  it('shows the letter of the state it is resting on', () => {
    const id = changing()
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const first = object.tiles[0]!.id
    const references = glyphReferenceRects(object)
    const group = rendered.get(id)!.group

    const showing = (t: number): string | null => {
      paintMosaicFrame(group, evaluateMosaicAtTime(object, t), references, object.localBounds)
      const visible = glyphsFor(id, first).filter((child) => child.visible)
      return visible.length === 0 ? null : String(visible[0]!.get('glyphKey')).split('|')[0]!
    }

    expect(showing(0), 'state 1').toBe('A')
    expect(showing(500), 'mid-transition it is still the letter being left').toBe('A')
    expect(showing(1000), 'the cut lands on arrival').toBe('B')
  })

  it('draws nothing at all where a state writes nothing', () => {
    const id = changing()
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const first = object.tiles[0]!.id
    const references = glyphReferenceRects(object)
    const group = rendered.get(id)!.group

    // On arrival at the state that says nothing there.
    paintMosaicFrame(group, evaluateMosaicAtTime(object, 2000), references, object.localBounds)

    expect(glyphsFor(id, first).filter((child) => child.visible)).toHaveLength(0)
    // And the tile itself is untouched — it keeps its place and its background.
    const tile = group
      .getObjects()
      .find((child) => child.get('role') === 'tile' && child.get('leafId') === first)
    expect(tile?.visible).toBe(true)
    expect(tile!.width).toBeGreaterThan(0)
  })

  it('never shows two letters in one tile', () => {
    const id = changing()
    draw()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const first = object.tiles[0]!.id
    const references = glyphReferenceRects(object)
    const group = rendered.get(id)!.group

    for (let t = 0; t <= 2000; t += 100) {
      paintMosaicFrame(group, evaluateMosaicAtTime(object, t), references, object.localBounds)
      expect(glyphsFor(id, first).filter((child) => child.visible).length, `t=${t}`).toBeLessThan(2)
    }
  })
})
