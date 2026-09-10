import { describe, expect, it } from 'vitest'

import { shapeIn } from '../fixtures/objects'
import {
  animatingIds,
  animatingMosaicIds,
  mosaicMoves,
  phaseAt,
  playbackDiff,
  signatureOf,
  type PlaybackState,
} from '../../src/editor/animationPlayback'
import { documentDefaults } from '../../src/state/defaults'
import { initialState, seedMosaic } from '../../src/mosaic/dissection'
import type {
  LetterMosaicObject,
  TextShaperDocument,
  TypographyObject,
} from '../../src/types/document'
import type { MosaicState } from '../../src/types/mosaic'

/**
 * What the animation loop decides, asked without a canvas or a clock.
 *
 * A hook driving `requestAnimationFrame` cannot be tested, but nothing that
 * matters about it is about frames: which objects should be moving, where each
 * one is in its loop, and what needs rebuilding after an edit are plain
 * questions, and they used to be buried in an effect body.
 */

const SHAPE = 'M0 0L100 0L100 100L0 100Z'

function object(id: string, patch: Partial<TypographyObject> = {}): TypographyObject {
  const d = documentDefaults
  return {
    kind: 'typography',
    id,
    name: id,
    originalSourcePath: SHAPE,
    currentSourcePath: SHAPE,
    simplifiedRenderPath: SHAPE,
    insetPath: null,
    localBounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: 'HELLO',
    font: { ...d.font },
    textFlowMode: 'word',
    typography: { ...d.typography },
    fittingMode: 'boundary-warp',
    run: { ...d.run },
    outline: null,
    dividers: [],
    appearance: { textFill: '#111', containerFill: '#eee', lineFill: null, opacity: 1 },
    animation: { ...d.animation },
    distortion: { ...d.distortion },
    seed: 5,
    visible: true,
    locked: false,
    geometryRevision: 1,
    ...patch,
  } as unknown as TypographyObject
}

/** An object that actually moves, so `isMoving` says yes. */
const moving = (id: string, patch: Partial<TypographyObject> = {}): TypographyObject =>
  object(id, {
    animation: { ...documentDefaults.animation, preset: 'wave' },
    ...patch,
  } as Partial<TypographyObject>)

function documentOf(...objects: TypographyObject[]): TextShaperDocument {
  return {
    schemaVersion: 18,
    id: 'doc',
    name: 'test',
    createdAt: '',
    updatedAt: '',
    artboard: { width: 1000, height: 800, background: '#fff' },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    objectOrder: objects.map((o) => o.id),
    defaults: documentDefaults,
  } as unknown as TextShaperDocument
}

const state = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
  playing: false,
  watching: false,
  selection: [],
  interacting: null,
  previewing: null,
  ...patch,
})

describe('which objects animate', () => {
  it('plays everything that moves, in z-order, once play is on', () => {
    const doc = documentOf(moving('a'), object('still'), moving('c'))
    expect(animatingIds(doc, state({ playing: true }))).toEqual(['a', 'c'])
  })

  it('leaves out what nobody can see', () => {
    // No group on the canvas to paint into, and frames spent on nothing.
    const doc = documentOf(moving('a'), moving('hidden', { visible: false }))
    expect(animatingIds(doc, state({ playing: true }))).toEqual(['a'])
  })

  it('ignores the selection and the panel entirely while playing', () => {
    // Play means the whole composition, not the part of it being worked on.
    const doc = documentOf(moving('a'), moving('b'))
    expect(animatingIds(doc, state({ playing: true, selection: ['a'] }))).toEqual(['a', 'b'])
    expect(animatingIds(doc, state({ playing: true, watching: false }))).toEqual(['a', 'b'])
  })
})

describe('the preview that was there before the play button', () => {
  /*
   * Kept exactly as it was: with play off, the sole selection previews itself
   * while a panel that cares is open. Play is an addition rather than a trade.
   */
  const doc = documentOf(moving('a'), moving('b'))

  it('shows the one selected object while a panel is watching', () => {
    expect(animatingIds(doc, state({ watching: true, selection: ['a'] }))).toEqual(['a'])
  })

  it('shows nothing with no panel open', () => {
    expect(animatingIds(doc, state({ watching: false, selection: ['a'] }))).toEqual([])
  })

  it('shows nothing for an empty or multiple selection', () => {
    // Two objects selected is a selection to move, not one to preview.
    expect(animatingIds(doc, state({ watching: true, selection: [] }))).toEqual([])
    expect(animatingIds(doc, state({ watching: true, selection: ['a', 'b'] }))).toEqual([])
  })

  it('shows nothing for a selected object that holds still', () => {
    const held = documentOf(object('a'))
    expect(animatingIds(held, state({ watching: true, selection: ['a'] }))).toEqual([])
  })
})

describe('where an object is in its loop', () => {
  it('runs from 0 to 1 and comes back round', () => {
    expect(phaseAt(0, 2)).toBe(0)
    expect(phaseAt(1000, 2)).toBeCloseTo(0.5, 9)
    expect(phaseAt(2000, 2)).toBeCloseTo(0, 9)
    expect(phaseAt(5000, 2)).toBeCloseTo(0.5, 9)
  })

  it('is a function of elapsed time and nothing else', () => {
    /*
     * The property the whole design rests on. Frames are rebuilt whenever an
     * object is edited, and with a start time held per object each rebuild would
     * drop that object to the beginning of its loop — so nudging one slider
     * would jerk every other object on the artboard back to zero. Elapsed time
     * cannot be disturbed by an edit.
     */
    expect(phaseAt(7300, 3)).toBe(phaseAt(7300, 3))
  })

  it('puts objects of the same loop length in step', () => {
    // Which is what "play them together" means.
    expect(phaseAt(4321, 5)).toBe(phaseAt(4321, 5))
    expect(phaseAt(4321, 5)).not.toBeCloseTo(phaseAt(4321, 7), 6)
  })

  it('survives a loop length no slider could produce', () => {
    // A zero would divide by nothing; a negative comes from a document written
    // by a version that allowed one.
    expect(Number.isFinite(phaseAt(1000, 0))).toBe(true)
    expect(phaseAt(1000, 0)).toBeGreaterThanOrEqual(0)
    expect(phaseAt(1000, 0)).toBeLessThan(1)
    expect(phaseAt(1000, -4)).toBeGreaterThanOrEqual(0)
    expect(phaseAt(1000, -4)).toBeLessThan(1)
  })
})

describe('what the loop rebuilds after an edit', () => {
  /** The font is there in these tests; the case where it is not has its own. */
  const ready = (): boolean => true
  const sign = (object: TypographyObject): string => signatureOf(object, true)

  it('notices a change to the FILL TYPE, which reaches the frames through the fit', () => {
    /*
     * The bug this whole signature was rewritten for. It was hand-written, it
     * left `fittingMode` out, and so switching a shape between Fill and Ring
     * while the animation played changed the document, redrew the canvas, and
     * was painted straight back over by a loop still holding the old fit. The
     * control looked dead.
     *
     * It is a fit input, not an animation one, which is exactly why a list
     * written from the animation's point of view missed it — and why the
     * signature is now `fitKey` plus what the fit ignores, rather than a list of
     * its own.
     */
    const base = moving('a')
    const ringed = { ...base, fittingMode: 'ring' } as TypographyObject
    expect(sign(ringed)).not.toBe(sign(base))
  })

  it('notices every other fit input too', () => {
    // The same class of setting, asked of the groups rather than one field, so
    // this keeps holding as the model grows.
    const base = moving('a')
    const nudged: Array<[string, Partial<TypographyObject>]> = [
      ['text flow', { textFlowMode: 'character' }],
      ['typography', { typography: { ...base.typography, letterSpacing: 0.4 } }],
      ['run', { run: { ...base.run, splitAngle: 90 } }],
      ['distortion', { distortion: { ...base.distortion, shear: 0.3 } }],
      ['seed', { seed: base.seed + 1 }],
      ['geometry', { geometryRevision: 2 }],
      ['text', { text: 'GOODBYE' }],
      ['font', { font: { ...base.font, fontId: 'other' } }],
      ['dividers', { dividers: [{ id: 'd', axis: 'row', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }] }],
    ] as Array<[string, Partial<TypographyObject>]>

    for (const [label, patch] of nudged) {
      expect(sign({ ...base, ...patch } as TypographyObject), label).not.toBe(sign(base))
    }
  })

  it('notices the two things the fit ignores and a frame does not', () => {
    // Paint and the animation settings. The fit does not re-solve a path for
    // either, so `fitKey` leaves them out on purpose — and a frame reads both.
    const base = moving('a')
    expect(sign({ ...base, animation: { ...base.animation, loopDuration: 9 } } as TypographyObject))
      .not.toBe(sign(base))
    expect(
      sign({ ...base, appearance: { ...base.appearance, textFill: '#abcdef' } } as TypographyObject),
    ).not.toBe(sign(base))
  })

  it('notices the font arriving', () => {
    // Until it does the fit has nothing to say, and the empty result it gave
    // while waiting must not be held on to once the letters exist.
    const base = moving('a')
    expect(signatureOf(base, false)).not.toBe(signatureOf(base, true))
  })

  it('says nothing changed for a move, which the frames do not read', () => {
    // Position lives on the group, not in the artwork painted into it. Rebuilding
    // for a drag would re-solve a layout on every pointer sample.
    const base = moving('a')
    const moved = { ...base, transform: { ...base.transform, x: 400 } } as TypographyObject
    expect(sign(moved)).toBe(sign(base))
  })

  it('builds what is new or stale and drops what has left', () => {
    const doc = documentOf(moving('a'), moving('b'))
    const cached = new Map([
      ['a', { signature: sign(shapeIn(doc, 'a')) }],
      ['gone', { signature: 'whatever' }],
    ])

    const diff = playbackDiff(cached, doc, ['a', 'b'], ready)
    expect(diff.build, 'b is new, a is current').toEqual(['b'])
    expect(diff.drop, 'gone is no longer wanted').toEqual(['gone'])
  })

  it('rebuilds an entry whose object was edited under it', () => {
    const doc = documentOf(moving('a'))
    const cached = new Map([['a', { signature: 'from before the edit' }]])
    expect(playbackDiff(cached, doc, ['a'], ready).build).toEqual(['a'])
    expect(playbackDiff(cached, doc, ['a'], ready).drop).toEqual([])
  })

  it('drops everything when the wanted set empties', () => {
    // Pressing pause, in other words — and every dropped object gets its resting
    // frame painted back, which is what stops one being stranded mid-loop.
    const doc = documentOf(moving('a'), moving('b'))
    const cached = new Map([
      ['a', { signature: sign(shapeIn(doc, 'a')) }],
      ['b', { signature: sign(shapeIn(doc, 'b')) }],
    ])
    expect(playbackDiff(cached, doc, [], ready).drop.sort()).toEqual(['a', 'b'])
    expect(playbackDiff(cached, doc, [], ready).build).toEqual([])
  })

  it('does not ask for an object that is no longer in the document', () => {
    // A delete can land between the id being chosen and the frame being drawn.
    const doc = documentOf(moving('a'))
    expect(playbackDiff(new Map(), doc, ['a', 'deleted'], ready).build).toEqual(['a'])
  })
})

describe('which mosaics animate', () => {
  /*
   * A mosaic runs on its own evaluator and its own clock, so it is not in
   * `animatingIds` with the shapes. But it does answer to the same play button,
   * which is what "show me the whole thing" has to mean.
   */
  const seeded = seedMosaic(3, 3)

  const stateAt = (shift: number): MosaicState => {
    const base = initialState(seeded.x, seeded.y, { fontId: 'anton', weight: 400, italic: false })
    if (shift === 0) return base
    const x = { ...base.x }
    for (const key of Object.keys(x)) x[key] = (x[key] as number) + shift
    return { ...base, x }
  }

  const mosaic = (id: string, shifts: number[], patch: Record<string, unknown> = {}) =>
    ({
      kind: 'mosaic',
      id,
      name: id,
      localBounds: { x: -180, y: -180, width: 360, height: 360 },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
      tiles: seeded.tiles,
      seed: { columns: 3, rows: 3 },
      font: { fontId: 'anton', weight: 400 },
      states: shifts.map(stateAt),
      gap: 6,
      outerPadding: 0,
      glyphInset: 6,
      snapStep: 10,
      loop: true,
      speed: 1,
      opacity: 1,
      visible: true,
      locked: false,
      ...patch,
    }) as unknown as LetterMosaicObject

  const docOf = (...objects: LetterMosaicObject[]): TextShaperDocument =>
    ({
      schemaVersion: 22,
      id: 'doc',
      name: 'test',
      artboard: { width: 1000, height: 800, background: '#fff' },
      objects: Object.fromEntries(objects.map((o) => [o.id, o])),
      objectOrder: objects.map((o) => o.id),
      defaults: documentDefaults,
    }) as unknown as TextShaperDocument

  it('says a mosaic whose states are identical has nothing to play', () => {
    // What a new mosaic is: three states, no movement, nothing authored yet.
    expect(mosaicMoves(mosaic('m', [0, 0, 0]))).toBe(false)
    expect(mosaicMoves(mosaic('m', [0, 0.1, 0.1]))).toBe(true)
  })

  it('plays every moving mosaic under the global button, on one clock', () => {
    const doc = docOf(mosaic('a', [0, 0.1]), mosaic('still', [0, 0]), mosaic('b', [0, 0.2]))
    const result = animatingMosaicIds(doc, { playing: true, previewing: null })
    expect(result.ids, 'the still one is left out').toEqual(['a', 'b'])
    expect(result.shared, 'and they run in step').toBe(true)
  })

  it('leaves a hidden mosaic alone', () => {
    const doc = docOf(mosaic('a', [0, 0.1], { visible: false }), mosaic('b', [0, 0.2]))
    expect(animatingMosaicIds(doc, { playing: true, previewing: null }).ids).toEqual(['b'])
  })

  it('previews just the one the panel is on when the button is off', () => {
    const doc = docOf(mosaic('a', [0, 0.1]), mosaic('b', [0, 0.2]))
    const result = animatingMosaicIds(doc, { playing: false, previewing: 'b' })
    expect(result.ids).toEqual(['b'])
    // Its own position, so pausing and playing again picks up where it left off.
    expect(result.shared).toBe(false)
  })

  it('plays nothing when neither is asking', () => {
    const doc = docOf(mosaic('a', [0, 0.1]))
    expect(animatingMosaicIds(doc, { playing: false, previewing: null }).ids).toEqual([])
  })

  /*
   * The global button wins while it is on: its list already holds whatever the
   * panel was previewing, and two clocks driving one mosaic would fight.
   */
  it('lets the global button take over a mosaic the panel was previewing', () => {
    const doc = docOf(mosaic('a', [0, 0.1]), mosaic('b', [0, 0.2]))
    const result = animatingMosaicIds(doc, { playing: true, previewing: 'b' })
    expect(result.ids).toEqual(['a', 'b'])
    expect(result.shared).toBe(true)
  })
})

/**
 * One object asked to play by the control sitting under it.
 *
 * Distinct from both of the other two rules. It names a single object, so it is
 * not what somebody meant when they pressed play for everything; and it is a
 * direct request, so it should not depend on which tab happens to be open —
 * which is the whole reason the control is on the canvas rather than in a panel.
 */
describe('an object playing on its own', () => {
  it('plays just that one, whatever tab is open', () => {
    const doc = documentOf(moving('a'), moving('b'))
    expect(animatingIds(doc, state({ previewing: 'b' }))).toEqual(['b'])
    expect(animatingIds(doc, state({ previewing: 'b', watching: true }))).toEqual(['b'])
  })

  it('beats the panel preview of a different selection', () => {
    const doc = documentOf(moving('a'), moving('b'))
    const asked = state({ previewing: 'b', watching: true, selection: ['a'] })
    expect(animatingIds(doc, asked)).toEqual(['b'])
  })

  it('gives way to the play button, which means everything', () => {
    const doc = documentOf(moving('a'), moving('b'))
    expect(animatingIds(doc, state({ playing: true, previewing: 'b' }))).toEqual(['a', 'b'])
  })

  it('animates nothing when the object it names does not move', () => {
    const doc = documentOf(moving('a'), object('still'))
    expect(animatingIds(doc, state({ previewing: 'still' }))).toEqual([])
  })

  it('animates nothing when the object it names is gone', () => {
    const doc = documentOf(moving('a'))
    expect(animatingIds(doc, state({ previewing: 'deleted' }))).toEqual([])
  })
})
