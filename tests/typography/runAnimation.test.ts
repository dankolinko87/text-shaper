import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { applyToPaths, parsePathInScope } from '../../src/geometry/path'
import { pathBounds } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { strokeToLinePath } from '../../src/geometry/strokeToPath'
import { documentDefaults } from '../../src/state/defaults'
import {
  ANIMATIONS,
  bannerAnimations,
  defaultConfig,
} from '../../src/typography/animation'
import { registerFont } from '../../src/typography/fontRegistry'
import {
  animationFrames,
  fitObject,
  hasContainer,
} from '../../src/typography/objectFit'
import {
  SHAPE_ANIMATIONS,
  defaultShapeConfig,
} from '../../src/typography/shapeAnimation'
import { wordsCanTravel } from '../../src/typography/runFit'
import type { TypographyObject, Vec2 } from '../../src/types/document'
import { drawnLineStroke } from '../fixtures/strokes'

/**
 * What the presets do to type set along a run.
 *
 * The regression this covers was invisible to every other test in the suite: the
 * artwork was right, the text was all there, the band tracked the ink — and four
 * of the seven presets did nothing at all, because `drawRunLine` handed the
 * frame's strip deformation to the packed branch and not to the rigid one. Set
 * letters are the default, so most of the presets appeared broken in every run
 * mode.
 *
 * Written as "which presets move what", because that is the shape of the bug.
 */

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(600, 500)

/** Presets that deform the whole strip: the type moves and so does its banner. */
const STRIP = ['wave', 'boil', 'sweep', 'sway']
/** Presets that move each letter in its own right, inside a banner that stays put. */
const PER_LETTER = ['bounce', 'pop', 'jitter']

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})

afterEach(() => {
  resetPaperScope()
})

function object(
  shapePath: string,
  mode: 'ring' | 'path',
  run: Record<string, unknown>,
  preset: string,
  banner: Record<string, unknown> = {},
): TypographyObject {
  const d = documentDefaults
  return {
    id: 'o1',
    name: 'test',
    originalSourcePath: shapePath,
    currentSourcePath: shapePath,
    simplifiedRenderPath: shapePath,
    insetPath: shapePath,
    localBounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: 'THE QUICK BROWN FOX',
    font: { ...d.font, fontId: 'anton' },
    textFlowMode: 'word',
    typography: { ...d.typography },
    fittingMode: mode,
    run: { ...d.run, lineHeight: 1.4, ...run },
    line: mode === 'path' ? { anchors: [] } : null,
    dividers: [],
    appearance: { textFill: '#111', containerFill: null, lineFill: '#fc0', opacity: 1 },
    animation: {
      ...d.animation,
      preset,
      config: defaultConfig(preset as never),
      ...banner,
    },
    distortion: { ...d.distortion },
    seed: 5,
    visible: true,
    locked: false,
    geometryRevision: 1,
  } as unknown as TypographyObject
}

/** The cases the bug spanned: both letter styles, all three kinds of run. */
function cases(): Array<[string, string, 'ring' | 'path', Record<string, unknown>]> {
  const drawn = strokeToLinePath(drawnLineStroke('wave'))
  if (!drawn.ok) throw new Error('the line fixture did not build')
  return [
    ['lap, set', ELLIPSE, 'ring', { turns: 'one', rigid: true }],
    ['lap, wrapped', ELLIPSE, 'ring', { turns: 'one', rigid: false }],
    ['spiral, set', ELLIPSE, 'ring', { turns: 'many', rigid: true }],
    ['drawn line, set', drawn.pathData, 'path', { rigid: true }],
    ['drawn line, wrapped', drawn.pathData, 'path', { rigid: false }],
  ]
}

const distinct = (values: readonly string[]): number => new Set(values).size

describe('animating type along a run', () => {
  it('moves the letters under every preset, set or wrapped', () => {
    for (const [name, shape, mode, run] of cases()) {
      for (const preset of ANIMATIONS) {
        if (preset.id === 'none') continue
        // Travel is the one preset that needs a run with no ends, and says so.
        if (preset.id === 'travel') continue

        const frames = animationFrames(object(shape, mode, run, preset.id), 4)
        expect(frames.length, `${name} / ${preset.id}`).toBeGreaterThan(1)
        expect(distinct(frames.map((f) => f.path)), `${name} / ${preset.id}`).toBeGreaterThan(1)
      }
    }
  })

  /*
   * The banner is part of the strip, not a backdrop pinned behind it.
   *
   * So the presets that deform the strip have to carry it, and the ones that
   * move individual letters must NOT — a letter bouncing inside a still banner
   * is the point of Bounce, and a banner that bounced with it would be one
   * shape wobbling rather than type coming alive inside a stripe.
   */
  it('carries the banner with the strip, and leaves it alone under the rest', () => {
    for (const [name, shape, mode, run] of cases()) {
      for (const id of [...STRIP, ...PER_LETTER]) {
        const frames = animationFrames(object(shape, mode, run, id), 4)
        const bands = distinct(frames.map((f) => f.bandPath ?? ''))
        const ribbons = distinct(frames.map((f) => f.ribbon.map((s) => s.band).join('|')))

        if (STRIP.includes(id)) {
          expect(bands, `${name} / ${id} banner`).toBeGreaterThan(1)
          expect(ribbons, `${name} / ${id} ribbon`).toBeGreaterThan(1)
        } else {
          expect(bands, `${name} / ${id} banner`).toBe(1)
          expect(ribbons, `${name} / ${id} ribbon`).toBe(1)
        }
      }
    }
  })

  /*
   * And carried by the SAME amount, which is the property that matters and the
   * one a "did it change?" test cannot see.
   *
   * Measured as ink escaping its banner: every corner of every letter should sit
   * inside the band it is drawn on, at every moment of the loop. A banner that
   * moved by its own arithmetic rather than by the type's would drift a little
   * and let the letters climb out, and the drawing would look fine in a still.
   */
  it('keeps the letters inside the banner at every moment', () => {
    for (const [name, shape, mode, run] of cases()) {
      for (const id of STRIP) {
        const frames = animationFrames(object(shape, mode, run, id), 6)
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i]!
          expect(frame.bandPath, `${name} / ${id}`).toBeTruthy()
          const escaped = outsideShare(frame.path, frame.bandPath as string)
          expect(escaped, `${name} / ${id} frame ${i}`).toBeLessThan(0.02)
        }
      }
    }
  })
})

/**
 * The share of the type's own corners that fall outside the banner.
 *
 * A share rather than a count, and a couple of percent of slack, because the
 * banner is a polyline through the run's samples while a letter is a Bézier: a
 * point on the outermost edge of an ascender can sit a hair outside the chord
 * drawn between two band samples without anything being wrong. What this is
 * looking for is letters standing clear of their background, which runs to tens
 * of percent.
 */
function outsideShare(textPath: string, bandPath: string): number {
  if (!textPath || !bandPath) return 1
  return withPaper((scope) => {
    const band = parsePathInScope(scope, bandPath)
    const text = parsePathInScope(scope, textPath)

    const points: Vec2[] = []
    applyToPaths(text, (path) => {
      for (const segment of path.segments) {
        points.push({ x: segment.point.x, y: segment.point.y })
      }
    })

    let outside = 0
    for (const p of points) {
      if (!band.contains(new scope.Point(p.x, p.y))) outside++
    }
    const share = points.length > 0 ? outside / points.length : 1
    text.remove()
    band.remove()
    return share
  })
}

describe('animating the banner in its own right', () => {
  /*
   * The banner is a shape, not a marking on the letters, so it gets a loop of
   * its own — and the two things that asks for are opposites: words travelling
   * round inside a banner that holds still, and a banner rippling under type
   * that does not.
   */
  const LAP = ['ring', { turns: 'one', rigid: true }] as const

  it('holds the banner still while the words move', () => {
    const still = object(ELLIPSE, LAP[0], LAP[1], 'wave', {
      bannerPreset: 'none',
      bannerConfig: {},
    })
    const frames = animationFrames(still, 4)
    expect(frames.length).toBeGreaterThan(1)
    expect(distinct(frames.map((f) => f.path)), 'the words').toBeGreaterThan(1)
    expect(distinct(frames.map((f) => f.bandPath ?? '')), 'the banner').toBe(1)
  })

  it('moves the banner while the words stay put', () => {
    const still = object(ELLIPSE, LAP[0], LAP[1], 'none', {
      bannerPreset: 'wave',
      bannerConfig: defaultConfig('wave'),
    })
    // The gate on the whole loop: a banner-only animation still has to count as
    // moving, or the editor never starts and the exporter writes one still.
    const frames = animationFrames(still, 4)
    expect(frames.length, 'not treated as moving').toBeGreaterThan(1)
    expect(distinct(frames.map((f) => f.bandPath ?? '')), 'the banner').toBeGreaterThan(1)
    expect(distinct(frames.map((f) => f.path)), 'the words').toBe(1)
  })

  /*
   * The banner is never carried ALONG its run, only deformed in place.
   *
   * Travel was offered for a while and taken away: a banner carried away from
   * the words it belongs to leaves them standing on bare shape, which is not a
   * banner any more. The menu is built from what each preset declares it takes
   * hold of, so this is a property of the model rather than a name on a list.
   */
  it('offers the banner only the presets that deform a strip', () => {
    const offered = bannerAnimations().map((preset) => preset.id)
    expect(offered).not.toContain('travel')
    expect(offered).not.toContain('bounce')
    expect(offered).not.toContain('pop')
    expect(offered).not.toContain('jitter')
    expect(offered).toEqual(expect.arrayContaining(['wave', 'boil', 'sweep', 'sway']))

    for (const preset of ANIMATIONS) {
      expect(offered.includes(preset.id), preset.id).toBe(preset.carries === 'strip')
    }
  })

  it('follows the type by default, exactly', () => {
    // `follow` has to be the type's own moment rather than a copy of its
    // settings, or the two drift apart by whatever the copy rounds.
    const following = object(ELLIPSE, LAP[0], LAP[1], 'wave')
    const explicit = object(ELLIPSE, LAP[0], LAP[1], 'wave', {
      bannerPreset: 'wave',
      bannerConfig: defaultConfig('wave'),
    })
    const a = animationFrames(following, 4).map((f) => f.bandPath)
    const b = animationFrames(explicit, 4).map((f) => f.bandPath)
    expect(a).toEqual(b)
    expect(distinct(a.map((v) => v ?? '')), 'a following banner moves').toBeGreaterThan(1)
  })


})

describe('carrying the words along a run', () => {
  /*
   * Travel used to be offered on one case out of five: a lap that had not been
   * cut open. The reason given was that a letter pushed past the end of an open
   * run collapses, because `runAt` clamps there — true of PACKED letters, which
   * are mapped through the run point by point, and not of SET ones, which are
   * whole shapes placed at a point and can simply appear again at the beginning.
   */
  it('marches set letters along a run with two ends, and wraps them', () => {
    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    if (!drawn.ok) throw new Error('the line fixture did not build')

    for (const [name, shape, mode, run] of [
      ['drawn line', drawn.pathData, 'path', { rigid: true, fontSize: 26 }],
      ['spiral', ELLIPSE, 'ring', { turns: 'many', rigid: true, fontSize: 30 }],
    ] as const) {
      const frames = animationFrames(
        object(shape, mode, run, 'travel', { bannerPreset: 'none', bannerConfig: {} }),
        6,
      )
      expect(distinct(frames.map((f) => f.path)), `${name} words`).toBeGreaterThan(1)

      /*
       * And very nearly ALL of them, at every moment.
       *
       * The assertion that matters, and the one "did it change?" misses: get the
       * carrying wrong and the letters do not march round, they march off — each
       * dropped as it passes the end, because a glyph placed off an open run is
       * not drawn. The paths still differ from frame to frame while the sentence
       * quietly empties out.
       *
       * One letter at a time is genuinely missing, and has to be: a run with two
       * ends cannot draw a letter straddling the seam, so the one spanning it is
       * left out rather than smeared across the gap. Three contours is the most
       * any single letter here has, so anything beyond that is the sentence
       * losing letters rather than the seam passing under one.
       */
      const contours = (path: string): number => (path.match(/M/g) ?? []).length
      const counts = frames.map((f) => contours(f.path))
      const whole = Math.max(...counts)
      expect(
        Math.min(...counts),
        `${name} loses more than the letter on the seam: ${counts.join(',')}`,
      ).toBeGreaterThanOrEqual(whole - 3)

      // Still on the run at every moment rather than marching off the end of it.
      const bounds = pathBounds(shape)
      for (const frame of frames) {
        const ink = pathBounds(frame.path)
        expect(ink.x, `${name} left`).toBeGreaterThan(bounds.x - 120)
        expect(ink.x + ink.width, `${name} right`).toBeLessThan(bounds.x + bounds.width + 120)
      }
    }
  })

  it('carries the words along every run but a lap that has been cut open', () => {
    // Travel used to take a third argument for whether the letters were SET,
    // because it was folded into the run as it was read. Moving the slots made
    // that distinction disappear along with the argument: a letter is a letter
    // either way.
    expect(wordsCanTravel(false), 'a run with two ends').toBe(true)
    expect(wordsCanTravel(true), 'a whole lap').toBe(true)
    expect(wordsCanTravel(true, true), 'a split lap').toBe(false)
  })

  it('marches packed letters along a run with two ends as well', () => {
    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    if (!drawn.ok) throw new Error('the line fixture did not build')
    for (const [name, shape, mode, run] of [
      ['drawn line', drawn.pathData, 'path', { rigid: false, fontSize: 26 }],
      ['spiral', ELLIPSE, 'ring', { turns: 'many', rigid: false, fontSize: 30 }],
    ] as const) {
      const frames = animationFrames(
        object(shape, mode, run, 'travel', { bannerPreset: 'none', bannerConfig: {} }),
        6,
      )
      expect(distinct(frames.map((f) => f.path)), `${name} words`).toBeGreaterThan(1)

      // On the run at every moment. A packed letter is mapped through the run
      // point by point, so one left straddling the seam would be drawn as a
      // streak between the two ends — which this would catch as a bounds blowout.
      const bounds = pathBounds(shape)
      for (const frame of frames) {
        const ink = pathBounds(frame.path)
        expect(ink.width, `${name} width`).toBeLessThan(bounds.width * 1.4)
        expect(ink.height, `${name} height`).toBeLessThan(bounds.height * 1.4)
      }
    }
  })
})

describe('how many rows a run comes out as', () => {
  /*
   * One, always — and the panel leans on it.
   *
   * Line offset delays each ROW against the one above, and `linePhase` returns
   * the phase untouched below two of them, so on a run the control does nothing
   * whatsoever. The panel hides it by asking how many rows the text actually
   * came out as, which is only sound while this holds: a lap, a spiral and a
   * drawn line are each ONE line of type, however many times it winds round.
   *
   * If a run mode ever gains rows, this fails and the control starts appearing
   * for it, which is the right outcome in both directions.
   */
  it('lays every kind of run out as a single line', () => {
    for (const [name, shape, mode, run] of cases()) {
      const fitted = fitObject(object(shape, mode, run, 'none'))
      expect(fitted.ok, name).toBe(true)
      if (!fitted.ok) continue
      expect(fitted.lineCount, `${name} rows`).toBe(1)
      expect(fitted.layout?.lines.length, `${name} layout rows`).toBe(1)
    }
  })
})

describe('animating the shape a run sits on', () => {
  /*
   * A shape preset deforms the CONTAINER, and a row of block text is laid out
   * through that container, so the type follows by itself. A run is not: a lap,
   * a spiral and a line are bent onto a run that knows nothing about the patch,
   * so the deformation has to be handed to them directly.
   *
   * It was not. Every shape preset pulled the outline about while the ring of
   * text around it stayed exactly where it was — the container and its type
   * visibly coming apart, which is the one thing the two menus are supposed to
   * be unable to do.
   */
  const withShape = (
    shape: string,
    mode: 'ring' | 'path',
    run: Record<string, unknown>,
    shapePreset: string,
    extra: Record<string, unknown> = {},
  ): TypographyObject => {
    const base = object(shape, mode, run, 'none')
    return {
      ...base,
      appearance: { ...base.appearance, containerFill: '#dcdcd8', lineFill: null },
      animation: {
        ...base.animation,
        shapePreset,
        shapeConfig: defaultShapeConfig(shapePreset as never),
        ...extra,
      },
    } as TypographyObject
  }

  it('carries the type with the shape it is set on', () => {
    for (const [name, shape, mode, run] of cases()) {
      if (mode === 'path') continue
      for (const preset of SHAPE_ANIMATIONS) {
        if (preset.id === 'none') continue
        const frames = animationFrames(withShape(shape, mode, run, preset.id), 4)
        const label = `${name} / ${preset.id}`
        expect(frames.length, label).toBeGreaterThan(1)
        expect(distinct(frames.map((f) => f.shapePath ?? '')), `${label} shape`).toBeGreaterThan(1)
        expect(distinct(frames.map((f) => f.path)), `${label} type`).toBeGreaterThan(1)
      }
    }
  })

  it('holds the type still when the shape is told not to reach it', () => {
    // The control that says the container is a frame around the words rather
    // than a vessel they are poured into.
    const held = withShape(ELLIPSE, 'ring', { turns: 'one', rigid: true }, 'pulse', {
      shapeAffectsText: false,
    })
    const frames = animationFrames(held, 4)
    expect(distinct(frames.map((f) => f.shapePath ?? '')), 'shape').toBeGreaterThan(1)
    expect(distinct(frames.map((f) => f.path)), 'type').toBe(1)
  })

  /*
   * The `line` field arrived with the line tool and was only ever written on a
   * line, so every object made before it has no such key while the type has
   * always said `LineSettings | null`. A strict test against null therefore read
   * every one of those shapes as a line and hid the Shape menu on all of them.
   *
   * A migration now fills the field in. This asks the question the other way —
   * would the predicate survive that data anyway — because the migration only
   * covers documents that are loaded through it.
   */
  it('reads a shape written before lines existed as a shape', () => {
    const legacy = object(ELLIPSE, 'ring', { turns: 'one' }, 'none') as unknown as Record<
      string,
      unknown
    >
    delete legacy['line']
    expect(hasContainer(legacy as unknown as TypographyObject)).toBe(true)

    const line = object(ELLIPSE, 'path', { rigid: true }, 'none')
    expect(hasContainer(line)).toBe(false)
  })

  it('has nothing to deform on a drawn line', () => {
    /*
     * A line is a run and nothing else. What the editor draws along it is a
     * guide, not artwork, so a shape preset could only wobble a grey line nobody
     * is looking at — which is why the menu is not offered for one, and why an
     * object that still carries a preset from before must not move either.
     */
    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    if (!drawn.ok) throw new Error('the line fixture did not build')

    for (const preset of SHAPE_ANIMATIONS) {
      if (preset.id === 'none') continue
      const line = withShape(drawn.pathData, 'path', { rigid: true }, preset.id)
      expect(hasContainer(line), 'a line has no container').toBe(false)
      // Nothing moving at all, so the loop never starts and the exporter writes
      // a single still.
      expect(animationFrames(line, 4).length, preset.id).toBe(1)

      /*
       * And with the TYPE moving — so frames really are being composed — the
       * shape still never draws. Asked separately because the two guards are
       * separate: one keeps the loop from starting, the other keeps the preset
       * from reaching a line that has no container. Either alone would make the
       * test above pass while the other was broken.
       */
      const alive = {
        ...line,
        animation: { ...line.animation, preset: 'wave', config: defaultConfig('wave') },
      } as TypographyObject
      const frames = animationFrames(alive, 4)
      expect(frames.length, `${preset.id} with moving type`).toBeGreaterThan(1)
      expect(distinct(frames.map((f) => f.path)), `${preset.id} type`).toBeGreaterThan(1)
      expect(frames.every((f) => f.shapePath === null), `${preset.id} shape`).toBe(true)
    }
  })
})

describe('what the ribbon can be relied on for', () => {
  /*
   * Every letter has to appear, at every moment, and this is the assertion that
   * would have caught the bug the ribbon's slicing caused twice: a travelling
   * sentence lost a slice of itself at a time until only the last one was left,
   * while the paths still differed from frame to frame and the fit stayed sound.
   *
   * Counted on the SLICES, because the flat path was right the whole time — the
   * loss was in how the pieces were laid down, not in what was drawn.
   */
  it('draws every letter in the slices, at every moment of a travelling loop', () => {
    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    if (!drawn.ok) throw new Error('the line fixture did not build')

    for (const [name, shape, mode, run] of [
      ['lap', ELLIPSE, 'ring', { turns: 'one', rigid: true }],
      ['spiral', ELLIPSE, 'ring', { turns: 'many', rigid: false }],
      ['drawn line', drawn.pathData, 'path', { rigid: true, fontSize: 26 }],
    ] as const) {
      const frames = animationFrames(object(shape, mode, run, 'travel'), 6)
      const contours = (path: string): number => (path.match(/M/g) ?? []).length

      for (const frame of frames) {
        const sliced = frame.ribbon.map((s) => contours(s.text)).reduce((a, b) => a + b, 0)
        expect(sliced, `${name}: the slices lost letters the flat path kept`).toBe(
          contours(frame.path),
        )
      }
    }
  })
})
