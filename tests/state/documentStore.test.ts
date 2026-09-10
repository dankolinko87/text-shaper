import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from '../../src/state/uiStore'
import {
  MOSAIC_DEFAULT_STATES,
  MOSAIC_MAX_STATES,
  MOSAIC_MIN_STATES,
  MOSAIC_MIN_TRANSITION_MS,
} from '../../src/types/mosaic'
import { MOSAIC_DEFAULT_SNAP } from '../../src/mosaic/snap'


import { readingOrder } from '../../src/mosaic/order'
import { isRim } from '../../src/types/mosaic'
import { mosaicTiles } from '../../src/mosaic/tiles'
import { moveEdge, selectionEdges } from '../../src/mosaic/boundaries'
import { setCharacter, typeCharacter } from '../../src/mosaic/typing'
import { mosaicIn, shapeIn } from '../fixtures/objects'
import type { LetterMosaicObject } from '../../src/types/document'
import { outlineToPath } from '../../src/geometry/outline'
import { pathBounds } from '../../src/geometry/path'
import { strokeToLinePath, strokeToShapePath } from '../../src/geometry/strokeToPath'
import { hasContainer } from '../../src/typography/objectFit'
import { createEmptyDocument } from '../../src/state/defaults'
import { MOSAIC_DEFAULT_SPACING, useDocumentStore } from '../../src/state/documentStore'
import {
  deserializeDocument,
  serializeDocument,
  validateDocument,
} from '../../src/state/persistence'
import { circleStroke, drawnLineStroke } from '../fixtures/strokes'

function addShape(cx = 300, cy = 300, r = 120): string {
  const stroke = strokeToShapePath(circleStroke(cx, cy, r))
  if (!stroke.ok) throw new Error('fixture stroke failed to convert')
  return useDocumentStore.getState().createObjectFromStroke(stroke)
}

/**
 * What a mosaic says, tile by tile, in one of its states.
 *
 * Letters belong to the states now — a tile is the place, the state says what is
 * written there — so every assertion about text has to name a state.
 */
const written = (mosaic: LetterMosaicObject, at = 0): (string | null)[] =>
  mosaic.tiles.map((tile) => mosaic.states[at]?.chars[tile.id] ?? null)

const writtenById = (mosaic: LetterMosaicObject, at = 0): (readonly [string, string | null])[] =>
  mosaic.tiles.map((tile) => [tile.id, mosaic.states[at]?.chars[tile.id] ?? null] as const)

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
})

describe('documentStore — objects', () => {
  it('creates an object from a stroke and selects it', () => {
    const id = addShape()
    const state = useDocumentStore.getState()
    expect(state.doc.objectOrder).toEqual([id])
    expect(state.selection).toEqual([id])
    expect(shapeIn(state.doc, id).currentSourcePath).toBeTruthy()
  })

  it('keeps originalSourcePath as the untouched restore target', () => {
    const id = addShape()
    const original = shapeIn(useDocumentStore.getState().doc, id).originalSourcePath

    useDocumentStore.getState().updateObject(id, {
      currentSourcePath: 'M0 0 L10 0 L10 10 Z',
      geometryRevision: 2,
    })

    const after = shapeIn(useDocumentStore.getState().doc, id)
    expect(after.originalSourcePath).toBe(original)
    expect(after.currentSourcePath).not.toBe(original)
  })

  it('duplicates an object directly above its source with a new id and seed', () => {
    const a = addShape()
    const b = addShape(500, 300)
    const [copy] = useDocumentStore.getState().duplicateObjects([a])
    expect(copy).toBeTruthy()
    if (!copy) return

    const { doc } = useDocumentStore.getState()
    expect(doc.objectOrder).toEqual([a, copy, b])
    expect(doc.objects[copy]?.name).toBe('Shape 1 copy')
    expect(shapeIn(doc, copy).seed).not.toBe(shapeIn(doc, a).seed)
  })

  it('deletes objects and prunes them from the selection', () => {
    const a = addShape()
    const b = addShape(500, 300)
    useDocumentStore.getState().setSelection([a, b])
    useDocumentStore.getState().deleteObjects([a])

    const state = useDocumentStore.getState()
    expect(state.doc.objectOrder).toEqual([b])
    expect(state.selection).toEqual([b])
  })

  it('reorders within the z-stack', () => {
    const a = addShape()
    const b = addShape(500, 300)
    const c = addShape(700, 300)
    useDocumentStore.getState().reorderObject(c, 0)
    expect(useDocumentStore.getState().doc.objectOrder).toEqual([c, a, b])
  })

  it('deselects an object when it is locked', () => {
    const id = addShape()
    useDocumentStore.getState().setSelection([id])
    useDocumentStore.getState().setLocked(id, true)
    expect(useDocumentStore.getState().selection).toEqual([])
    expect(shapeIn(useDocumentStore.getState().doc, id).locked).toBe(true)
  })

  it('edits one object without disturbing another', () => {
    const a = addShape()
    const b = addShape(600, 300)
    const bPathBefore = shapeIn(useDocumentStore.getState().doc, b).currentSourcePath

    useDocumentStore.getState().updateObject(a, { text: 'only mine' })

    const state = useDocumentStore.getState()
    expect(shapeIn(state.doc, a).text).toBe('only mine')
    expect(shapeIn(state.doc, b).text).toBe('')
    expect(shapeIn(state.doc, b).currentSourcePath).toBe(bPathBefore)
  })
})

describe('documentStore — history', () => {
  it('records one entry per commit, not per mutation', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')

    // Simulate a gesture streaming many updates with a single commit at the end.
    for (let i = 0; i < 20; i++) {
      useDocumentStore.getState().updateObject(id, { text: `step ${i}` })
    }
    useDocumentStore.getState().commit('Edit text')

    expect(useDocumentStore.getState().past).toHaveLength(2)
  })

  it('undoes a whole gesture in one step', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')
    const before = shapeIn(useDocumentStore.getState().doc, id).text

    for (let i = 0; i < 20; i++) {
      useDocumentStore.getState().updateObject(id, { text: `step ${i}` })
    }
    useDocumentStore.getState().commit('Edit text')
    expect(shapeIn(useDocumentStore.getState().doc, id).text).toBe('step 19')

    useDocumentStore.getState().undo()
    expect(shapeIn(useDocumentStore.getState().doc, id).text).toBe(before)
  })

  it('redoes what was undone', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')
    useDocumentStore.getState().updateObject(id, { text: 'hello' })
    useDocumentStore.getState().commit('Edit text')

    useDocumentStore.getState().undo()
    expect(shapeIn(useDocumentStore.getState().doc, id).text).toBe('')
    useDocumentStore.getState().redo()
    expect(shapeIn(useDocumentStore.getState().doc, id).text).toBe('hello')
  })

  it('clears the redo stack once a new change is committed', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')
    useDocumentStore.getState().updateObject(id, { text: 'first' })
    useDocumentStore.getState().commit('Edit text')
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().canRedo()).toBe(true)

    useDocumentStore.getState().updateObject(id, { text: 'second' })
    useDocumentStore.getState().commit('Edit text again')
    expect(useDocumentStore.getState().canRedo()).toBe(false)
  })

  it('is a no-op when there is nothing to undo or redo', () => {
    const before = useDocumentStore.getState().doc
    useDocumentStore.getState().undo()
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc).toBe(before)
  })

  it('restores a deleted object on undo', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')
    useDocumentStore.getState().deleteObjects([id])
    useDocumentStore.getState().commit('Delete')

    expect(useDocumentStore.getState().doc.objectOrder).toEqual([])
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.objectOrder).toEqual([id])
  })

  it('does not restore selection for objects that no longer exist', () => {
    const id = addShape()
    useDocumentStore.getState().commit('Draw shape')
    useDocumentStore.getState().deleteObjects([id])
    useDocumentStore.getState().commit('Delete')
    useDocumentStore.getState().redo()
    for (const selected of useDocumentStore.getState().selection) {
      expect(useDocumentStore.getState().doc.objects[selected]).toBeTruthy()
    }
  })
})

describe('persistence', () => {
  it('round-trips a document with objects', () => {
    addShape()
    addShape(600, 400, 80)
    const doc = useDocumentStore.getState().doc

    const result = deserializeDocument(serializeDocument(doc))
    expect(result.ok).toBe(true)
    expect(result.doc).toEqual(doc)
  })

  it('rejects a document from a newer schema version', () => {
    const doc = { ...createEmptyDocument(), schemaVersion: 99 }
    const result = deserializeDocument(JSON.stringify(doc))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/newer version/i)
  })

  it('rejects malformed JSON', () => {
    expect(deserializeDocument('{not json').ok).toBe(false)
  })

  it('rejects an object order that references a missing object', () => {
    const doc = createEmptyDocument() as unknown as Record<string, unknown>
    doc.objectOrder = ['ghost']
    const result = validateDocument(doc)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/missing object/i)
  })

  it('rejects duplicate ids in the object order', () => {
    addShape()
    const doc = JSON.parse(
      serializeDocument(useDocumentStore.getState().doc),
    ) as Record<string, unknown>
    const order = doc.objectOrder as string[]
    doc.objectOrder = [...order, order[0] as string]
    const result = validateDocument(doc)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/duplicate/i)
  })

  it('rejects an object missing from the order', () => {
    addShape()
    const doc = JSON.parse(
      serializeDocument(useDocumentStore.getState().doc),
    ) as Record<string, unknown>
    doc.objectOrder = []
    const result = validateDocument(doc)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/missing from the object order/i)
  })

  it('preserves the exact text through a save and reload', () => {
    const id = addShape()
    const text = 'Typography  becomes\nthe shape — itself!'
    useDocumentStore.getState().updateObject(id, { text })

    const result = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(result.ok).toBe(true)
    expect(shapeIn(result.doc!, id).text).toBe(text)
  })
})

describe('the nodes an object is created with', () => {
  /*
   * An object carries its geometry twice: the path string every downstream
   * reader consumes, and the node list the editor takes hold of. They have to
   * agree from the moment the object exists, or the first handle dragged jumps
   * the shape back to whatever the stale list said.
   */
  it('gives a drawn shape nodes that describe its own path', () => {
    const id = addShape()
    const object = shapeIn(useDocumentStore.getState().doc, id)
    expect(object.outline, 'a drawn shape has nodes').not.toBeNull()

    const drawn = pathBounds(outlineToPath(object.outline!))
    const stored = pathBounds(object.currentSourcePath)
    expect(Math.abs(drawn.width - stored.width)).toBeLessThan(0.05)
    expect(Math.abs(drawn.height - stored.height)).toBeLessThan(0.05)
  })

  it('gives a primitive none', () => {
    // An ellipse is a preset, not a drawing. Four draggable nodes on it would be
    // offering an edit the tool does not mean.
    const path = 'M0 0L100 0L100 80L0 80Z'
    const id = useDocumentStore.getState().createObjectFromGeometry({
      pathData: path,
      localBounds: { x: 0, y: 0, width: 100, height: 80 },
      artboardCenter: { x: 0, y: 0 },
      open: false,
      name: 'Rectangle',
    })
    expect(shapeIn(useDocumentStore.getState().doc, id).outline).toBeNull()
  })

  it('does not hand the caller\'s own nodes to the object', () => {
    // The pipeline that produced the outline may still be holding it, and an
    // object's geometry is its own.
    const stroke = strokeToShapePath(circleStroke(300, 300, 120))
    if (!stroke.ok) throw new Error('fixture stroke failed to convert')
    const id = useDocumentStore.getState().createObjectFromGeometry(stroke)

    stroke.outline.subpaths[0]!.nodes[0]!.point.x = 9999
    const stored = shapeIn(useDocumentStore.getState().doc, id).outline!
    expect(stored.subpaths[0]!.nodes[0]!.point.x).not.toBe(9999)
  })
})

describe('a drawn line stays a line', () => {
  /*
   * The whole difference between the two drawing tools, and it went missing
   * once: the discriminator that decides it was optional, a caller stopped
   * passing anything, and the default was the other answer — so every line the
   * line tool drew came out a filled shape. Nothing failed, because nothing
   * asked.
   */
  function draw(open: boolean): string {
    const stroke = open
      ? strokeToLinePath(drawnLineStroke('wave'))
      : strokeToShapePath(circleStroke(300, 300, 120))
    if (!stroke.ok) throw new Error('fixture stroke failed to convert')
    return useDocumentStore.getState().createObjectFromGeometry(stroke)
  }

  it('puts it in the one mode an open path can be in', () => {
    const id = draw(true)
    const line = shapeIn(useDocumentStore.getState().doc, id)
    expect(line.fittingMode, 'a line runs along its path').toBe('path')
    expect(hasContainer(line), 'and has no inside').toBe(false)
    // A guide, not artwork: no fill is what makes the renderer draw it as a
    // thin stroke instead of a solid.
    expect(line.appearance.containerFill).toBeNull()
  })

  it('leaves a drawn shape as something to fill', () => {
    const id = draw(false)
    const shape = shapeIn(useDocumentStore.getState().doc, id)
    expect(shape.fittingMode).toBe('boundary-warp')
    expect(hasContainer(shape)).toBe(true)
    expect(shape.appearance.containerFill).not.toBeNull()
  })
})

describe('mosaics in the document', () => {
  /*
   * The union's first real exercise: a second kind of object living alongside
   * the first, through creation, duplication and a round trip.
   */
  const make = (columns = 3, rows = 3): string =>
    useDocumentStore.getState().createMosaic({
      columns,
      rows,
      artboardCenter: { x: 100, y: 200 },
      text: 'ABCDEFGHI',
    })

  it('creates one alongside the shapes, selected and centred where asked', () => {
    const shape = addShape()
    const id = make()
    const doc = useDocumentStore.getState().doc

    expect(doc.objectOrder).toEqual([shape, id])
    expect(useDocumentStore.getState().selection).toEqual([id])

    const mosaic = mosaicIn(doc, id)
    expect(mosaic.kind).toBe('mosaic')
    expect(mosaic.transform.x).toBe(100)
    expect(written(mosaic).join('')).toBe('ABCDEFGHI')
    // Its own origin is the middle of the composition, like everything else.
    expect(mosaic.localBounds.x).toBe(-mosaic.localBounds.width / 2)
  })

  it('starts with three identical states, each holding every line the tiles name', () => {
    const id = make(4, 2)
    const mosaic = mosaicIn(useDocumentStore.getState().doc, id)
    // A timeline from the outset, with nothing happening on it yet. Editing any
    // one of them is what makes it move.
    expect(mosaic.states).toHaveLength(MOSAIC_DEFAULT_STATES)

    for (const state of mosaic.states) {
      for (const tile of mosaic.tiles) {
        for (const line of [tile.left, tile.right]) {
          if (!isRim(line)) expect(state.x[line], line).toBeTypeOf('number')
        }
        for (const line of [tile.top, tile.bottom]) {
          if (!isRim(line)) expect(state.y[line], line).toBeTypeOf('number')
        }
      }
    }

    const first = mosaic.states[0]!
    for (const state of mosaic.states.slice(1)) {
      expect(state.x, 'identical, so nothing moves until it is edited').toEqual(first.x)
      expect(state.y).toEqual(first.y)
    }
    // Same geometry, but each is its own state.
    const ids = new Set(mosaic.states.map((state) => state.id))
    expect(ids.size, 'every state has its own id').toBe(mosaic.states.length)
  })

  it('duplicates one without sharing an id with it', () => {
    /*
     * The failure this prevents: ids are unique across the document and every
     * state keys its proportions and colours by them, so a duplicate that kept
     * them would read the original's entries — and would appear to move when the
     * original was edited.
     */
    const id = make()
    const [copy] = useDocumentStore.getState().duplicateObjects([id])
    expect(copy).toBeTruthy()
    if (!copy) return

    const doc = useDocumentStore.getState().doc
    const from = mosaicIn(doc, id)
    const to = mosaicIn(doc, copy)

    const ids = (m: typeof from): string[] => [
      ...m.tiles.map((l) => l.id),
      ...Object.keys(m.states[0]!.x),
      ...Object.keys(m.states[0]!.y),
      ...m.states.map((s) => s.id),
    ]
    const before = new Set(ids(from))
    for (const each of ids(to)) expect(before.has(each), each).toBe(false)

    // And identical to look at: same characters, same rectangles.
    expect(written(to)).toEqual(written(from))
    expect([...mosaicTiles(to)].map(([, t]) => t.structural)).toEqual(
      [...mosaicTiles(from)].map(([, t]) => t.structural),
    )
  })

  it('survives being saved and loaded', () => {
    const id = make(2, 3)
    const result = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(result.ok, result.error).toBe(true)

    const mosaic = mosaicIn(result.doc!, id)
    expect(mosaic.kind).toBe('mosaic')
    expect(mosaic.tiles).toHaveLength(6)
    expect(mosaic.states[0]!.x).toEqual(
      mosaicIn(useDocumentStore.getState().doc, id).states[0]!.x,
    )
    expect(mosaic.states[0]!.y).toEqual(
      mosaicIn(useDocumentStore.getState().doc, id).states[0]!.y,
    )
  })

  it('leaves the shape operations alone', () => {
    // `updateObject` and the geometry writers are typography's. Handing one a
    // mosaic must do nothing rather than half-apply a shape's fields to it.
    const id = make()
    const before = mosaicIn(useDocumentStore.getState().doc, id)
    useDocumentStore.getState().updateObject(id, { text: 'nope' } as never)
    useDocumentStore.getState().setGeometry(id, { path: 'M0 0L1 1Z', outline: null })
    expect(mosaicIn(useDocumentStore.getState().doc, id)).toEqual(before)
  })
})

describe('what a mosaic remembers', () => {
  /*
   * Characters live on leaves and leaves keep their ids for the life of the
   * object — that is what will let an animation know which tile becomes which.
   * A round trip is the cheapest place to check the promise holds.
   */
  const typed = (): string => {
    const id = useDocumentStore.getState().createMosaic({
      columns: 3,
      rows: 3,
      artboardCenter: { x: 0, y: 0 },
    })
    const mosaic = mosaicIn(useDocumentStore.getState().doc, id)
    const order = readingOrder(mosaicTiles(mosaic))
    let written = mosaic.states[0]!.chars
    for (const [i, char] of [...'AB·D·F'].entries()) {
      if (char !== '·') written = setCharacter(written, order[i] as string, char)
    }
    // Every state, so the mosaic says the same thing wherever the timeline is.
    mosaic.states.forEach((_, at) => useDocumentStore.getState().setMosaicChars(id, at, written))
    return id
  }

  it('keeps every character and every leaf id through a save and load', () => {
    const id = typed()
    const before = mosaicIn(useDocumentStore.getState().doc, id)

    const result = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(result.ok, result.error).toBe(true)
    const after = mosaicIn(result.doc!, id)

    expect(writtenById(after)).toEqual(writtenById(before))
  })

  it('keeps empty tiles as tiles rather than dropping them', () => {
    // An empty tile still occupies its share of the mosaic and is still where
    // the caret can go. Losing it on save would change the layout.
    const id = typed()
    const loaded = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    const after = mosaicIn(loaded.doc!, id)
    expect(after.tiles).toHaveLength(9)
    expect(written(after).filter((char) => char === null)).toHaveLength(5)
  })

  it('will not let a shape update touch one', () => {
    const id = typed()
    const before = mosaicIn(useDocumentStore.getState().doc, id)
    useDocumentStore.getState().updateObject(id, { text: 'nope' } as never)
    expect(mosaicIn(useDocumentStore.getState().doc, id)).toEqual(before)
  })
})

describe('what every object can be told, whatever kind it is', () => {
  /*
   * Name, placement, visibility and lock belong to every object. They were all
   * routed through `updateObject`, which is typography's — so on a mosaic every
   * one of them was silently refused. Dragging one did nothing at all: the write
   * was dropped and the next redraw put the object back where it started.
   */
  const mosaic = (): string =>
    useDocumentStore.getState().createMosaic({
      columns: 2,
      rows: 2,
      artboardCenter: { x: 100, y: 100 },
    })

  it('moves a mosaic, which is the one that was broken', () => {
    const id = mosaic()
    const moved = { ...mosaicIn(useDocumentStore.getState().doc, id).transform, x: 500, y: 250 }
    useDocumentStore.getState().setBase(id, { transform: moved })

    const after = mosaicIn(useDocumentStore.getState().doc, id).transform
    expect(after.x).toBe(500)
    expect(after.y).toBe(250)
  })

  it('turns one too', () => {
    const id = mosaic()
    const turned = { ...mosaicIn(useDocumentStore.getState().doc, id).transform, rotation: 30 }
    useDocumentStore.getState().setBase(id, { transform: turned })
    expect(mosaicIn(useDocumentStore.getState().doc, id).transform.rotation).toBe(30)
  })

  it('renames, hides and locks either kind', () => {
    const shape = addShape()
    const tiles = mosaic()

    for (const id of [shape, tiles]) {
      const store = useDocumentStore.getState()
      store.renameObject(id, 'renamed')
      store.setVisible(id, false)
      store.setLocked(id, true)

      const object = useDocumentStore.getState().doc.objects[id]!
      expect(object.name, id).toBe('renamed')
      expect(object.visible, id).toBe(false)
      expect(object.locked, id).toBe(true)
    }
  })

  it('still refuses a shape setting on a mosaic', () => {
    // The base action is not a way around the discriminator: typography's own
    // settings still belong to typography.
    const id = mosaic()
    const before = mosaicIn(useDocumentStore.getState().doc, id)
    useDocumentStore.getState().updateObject(id, { text: 'nope' } as never)
    expect(mosaicIn(useDocumentStore.getState().doc, id)).toEqual(before)
  })
})

describe('a mosaic’s spacing', () => {
  /*
   * The three values reach the document through one action, which clamps them.
   * The panel's sliders are already ranged to the legal maxima, so the clamp is
   * for what a person can type into the number field and for a document that
   * arrived from somewhere else.
   */
  const mosaic = (): string =>
    useDocumentStore.getState().createMosaic({
      columns: 3,
      rows: 4,
      artboardCenter: { x: 0, y: 0 },
    })

  // Spacing lives on the state now, along with the font.
  const spacingOf = (id: string) => {
    const state = mosaicIn(useDocumentStore.getState().doc, id).states[0]!
    return { gap: state.gap, outerPadding: state.outerPadding, glyphInset: state.glyphInset }
  }

  it('takes a value the mosaic has room for', () => {
    const id = mosaic()
    useDocumentStore.getState().setMosaicSpacing(id, { gap: 20, outerPadding: 12, glyphInset: 4 })
    expect(spacingOf(id)).toEqual({ gap: 20, outerPadding: 12, glyphInset: 4 })
  })

  it('refuses one it does not, rather than collapsing its tiles', () => {
    const id = mosaic()
    useDocumentStore.getState().setMosaicSpacing(id, { gap: 100000 })

    const after = mosaicIn(useDocumentStore.getState().doc, id)
    expect(after.states[0]!.gap).toBeLessThan(100000)
    for (const tile of mosaicTiles(after).values()) {
      expect(tile.visible.width).toBeGreaterThan(0)
      expect(tile.visible.height).toBeGreaterThan(0)
    }
  })

  it('never rewrites a value it was not asked about', () => {
    /*
     * Found by hand, in the browser. Typing an over-large gap ran all three
     * values through the repair chain, which dropped the glyph inset to zero as
     * a side effect — and Escape then restored the gap while leaving the inset
     * where the accident had left it, so an abandoned edit permanently changed
     * a control nobody had touched.
     *
     * A control may narrow another control's RANGE. It may not change its value.
     */
    const id = mosaic()
    useDocumentStore.getState().setMosaicSpacing(id, { glyphInset: 12, outerPadding: 8 })
    const before = spacingOf(id)
    expect(before).toEqual({ gap: MOSAIC_DEFAULT_SPACING.gap, outerPadding: 8, glyphInset: 12 })

    useDocumentStore.getState().setMosaicSpacing(id, { gap: 99999 })

    const after = spacingOf(id)
    expect(after.glyphInset, 'the inset was left alone').toBe(12)
    expect(after.outerPadding, 'so was the padding').toBe(8)
    // And the gap it settled on still leaves room for both of them.
    for (const tile of mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id)).values()) {
      expect(tile.glyph.width).toBeGreaterThan(0)
      expect(tile.glyph.height).toBeGreaterThan(0)
    }
  })

  it('resolves all three against each other when all three are set at once', () => {
    // Reset asks for the whole triple, where there is no neighbour to protect —
    // so that one goes through the repair chain, in dependency order.
    const id = mosaic()
    useDocumentStore
      .getState()
      .setMosaicSpacing(id, { gap: 5000, outerPadding: 5000, glyphInset: 5000 })

    const after = spacingOf(id)
    expect(after.gap).toBeLessThan(5000)
    expect(after.outerPadding).toBeLessThan(5000)
    expect(after.glyphInset).toBeLessThan(5000)
    for (const tile of mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id)).values()) {
      expect(tile.visible.width).toBeGreaterThanOrEqual(0)
      expect(tile.glyph.width).toBeGreaterThanOrEqual(0)
    }
  })

  it('makes one history entry for a whole slider gesture', () => {
    /*
     * A drag streams values into the store and commits once on release. Without
     * that, dragging a slider across its range would bury every other edit in
     * the session under a hundred entries and make undo useless.
     */
    const id = mosaic()
    useDocumentStore.getState().commit('Draw mosaic')
    const before = useDocumentStore.getState().past.length

    const store = useDocumentStore.getState()
    for (const gap of [7, 9, 12, 16, 21]) store.setMosaicSpacing(id, { gap })
    store.commit('Change gap')

    expect(useDocumentStore.getState().past.length).toBe(before + 1)
    expect(spacingOf(id).gap).toBe(21)

    // And one undo puts back the value from before the gesture began, not the
    // fourth frame of it.
    useDocumentStore.getState().undo()
    expect(spacingOf(id).gap).toBe(MOSAIC_DEFAULT_SPACING.gap)
  })

  it('adds nothing to the history when a gesture changed nothing', () => {
    const id = mosaic()
    useDocumentStore.getState().commit('Draw mosaic')
    const before = useDocumentStore.getState().past.length

    const store = useDocumentStore.getState()
    store.setMosaicSpacing(id, { gap: MOSAIC_DEFAULT_SPACING.gap })
    store.commit('Change gap')
    expect(useDocumentStore.getState().past.length).toBe(before)
  })

  it('survives a save and a load, along with the font', () => {
    const id = mosaic()
    const store = useDocumentStore.getState()
    store.setMosaicSpacing(id, { gap: 14, outerPadding: 9, glyphInset: 3.5 })
    store.setMosaicFont(
      id,
      { ...mosaicIn(useDocumentStore.getState().doc, id).states[0]!.font, fontId: 'bebas-neue' },
      0,
    )

    const result = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(result.ok, result.error).toBe(true)
    const after = mosaicIn(result.doc!, id)

    expect(after.states[0]!.gap).toBe(14)
    expect(after.states[0]!.outerPadding).toBe(9)
    expect(after.states[0]!.glyphInset).toBe(3.5)
    expect(after.states[0]!.font.fontId).toBe('bebas-neue')
  })

  it('leaves the tiles and their characters exactly where they were', () => {
    // Spacing moves rectangles, never identity. The caret is a leaf id, so a
    // tile that changed id under a spacing change would move the caret with it.
    const id = mosaic()
    const before = mosaicIn(useDocumentStore.getState().doc, id).tiles

    useDocumentStore.getState().setMosaicSpacing(id, { gap: 24, outerPadding: 18 })

    const after = mosaicIn(useDocumentStore.getState().doc, id).tiles
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id))
  })

  it('will not take a shape setting through the spacing door', () => {
    const shape = addShape()
    const before = shapeIn(useDocumentStore.getState().doc, shape)
    useDocumentStore.getState().setMosaicSpacing(shape, { gap: 40 })
    expect(shapeIn(useDocumentStore.getState().doc, shape)).toEqual(before)
  })
})

describe('reshaping a mosaic', () => {
  /*
   * Dragging lines and the two topology primitives, as the store sees them. The
   * geometry is proved in `tests/mosaic/boundaries.test.ts`; what matters here
   * is history, identity, and reaching every state.
   */
  const mosaic = (cols = 3, rows = 3): string =>
    useDocumentStore.getState().createMosaic({
      columns: cols,
      rows: rows,
      artboardCenter: { x: 0, y: 0 },
    })

  const stateOf = (id: string) => {
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    return m.states[0]!
  }

  const firstEdge = (id: string) => {
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    const state = stateOf(id)
    return selectionEdges(
      m.tiles,
      state.x,
      state.y,
      m.localBounds,
      { gap: state.gap, outerPadding: state.outerPadding, glyphInset: state.glyphInset },
      [m.tiles[0]!.id],
    )[0]!
  }

  it('makes one history entry for a whole drag, whatever it passed through', () => {
    const id = mosaic()
    useDocumentStore.getState().commit('Draw mosaic')
    const before = useDocumentStore.getState().past.length

    const edge = firstEdge(id)
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    const start = stateOf(id)
    const spacing = { gap: m.states[0]!.gap, outerPadding: m.states[0]!.outerPadding, glyphInset: m.states[0]!.glyphInset }

    // Sixty frames of a drag, the way the layer streams them.
    for (let frame = 1; frame <= 60; frame++) {
      const moved = moveEdge(
        m.tiles,
        start.x,
        start.y,
        m.localBounds,
        spacing,
        edge.axis,
        edge.id,
        frame * 0.5,
      )!
      useDocumentStore.getState().setMosaicCoordinates(id, edge.axis, [{ id: edge.id, value: moved.updates[0]!.value }])
    }
    useDocumentStore.getState().commit('Resize tiles')

    expect(useDocumentStore.getState().past.length).toBe(before + 1)

    // And one undo puts back where the drag began, not its fifty-ninth frame.
    useDocumentStore.getState().undo()
    expect(stateOf(id)[edge.axis][edge.id]).toBe(start[edge.axis][edge.id])
  })

  it('adds nothing to the history when a drag ended where it started', () => {
    const id = mosaic()
    useDocumentStore.getState().commit('Draw mosaic')
    const before = useDocumentStore.getState().past.length

    const edge = firstEdge(id)
    const value = stateOf(id)[edge.axis][edge.id] as number
    useDocumentStore.getState().setMosaicCoordinates(id, edge.axis, [{ id: edge.id, value: value }])
    useDocumentStore.getState().commit('Resize tiles')

    expect(useDocumentStore.getState().past.length).toBe(before)
  })

  it('moves only the tiles that name the line', () => {
    /*
     * The property four rounds of reports were about, checked through the store
     * rather than the geometry: a drag changes one number, and the tiles reading
     * that number are exactly the tiles whose rectangles change.
     */
    const id = mosaic(4, 4)
    const edge = firstEdge(id)
    const before = new Map(
      [...mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id))].map(([k, v]) => [
        k,
        v.structural,
      ]),
    )

    const value = (stateOf(id)[edge.axis][edge.id] as number) + 0.04
    useDocumentStore.getState().setMosaicCoordinates(id, edge.axis, [{ id: edge.id, value: value }])

    const after = mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id))
    const changed = [...before.keys()].filter((tile) => {
      const a = before.get(tile)!
      const b = after.get(tile)!.structural
      return Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.width - b.width) > 1e-9
    })
    expect(new Set(changed)).toEqual(new Set(edge.moves))
  })

  it('never moves a character between tiles while resizing', () => {
    const id = mosaic()
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    let written = object.states[0]!.chars
    for (const [i, tile] of object.tiles.entries()) {
      written = setCharacter(written, tile.id, String.fromCharCode(65 + i))
    }
    object.states.forEach((_, at) => useDocumentStore.getState().setMosaicChars(id, at, written))
    const before = writtenById(mosaicIn(useDocumentStore.getState().doc, id))

    const edge = firstEdge(id)
    const value = (stateOf(id)[edge.axis][edge.id] as number) + 0.05
    useDocumentStore.getState().setMosaicCoordinates(id, edge.axis, [{ id: edge.id, value: value }])

    expect(writtenById(mosaicIn(useDocumentStore.getState().doc, id))).toEqual(
      before,
    )
  })

  it('forks a line so a tile stops being aligned, without moving anything', () => {
    const id = mosaic(2, 2)
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    const state = stateOf(id)
    const target = m.tiles[0]!
    const before = new Map(
      [...mosaicTiles(m)].map(([k, v]) => [k, v.structural]),
    )

    const ok = useDocumentStore.getState().forkMosaicCoordinate(id, 'x', target.right, {
      from: state.y[target.top] ?? 0,
      to: state.y[target.bottom] ?? 1,
    })
    expect(ok).toBe(true)

    // Nothing moved.
    const after = mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id))
    for (const [tile, rect] of before) {
      expect(after.get(tile)!.structural, tile).toEqual(rect)
    }

    // And that line now moves two tiles rather than the column.
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const next = stateOf(id)
    const edges = selectionEdges(
      object.tiles,
      next.x,
      next.y,
      object.localBounds,
      { gap: object.states[0]!.gap, outerPadding: object.states[0]!.outerPadding, glyphInset: object.states[0]!.glyphInset },
      [target.id],
    )
    const own = edges.find((e) => e.axis === 'x' && e.moves.length === 2)
    expect(own, 'the forked line moves only the pair').toBeTruthy()
  })

  it('widens a fork to whole tiles rather than tearing one', () => {
    /*
     * Asked for half a row, it takes the whole row: repointing a tile that is
     * partly inside the span would move one of its corners and not the other.
     * Reaching a little further is much better than refusing and leaving the
     * line shared with everything.
     */
    const id = mosaic(2, 2)
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    const target = m.tiles[0]!
    const before = new Map([...mosaicTiles(m)].map(([k, v]) => [k, v.structural]))

    expect(
      useDocumentStore.getState().forkMosaicCoordinate(id, 'x', target.right, { from: 0, to: 0.25 }),
    ).toBe(true)

    // And nothing moved, which is what makes taking more harmless.
    const after = mosaicTiles(mosaicIn(useDocumentStore.getState().doc, id))
    for (const [tile, rect] of before) expect(after.get(tile)!.structural, tile).toEqual(rect)
  })

  it('splits a tile, in one entry, reaching every state', () => {
    const id = mosaic(2, 2)
    useDocumentStore.getState().commit('Draw mosaic')
    const at = useDocumentStore.getState().past.length

    const target = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
    const created = useDocumentStore.getState().splitMosaicTile(id, target, 'x')
    useDocumentStore.getState().commit('Split tile vertically')

    expect(created).toBeTruthy()
    expect(useDocumentStore.getState().past.length).toBe(at + 1)

    const after = mosaicIn(useDocumentStore.getState().doc, id)
    expect(after.tiles).toHaveLength(5)
    const fresh = after.tiles.find((t) => t.id === created)!
    for (const state of after.states) {
      expect(state.x[fresh.left], 'every state learned the new line').toBeDefined()
    }
  })

  it('removes an empty tile but refuses a full one', () => {
    const id = mosaic(3, 1)
    const tiles = mosaicIn(useDocumentStore.getState().doc, id).tiles
    const [first, second] = tiles

    useDocumentStore
      .getState()
      .setMosaicChars(
        id,
        0,
        setCharacter(mosaicIn(useDocumentStore.getState().doc, id).states[0]!.chars, second!.id, 'X'),
      )
    expect(
      useDocumentStore.getState().removeMosaicTile(id, second!.id),
      'has a letter in it',
    ).toBeNull()

    const absorbed = useDocumentStore.getState().removeMosaicTile(id, first!.id)
    expect(absorbed).toBe(second!.id)
    expect(mosaicIn(useDocumentStore.getState().doc, id).tiles).toHaveLength(2)
  })

  it('drops a removed tile’s colour records and its retired lines', () => {
    const id = mosaic(2, 1)
    const target = mosaicIn(useDocumentStore.getState().doc, id).tiles[1]!.id
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const line = object.tiles[1]!.left
    useDocumentStore.getState().updateMosaic(id, {
      states: object.states.map((s) => ({
        ...s,
        glyphColour: { ...s.glyphColour, [target]: '#ff0000' },
        tileColour: { ...s.tileColour, [target]: '#00ff00' },
      })),
    })

    useDocumentStore.getState().removeMosaicTile(id, target)
    for (const state of mosaicIn(useDocumentStore.getState().doc, id).states) {
      expect(state.glyphColour[target]).toBeUndefined()
      expect(state.tileColour[target]).toBeUndefined()
      expect(state.x[line], 'the line between them went too').toBeUndefined()
    }
  })

  it('keeps ids unique across the document after a split', () => {
    const a = mosaic(2, 2)
    const b = mosaic(2, 2)
    for (const id of [a, b]) {
      const tile = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
      useDocumentStore.getState().splitMosaicTile(id, tile, 'y')
    }

    const everything: string[] = []
    for (const id of [a, b]) {
      const object = mosaicIn(useDocumentStore.getState().doc, id)
      everything.push(...object.tiles.map((t) => t.id))
      const state = object.states[0]!
      everything.push(...Object.keys(state.x), ...Object.keys(state.y))
    }
    expect(new Set(everything).size).toBe(everything.length)
  })

  it('survives a save and a load after structural editing', () => {
    const id = mosaic(3, 2)
    const tiles = mosaicIn(useDocumentStore.getState().doc, id).tiles
    useDocumentStore.getState().splitMosaicTile(id, tiles[0]!.id, 'x')
    useDocumentStore.getState().removeMosaicTile(id, tiles[3]!.id)

    const before = mosaicIn(useDocumentStore.getState().doc, id)
    const beforeRects = [...mosaicTiles(before)].map(([k, v]) => [k, v.structural])

    const result = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(result.ok, result.error).toBe(true)
    const after = mosaicIn(result.doc!, id)

    expect(writtenById(after)).toEqual(writtenById(before))
    expect([...mosaicTiles(after)].map(([k, v]) => [k, v.structural])).toEqual(beforeRects)
  })

  it('refuses all of them on a shape', () => {
    const shape = addShape()
    const before = shapeIn(useDocumentStore.getState().doc, shape)
    useDocumentStore.getState().setMosaicCoordinates(shape, 'x', [{ id: 'nope', value: 0.5 }])
    expect(useDocumentStore.getState().forkMosaicCoordinate(shape, 'x', 'nope', { from: 0, to: 1 })).toBe(false)
    expect(useDocumentStore.getState().splitMosaicTile(shape, 'nope', 'x')).toBeNull()
    expect(useDocumentStore.getState().removeMosaicTile(shape, 'nope')).toBeNull()
    expect(shapeIn(useDocumentStore.getState().doc, shape)).toEqual(before)
  })
})

describe('typing after the structure has changed', () => {
  const mosaic = (cols = 3, rows = 1): string =>
    useDocumentStore.getState().createMosaic({
      columns: cols,
      rows: rows,
      artboardCenter: { x: 0, y: 0 },
    })

  it('puts the tile a split created into reading order, ready to be typed into', () => {
    const id = mosaic(2, 1)
    const first = mosaicIn(useDocumentStore.getState().doc, id).tiles[0]!.id
    const created = useDocumentStore.getState().splitMosaicTile(id, first, 'x')!

    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const order = readingOrder(mosaicTiles(object))

    expect(order).toContain(created)
    // Left to right: the original, then the tile made beside it, then the rest.
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(created))

    // And it takes a character like any other tile.
    const typed = typeCharacter(object.states[0]!.chars, order, created, 'Q')
    useDocumentStore.getState().setMosaicChars(id, 0, typed.chars)
    expect(mosaicIn(useDocumentStore.getState().doc, id).states[0]!.chars[created]).toBe('Q')
  })

  it('drops a removed tile out of reading order and leaves the rest typeable', () => {
    const id = mosaic(3, 1)
    const leaves = mosaicIn(useDocumentStore.getState().doc, id).tiles
    const gone = leaves[1]!.id

    const absorbed = useDocumentStore.getState().removeMosaicTile(id, gone)!
    const object = mosaicIn(useDocumentStore.getState().doc, id)
    const order = readingOrder(mosaicTiles(object))

    expect(order).not.toContain(gone)
    expect(order).toContain(absorbed)

    const typed = typeCharacter(object.states[0]!.chars, order, order[0] as string, 'A')
    expect(Object.values(typed.chars).filter((char) => char === 'A')).toHaveLength(1)
  })
})

describe('a mosaic’s snap grid', () => {
  const mosaic = (cols = 3, rows = 3): string =>
    useDocumentStore.getState().createMosaic({
      columns: cols,
      rows: rows,
      artboardCenter: { x: 0, y: 0 },
    })

  it('is born with one', () => {
    const id = mosaic()
    expect(mosaicIn(useDocumentStore.getState().doc, id).snapStep).toBe(MOSAIC_DEFAULT_SNAP)
  })

  it('takes a new step, and refuses nonsense', () => {
    const id = mosaic()
    const store = () => useDocumentStore.getState()
    store().setMosaicSnap(id, 25)
    expect(mosaicIn(store().doc, id).snapStep).toBe(25)

    store().setMosaicSnap(id, -4)
    expect(mosaicIn(store().doc, id).snapStep, 'negatives mean off').toBe(0)

    store().setMosaicSnap(id, Number.NaN)
    expect(mosaicIn(store().doc, id).snapStep).toBe(0)
  })

  it('writes nothing when the step is already what was asked for', () => {
    const id = mosaic()
    const store = () => useDocumentStore.getState()
    store().setMosaicSnap(id, 25)
    store().commit('Change snap grid')
    const entries = store().past.length
    store().setMosaicSnap(id, 25)
    store().commit('Change snap grid')
    expect(store().past.length, 'an unchanged document is not an undo step').toBe(entries)
  })
})

describe('rejoining a mosaic’s lines', () => {
  /*
   * The store half of the round trip proved in `tests/mosaic/boundaries.test.ts`:
   * a fork that comes home has to disappear from EVERY state, or a state is left
   * holding a number for a line no tile names any more.
   */
  const mosaic = (): string =>
    useDocumentStore.getState().createMosaic({
      columns: 3,
      rows: 3,
      artboardCenter: { x: 0, y: 0 },
    })

  const forkFirstColumn = (id: string): string => {
    const store = useDocumentStore.getState()
    const m = mosaicIn(store.doc, id)
    const state = m.states[0]!
    const line = m.tiles[0]!.right
    const before = new Set(Object.keys(state.x))
    expect(store.forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 3 })).toBe(true)
    const after = mosaicIn(useDocumentStore.getState().doc, id)
    const now = after.states[0]!
    const created = Object.keys(now.x).find((key) => !before.has(key))
    if (!created) throw new Error('the fork minted no line')
    return created
  }

  it('drops the retired line from every state, not just the one on show', () => {
    const id = mosaic()
    const created = forkFirstColumn(id)

    // A second state, holding the same numbers — so the two lines agree
    // everywhere and are genuinely one line.
    const withTwo = mosaicIn(useDocumentStore.getState().doc, id)
    useDocumentStore.getState().updateMosaic(id, {
      states: [withTwo.states[0]!, { ...withTwo.states[0]! }],
    })

    // Naming the line the gesture wrote, as the drag does — otherwise which of
    // the pair survives is arbitrary, since the two describe the same layout.
    expect(
      useDocumentStore.getState().mergeMosaicCoordinates(id, 'x', new Set([created])),
    ).toBe(true)
    const merged = mosaicIn(useDocumentStore.getState().doc, id)
    for (const state of merged.states) {
      expect(Object.keys(state.x), 'no state still names it').not.toContain(created)
    }
    for (const tile of merged.tiles) {
      expect(tile.left).not.toBe(created)
      expect(tile.right).not.toBe(created)
    }
  })

  it('refuses when a state tells the two lines apart', () => {
    const id = mosaic()
    const created = forkFirstColumn(id)
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    const first = m.states[0]!
    // A second state where the fork sits somewhere else entirely. Joining them
    // would flatten the movement between the two states into nothing.
    useDocumentStore.getState().updateMosaic(id, {
      states: [first, { ...first, x: { ...first.x, [created]: 0.6 } }],
    })

    expect(useDocumentStore.getState().mergeMosaicCoordinates(id, 'x')).toBe(false)
    const after = mosaicIn(useDocumentStore.getState().doc, id)
    expect(Object.keys(after.states[0]!.x)).toContain(created)
  })

  it('says no when there is nothing to join', () => {
    const id = mosaic()
    expect(useDocumentStore.getState().mergeMosaicCoordinates(id, 'x')).toBe(false)
    expect(useDocumentStore.getState().mergeMosaicCoordinates(id, 'y')).toBe(false)
  })
})

describe('putting a mosaic back to the grid it was made as', () => {
  /*
   * "Reset" means the shape it had before anyone dragged anything, which is not
   * the same as evening out the lines it holds now. Dragging FORKS lines — pull
   * one tile's edge and the line it sat on becomes two — so a mosaic seeded as
   * three columns can be carrying five coordinates by the time it looks wrong.
   * Spreading those five evenly gives a tidy mosaic that is not the one made.
   */
  const mosaic = (cols = 3, rows = 3, text?: string): string =>
    useDocumentStore.getState().createMosaic({
      columns: cols,
      rows: rows,
      artboardCenter: { x: 0, y: 0 },
      text,
    })

  const shownState = (id: string) => {
    const m = mosaicIn(useDocumentStore.getState().doc, id)
    return m.states[0]!
  }

  it('remembers what it was made as', () => {
    const id = mosaic(4, 2)
    expect(mosaicIn(useDocumentStore.getState().doc, id).seed).toEqual({ columns: 4, rows: 2 })
  })

  it('says no when it is already the grid it was seeded as', () => {
    const id = mosaic(3, 3)
    expect(useDocumentStore.getState().rebuildMosaicGrid(id)).toBe(false)
  })

  it('drops the lines a drag forked, which evening out could never do', () => {
    const id = mosaic(3, 3)
    const store = () => useDocumentStore.getState()
    const before = Object.keys(shownState(id).x).length
    expect(before, 'three columns means two lines').toBe(2)

    // Reshape it the way the editor does: fork a line, then move the fork.
    const m = mosaicIn(store().doc, id)
    const line = m.tiles[0]!.right
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 3 })).toBe(true)
    const forked = Object.keys(shownState(id).x)
    const created = forked.find((key) => !Object.keys(m.states[0]!.x).includes(key))!
    store().setMosaicCoordinates(id, 'x', [{ id: created, value: 0.2 }])
    expect(Object.keys(shownState(id).x).length, 'the fork is a third line').toBe(3)

    expect(store().rebuildMosaicGrid(id)).toBe(true)
    const after = shownState(id)
    expect(Object.keys(after.x).length, 'and the rebuild takes it away again').toBe(2)
    expect([...Object.values(after.x)].sort()).toEqual([1 / 3, 2 / 3])
    expect([...Object.values(after.y)].sort()).toEqual([1 / 3, 2 / 3])
  })

  it('keeps every letter, and the tile ids they live on', () => {
    const id = mosaic(3, 2, 'ABCDEF')
    const store = () => useDocumentStore.getState()
    const before = writtenById(mosaicIn(store().doc, id))

    const line = mosaicIn(store().doc, id).tiles[0]!.right
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.1 }])
    expect(store().rebuildMosaicGrid(id)).toBe(true)

    const after = writtenById(mosaicIn(store().doc, id))
    expect(after, 'ids and letters both come through').toEqual(before)
  })

  it('reaches every state, so none is left describing a mosaic that is gone', () => {
    const id = mosaic(3, 3)
    const store = () => useDocumentStore.getState()
    const first = mosaicIn(store().doc, id).states[0]!
    store().updateMosaic(id, { states: [first, { ...first, x: { ...first.x } }] })

    const line = mosaicIn(store().doc, id).tiles[0]!.right
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.1 }])
    expect(store().rebuildMosaicGrid(id)).toBe(true)

    const after = mosaicIn(store().doc, id)
    const named = new Set<string>()
    for (const tile of after.tiles) {
      named.add(tile.left)
      named.add(tile.right)
    }
    for (const state of after.states) {
      for (const key of Object.keys(state.x)) {
        expect(named, 'no state holds a line no tile names').toContain(key)
      }
    }
  })

  it('takes back the tiles a split added, which is what the original had', () => {
    const id = mosaic(2, 2)
    const store = () => useDocumentStore.getState()
    const target = mosaicIn(store().doc, id).tiles[0]!.id
    expect(store().splitMosaicTile(id, target, 'x')).toBeTruthy()
    expect(mosaicIn(store().doc, id).tiles).toHaveLength(5)

    expect(store().rebuildMosaicGrid(id)).toBe(true)
    expect(mosaicIn(store().doc, id).tiles, 'back to the four it was made as').toHaveLength(4)
  })

  it('is one undo away, whatever it took back', () => {
    const id = mosaic(2, 2)
    const store = () => useDocumentStore.getState()
    store().commit('Draw mosaic')
    const target = mosaicIn(store().doc, id).tiles[0]!.id
    store().splitMosaicTile(id, target, 'x')
    store().commit('Split tile')

    store().rebuildMosaicGrid(id)
    store().commit('Rebuild grid')
    expect(mosaicIn(store().doc, id).tiles).toHaveLength(4)

    store().undo()
    expect(mosaicIn(store().doc, id).tiles, 'the split tile is back').toHaveLength(5)
  })
})

describe('a mosaic’s animation states', () => {
  const make = (): string =>
    useDocumentStore.getState().createMosaic({
      columns: 3,
      rows: 3,
      artboardCenter: { x: 0, y: 0 },
      text: 'ABCDEFGHI',
    })

  const store = () => useDocumentStore.getState()
  const statesOf = (id: string) => mosaicIn(store().doc, id).states
  const idsOf = (id: string) => statesOf(id).map((state) => state.id)

  /** Move one line in one state, so the states stop being identical. */
  const nudge = (id: string, at: number, to: number): string => {
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[at]!.x)[0] as string
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: to }], at)
    return line
  }

  it('inserts a copy immediately after the state asked for', () => {
    const id = make()
    nudge(id, 1, 0.2)
    const before = idsOf(id)

    const made = store().addMosaicState(id, 1)
    expect(made, 'the new state sits right after the one copied').toBe(2)

    const after = statesOf(id)
    expect(after).toHaveLength(4)
    // Continuity: it looks exactly like the state it came from.
    expect(after[2]!.x).toEqual(after[1]!.x)
    expect(after[2]!.y).toEqual(after[1]!.y)
    // Every retained state keeps the id it had; the newcomer gets its own.
    expect([after[0]!.id, after[1]!.id, after[3]!.id]).toEqual(before)
    expect(new Set(idsOf(id)).size).toBe(4)
  })

  it('duplicates the current state the same way', () => {
    const id = make()
    nudge(id, 2, 0.7)
    const made = store().duplicateMosaicState(id, 2)
    expect(made).toBe(3)
    const after = statesOf(id)
    expect(after[3]!.x).toEqual(after[2]!.x)
    expect(after[3]!.id).not.toBe(after[2]!.id)
  })

  it('removes a state and says where to look next', () => {
    const id = make()
    const before = idsOf(id)
    const next = store().deleteMosaicState(id, 1)
    expect(next).toBe(1)
    expect(idsOf(id), 'the others are untouched').toEqual([before[0], before[2]])
  })

  it('keeps at least two states, and no more than twelve', () => {
    const id = make()
    store().deleteMosaicState(id, 2)
    expect(statesOf(id)).toHaveLength(2)
    // A timeline needs two ends.
    expect(store().deleteMosaicState(id, 1), 'refused').toBeNull()
    expect(statesOf(id)).toHaveLength(2)

    store().setMosaicStateCount(id, 99)
    expect(statesOf(id)).toHaveLength(MOSAIC_MAX_STATES)
    expect(store().addMosaicState(id, 0), 'refused at the ceiling').toBeNull()

    store().setMosaicStateCount(id, 0)
    expect(statesOf(id)).toHaveLength(MOSAIC_MIN_STATES)
  })

  /*
   * The distinction the brief is explicit about: raising the count appends and
   * copies whatever is LAST, never the middle state somebody happens to be on.
   */
  it('grows from the end, not from wherever the cursor is', () => {
    const id = make()
    nudge(id, 0, 0.11)
    nudge(id, 2, 0.77)
    const last = statesOf(id)[2]!

    store().setMosaicStateCount(id, 5)
    const after = statesOf(id)
    expect(after).toHaveLength(5)
    for (const grown of [after[3]!, after[4]!]) {
      expect(grown.x, 'copied from the end of the timeline').toEqual(last.x)
    }
    // And the ones that were already there are exactly as they were.
    expect(after[0]!.x).toEqual(statesOf(id)[0]!.x)
    expect(after.slice(0, 3).map((s) => s.id)).toEqual(idsOf(id).slice(0, 3))
  })

  it('shrinks from the end, keeping the ids of what stays', () => {
    const id = make()
    store().setMosaicStateCount(id, 6)
    const before = idsOf(id)
    store().setMosaicStateCount(id, 3)
    expect(idsOf(id), 'the first three, unchanged').toEqual(before.slice(0, 3))
  })

  /*
   * Reordering is the one mosaic edit that changes what PLAYS without changing
   * a single composition, so what these check is that nothing rides on the slot
   * — a state's lines and its timing are its own and travel with it.
   */
  describe('reordering', () => {
    it('moves a state, carrying its timing and its lines with it', () => {
      const id = make()
      const line = Object.keys(statesOf(id)[0]!.x)[0] as string
      // Three states told apart by both the things a slot might have owned.
      store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.8 }], 2)
      store().setMosaicStateTiming(id, 2, { holdMs: 777, transitionMs: 888 })
      const before = idsOf(id)

      expect(store().moveMosaicState(id, 2, 0)).toBe(true)

      expect(idsOf(id), 'the last one is now first').toEqual([
        before[2],
        before[0],
        before[1],
      ])
      const moved = statesOf(id)[0]!
      expect([moved.holdMs, moved.transitionMs], 'its own timing came along').toEqual([777, 888])
      expect(moved.x[line], 'and its own geometry').toBeCloseTo(0.8)
    })

    it('refuses a move that changes nothing, so undo stays clean', () => {
      const id = make()
      const before = idsOf(id)
      expect(store().moveMosaicState(id, 1, 1), 'same slot').toBe(false)
      expect(store().moveMosaicState(id, 9, 0), 'no such state').toBe(false)
      expect(idsOf(id)).toEqual(before)
    })

    it('clamps a drop past the end to the end', () => {
      const id = make()
      const before = idsOf(id)
      // What a pointer released below the last card is saying.
      expect(store().moveMosaicState(id, 0, 99)).toBe(true)
      expect(idsOf(id)).toEqual([before[1], before[2], before[0]])
    })

    it('leaves every other state exactly as it was', () => {
      const id = make()
      const untouched = statesOf(id).map((state) => state.id)
      store().moveMosaicState(id, 0, 2)
      expect(statesOf(id).map((s) => s.id).sort()).toEqual([...untouched].sort())
      expect(statesOf(id)).toHaveLength(3)
    })
  })
})

describe('what a state edit reaches', () => {
  const store = () => useDocumentStore.getState()
  const make = (): string =>
    store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })

  it('never reaches backwards, and never touches a state somebody authored', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[1]!.x)[0] as string
    const before = m.states[0]!.x[line]

    // Author state 2 first, so it is somebody's composition rather than a copy.
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.75 }], 2)
    // Then edit state 1.
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.2 }], 1)

    const after = mosaicIn(store().doc, id)
    expect(after.states[1]!.x[line], 'the one being edited moved').toBe(0.2)
    expect(after.states[0]!.x[line], 'an earlier state is never reached').toBe(before)
    expect(after.states[2]!.x[line], 'and an authored one stops it dead').toBe(0.75)
  })

  /*
   * Three identical states are what a new mosaic has: a timeline to work on,
   * not three compositions anybody chose. Editing the first and leaving the rest
   * behind would invent movement out of nothing — the mosaic would start
   * animating the moment it was first touched.
   */
  it('carries an edit forward through the states that are still copies', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string

    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.2 }], 0)

    const after = mosaicIn(store().doc, id)
    for (const [at, state] of after.states.entries()) {
      expect(state.x[line], `state ${at} came along`).toBe(0.2)
    }
  })

  it('stops following the moment a state is given a composition of its own', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string

    // Authoring state 1 carries forward into state 2, which was still its copy.
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.7 }], 1)
    // Now state 0 is edited. State 1 differs from it, so the edit stops there.
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.2 }], 0)

    const after = mosaicIn(store().doc, id)
    expect(after.states[0]!.x[line]).toBe(0.2)
    expect(after.states[1]!.x[line], 'authored, so it stays put').toBe(0.7)
    expect(after.states[2]!.x[line], 'and so does everything behind it').toBe(0.7)
    void m
  })

  it('leaves characters, spacing, font and transform alone', () => {
    const id = make()
    const before = mosaicIn(store().doc, id)
    const line = Object.keys(before.states[0]!.x)[0] as string
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.2 }], 0)

    const after = mosaicIn(store().doc, id)
    expect(after.tiles).toEqual(before.tiles)
    expect([after.states[0]!.gap, after.states[0]!.outerPadding, after.states[0]!.glyphInset]).toEqual([
      before.states[0]!.gap,
      before.states[0]!.outerPadding,
      before.states[0]!.glyphInset,
    ])
    expect(after.states[0]!.font).toEqual(before.states[0]!.font)
    expect(after.transform).toEqual(before.transform)
  })

  /*
   * Topology is global: which tiles exist and which lines they name is one fact
   * about the mosaic, not three. A state left holding the old set would be
   * describing a mosaic that no longer exists.
   */
  it('reaches every state when the structure changes, leaving no line unvalued', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)

    expect(store().splitMosaicTile(id, m.tiles[0]!.id, 'x', 0)).toBeTruthy()
    const line = Object.keys(mosaicIn(store().doc, id).states[0]!.x)[0] as string
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 3 }, 0)).toBe(true)

    const after = mosaicIn(store().doc, id)
    const named = new Set<string>()
    for (const tile of after.tiles) {
      named.add(tile.left)
      named.add(tile.right)
      named.add(tile.top)
      named.add(tile.bottom)
    }
    for (const [at, state] of after.states.entries()) {
      for (const line of named) {
        if (isRim(line)) continue
        const value = state.x[line] ?? state.y[line]
        expect(value, `state ${at} values ${line}`).toBeTypeOf('number')
      }
    }
  })
})

describe('timing, easing and the transport', () => {
  const store = () => useDocumentStore.getState()
  const make = (): string =>
    store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })

  it('makes one undo entry for a committed timing gesture', () => {
    const id = make()
    store().commit('Draw mosaic')
    const before = store().past.length

    // A drag of the slider is many writes and one commit.
    for (const ms of [100, 200, 300, 420]) store().setMosaicStateTiming(id, 0, { holdMs: ms })
    store().commit('Change hold')

    expect(store().past.length, 'one entry for the gesture').toBe(before + 1)
    expect(mosaicIn(store().doc, id).states[0]!.holdMs).toBe(420)
  })

  it('refuses a transition of zero, which the timeline cannot place a frame in', () => {
    const id = make()
    store().setMosaicStateTiming(id, 0, { transitionMs: 0 })
    expect(mosaicIn(store().doc, id).states[0]!.transitionMs).toBe(MOSAIC_MIN_TRANSITION_MS)
  })

  it('allows a hold of zero, which is one continuous movement', () => {
    const id = make()
    store().setMosaicStateTiming(id, 0, { holdMs: 0 })
    expect(mosaicIn(store().doc, id).states[0]!.holdMs).toBe(0)
  })

  it('never rewrites a state’s timing when the speed changes', () => {
    const id = make()
    store().setMosaicStateTiming(id, 1, { holdMs: 250, transitionMs: 900 })
    const before = mosaicIn(store().doc, id).states.map((s) => [s.holdMs, s.transitionMs])

    store().setMosaicSpeed(id, 3)

    const after = mosaicIn(store().doc, id).states.map((s) => [s.holdMs, s.transitionMs])
    expect(after, 'a rate is not a duration').toEqual(before)
    expect(mosaicIn(store().doc, id).speed).toBe(3)
  })
})

describe('looking at a different state', () => {
  it('changes nothing about the document at all', () => {
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })
    useDocumentStore.getState().commit('Draw mosaic')

    const doc = useDocumentStore.getState().doc
    const entries = useDocumentStore.getState().past.length

    useUiStore.getState().setMosaicState(id, 2)
    expect(useUiStore.getState().shownState(id)).toBe(2)

    // Navigation is where the cursor is standing, not an edit.
    expect(useDocumentStore.getState().doc, 'same document object').toBe(doc)
    expect(useDocumentStore.getState().past.length, 'no undo entry').toBe(entries)
  })

  it('steps back inside a mosaic whose states shrank underneath it', () => {
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })
    useUiStore.getState().setMosaicState(id, 2)

    useDocumentStore.getState().setMosaicStateCount(id, 2)
    useUiStore.getState().clampMosaicState(id, 2)
    expect(useUiStore.getState().shownState(id)).toBe(1)
  })
})

describe('resetting one state’s layout', () => {
  /*
   * The correction that makes reset usable while animating: it is a tool, not an
   * erasing agent. It puts the state you are on back on the seeded grid and
   * leaves the topology and every other state exactly as they were.
   */
  const store = () => useDocumentStore.getState()
  const make = (): string =>
    store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })

  it('puts the state being edited back on the grid', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const xs = Object.keys(m.states[1]!.x)
    store().setMosaicCoordinates(
      id,
      'x',
      xs.map((line, at) => ({ id: line, value: at === 0 ? 0.12 : 0.8 })),
      1,
    )

    expect(store().resetMosaicGrid(id, 1)).toBe(true)
    const after = mosaicIn(store().doc, id).states[1]!
    expect([...Object.values(after.x)].sort()).toEqual([1 / 3, 2 / 3])
  })

  it('leaves every other state untouched, which is what saves the animation', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string

    // Three different compositions, then reset only the middle one.
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.15 }], 0)
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.22 }], 1)
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.85 }], 2)
    const before = mosaicIn(store().doc, id).states.map((state) => JSON.stringify(state))

    expect(store().resetMosaicGrid(id, 1)).toBe(true)
    const after = mosaicIn(store().doc, id).states
    expect(after[0]!.x[line], 'the first is exactly as it was').toBe(0.15)
    expect(after[2]!.x[line], 'and so is the last').toBe(0.85)
    expect(JSON.stringify(after[0]), 'byte for byte').toBe(before[0])
    expect(JSON.stringify(after[2])).toBe(before[2])
  })

  it('never changes the topology, so no coordinate is minted or retired', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 3 }, 0)).toBe(true)

    const forked = mosaicIn(store().doc, id)
    const tiles = JSON.stringify(forked.tiles)
    const lines = Object.keys(forked.states[0]!.x).sort()

    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.1 }], 0)
    store().resetMosaicGrid(id, 0)

    const after = mosaicIn(store().doc, id)
    expect(JSON.stringify(after.tiles), 'the same tiles').toBe(tiles)
    expect(Object.keys(after.states[0]!.x).sort(), 'the same lines').toEqual(lines)
  })

  /*
   * Both halves of a fork come home to the line they were forked from, so they
   * land on the SAME value — which is legal, because a fork puts no tile between
   * them, and looks exactly like the grid the mosaic started as.
   */
  it('brings a forked pair back onto one another', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string
    const before = m.states[0]!.x[line] as number
    const had = new Set(Object.keys(m.states[0]!.x))
    store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 3 }, 0)

    const forked = mosaicIn(store().doc, id)
    const created = Object.keys(forked.states[0]!.x).find((key) => !had.has(key)) as string
    expect(created, 'the fork minted a line').toBeTruthy()
    store().setMosaicCoordinates(id, 'x', [{ id: created, value: 0.2 }], 0)

    expect(store().resetMosaicGrid(id, 0)).toBe(true)
    const after = mosaicIn(store().doc, id).states[0]!
    expect(after.x[created], 'back onto the line it came from').toBe(before)
    expect(after.x[line]).toBe(before)
  })

  it('refuses rather than collapsing a tile somebody split', () => {
    const id = make()
    const m = mosaicIn(store().doc, id)
    // A split puts a line BETWEEN two seeded ones; sending it to the nearest
    // would take one half to nothing.
    expect(store().splitMosaicTile(id, m.tiles[0]!.id, 'x', 0)).toBeTruthy()
    expect(store().resetMosaicGrid(id, 0), 'refused, not approximated').toBe(false)
  })

  it('says no when the state is already on the grid', () => {
    const id = make()
    expect(store().resetMosaicGrid(id, 0)).toBe(false)
  })
})

describe('previewing does not author', () => {
  const store = () => useDocumentStore.getState()
  const ui = () => useUiStore.getState()

  const make = (): string =>
    store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })

  it('leaves no history behind, whatever the transport is asked to do', () => {
    const id = make()
    store().commit('Draw mosaic')
    const doc = store().doc
    const entries = store().past.length

    ui().playMosaic(id)
    ui().pauseMosaicPlayback(1234)
    ui().playMosaic(id)
    ui().restartMosaic(id)
    ui().stopMosaicPlayback()

    expect(store().doc, 'the document was never touched').toBe(doc)
    expect(store().past.length, 'and neither was the history').toBe(entries)
  })

  it('resumes where a pause left it, and starts over on restart', () => {
    const id = make()
    ui().playMosaic(id)
    ui().pauseMosaicPlayback(820)
    expect(ui().mosaicPlayback).toMatchObject({ object: id, playing: false, atMs: 820 })

    ui().playMosaic(id)
    expect(ui().mosaicPlayback, 'picked up, not restarted').toMatchObject({
      playing: true,
      atMs: 820,
    })

    ui().restartMosaic(id)
    expect(ui().mosaicPlayback, 'back to the beginning, still running').toMatchObject({
      playing: true,
      atMs: 0,
    })
  })

  it('is left entirely when an authored state is chosen', () => {
    const id = make()
    ui().playMosaic(id)
    // What the panel does when a chevron is pressed.
    ui().stopMosaicPlayback()
    ui().setMosaicState(id, 1)

    expect(ui().mosaicPlayback, 'no frame on screen any more').toBeNull()
    expect(ui().shownState(id), 'and the state picked is the one being edited').toBe(1)
  })
})

describe('an authored animation through a save and back', () => {
  it('survives serialisation exactly', () => {
    // Read fresh each time: the store hands out a snapshot, and every write
    // replaces the document it points at.
    const store = () => useDocumentStore.getState()
    const id = store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })

    // Three distinct compositions with three distinct timings.
    const m = mosaicIn(store().doc, id)
    const line = Object.keys(m.states[0]!.x)[0] as string
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.2 }], 1)
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.8 }], 2)
    store().setMosaicStateTiming(id, 0, { holdMs: 120, transitionMs: 340 })
    store().setMosaicEasing(id, 1, 'snappy')
    store().setMosaicSpeed(id, 1.5)

    const before = mosaicIn(useDocumentStore.getState().doc, id)
    const round = deserializeDocument(serializeDocument(useDocumentStore.getState().doc))
    expect(round.ok, round.error).toBe(true)
    const after = round.doc!.objects[id]
    if (after?.kind !== 'mosaic') throw new Error('expected a mosaic')

    expect(after.states.map((s) => s.id), 'state ids').toEqual(before.states.map((s) => s.id))
    expect(after.states.map((s) => s.x), 'geometry per state').toEqual(
      before.states.map((s) => s.x),
    )
    expect(
      after.states.map((s) => [s.holdMs, s.transitionMs, s.easing]),
      'timing and easing per state',
    ).toEqual(before.states.map((s) => [s.holdMs, s.transitionMs, s.easing]))
    // `loop` is no longer written by anything, but it still round-trips —
    // which is the point of leaving it in the schema.
    expect([after.loop, after.speed]).toEqual([true, 1.5])
  })
})

describe('getting back out of a preview', () => {
  /*
   * Reported from the app: "once mosaic was animated it became unreachable and
   * cant be clicked". Pausing left the preview on screen, and every press after
   * that was refused — correctly, since a frame belongs to no state and must
   * never be edited — but with nothing to press that would end it. The press
   * itself now spends itself going back.
   */
  it('a paused preview is still a preview, and still not editable', () => {
    const ui = () => useUiStore.getState()
    const id = useDocumentStore
      .getState()
      .createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })

    ui().playMosaic(id)
    ui().pauseMosaicPlayback(500)
    expect(ui().mosaicPlayback, 'paused, but still showing a frame').toMatchObject({
      object: id,
      playing: false,
    })

    // What a press on the canvas now does.
    ui().stopMosaicPlayback()
    expect(ui().mosaicPlayback, 'and a press is what ends it').toBeNull()
  })
})

describe('reset after a line has been forked and dragged', () => {
  /*
   * Reported from the app: "reset button not working".
   *
   * Reset used to send each line to the seed position NEAREST its own value,
   * which forgets where a line came from. Dragging forks lines — a mosaic seeded
   * with a line at a fifth ends up holding two — and a fork dragged past the next
   * seed position rounded onto its NEIGHBOUR, collapsing the tile between them.
   * The layout was then illegal, reset refused itself, and the button did
   * nothing at all.
   *
   * A line's home is read off the tiles instead: the number of cells to its
   * left. Two halves of a fork have nothing between them, so they sit at the
   * same depth and come home to the one line they were forked from — however far
   * either has been dragged.
   */
  const store = () => useDocumentStore.getState()

  const reshaped = (dragTo: number): { id: string; original: number[] } => {
    const id = store().createMosaic({ columns: 5, rows: 4, artboardCenter: { x: 0, y: 0 } })
    const m = mosaicIn(store().doc, id)
    const original = Object.values(m.states[0]!.x).slice().sort()
    const line = m.tiles[0]!.right
    const had = new Set(Object.keys(m.states[0]!.x))
    expect(store().forkMosaicCoordinate(id, 'x', line, { from: 0, to: 1 / 4 }, 0)).toBe(true)
    const created = Object.keys(mosaicIn(store().doc, id).states[0]!.x).find((k) => !had.has(k))!
    store().setMosaicCoordinates(id, 'x', [{ id: created, value: dragTo }], 0)
    return { id, original }
  }

  it('brings a fork home however far it was dragged', () => {
    // Past the NEXT seed line first: that is the case the old rule collapsed,
    // rounding the fork onto its neighbour and refusing the reset outright.
    for (const dragTo of [0.72, 0.95, 0.34, 0.05]) {
      const { id, original } = reshaped(dragTo)
      expect(store().resetMosaicGrid(id, 0), `dragged to ${dragTo}`).toBe(true)

      const after = mosaicIn(store().doc, id).states[0]!.x
      const values = Object.values(after).slice().sort()
      // Five lines now, because the fork is still there — but the picture is the
      // grid it was made as: the fork sits exactly on the line it came from.
      expect(values).toHaveLength(original.length + 1)
      expect(values.filter((v, at) => at === 0 || v !== values[at - 1])).toEqual(original)
      expect(values[0], 'the fork came home to its partner').toBe(values[1])
    }
  })

  it('still refuses a mosaic that no longer fits its grid', () => {
    const id = store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })
    // A split puts a line BETWEEN two seeded ones, making the mosaic one cell
    // deeper than the grid it was made as. Nothing can go home.
    expect(store().splitMosaicTile(id, mosaicIn(store().doc, id).tiles[0]!.id, 'x', 0)).toBeTruthy()
    expect(store().resetMosaicGrid(id, 0)).toBe(false)
    // And rebuilding is the way out.
    expect(store().rebuildMosaicGrid(id)).toBe(true)
    expect(mosaicIn(store().doc, id).tiles).toHaveLength(9)
  })
})

describe('colouring tiles in one state', () => {
  const store = () => useDocumentStore.getState()
  const make = (): string =>
    store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 }, text: 'ABCDEFGH' })
  const tilesOf = (id: string) => mosaicIn(store().doc, id).tiles.map((t) => t.id)
  const stateAt = (id: string, at: number) => mosaicIn(store().doc, id).states[at]!

  const RED = '#ff0000'
  const BLUE = '#0000ff'

  it('colours one tile’s letter', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().setMosaicGlyphColour(id, 0, [first as string], RED)
    expect(stateAt(id, 0).glyphColour[first as string]).toBe(RED)
  })

  it('colours several at once, adjacent or not', () => {
    const id = make()
    const tiles = tilesOf(id)
    // Deliberately not a block: colour has no structural requirement.
    const scattered = [tiles[0]!, tiles[4]!, tiles[8]!]
    store().setMosaicGlyphColour(id, 0, scattered, BLUE)

    const state = stateAt(id, 0)
    for (const leaf of scattered) expect(state.glyphColour[leaf]).toBe(BLUE)
    expect(state.glyphColour[tiles[1]!], 'and nobody else').toBeUndefined()
  })

  it('keeps the letter’s colour and the background independent', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().setMosaicGlyphColour(id, 0, [first as string], RED)
    store().setMosaicTileColour(id, 0, [first as string], BLUE)

    const state = stateAt(id, 0)
    expect(state.glyphColour[first as string]).toBe(RED)
    expect(state.tileColour[first as string]).toBe(BLUE)

    // Changing one leaves the other exactly where it was.
    store().setMosaicGlyphColour(id, 0, [first as string], '#00ff00')
    expect(stateAt(id, 0).tileColour[first as string]).toBe(BLUE)
  })

  it('colours an empty tile, and keeps it for a letter typed later', () => {
    const id = make()
    // 'ABCDEFGH' fills eight of nine, so the last is empty.
    const mosaicNow = mosaicIn(store().doc, id)
    const empty = mosaicNow.tiles.find((t) => !mosaicNow.states[0]!.chars[t.id])!
    store().setMosaicGlyphColour(id, 0, [empty.id], RED)
    store().setMosaicTileColour(id, 0, [empty.id], BLUE)

    const state = stateAt(id, 0)
    expect(state.glyphColour[empty.id], 'held for a letter that is not there yet').toBe(RED)
    expect(state.tileColour[empty.id]).toBe(BLUE)
  })

  it('clears a background away entirely, leaving no entry behind', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().setMosaicTileColour(id, 0, [first as string], BLUE)
    store().setMosaicTileColour(id, 0, [first as string], null)

    const map = stateAt(id, 0).tileColour
    expect(map[first as string] ?? null).toBeNull()
    /*
     * Absent, not present-and-null. "No background" needs ONE representation:
     * with two, a state that had been cleared and one that never had a colour
     * hold the same picture but compare as different, and the follow rule stops
     * carrying edits forward across them.
     */
    expect(Object.prototype.hasOwnProperty.call(map, first as string)).toBe(false)
  })

  it('does not count clearing a tile that had no background as a change', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().commit('Draw mosaic')
    const before = store().doc

    store().setMosaicTileColour(id, 0, [first as string], null)

    expect(store().doc).toBe(before)
  })

  it('leaves a cleared state still following the ones after it', () => {
    const id = make()
    const [first, second] = tilesOf(id)
    store().setMosaicTileColour(id, 0, [first as string], BLUE)
    store().setMosaicTileColour(id, 0, [first as string], null)

    // State 1 was never authored, so this must still reach it.
    store().setMosaicTileColour(id, 0, [second as string], RED)

    expect(stateAt(id, 1).tileColour[second as string]).toBe(RED)
  })

  it('writes to the state being edited and no other authored one', () => {
    const id = make()
    const [first] = tilesOf(id)
    // Author state 2 so it stops following, then colour state 1.
    store().setMosaicGlyphColour(id, 2, [first as string], BLUE)
    store().setMosaicGlyphColour(id, 1, [first as string], RED)

    expect(stateAt(id, 1).glyphColour[first as string]).toBe(RED)
    expect(stateAt(id, 2).glyphColour[first as string], 'authored, so untouched').toBe(BLUE)
    expect(stateAt(id, 0).glyphColour[first as string], 'never reaches backwards').toBeUndefined()
  })

  /*
   * The same rule geometry, spacing and font follow: a state nobody has authored
   * comes along, so the first colour picked does not invent an animation.
   */
  it('carries forward through the states that are still copies', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().setMosaicGlyphColour(id, 0, [first as string], RED)
    for (const at of [0, 1, 2]) {
      expect(stateAt(id, at).glyphColour[first as string], `state ${at}`).toBe(RED)
    }
  })

  it('writes nothing when the colour is already the one asked for', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().setMosaicGlyphColour(id, 0, [first as string], RED)
    store().commit('Colour letters')
    const entries = store().past.length
    const doc = store().doc

    store().setMosaicGlyphColour(id, 0, [first as string], RED)
    expect(store().doc, 'the same document object').toBe(doc)
    store().commit('Colour letters')
    expect(store().past.length, 'and no undo entry').toBe(entries)
  })

  it('ignores tiles, states and mosaics that are not there', () => {
    const id = make()
    const doc = store().doc
    store().setMosaicGlyphColour(id, 0, ['no-such-tile'], RED)
    store().setMosaicGlyphColour(id, 99, tilesOf(id), RED)
    store().setMosaicGlyphColour('no-such-mosaic', 0, tilesOf(id), RED)
    // The out-of-range state falls back to the first, so that one does write.
    expect(store().doc === doc || stateAt(id, 0).glyphColour[tilesOf(id)[0]!] === RED).toBe(true)
  })

  it('restores every tile’s own colour on undo, mixed selections included', () => {
    const id = make()
    const tiles = tilesOf(id)
    const [a, b] = [tiles[0]!, tiles[1]!]
    // Two different starting colours, committed separately.
    store().setMosaicGlyphColour(id, 0, [a], RED)
    store().setMosaicGlyphColour(id, 0, [b], BLUE)
    store().commit('Colour letters')

    // One gesture over a mixed selection.
    store().setMosaicGlyphColour(id, 0, [a, b], '#00ff00')
    store().commit('Colour letters')
    expect(stateAt(id, 0).glyphColour[a]).toBe('#00ff00')

    store().undo()
    expect(stateAt(id, 0).glyphColour[a], 'each goes back to its own').toBe(RED)
    expect(stateAt(id, 0).glyphColour[b]).toBe(BLUE)
  })

  it('makes one entry for a whole picker gesture', () => {
    const id = make()
    const [first] = tilesOf(id)
    store().commit('Draw mosaic')
    const entries = store().past.length
    // A picker drag is many previews and one commit.
    for (const shade of ['#ff0000', '#ee0000', '#dd0000', '#cc0000']) {
      store().setMosaicGlyphColour(id, 0, [first as string], shade)
    }
    store().commit('Colour letters')
    expect(store().past.length).toBe(entries + 1)
  })
})

describe('colour through the operations that change tiles', () => {
  const store = () => useDocumentStore.getState()
  const make = (): string =>
    store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })

  it('copies a split tile’s colours into both halves, in every state', () => {
    const id = make()
    const parent = mosaicIn(store().doc, id).tiles[0]!.id
    store().setMosaicGlyphColour(id, 0, [parent], '#ff0000')
    store().setMosaicTileColour(id, 0, [parent], '#00ff00')

    const born = store().splitMosaicTile(id, parent, 'x', 0)
    expect(born).toBeTruthy()
    for (const state of mosaicIn(store().doc, id).states) {
      expect(state.glyphColour[born as string], 'the new half inherits').toBe('#ff0000')
      expect(state.tileColour[born as string]).toBe('#00ff00')
      expect(state.glyphColour[parent], 'and so does the old one').toBe('#ff0000')
    }
  })

  it('takes a removed tile’s colours away with it, in every state', () => {
    const id = make()
    const tiles = mosaicIn(store().doc, id).tiles
    const target = tiles[1]!.id
    store().setMosaicTileColour(id, 0, [target], '#123456')

    expect(store().removeMosaicTile(id, target)).toBeTruthy()
    for (const state of mosaicIn(store().doc, id).states) {
      expect(state.tileColour[target], 'no colour for a tile that is gone').toBeUndefined()
    }
  })

  it('leaves colours alone when a state’s layout is reset', () => {
    const id = make()
    const first = mosaicIn(store().doc, id).tiles[0]!.id
    store().setMosaicGlyphColour(id, 0, [first], '#abcdef')
    const line = Object.keys(mosaicIn(store().doc, id).states[0]!.x)[0] as string
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.12 }], 0)

    expect(store().resetMosaicGrid(id, 0)).toBe(true)
    expect(mosaicIn(store().doc, id).states[0]!.glyphColour[first]).toBe('#abcdef')
  })

  it('keeps colours through a rebuild, by tile', () => {
    const id = make()
    const first = mosaicIn(store().doc, id).tiles[0]!.id
    store().setMosaicTileColour(id, 0, [first], '#abcdef')
    const line = Object.keys(mosaicIn(store().doc, id).states[0]!.x)[0] as string
    store().setMosaicCoordinates(id, 'x', [{ id: line, value: 0.12 }], 0)

    expect(store().rebuildMosaicGrid(id)).toBe(true)
    expect(mosaicIn(store().doc, id).states[0]!.tileColour[first]).toBe('#abcdef')
  })

  it('copies colours into a duplicated state', () => {
    const id = make()
    const first = mosaicIn(store().doc, id).tiles[0]!.id
    store().setMosaicGlyphColour(id, 1, [first], '#ff00ff')
    const made = store().duplicateMosaicState(id, 1)
    expect(made).toBe(2)
    expect(mosaicIn(store().doc, id).states[2]!.glyphColour[first]).toBe('#ff00ff')
  })
})

describe('tile selection is not part of the artwork', () => {
  it('changes no document and no history', () => {
    const store = () => useDocumentStore.getState()
    const id = store().createMosaic({ columns: 3, rows: 3, artboardCenter: { x: 0, y: 0 } })
    store().commit('Draw mosaic')
    const doc = store().doc
    const entries = store().past.length

    const ui = useUiStore.getState()
    const tiles = mosaicIn(doc, id).tiles.map((t) => t.id)
    ui.setMosaicSelection(tiles)
    ui.toggleMosaicSelection(tiles[0] as string)
    ui.setMosaicSelection([])

    expect(store().doc, 'selection lives outside the document').toBe(doc)
    expect(store().past.length, 'and outside the history').toBe(entries)
  })
})
