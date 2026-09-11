import { describe, expect, it } from 'vitest'
import { DOCUMENT_SCHEMA_VERSION } from '../../src/types/document'
import { MOSAIC_DEFAULT_SNAP } from '../../src/mosaic/snap'
import { sameGeometry } from '../../src/mosaic/dissection'
import {
  DEFAULT_GLYPH_COLOUR,
  MOSAIC_DEFAULT_EASING,
  MOSAIC_DEFAULT_SPACING,
  MOSAIC_DEFAULT_HOLD_MS,
  MOSAIC_DEFAULT_TRANSITION_MS,
} from '../../src/types/mosaic'

import { shapeIn } from '../fixtures/objects'
import { createEmptyDocument, documentDefaults } from '../../src/state/defaults'
import { deserializeDocument, serializeDocument } from '../../src/state/persistence'
import { useDocumentStore } from '../../src/state/documentStore'
import { valuesFor } from '../../src/frame/frame'
import { paintAt, samePaint, stopColourAt } from '../../src/typography/colour'
import type { ColourSettings } from '../../src/types/document'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { mosaicTiles } from '../../src/mosaic/tiles'

/**
 * A document saved at a given schema version, with one object's fields set.
 *
 * Built from a v1 skeleton and stamped with the version, which is enough: a
 * migration only reads the fields it is about, and the ones it does not touch
 * ride through untouched by definition.
 */
function documentAt(version: number, fields: Record<string, unknown>): string {
  const raw = JSON.parse(legacyDocument()) as Record<string, unknown>
  raw['schemaVersion'] = version
  const objects = raw['objects'] as Record<string, Record<string, unknown>>
  Object.assign(objects['a'] as Record<string, unknown>, fields)
  return JSON.stringify(raw)
}

/** A v1 document: one shape, some text, and a hand-placed grid. */
function legacyDocument(): string {
  const doc = createEmptyDocument()
  const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>
  raw['schemaVersion'] = 1
  raw['objects'] = {
    a: {
      id: 'a',
      name: 'Shape 1',
      originalSourcePath: 'M0 0L100 0L100 100L0 100Z',
      currentSourcePath: 'M0 0L100 0L100 100L0 100Z',
      simplifiedRenderPath: 'M0 0L100 0L100 100L0 100Z',
      insetPath: null,
      localBounds: { x: 0, y: 0, width: 100, height: 100 },
      geometryRevision: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
      text: 'RONESHA IS THE BEST',
      textFlowMode: 'word',
      fittingMode: 'boundary-warp',
      // Object-space points, the v1 meaning of a divider.
      dividers: [
        { id: 'd1', points: [{ x: 0, y: 33 }, { x: 50, y: 30 }, { x: 100, y: 33 }] },
        { id: 'd2', points: [{ x: 0, y: 66 }, { x: 50, y: 70 }, { x: 100, y: 66 }] },
      ],
      font: { ...documentDefaults.font },
      typography: { ...documentDefaults.typography },
      distortion: { ...documentDefaults.distortion },
      appearance: { ...documentDefaults.appearance },
      animation: { ...documentDefaults.animation },
      seed: 7,
      visible: true,
      locked: false,
    },
  }
  raw['objectOrder'] = ['a']
  return JSON.stringify(raw)
}

describe('opening a document saved before the patch model', () => {
  it('clears the grid rather than reinterpreting it', () => {
    // A v1 divider is y = f(x) in object units; a v2 divider is v = f(u) on the
    // unit square. The same numbers mean something completely different, so
    // carrying them across would drop rows in wildly wrong places. The rows
    // regenerate automatically, so the visible result is the automatic layout.
    const result = deserializeDocument(legacyDocument())
    expect(result.ok, result.error).toBe(true)
    expect(shapeIn(result.doc!, 'a').dividers).toEqual([])
  })

  it('keeps the shape and its text', () => {
    const result = deserializeDocument(legacyDocument())
    const object = shapeIn(result.doc!, 'a')
    expect(object.text).toBe('RONESHA IS THE BEST')
    expect(object.currentSourcePath).toBe('M0 0L100 0L100 100L0 100Z')
    expect(object.seed).toBe(7)
  })

  it('stamps the current schema version', () => {
    const result = deserializeDocument(legacyDocument())
    expect(result.doc!.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION)
    // And it arrives as an object of a known kind, which is what everything
    // downstream now narrows on.
    expect(shapeIn(result.doc!, 'a').kind).toBe('typography')
  })

  it('leaves a document already at the current version alone', () => {
    const doc = createEmptyDocument()
    const result = deserializeDocument(serializeDocument(doc))
    expect(result.ok).toBe(true)
    expect(result.doc!.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION)
  })

  it('refuses a document from a newer version of the app', () => {
    const raw = JSON.parse(serializeDocument(createEmptyDocument())) as Record<string, unknown>
    raw['schemaVersion'] = DOCUMENT_SCHEMA_VERSION + 1
    expect(deserializeDocument(JSON.stringify(raw)).ok).toBe(false)
  })
})

/** A v4 document whose colour lived among the motion presets. */
function documentWithColourPreset(
  animation: Record<string, unknown>,
): string {
  const raw = JSON.parse(legacyDocument()) as Record<string, unknown>
  raw['schemaVersion'] = 4
  const objects = raw['objects'] as Record<string, Record<string, unknown>>
  objects['a']!['dividers'] = []
  objects['a']!['animation'] = animation
  return JSON.stringify(raw)
}

describe('opening a document from before colour had its own tab', () => {
  it('turns the colour preset into a colour effect, settings and all', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'colour',
        loopDuration: 3,
        config: { to: '#00ff00' },
        shapePreset: 'none',
        shapeConfig: {},
      }),
    )
    expect(result.ok, result.error).toBe(true)
    const animation = shapeIn(result.doc!, 'a').animation
    expect(animation.preset).toBe('none')
    expect(animation.textColour).toEqual({ effect: 'cycle', config: { to: '#00ff00' } })
    // The loop it was set to is still the loop it runs at.
    expect(animation.loopDuration).toBe(3)
  })

  it('carries a flicker across with its beat intact', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'flicker',
        loopDuration: 2,
        config: { to: '#0000ff', beats: 5 },
        shapePreset: 'none',
        shapeConfig: {},
      }),
    )
    expect(result.ok, result.error).toBe(true)
    expect(shapeIn(result.doc!, 'a').animation.textColour).toEqual({
      effect: 'flicker',
      config: { to: '#0000ff', beats: 5 },
    })
  })

  it('turns the shape’s throb into the container’s colour effect', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'none',
        loopDuration: 2,
        config: {},
        shapePreset: 'throb',
        shapeConfig: { to: '#ff00ff' },
      }),
    )
    expect(result.ok, result.error).toBe(true)
    const animation = shapeIn(result.doc!, 'a').animation
    expect(animation.shapePreset).toBe('none')
    expect(animation.shapeColour).toEqual({ effect: 'cycle', config: { to: '#ff00ff' } })
  })

  it('keeps a motion preset as motion, and gives it no colour effect', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'bounce',
        loopDuration: 2,
        config: { height: 0.4, stagger: 0.2 },
        shapePreset: 'jelly',
        shapeConfig: { amount: 0.2 },
      }),
    )
    expect(result.ok, result.error).toBe(true)
    const animation = shapeIn(result.doc!, 'a').animation
    expect(animation.preset).toBe('bounce')
    expect(animation.config).toEqual({ height: 0.4, stagger: 0.2 })
    expect(animation.shapePreset).toBe('jelly')
    expect(animation.textColour.effect).toBe('none')
    expect(animation.shapeColour.effect).toBe('none')
  })

  it('renames the sweep’s own row stagger to the shared line offset', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'sweep',
        loopDuration: 2,
        config: { amount: 0.3, stagger: 0.6 },
        shapePreset: 'none',
        shapeConfig: {},
      }),
    )
    expect(result.ok, result.error).toBe(true)
    const config = shapeIn(result.doc!, 'a').animation.config
    expect(config).toEqual({ amount: 0.3, lineOffset: 0.6 })
  })

  it('has the type follow the shape, as it always did', () => {
    const result = deserializeDocument(
      documentWithColourPreset({
        preset: 'none',
        loopDuration: 2,
        config: {},
        shapePreset: 'pulse',
        shapeConfig: { amount: 0.1 },
      }),
    )
    expect(shapeIn(result.doc!, 'a').animation.shapeAffectsText).toBe(true)
  })

  it('gives every object the settings a mode it is not in will need', () => {
    /*
     * Run settings are added rather than mapped: no old object is in that mode,
     * where they are the only things read. They exist so the panel has something
     * to bind to the moment someone switches a shape over, rather than reading
     * undefined off an object saved before the mode existed.
     */
    const result = deserializeDocument(legacyDocument())
    expect(result.ok, result.error).toBe(true)
    const object = shapeIn(result.doc!, 'a')
    expect(object.run).toBeTruthy()
    expect(object.run.turns).toBe('one')
    expect(object.run.side).toBe(1)
    expect(object.run.split).toBe(false)
    // The band's height and the gap after it are new terms in an old sum, and a
    // line height of 1 is where the new sum equals the old — so nothing anyone
    // has already made moves. The banner stays off: a fill nobody asked for
    // should not appear under their type when they open the file.
    expect(object.run.lineHeight).toBe(1)
    expect(object.appearance.lineFill).toBeNull()
  })

  it('folds a saved spiral into a run of many turns, settings intact', () => {
    /*
     * A lap and a spiral were the same fit written twice; they are now one mode
     * with a turn count. Which mode an object was in becomes its `turns`, and the
     * settings that mode did not have take the defaults — so a spiral keeps its
     * hole and its direction, and a lap keeps its band position, split and gap.
     */
    const spiral = deserializeDocument(
      documentAt(9, {
        fittingMode: 'spiral',
        spiral: { outward: true, centreHole: 0.4, upright: true, rigid: false, lineHeight: 1.6, baselineShift: -0.2 },
        ring: { side: -1, split: true, gap: 0.2, upright: false, rigid: true, lineHeight: 1 },
      }),
    )
    expect(spiral.ok, spiral.error).toBe(true)
    const wound = shapeIn(spiral.doc!, 'a')
    expect(wound.fittingMode).toBe('ring')
    expect(wound.run.turns).toBe('many')
    expect(wound.run.centreHole).toBe(0.4)
    expect(wound.run.outward).toBe(true)
    expect(wound.run.rigid).toBe(false)
    expect(wound.run.lineHeight).toBe(1.6)
    expect(wound.run.baselineShift).toBe(-0.2)
    // The lap's own settings are NOT carried over: this object was never a lap,
    // and its ring block held whatever the defaults happened to be.
    expect(wound.run.side).toBe(1)
    expect(wound.run.split).toBe(false)
  })

  it('folds a saved ring into a run of one turn, settings intact', () => {
    const ring = deserializeDocument(
      documentAt(9, {
        fittingMode: 'ring',
        spiral: { outward: true, centreHole: 0.4, upright: false, rigid: false, lineHeight: 1 },
        ring: { side: -1, split: true, gap: 0.2, upright: true, rigid: true, lineHeight: 2.2, baselineShift: 0.1 },
      }),
    )
    expect(ring.ok, ring.error).toBe(true)
    const lap = shapeIn(ring.doc!, 'a')
    expect(lap.fittingMode).toBe('ring')
    expect(lap.run.turns).toBe('one')
    expect(lap.run.side).toBe(-1)
    expect(lap.run.split).toBe(true)
    expect(lap.run.gap).toBe(0.2)
    expect(lap.run.upright).toBe(true)
    expect(lap.run.lineHeight).toBe(2.2)
    expect(lap.run.baselineShift).toBe(0.1)
    // And the spiral's are not: it was never a spiral.
    expect(lap.run.centreHole).toBe(0)
    expect(lap.run.outward).toBe(false)
  })

  it('gives a saved line its nodes back, and everything else an honest null', () => {
    /*
     * Geometry gained a second half — the nodes the editor takes hold of — and
     * an object that reaches v17 without them would jump the first time a handle
     * was dragged.
     *
     * A line is the one population that can be answered with confidence: it
     * already had a point editor, so deriving nodes for it regresses nothing.
     * A v16 shape is unanswerable — nothing distinguishes a freehand drawing
     * from a primitive, or from a shape whose edges the grid rewrote — so it
     * gets null rather than a guess.
     */
    const curve = 'M0 0C20 -40 80 40 100 0'
    const line = deserializeDocument(
      documentAt(16, {
        currentSourcePath: curve,
        line: { anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      }),
    )
    expect(line.ok, line.error).toBe(true)
    const outline = shapeIn(line.doc!, 'a').outline
    expect(outline, 'a line has nodes').not.toBeNull()
    expect(outline!.subpaths[0]!.closed).toBe(false)
    expect(outline!.subpaths[0]!.nodes.length).toBe(2)
    // Derived from the PATH, not from the bare anchors: rebuilding from anchors
    // would re-run the old tangent guess and move every line on load.
    expect(Math.hypot(...Object.values(outline!.subpaths[0]!.nodes[0]!.handleOut))).toBeGreaterThan(
      0,
    )

    const shape = deserializeDocument(documentAt(16, { line: null }))
    expect(shape.ok, shape.error).toBe(true)
    // Present and null, not absent. `line` was left undefined once and a
    // truthiness test then read every shape as a line.
    expect(shapeIn(shape.doc!, 'a')).toHaveProperty('outline')
    expect(shapeIn(shape.doc!, 'a').outline).toBeNull()
  })

  it('does not throw on a line whose path cannot be read', () => {
    // A migration that throws loses the whole document. Losing node editing on
    // one line is recoverable; losing the file is not.
    const result = deserializeDocument(
      documentAt(16, { currentSourcePath: 'not a path at all', line: { anchors: [] } }),
    )
    expect(result.ok, result.error).toBe(true)
    expect(shapeIn(result.doc!, 'a').outline).toBeNull()
  })

  it('says what kind every object is', () => {
    /*
     * The document gained a second kind of object, and every reader narrows on
     * `kind` before touching anything specific to one. Written on every object
     * rather than defaulted at read time, for the reason migration 14 exists: a
     * field that is merely usually present acquires a truthiness test somewhere,
     * and the one place it is absent becomes a fault nobody can reproduce.
     */
    const result = deserializeDocument(documentAt(17, {}))
    expect(result.ok, result.error).toBe(true)
    expect(shapeIn(result.doc!, 'a').kind).toBe('typography')
  })

  it('leaves a kind that is already there alone', () => {
    // Re-running a migration must not overwrite what a later version wrote.
    const result = deserializeDocument(documentAt(17, { kind: 'typography' }))
    expect(result.ok, result.error).toBe(true)
    expect(shapeIn(result.doc!, 'a').kind).toBe('typography')
  })

  it('carries a v1 document all the way to today in one go', () => {
    // Every migration in sequence, which is what anyone with an old save runs.
    const result = deserializeDocument(legacyDocument())
    expect(result.ok, result.error).toBe(true)
    const animation = shapeIn(result.doc!, 'a').animation
    expect(animation.textColour.effect).toBe('none')
    expect(animation.shapeColour.effect).toBe('none')
    expect(animation.shapeAffectsText).toBe(true)
    expect(result.doc!.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION)
  })
})

describe('v18 → v19: a partition tree becomes tiles and lines', () => {
  /**
   * A v18 mosaic, written exactly as the old model wrote one.
   *
   * The seed peeled the first column into its own branch, so this is not a
   * lattice: `stack` is a column of three, and each band beside it divides
   * itself into two. Which is what makes it a real test — the conversion has to
   * discover that the bands' edges line up and give them one coordinate.
   */
  const v18 = () => ({
    schemaVersion: 18,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        root: {
          kind: 'split',
          id: 's_root',
          direction: 'across',
          children: [
            {
              kind: 'split',
              id: 's_stack',
              direction: 'down',
              children: [
                { kind: 'leaf', id: 'l_a', char: 'A' },
                { kind: 'leaf', id: 'l_b', char: 'B' },
                { kind: 'leaf', id: 'l_c', char: null },
              ],
            },
            {
              kind: 'split',
              id: 's_bands',
              direction: 'down',
              children: [
                {
                  kind: 'split',
                  id: 's_r1',
                  direction: 'across',
                  children: [
                    { kind: 'leaf', id: 'l_d', char: 'D' },
                    { kind: 'leaf', id: 'l_e', char: 'E' },
                  ],
                },
                {
                  kind: 'split',
                  id: 's_r2',
                  direction: 'across',
                  children: [
                    { kind: 'leaf', id: 'l_f', char: null },
                    { kind: 'leaf', id: 'l_g', char: 'G' },
                  ],
                },
                {
                  kind: 'split',
                  id: 's_r3',
                  direction: 'across',
                  children: [
                    { kind: 'leaf', id: 'l_h', char: 'H' },
                    { kind: 'leaf', id: 'l_i', char: 'I' },
                  ],
                },
              ],
            },
          ],
        },
        font: { fontId: 'anton', weight: 400, italic: false },
        states: [
          {
            id: 'st1',
            ratios: {
              s_root: [1 / 3, 2 / 3],
              s_stack: [0.5, 0.25, 0.25],
              s_bands: [1 / 3, 1 / 3, 1 / 3],
              s_r1: [0.5, 0.5],
              s_r2: [0.5, 0.5],
              s_r3: [0.5, 0.5],
            },
            glyphColour: { l_a: '#ff0000' },
            tileColour: { l_b: '#00ff00' },
            hold: 1,
            transition: 0.6,
            easing: 'ease-in-out',
          },
        ],
        activeState: 0,
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  /** The rectangles the OLD model would have produced, worked out by hand. */
  const expected: Record<string, { x: number; y: number; width: number; height: number }> = {
    // The peeled column: a third of the width, split 0.5 / 0.25 / 0.25.
    l_a: { x: -150, y: -150, width: 100, height: 150 },
    l_b: { x: -150, y: 0, width: 100, height: 75 },
    l_c: { x: -150, y: 75, width: 100, height: 75 },
    // Three bands of a hundred, each halved.
    l_d: { x: -50, y: -150, width: 100, height: 100 },
    l_e: { x: 50, y: -150, width: 100, height: 100 },
    l_f: { x: -50, y: -50, width: 100, height: 100 },
    l_g: { x: 50, y: -50, width: 100, height: 100 },
    l_h: { x: -50, y: 50, width: 100, height: 100 },
    l_i: { x: 50, y: 50, width: 100, height: 100 },
  }

  const migrated = () => {
    const result = deserializeDocument(JSON.stringify(v18()))
    expect(result.ok, result.error).toBe(true)
    const object = result.doc!.objects['m1']
    expect(object?.kind).toBe('mosaic')
    return object as Extract<typeof object, { kind: 'mosaic' }>
  }

  it('draws exactly the same picture', () => {
    /*
     * The whole test. A migration that changed what anyone's mosaic looked like
     * would be worse than no migration at all, so this is checked against
     * rectangles computed by hand from the old model rather than against the new
     * code's own opinion.
     */
    const mosaic = migrated()
    const rects = mosaicTiles(mosaic)
    expect(rects.size).toBe(9)

    for (const [id, want] of Object.entries(expected)) {
      const got = rects.get(id)?.structural
      expect(got, id).toBeTruthy()
      expect(got!.x, `${id} x`).toBeCloseTo(want.x, 9)
      expect(got!.y, `${id} y`).toBeCloseTo(want.y, 9)
      expect(got!.width, `${id} width`).toBeCloseTo(want.width, 9)
      expect(got!.height, `${id} height`).toBeCloseTo(want.height, 9)
    }
  })

  it('keeps every tile id and character', () => {
    const mosaic = migrated()
    // Letters live on the states now; the tiles keep only their identity.
    expect(
      mosaic.tiles.map((t) => [t.id, mosaic.states[0]!.chars[t.id] ?? null]).sort(),
    ).toEqual(
      [
        ['l_a', 'A'],
        ['l_b', 'B'],
        ['l_c', null],
        ['l_d', 'D'],
        ['l_e', 'E'],
        ['l_f', null],
        ['l_g', 'G'],
        ['l_h', 'H'],
        ['l_i', 'I'],
      ].sort(),
    )
  })

  it('keeps colours, which are keyed by tile id', () => {
    const state = migrated().states[0]!
    expect(state.glyphColour['l_a']).toBe('#ff0000')
    expect(state.tileColour['l_b']).toBe('#00ff00')
  })

  it('gives tiles that lined up ONE line between them, so they stay aligned', () => {
    /*
     * The point of converting geometrically. The three bands each divided
     * themselves in the tree — three separate splits — but their dividers sat at
     * the same x, so they become one coordinate here. Dragging it moves the
     * column, which is what it looked like it should do all along and what the
     * old model could not offer.
     */
    const mosaic = migrated()
    const byId = new Map(mosaic.tiles.map((t) => [t.id, t]))
    expect(byId.get('l_d')!.right).toBe(byId.get('l_f')!.right)
    expect(byId.get('l_f')!.right).toBe(byId.get('l_h')!.right)
    // And the peeled column's right edge is the same line as the bands' left.
    expect(byId.get('l_a')!.right).toBe(byId.get('l_d')!.left)
  })

  it('leaves no trace of the tree behind', () => {
    const mosaic = migrated() as unknown as Record<string, unknown>
    expect(mosaic['root']).toBeUndefined()
    expect((mosaic['states'] as Record<string, unknown>[])[0]!['ratios']).toBeUndefined()
  })

  it('leaves shapes alone', () => {
    const raw = v18() as Record<string, unknown>
    const objects = raw['objects'] as Record<string, unknown>
    objects['s1'] = {
      kind: 'typography',
      id: 's1',
      name: 'Shape',
      text: 'hello',
      currentSourcePath: 'M0 0L10 0L10 10Z',
      originalSourcePath: 'M0 0L10 0L10 10Z',
      simplifiedRenderPath: 'M0 0L10 0L10 10Z',
    }
    ;(raw['objectOrder'] as string[]).push('s1')

    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    expect(result.doc!.objects['s1']?.kind).toBe('typography')
  })
})

describe('v19 → v20: mosaics gain a snap grid', () => {
  /*
   * The property only decides where a FUTURE drag is allowed to come to rest.
   * Nothing about the saved layout changes on load, which is why this migration
   * can hand every existing mosaic the same default a new one is born with
   * without touching a single line.
   */
  const v19 = () => ({
    schemaVersion: 19,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1', 's1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        tiles: [
          { id: 't_a', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't_b', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [{ x: { c_x: 0.4 }, y: {} }],
        activeState: 0,
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
      s1: {
        kind: 'typography',
        id: 's1',
        name: 'Shape',
        text: 'hello',
        currentSourcePath: 'M0 0L10 0L10 10Z',
        originalSourcePath: 'M0 0L10 0L10 10Z',
        simplifiedRenderPath: 'M0 0L10 0L10 10Z',
      },
    },
  })

  it('gives every mosaic the default grid', () => {
    const result = deserializeDocument(JSON.stringify(v19()))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind).toBe('mosaic')
    expect(mosaic?.kind === 'mosaic' && mosaic.snapStep).toBe(MOSAIC_DEFAULT_SNAP)
  })

  it('moves nothing — the lines are exactly where they were saved', () => {
    const result = deserializeDocument(JSON.stringify(v19()))
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    expect(mosaic.states[0]?.x['c_x']).toBe(0.4)
    expect(mosaic.tiles.map((t) => t.id)).toEqual(['t_a', 't_b'])
    expect(mosaic.tiles.map((t) => mosaic.states[0]!.chars[t.id])).toEqual(['A', 'B'])
  })

  it('keeps a grid the document already carried', () => {
    const raw = v19() as Record<string, unknown>
    const objects = raw['objects'] as Record<string, Record<string, unknown>>
    ;(objects['m1'] as Record<string, unknown>)['snapStep'] = 3
    const result = deserializeDocument(JSON.stringify(raw))
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind === 'mosaic' && mosaic.snapStep).toBe(3)
  })

  it('adds nothing to a shape', () => {
    const result = deserializeDocument(JSON.stringify(v19()))
    const shape = result.doc!.objects['s1']
    expect(shape?.kind).toBe('typography')
    expect((shape as unknown as Record<string, unknown>)['snapStep']).toBeUndefined()
  })
})

describe('v20 → v21: a mosaic remembers the grid it was made as', () => {
  /*
   * Inference is exactly why the property exists going forward: counting the
   * lines a mosaic holds recovers its seed only while it is still a lattice.
   * Once a drag has forked one, the count is too high and the original is gone.
   */
  const v20 = (tiles: unknown[]) => ({
    schemaVersion: 20,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        tiles,
        states: [{ x: { c_x: 0.5 }, y: { c_y: 0.5 } }],
        activeState: 0,
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  /** A plain 2 × 2: one line across, one down, four tiles. */
  const lattice = [
    { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'c_y' },
    { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'c_y' },
    { id: 't3', char: 'C', left: 'mx_min', right: 'c_x', top: 'c_y', bottom: 'my_max' },
    { id: 't4', char: 'D', left: 'c_x', right: 'mx_max', top: 'c_y', bottom: 'my_max' },
  ]

  /*
   * The bounds are the good evidence, and the reason this recovers a reshaped
   * mosaic that line-counting cannot. A mosaic is created columns × rows cells
   * of 120, and localBounds never changes afterwards — the object is scaled
   * through its transform — so the bounds still describe the original grid
   * however far the lines inside it have been dragged.
   */
  it('recovers the original grid of a mosaic whose lines were forked apart', () => {
    // 600 × 600 of bounds is a 5 × 5, whatever the dissection says now. Give it
    // a pile of forked lines so that counting them would answer 15 × 2.
    const many: unknown[] = []
    for (let i = 0; i < 25; i++) {
      many.push({
        id: `t${i}`,
        char: null,
        left: `c_x${i}`,
        right: `c_x${i + 1}`,
        top: 'my_min',
        bottom: 'my_max',
      })
    }
    const raw = v20(many) as Record<string, unknown>
    const objects = raw['objects'] as Record<string, Record<string, unknown>>
    objects['m1']!['localBounds'] = { x: -300, y: -300, width: 600, height: 600 }

    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind === 'mosaic' && mosaic.seed).toEqual({ columns: 5, rows: 5 })
  })

  it('falls back to counting when the bounds are not whole cells', () => {
    // 300 × 300 is two and a half cells, so the bounds say nothing usable.
    const result = deserializeDocument(JSON.stringify(v20(lattice)))
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind === 'mosaic' && mosaic.seed).toEqual({ columns: 2, rows: 2 })
  })

  it('reads the seed straight off a mosaic that is still a lattice', () => {
    const result = deserializeDocument(JSON.stringify(v20(lattice)))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind === 'mosaic' && mosaic.seed).toEqual({ columns: 2, rows: 2 })
  })

  it('leaves nobody’s letters homeless when the tiles no longer make a rectangle', () => {
    // The top-left tile split in two: five tiles, two lines down, still two across.
    const split = [
      { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'c_y2' },
      { id: 't5', char: 'E', left: 'mx_min', right: 'c_x', top: 'c_y2', bottom: 'c_y' },
      ...lattice.slice(1),
    ]
    const result = deserializeDocument(JSON.stringify(v20(split)))
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    const { columns, rows } = mosaic.seed
    expect(columns * rows, 'the guessed grid holds every tile').toBeGreaterThanOrEqual(
      mosaic.tiles.length,
    )
  })

  it('keeps a seed the document already carried', () => {
    const raw = v20(lattice) as Record<string, unknown>
    const objects = raw['objects'] as Record<string, Record<string, unknown>>
    ;(objects['m1'] as Record<string, unknown>)['seed'] = { columns: 7, rows: 3 }
    const result = deserializeDocument(JSON.stringify(raw))
    const mosaic = result.doc!.objects['m1']
    expect(mosaic?.kind === 'mosaic' && mosaic.seed).toEqual({ columns: 7, rows: 3 })
  })

  it('moves nothing on load', () => {
    const result = deserializeDocument(JSON.stringify(v20(lattice)))
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    expect(mosaic.states[0]?.x['c_x']).toBe(0.5)
    expect(mosaic.tiles.map((t) => mosaic.states[0]!.chars[t.id])).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('a version number is not proof of shape', () => {
  /*
   * The failure this exists for, seen in a real document: a tab left open across
   * a schema change writes the NEW version number onto objects that never went
   * through the migration. On the next load the chain is skipped entirely —
   * the number already matches — and the app gets a mosaic missing a field it
   * requires, whose properties panel throws the moment it is selected.
   *
   * Hand-edited files and half-written saves arrive the same way.
   */
  const stamped = (extra: Record<string, unknown>) => ({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [{ x: { c_x: 0.5 }, y: {} }],
        activeState: 0,
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
        ...extra,
      },
    },
  })

  const mosaicFrom = (raw: unknown) => {
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic
  }

  it('fills in a seed the file claims to already have migrated', () => {
    const mosaic = mosaicFrom(stamped({ snapStep: 10 }))
    expect(mosaic.seed, 'inferred rather than left undefined').toEqual({ columns: 2, rows: 1 })
  })

  it('fills in a snap step the same way', () => {
    const mosaic = mosaicFrom(stamped({ seed: { columns: 2, rows: 1 } }))
    expect(mosaic.snapStep).toBe(MOSAIC_DEFAULT_SNAP)
  })

  it('fills in both when neither is there', () => {
    const mosaic = mosaicFrom(stamped({}))
    expect(mosaic.snapStep).toBe(MOSAIC_DEFAULT_SNAP)
    expect(mosaic.seed).toEqual({ columns: 2, rows: 1 })
  })

  it('repairs a seed that is present but malformed', () => {
    const mosaic = mosaicFrom(stamped({ snapStep: 10, seed: { columns: 'two' } }))
    expect(mosaic.seed).toEqual({ columns: 2, rows: 1 })
  })

  it('leaves a complete document exactly as it found it', () => {
    const mosaic = mosaicFrom(stamped({ snapStep: 3, seed: { columns: 9, rows: 4 } }))
    expect(mosaic.snapStep).toBe(3)
    expect(mosaic.seed).toEqual({ columns: 9, rows: 4 })
  })
})

describe('v21 → v22: state timings become milliseconds', () => {
  const v21 = (states: unknown[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 21,
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
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        seed: { columns: 3, rows: 3 },
        states,
        activeState: 1,
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
        ...extra,
      },
    },
  })

  const mosaicFrom = (raw: unknown) => {
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic
  }

  it('converts seconds to milliseconds', () => {
    const mosaic = mosaicFrom(
      v21([{ id: 's1', x: { c_x: 0.4 }, y: {}, hold: 1, transition: 0.6, easing: 'smooth' }]),
    )
    expect(mosaic.states[0]?.holdMs).toBe(1000)
    expect(mosaic.states[0]?.transitionMs).toBe(600)
    expect(mosaic.states[0]?.easing, 'the curve is carried across').toBe('smooth')
  })

  it('leaves no trace of the old names', () => {
    const mosaic = mosaicFrom(v21([{ id: 's1', x: {}, y: {}, hold: 2, transition: 1 }]))
    const raw = mosaic.states[0] as unknown as Record<string, unknown>
    expect(raw['hold']).toBeUndefined()
    expect(raw['transition']).toBeUndefined()
  })

  /*
   * Which state was on show is where somebody's cursor was standing, not
   * artwork, so it leaves the document entirely.
   */
  it('drops the stored active state', () => {
    const mosaic = mosaicFrom(v21([{ id: 's1', x: {}, y: {}, hold: 0, transition: 0.5 }]))
    expect((mosaic as unknown as Record<string, unknown>)['activeState']).toBeUndefined()
  })

  it('fills in timing a file never carried', () => {
    const mosaic = mosaicFrom(v21([{ id: 's1', x: {}, y: {} }]))
    expect(mosaic.states[0]?.holdMs).toBe(MOSAIC_DEFAULT_HOLD_MS)
    expect(mosaic.states[0]?.transitionMs).toBe(MOSAIC_DEFAULT_TRANSITION_MS)
    expect(mosaic.states[0]?.easing).toBe(MOSAIC_DEFAULT_EASING)
  })

  it('repairs states that arrive malformed', () => {
    const mosaic = mosaicFrom(
      v21([
        { x: null, y: undefined, easing: 'bouncy-nonsense', holdMs: 'soon' },
        { id: 's2', x: { c_x: 0.5 }, y: {}, holdMs: 40, transitionMs: 90, easing: 'snappy' },
      ]),
    )
    const first = mosaic.states[0]!
    expect(first.id, 'given an id rather than left without one').toBeTruthy()
    expect(first.x).toEqual({})
    expect(first.y).toEqual({})
    expect(first.easing, 'an easing nothing implements falls back').toBe(MOSAIC_DEFAULT_EASING)
    expect(first.holdMs).toBe(MOSAIC_DEFAULT_HOLD_MS)
    // The sound one beside it is untouched.
    expect(mosaic.states[1]).toMatchObject({ holdMs: 40, transitionMs: 90, easing: 'snappy' })
  })

  it('gives a mosaic with no states at all something to draw', () => {
    const mosaic = mosaicFrom(v21([]))
    expect(mosaic.states.length).toBeGreaterThanOrEqual(1)
    expect(mosaic.states[0]?.x).toEqual({})
  })

  it('keeps the loop and speed the artwork was authored with', () => {
    const mosaic = mosaicFrom(
      v21([{ id: 's1', x: {}, y: {}, hold: 0, transition: 0.2 }], { loop: false, speed: 2 }),
    )
    expect(mosaic.loop).toBe(false)
    expect(mosaic.speed).toBe(2)
  })
})

describe('v22 → v23: font and spacing move onto the states', () => {
  /*
   * They describe a composition as much as the lines do — a mosaic set tighter,
   * or in another face, is a different picture — so they belong with the states
   * that animate. Every state takes the object's values, which means a document
   * loads looking exactly as it did and nothing moves until one is edited.
   */
  const v22 = (states: unknown[]) => ({
    schemaVersion: 22,
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
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        seed: { columns: 2, rows: 1 },
        states,
        font: { fontId: 'pirata-one', weight: 700, italic: true },
        gap: 11,
        outerPadding: 5,
        glyphInset: 3,
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  const mosaicFrom = (raw: unknown) => {
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic
  }

  const state = (id: string) => ({ id, x: { c_x: 0.5 }, y: {}, holdMs: 0, transitionMs: 400, easing: 'linear' })

  it('gives every state the values the object carried', () => {
    const mosaic = mosaicFrom(v22([state('s1'), state('s2'), state('s3')]))
    expect(mosaic.states).toHaveLength(3)
    for (const [at, each] of mosaic.states.entries()) {
      expect(each.font, `state ${at} font`).toEqual({
        fontId: 'pirata-one',
        weight: 700,
        italic: true,
      })
      expect([each.gap, each.outerPadding, each.glyphInset], `state ${at} spacing`).toEqual([
        11, 5, 3,
      ])
    }
  })

  it('makes every state identical, so nothing moves on load', () => {
    const mosaic = mosaicFrom(v22([state('s1'), state('s2')]))
    const [a, b] = mosaic.states
    expect(sameGeometry(a!, b!), 'a document opens looking exactly as it did').toBe(true)
  })

  it('leaves nothing behind on the object', () => {
    const mosaic = mosaicFrom(v22([state('s1')])) as unknown as Record<string, unknown>
    for (const key of ['font', 'gap', 'outerPadding', 'glyphInset']) {
      expect(mosaic[key], `${key} is gone from the object`).toBeUndefined()
    }
  })

  it('fills in a state the migration never reached', () => {
    // A file stamped with the current version whose states never got the fields —
    // which the version number alone cannot rule out.
    const raw = v22([state('s1')]) as Record<string, unknown>
    raw['schemaVersion'] = DOCUMENT_SCHEMA_VERSION
    const objects = raw['objects'] as Record<string, Record<string, unknown>>
    delete objects['m1']!['font']
    delete objects['m1']!['gap']

    const mosaic = mosaicFrom(raw)
    expect(mosaic.states[0]?.font.fontId, 'given a font rather than left without one').toBeTruthy()
    expect(mosaic.states[0]?.gap).toBe(MOSAIC_DEFAULT_SPACING.gap)
  })
})

describe('colours at the load boundary', () => {
  /*
   * No migration: the colour maps have been on the state since the model was
   * written. What the boundary does is tidy — a colour for a tile that no longer
   * exists would accumulate forever, and a string that is not a colour would
   * reach the canvas and paint nothing at all.
   */
  const withColours = (glyph: unknown, tile: unknown) => ({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
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
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't2', char: 'B', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        seed: { columns: 2, rows: 1 },
        states: [
          {
            id: 's1',
            x: { c_x: 0.5 },
            y: {},
            holdMs: 0,
            transitionMs: 400,
            easing: 'linear',
            font: { fontId: 'anton', weight: 400, italic: false },
            gap: 6,
            outerPadding: 0,
            glyphInset: 6,
            glyphColour: glyph,
            tileColour: tile,
          },
        ],
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  const stateFrom = (raw: unknown) => {
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic.states[0]!
  }

  it('drops colours for tiles that no longer exist', () => {
    const state = stateFrom(withColours({ t1: '#ff0000', gone: '#00ff00' }, { gone: '#0000ff' }))
    expect(state.glyphColour).toEqual({ t1: '#ff0000' })
    expect(state.tileColour).toEqual({})
  })

  it('replaces a string that is not a colour rather than passing it on', () => {
    const state = stateFrom(withColours({ t1: 'not-a-colour', t2: '#00ff00' }, {}))
    expect(state.glyphColour['t1']).toBe(DEFAULT_GLYPH_COLOUR)
    expect(state.glyphColour['t2'], 'and leaves a good one alone').toBe('#00ff00')
  })

  it('drops a null background, because a missing entry already says that', () => {
    const state = stateFrom(withColours({}, { t1: null, t2: '#abcdef' }))
    // Still no background — but written the one way, so a cleared tile and a
    // never-coloured one compare as the same thing.
    expect(state.tileColour['t1'] ?? null, 'no background is not a transparent one').toBeNull()
    expect(Object.prototype.hasOwnProperty.call(state.tileColour, 't1')).toBe(false)
    expect(state.tileColour['t2']).toBe('#abcdef')
  })

  it('survives maps that are not maps', () => {
    const state = stateFrom(withColours('nonsense', ['also', 'nonsense']))
    expect(state.glyphColour).toEqual({})
    expect(state.tileColour).toEqual({})
  })

  it('replaces a bad tile colour with no background rather than a guess', () => {
    const state = stateFrom(withColours({}, { t1: 'rgb(1,2,3)' }))
    expect(state.tileColour['t1'] ?? null, 'nothing is the honest answer').toBeNull()
    expect(Object.prototype.hasOwnProperty.call(state.tileColour, 't1')).toBe(false)
  })
})

/**
 * Corner radii arriving on the states.
 *
 * Square is what every document written before them already looks like, so the
 * migration only writes down a shape that was previously implied — a file must
 * load looking exactly as it did.
 */
describe('corners on documents written before them', () => {
  const atVersion = (version: number, state: Record<string, unknown>) => ({
    schemaVersion: version,
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
        tiles: [
          { id: 't1', char: 'A', left: 'mx_min', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [
          {
            id: 's1',
            x: {},
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
            ...state,
          },
        ],
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  const load = (raw: unknown) => {
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic.states[0]!
  }

  it('loads a document from before them with square corners', () => {
    const state = load(atVersion(23, {}))
    expect(state.tileRadius).toBe(0)
    expect(state.outerRadius).toBe(0)
  })

  it('keeps radii that are already there', () => {
    const state = load(atVersion(24, { tileRadius: 12, outerRadius: 40 }))
    expect(state.tileRadius).toBe(12)
    expect(state.outerRadius).toBe(40)
  })

  it('takes a negative radius to square, because it is not a shape', () => {
    const state = load(atVersion(24, { tileRadius: -8, outerRadius: 3 }))
    expect(state.tileRadius).toBe(0)
    expect(state.outerRadius, 'and leaves a good one alone').toBe(3)
  })

  it('replaces a radius that is not a number at all', () => {
    const state = load(atVersion(24, { tileRadius: 'round', outerRadius: Number.POSITIVE_INFINITY }))
    expect(state.tileRadius).toBe(0)
    expect(state.outerRadius).toBe(0)
  })
})

describe('v25 → v26: mosaics gain a backdrop', () => {
  /*
   * A colour behind the whole composition, filling the outer padding and the
   * gaps. Every document written before it simply has no backdrop, and that is
   * the honest reading of a missing field rather than a default to invent.
   */
  const v25 = () => ({
    schemaVersion: 25,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['m1'],
    objects: {
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        tiles: [
          { id: 't_a', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't_b', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [
          {
            x: { c_x: 0.4 },
            y: {},
            chars: { t_a: 'A', t_b: 'B' },
            glyphColour: {},
            tileColour: { t_a: '#ff0000ff' },
            font: { fontId: 'anton', weight: 400 },
          },
        ],
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  const loaded = (patch?: (state: Record<string, unknown>) => void) => {
    const raw = v25() as Record<string, unknown>
    const objects = raw['objects'] as Record<string, Record<string, unknown>>
    const states = (objects['m1'] as Record<string, unknown>)['states'] as Record<
      string,
      unknown
    >[]
    if (patch) patch(states[0] as Record<string, unknown>)
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    return mosaic
  }

  it('gives an older document no backdrop at all', () => {
    expect(loaded().states[0]?.background).toBeNull()
  })

  it('changes nothing else about the composition', () => {
    const mosaic = loaded()
    expect(mosaic.states[0]?.x['c_x']).toBe(0.4)
    expect(mosaic.states[0]?.tileColour['t_a']).toBe('#ff0000ff')
    expect(mosaic.tiles.map((t) => mosaic.states[0]!.chars[t.id])).toEqual(['A', 'B'])
  })

  it('keeps a backdrop the document already carried', () => {
    expect(loaded((state) => (state['background'] = '#00ff00ff')).states[0]?.background).toBe(
      '#00ff00ff',
    )
  })

  it('drops a value that is not a colour rather than painting it', () => {
    // No default to fall back to that anyone chose — an unreadable value is no
    // backdrop, the same answer a missing field gives.
    expect(loaded((state) => (state['background'] = 'chartreuse')).states[0]?.background).toBeNull()
    expect(loaded((state) => (state['background'] = 42)).states[0]?.background).toBeNull()
  })
})

describe('v26 → v27: things gain an edge', () => {
  /*
   * A shape's container and a mosaic's silhouette can be given a border. Every
   * document written before this has none, and null is the honest reading of a
   * missing field — a border nobody added is not a border of no width.
   */
  const v26 = () => ({
    schemaVersion: 26,
    id: 'doc',
    name: 'Test',
    artboard: { width: 1000, height: 1000, background: '#fff' },
    objectOrder: ['s1', 'm1'],
    objects: {
      s1: {
        kind: 'typography',
        id: 's1',
        name: 'Shape 1',
        text: 'HELLO',
        currentSourcePath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
        sourcePath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        appearance: { textFill: '#101014', containerFill: '#dcdcd8', lineFill: null, opacity: 1 },
        opacity: 1,
        visible: true,
        locked: false,
      },
      m1: {
        kind: 'mosaic',
        id: 'm1',
        name: 'Mosaic 1',
        localBounds: { x: -150, y: -150, width: 300, height: 300 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
        tiles: [
          { id: 't_a', left: 'mx_min', right: 'c_x', top: 'my_min', bottom: 'my_max' },
          { id: 't_b', left: 'c_x', right: 'mx_max', top: 'my_min', bottom: 'my_max' },
        ],
        states: [
          {
            x: { c_x: 0.4 },
            y: {},
            chars: { t_a: 'A', t_b: 'B' },
            glyphColour: {},
            tileColour: { t_a: '#ff0000ff' },
            background: '#00ff00ff',
            font: { fontId: 'anton', weight: 400 },
          },
          {
            x: { c_x: 0.7 },
            y: {},
            chars: { t_a: 'A', t_b: 'B' },
            glyphColour: {},
            tileColour: {},
            background: null,
            font: { fontId: 'anton', weight: 400 },
          },
        ],
        font: { fontId: 'anton', weight: 400 },
        gap: 6,
        outerPadding: 0,
        glyphInset: 6,
        snapStep: 10,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      },
    },
  })

  const loaded = () => {
    const result = deserializeDocument(JSON.stringify(v26()))
    expect(result.ok, result.error).toBe(true)
    return result.doc!
  }

  it('gives an older shape no border at all', () => {
    const shape = loaded().objects['s1']
    if (shape?.kind !== 'typography') throw new Error('expected a shape')
    expect(shape.appearance.containerStroke).toBeNull()
  })

  it('gives every state of an older mosaic no border at all', () => {
    const mosaic = loaded().objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    expect(mosaic.states.map((state) => state.stroke)).toEqual([null, null])
  })

  it('changes nothing else it was carrying', () => {
    const doc = loaded()
    const shape = doc.objects['s1']
    const mosaic = doc.objects['m1']
    if (shape?.kind !== 'typography' || mosaic?.kind !== 'mosaic') throw new Error('bad load')
    expect(shape.appearance.containerFill).toBe('#dcdcd8')
    expect(shape.text).toBe('HELLO')
    expect(mosaic.states[0]?.background).toBe('#00ff00ff')
    expect(mosaic.states[0]?.tileColour['t_a']).toBe('#ff0000ff')
    expect(mosaic.states.map((s) => s.x['c_x'])).toEqual([0.4, 0.7])
  })

  it('fills the gap for a document already stamped 27 that never had the field', () => {
    /*
     * The migration loop runs nothing for a file already at the current
     * version, so a document that claims 27 without carrying the field would
     * sail past it. The idempotent pass after the loop is what catches that —
     * and it is also why the next part to want a border needs no migration.
     */
    const raw = v26() as Record<string, unknown>
    raw['schemaVersion'] = 27
    const result = deserializeDocument(JSON.stringify(raw))
    expect(result.ok, result.error).toBe(true)
    const mosaic = result.doc!.objects['m1']
    if (mosaic?.kind !== 'mosaic') throw new Error('expected a mosaic')
    expect(mosaic.states.map((state) => state.stroke)).toEqual([null, null])
  })
})

describe('v28 -> v29: a frame’s states say only what was authored in them', () => {
  const store = () => useDocumentStore.getState()

  /**
   * A real document saved by a build whose writers froze the member's whole
   * current self into a state — then stamped 28 so the repair runs on load.
   */
  const frozenAt28 = (): { raw: string; frame: string; id: string; own: Record<string, unknown> } => {
    useDocumentStore.setState({
      doc: { ...store().doc, objects: {}, objectOrder: [] },
      past: [],
      future: [],
      selection: [],
    })
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = store().createObjectFromGeometry({
      open: false,
      pathData: 'M -60 -50 L 60 -50 L 60 50 L -60 50 Z',
      localBounds: { x: -60, y: -50, width: 120, height: 100 },
      artboardCenter: { x: 300, y: 200 },
      name: 'Box',
    })
    store().updateObject(shape, { text: 'HELLO' })
    const outline = pathToOutline(
      (store().doc.objects[shape] as { currentSourcePath: string }).currentSourcePath,
    )
    if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
    store().addToFrame(frame, [shape])
    store().duplicateFrameState(frame, 1)

    const raw = JSON.parse(serializeDocument(store().doc)) as Record<string, unknown>
    raw['schemaVersion'] = 28
    const object = (raw['objects'] as Record<string, Record<string, unknown>>)[frame]!
    const member = (object['members'] as Record<string, unknown>[])[0]!
    const own = member['object'] as Record<string, unknown>
    const id = member['id'] as string
    const full = (): Record<string, unknown> => ({
      transform: { ...(own['transform'] as object) },
      opacity: 1,
      appearance: { ...(own['appearance'] as object) },
      nodes: JSON.parse(JSON.stringify(own['outline'])),
      typeSettings: {
        text: own['text'],
        font: own['font'],
        fittingMode: own['fittingMode'],
        textFlowMode: own['textFlowMode'],
        typography: own['typography'],
        run: own['run'],
      },
      padding: (own['typography'] as { padding: number }).padding,
    })
    const states = object['states'] as Record<string, unknown>[]
    // State 1: frozen, and still equal to the member — a drag did this.
    ;(states[0]!['values'] as Record<string, unknown>)[id] = full()
    // State 2: frozen, then authored — a colour and a sentence of its own.
    const authored = full()
    ;(authored['appearance'] as Record<string, unknown>)['containerFill'] = '#ff0000'
    ;(authored['typeSettings'] as Record<string, unknown>)['text'] = 'BYE'
    authored['padding'] = 7
    ;(states[1]!['values'] as Record<string, unknown>)[id] = authored
    return { raw: JSON.stringify(raw), frame, id, own }
  }

  const loaded = (raw: string, frame: string) => {
    const result = deserializeDocument(raw)
    expect(result.ok, result.error).toBe(true)
    const object = result.doc!.objects[frame]
    if (object?.kind !== 'frame') throw new Error('expected a frame')
    return object
  }

  it('empties a state that only restated the member', () => {
    const { raw, frame, id } = frozenAt28()
    const object = loaded(raw, frame)
    expect(object.states[0]!.values[id] ?? {}, 'nothing was authored here').toEqual({})
  })

  it('keeps only what differs in a state that was authored', () => {
    const { raw, frame, id } = frozenAt28()
    const object = loaded(raw, frame)
    const patch = object.states[1]!.values[id] as Record<string, unknown>
    expect(Object.keys(patch).sort()).toEqual(['appearance', 'typeSettings'])
    expect(Object.keys(patch['appearance'] as object)).toEqual(['containerFill'])
    expect(Object.keys(patch['typeSettings'] as object)).toEqual(['text'])
    expect('padding' in patch, 'never a field').toBe(false)
  })

  it('draws exactly what it drew before', () => {
    const { raw, frame, id, own } = frozenAt28()
    const object = loaded(raw, frame)
    const member = object.members.find((each) => each.id === id)!
    const restingFill = (own['appearance'] as { containerFill: string | null }).containerFill

    const first = valuesFor(member, object.states[0])
    expect(first.appearance?.containerFill).toBe(restingFill)
    expect(first.typeSettings?.text).toBe('HELLO')

    const second = valuesFor(member, object.states[1])
    expect(second.appearance?.containerFill).toBe('#ff0000')
    expect(second.typeSettings?.text).toBe('BYE')
    expect(second.padding, 'the frozen 7 was never real; the member’s inset is').toBe(
      (own['typography'] as { padding: number }).padding,
    )
  })

  it('leaves a document that never froze anything exactly as it was', () => {
    const { raw, frame, id } = frozenAt28()
    const clean = JSON.parse(raw) as Record<string, unknown>
    const object = (clean['objects'] as Record<string, Record<string, unknown>>)[frame]!
    for (const state of object['states'] as Record<string, unknown>[]) {
      delete (state['values'] as Record<string, unknown>)[id]
    }
    const result = deserializeDocument(JSON.stringify(clean))
    expect(result.ok, result.error).toBe(true)
    const after = result.doc!.objects[frame]
    if (after?.kind !== 'frame') throw new Error('expected a frame')
    expect(after.states.every((state) => Object.keys(state.values).length === 0)).toBe(true)
  })
})

describe('v29 -> v30: a gradient is its own stops', () => {
  const settingsOf = (object: Record<string, unknown>, key: 'textColour' | 'shapeColour'): ColourSettings =>
    (object['animation'] as Record<string, ColourSettings>)[key] as ColourSettings

  it('turns each gradient into the two stops that draw the same picture', () => {
    const object = JSON.parse(
      JSON.stringify(deserializeDocument(gradientDocument('#00ff00')).doc!.objects['a']),
    ) as Record<string, unknown>
    const text = settingsOf(object, 'textColour')
    const shape = settingsOf(object, 'shapeColour')
    expect(text.config['stops']).toEqual([
      { at: 0, colour: '#123456' },
      { at: 1, colour: '#00ff00' },
    ])
    expect(shape.config['stops']).toEqual([
      { at: 0, colour: '#abcdef' },
      { at: 1, colour: '#0000ff' },
    ])
    expect('to' in text.config).toBe(false)
    expect(text.config['angle'], 'everything else rides through').toBe(30)
    expect(text.config['motion']).toBe('sweep')

    // The picture is the one the old two-colour config painted, at rest and in motion.
    const old: ColourSettings = {
      effect: 'gradient',
      config: { to: '#00ff00', shape: 'linear', angle: 30, motion: 'sweep', travel: 0.4 },
    }
    for (const phase of [0, 0.3, 0.7]) {
      const was = paintAt(old, phase, '#123456')
      const now = paintAt(text, phase, '#123456')
      expect(samePaint(was, now), `phase ${phase}`).toBe(true)
      if (was.kind === 'gradient' && now.kind === 'gradient') {
        for (const t of [0, 0.5, 1]) expect(stopColourAt(now.stops, t)).toBe(stopColourAt(was.stops, t))
      }
    }
  })

  it('reads the second colour as the painter did: eight digits were never painted', () => {
    const object = JSON.parse(
      JSON.stringify(deserializeDocument(gradientDocument('#00ff0080')).doc!.objects['a']),
    ) as Record<string, unknown>
    expect((settingsOf(object, 'textColour').config['stops'] as { colour: string }[])[1]?.colour).toBe('#e0552f')
  })

  it('leaves a cycle its second colour', () => {
    const doc = deserializeDocument(
      documentAt(29, {
        // A v29 document says what it is; the v1 skeleton beneath does not.
        kind: 'typography',
        animation: {
          preset: 'none',
          config: {},
          loopDuration: 2,
          shapePreset: 'none',
          shapeConfig: {},
          shapeAffectsText: true,
          bannerPreset: 'follow',
          bannerConfig: {},
          textColour: { effect: 'cycle', config: { to: '#00ff00' } },
          shapeColour: { effect: 'none', config: {} },
        },
      }),
    )
    const object = doc.doc!.objects['a']
    expect(object?.kind === 'typography' && object.animation.textColour.config['to']).toBe('#00ff00')
  })

  it('reaches a gradient on a member inside a frame, and is a no-op the second time', () => {
    useDocumentStore.setState({
      doc: { ...useDocumentStore.getState().doc, objects: {}, objectOrder: [] },
      past: [],
      future: [],
      selection: [],
    })
    const store = useDocumentStore.getState()
    const frame = store.createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = store.createObjectFromGeometry({
      open: false,
      pathData: 'M -60 -50 L 60 -50 L 60 50 L -60 50 Z',
      localBounds: { x: -60, y: -50, width: 120, height: 100 },
      artboardCenter: { x: 300, y: 200 },
      name: 'Box',
    })
    useDocumentStore.getState().addToFrame(frame, [shape])

    const raw = JSON.parse(serializeDocument(useDocumentStore.getState().doc)) as Record<string, unknown>
    raw['schemaVersion'] = 29
    const object = (raw['objects'] as Record<string, Record<string, unknown>>)[frame]!
    const own = (object['members'] as { object: Record<string, unknown> }[])[0]!.object
    const animation = own['animation'] as Record<string, unknown>
    animation['textColour'] = { effect: 'gradient', config: { to: '#ff0000', shape: 'linear', angle: 0, motion: 'still', travel: 0.5 } }
    const base = (own['appearance'] as { textFill: string }).textFill

    const once = deserializeDocument(JSON.stringify(raw))
    const loaded = once.doc!.objects[frame]
    if (loaded?.kind !== 'frame') throw new Error('expected a frame')
    const member = loaded.members[0]!.object
    if (member.kind !== 'typography') throw new Error('expected type')
    expect(member.animation.textColour.config['stops']).toEqual([
      { at: 0, colour: base },
      { at: 1, colour: '#ff0000' },
    ])

    const again = deserializeDocument(serializeDocument(once.doc!))
    const twice = again.doc!.objects[frame]
    if (twice?.kind !== 'frame') throw new Error('expected a frame')
    const member2 = twice.members[0]!.object
    expect(member2.kind === 'typography' && member2.animation.textColour.config['stops']).toEqual(
      member.animation.textColour.config['stops'],
    )
  })
})

/** A v29 document whose shape carries a gradient on its type and its container. */
function gradientDocument(textTo: string): string {
  return documentAt(29, {
    kind: 'typography',
    appearance: {
      textFill: '#123456',
      containerFill: '#abcdef',
      lineFill: null,
      containerStroke: null,
      opacity: 1,
    },
    animation: {
      preset: 'none',
      config: {},
      loopDuration: 2,
      shapePreset: 'none',
      shapeConfig: {},
      shapeAffectsText: true,
      bannerPreset: 'follow',
      bannerConfig: {},
      textColour: {
        effect: 'gradient',
        config: { to: textTo, shape: 'linear', angle: 30, motion: 'sweep', travel: 0.4 },
      },
      shapeColour: {
        effect: 'gradient',
        config: { to: '#0000ff', shape: 'radial', angle: 45, motion: 'still', travel: 0.5 },
      },
    },
  })
}
