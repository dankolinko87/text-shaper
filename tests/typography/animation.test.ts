import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { pathBounds } from '../../src/geometry/path'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { createEmptyDocument, documentDefaults } from '../../src/state/defaults'
import {
  ANIMATIONS,
  STATIC_FRAME,
  animationById,
  defaultConfig,
  defaultLoop,
  linePhase,
} from '../../src/typography/animation'
import {
  SHAPE_ANIMATIONS,
  defaultShapeConfig,
  type ShapePreset,
} from '../../src/typography/shapeAnimation'
import { fitTextToShape } from '../../src/typography/fit'
import { renderFrame } from '../../src/typography/frame'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'
import { animationFrames, fitObject, frameAt, prepareFrames } from '../../src/typography/objectFit'
import type { AnimationPreset, TypographyObject } from '../../src/types/document'

const FONT_ID = 'anton'
const SHAPE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const TEXT = 'RONESHA IS THE VERY BEST'

beforeAll(async () => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  // Spiral mode offsets the outline to wind its turns, which needs the clipper.
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

/** A document object carrying the given preset, ready to animate. */
function shapeWith(
  preset: AnimationPreset,
  config?: Record<string, number | string>,
): TypographyObject {
  return {
    kind: 'typography',
    id: 'a',
    name: 'Shape',
    originalSourcePath: SHAPE,
    currentSourcePath: SHAPE,
    simplifiedRenderPath: SHAPE,
    insetPath: null,
    localBounds: { x: -340, y: -300, width: 680, height: 600 },
    geometryRevision: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: TEXT,
    textFlowMode: 'word',
    fittingMode: 'boundary-warp',
    dividers: [],
    font: { ...documentDefaults.font },
    typography: { ...documentDefaults.typography },
    run: { ...documentDefaults.run },
    outline: null,
    distortion: { ...documentDefaults.distortion },
    appearance: { ...documentDefaults.appearance },
    animation: {
      preset,
      loopDuration: 2,
      config: config ?? defaultConfig(preset),
      shapePreset: 'none',
      shapeConfig: {},
      shapeAffectsText: true,
      bannerPreset: 'follow',
      bannerConfig: {},
      textColour: { effect: 'none', config: {} },
      shapeColour: { effect: 'none', config: {} },
    },
    seed: 7,
    visible: true,
    locked: false,
  }
}

const MOVING = ANIMATIONS.filter((preset) => preset.id !== 'none')

/**
 * The presets that move ANY kind of text.
 *
 * Travel is the exception and has to be, so the rules below are written without
 * it. It carries the words bodily round their run and relies on their coming
 * back to where they started, which needs a run with no ends: a lap, uncut. On
 * a shape's rows there is no run at all, and on a spiral or a split lap the
 * words would walk off the end — `runAt` clamps there, and every point past it
 * lands on the same place, which collapses a letter to a spike.
 *
 * So it is not offered where it cannot work — see `AnimatePanel` — and it has
 * its own test below rather than being asserted against text it never touches.
 */
const CARRIED = MOVING.filter((preset) => preset.id !== 'travel')

describe('the frozen layout', () => {
  it('redraws the still artwork exactly', () => {
    // The guard for the whole split. If holding the solved layout and emitting
    // from it did not reproduce today's output byte for byte, the refactor
    // would have changed the artwork while claiming only to have moved code.
    for (const shape of PRIMITIVES) {
      const result = fitTextToShape({
        text: TEXT,
        shapePath: shape.build(680, 600),
        fontId: FONT_ID,
        flowMode: 'word',
        lineSpacing: 1.14,
        letterSpacing: 0,
        quality: 'final',
        fittingMode: 'boundary-warp',
        distortion: documentDefaults.distortion,
        seed: 1,
      })
      expect(result.ok, shape.label).toBe(true)
      if (!result.ok || !result.layout) continue
      expect(renderFrame(result.layout, STATIC_FRAME), shape.label).toBe(result.path)
    }
  })

  it('never lets the words move between rows mid-loop', () => {
    // The reason the layout is frozen at all. If the fit re-ran per frame the
    // line breaks could change and words would visibly jump.
    for (const preset of MOVING) {
      const object = shapeWith(preset.id)
      const fitted = fitObject(object)
      expect(fitted.ok, preset.label).toBe(true)
      if (!fitted.ok || !fitted.layout) continue

      const texts = fitted.layout.lines.map((line) => line.characters.join(''))
      for (let i = 0; i <= 12; i++) {
        const frame = preset.frame(defaultConfig(preset.id), i / 12, object.seed)
        renderFrame(fitted.layout, frame)
        // The layout is the same object throughout; nothing may have rewritten it.
        expect(fitted.layout.lines.map((line) => line.characters.join('')), preset.label).toEqual(
          texts,
        )
      }
    }
  })
})

describe('every preset loops seamlessly', () => {
  it('ends exactly where it began', () => {
    // Phase 0 and phase 1 are the same point on the same circle. This is what
    // makes a GIF loop without a visible jolt at the seam.
    for (const preset of MOVING) {
      const object = shapeWith(preset.id)
      const fitted = fitObject(object)
      if (!fitted.ok || !fitted.layout) continue
      const config = defaultConfig(preset.id)

      const start = renderFrame(fitted.layout, preset.frame(config, 0, object.seed))
      const end = renderFrame(fitted.layout, preset.frame(config, 1, object.seed))
      expect(end, `${preset.label} does not close its loop`).toBe(start)
    }
  })

  it('produces a sequence with no repeated closing frame', () => {
    // Frames run i/count, so the last one is short of a full turn — a frame at
    // phase 1 would duplicate the first and stutter the loop.
    //
    for (const preset of CARRIED) {
      const frames = animationFrames(shapeWith(preset.id), 8)
      expect(frames, preset.label).toHaveLength(8)
      expect(frames[0]!.path, preset.label).not.toBe(frames[7]!.path)
    }
  })

  it('actually moves, on a shape with no dividers at all', () => {
    // Sweep works by shifting vertical deformers. On a shape that has none it
    // grips an implicit one at the centre — otherwise choosing the preset would
    // appear to do nothing until you had discovered deformers and added one.
    for (const preset of CARRIED) {
      const frames = animationFrames(shapeWith(preset.id), 8)
      const distinct = new Set(frames.map((f) => f.path))
      expect(distinct.size, `${preset.label} is not animating`).toBeGreaterThan(1)
    }
  })
})

describe('frames stay correct', () => {
  it('keeps the text exact at every point in the loop', () => {
    for (const preset of MOVING) {
      const object = shapeWith(preset.id)
      const fitted = fitObject(object)
      if (!fitted.ok || !fitted.layout) continue
      const texts = fitted.layout.lines.map((line) => line.characters.join(''))
      expect(verifyExactText(TEXT, texts, 'word').ok, preset.label).toBe(true)
    }
  })

  it('is deterministic for a seed, and differs between seeds', () => {
    const object = shapeWith('boil')
    const a = animationFrames(object, 6)
    const b = animationFrames(object, 6)
    const c = animationFrames({ ...object, seed: 99 }, 6)
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path))
    expect(a.map((f) => f.path)).not.toEqual(c.map((f) => f.path))
  })

  it('emits no non-finite geometry at either end of every control', () => {
    for (const preset of MOVING) {
      for (const extreme of ['min', 'max'] as const) {
        const config: Record<string, number | string> = {}
        for (const control of preset.controls) {
          config[control.key] = control.kind === 'number' ? control[extreme] : control.value
        }
        for (const frame of animationFrames(shapeWith(preset.id, config), 4)) {
          expect(frame.path, `${preset.label} at ${extreme}`).not.toMatch(/NaN|Infinity/)
        }
      }
    }
  })

  it('falls back to a single still frame with no preset', () => {
    const frames = animationFrames(shapeWith('none'), 12)
    expect(frames).toHaveLength(1)
  })
})

describe('animating the shape itself', () => {
  const MOVING_SHAPES = SHAPE_ANIMATIONS.filter((preset) => preset.id !== 'none')

  /** The same object with a shape preset chosen. */
  const withShape = (id: ShapePreset): TypographyObject => {
    const object = shapeWith('none')
    return {
      ...object,
      animation: {
        ...object.animation,
        shapePreset: id,
        shapeConfig: defaultShapeConfig(id),
      },
    }
  }

  it('leaves the container alone when set to none', () => {
    for (const frame of animationFrames(shapeWith('bounce'), 6)) {
      expect(frame.shapePath).toBeNull()
    }
  })

  it('gives every shape preset something visible to do', () => {
    // A menu entry that changes nothing is the same trap as a dead slider.
    for (const preset of MOVING_SHAPES) {
      const frames = animationFrames(withShape(preset.id), 6)
      const distinct = new Set(frames.map((f) => `${f.shapePath}|${f.shapeFill}`))
      expect(distinct.size, `${preset.label} does not animate the shape`).toBeGreaterThan(1)
    }
  })

  it('drives the type through the deformed shape', () => {
    // The point of the whole feature: the shape's form reaches the type inside
    // it. If the container moved while the type sat still, these would match.
    for (const preset of MOVING_SHAPES) {
      const frames = animationFrames(withShape(preset.id), 6)
      const paths = new Set(frames.map((f) => f.path))
      expect(paths.size, `${preset.label} does not move the type with it`).toBeGreaterThan(1)
    }
  })

  it('closes its loop', () => {
    for (const preset of MOVING_SHAPES) {
      const object = withShape(preset.id)
      const source = prepareFrames(object)
      if (!source) continue
      const at = (phase: number) => frameAt(object, source, phase)
      expect(at(0).shapePath, `${preset.label} does not close its loop`).toBe(at(1).shapePath)
      expect(at(0).path, `${preset.label} does not close its loop`).toBe(at(1).path)
    }
  })

  it('leaves the outline untouched at rest', () => {
    // A preset at zero amount must give back the shape the user drew, not a
    // near-miss: this is what proves the subdivision and the mapping are exact
    // rather than merely close.
    const object = withShape('pulse')
    const source = prepareFrames(object)
    if (!source) throw new Error('no layout')
    const still = frameAt(
      { ...object, animation: { ...object.animation, shapeConfig: { amount: 0 } } },
      source,
      0.25,
    )
    const before = pathBounds(SHAPE)
    const after = pathBounds(still.shapePath!)
    expect(after.x).toBeCloseTo(before.x, 1)
    expect(after.y).toBeCloseTo(before.y, 1)
    expect(after.width).toBeCloseTo(before.width, 1)
    expect(after.height).toBeCloseTo(before.height, 1)
  })

  it('keeps the text exact however the shape is deformed', () => {
    for (const preset of MOVING_SHAPES) {
      const object = withShape(preset.id)
      const fitted = fitObject(object)
      if (!fitted.ok || !fitted.layout) continue
      const texts = fitted.layout.lines.map((line) => line.characters.join(''))
      expect(verifyExactText(TEXT, texts, 'word').ok, preset.label).toBe(true)
    }
  })

  it('emits no non-finite geometry at either end of every control', () => {
    for (const preset of MOVING_SHAPES) {
      for (const extreme of ['min', 'max'] as const) {
        const config: Record<string, number | string> = {}
        for (const control of preset.controls) {
          config[control.key] = control.kind === 'number' ? control[extreme] : control.value
        }
        const object = withShape(preset.id)
        const frames = animationFrames(
          { ...object, animation: { ...object.animation, shapeConfig: config } },
          4,
        )
        for (const frame of frames) {
          expect(frame.shapePath ?? '', `${preset.label} at ${extreme}`).not.toMatch(/NaN|Infinity/)
          expect(frame.path, `${preset.label} at ${extreme}`).not.toMatch(/NaN|Infinity/)
        }
      }
    }
  })

  it('can be told to leave the type alone', () => {
    // For a shape that FRAMES the words rather than holding them: the container
    // moves and the type keeps its place.
    const object = withShape('jelly')
    const held = {
      ...object,
      animation: { ...object.animation, shapeAffectsText: false },
    }
    const frames = animationFrames(held, 6)
    // The shape still moves...
    expect(new Set(frames.map((f) => f.shapePath)).size).toBeGreaterThan(1)
    // ...and the type does not.
    expect(new Set(frames.map((f) => f.path)).size).toBe(1)
    // Which is the still artwork, unchanged.
    const still = fitObject(object)
    expect(still.ok && frames[0]!.path).toBe(still.ok && still.path)
  })

  it('composes with a type preset rather than replacing it', () => {
    // Both menus at once: the shape jellies while the letters bounce.
    const object = withShape('jelly')
    const both = animationFrames({ ...object, animation: { ...object.animation, preset: 'bounce' } }, 6)
    expect(new Set(both.map((f) => f.path)).size).toBeGreaterThan(1)
    expect(new Set(both.map((f) => f.shapePath)).size).toBeGreaterThan(1)
  })
})

describe('the sweep', () => {
  it('moves the deformers, and comes back', () => {
    const preset = animationById('sweep')
    const config = { amount: 0.25 }
    expect(preset.frame(config, 0.25, 7).deformerShift).toBeGreaterThan(0)
    expect(preset.frame(config, 0, 7).deformerShift).toBeCloseTo(
      preset.frame(config, 1, 7).deformerShift,
      9,
    )
  })

  it('grips a shape with no deformers of its own', () => {
    // Sweep works by shifting vertical deformers. On a shape that has none it
    // grips an implicit one at the centre — otherwise choosing the preset would
    // appear to do nothing until you had discovered deformers and added one.
    const frames = animationFrames(shapeWith('sweep', { amount: 0.25 }), 6)
    expect(new Set(frames.map((f) => f.path)).size).toBeGreaterThan(1)
  })
})

describe('the line offset every preset carries', () => {
  it('is offered by every moving preset', () => {
    // Shared rather than written out per preset, so none can be forgotten and
    // they all name it the same thing.
    for (const preset of MOVING) {
      expect(
        preset.controls.some((control) => control.key === 'lineOffset'),
        preset.label,
      ).toBe(true)
    }
    expect(animationById('none').controls).toHaveLength(0)
  })

  it('leaves every line together at zero', () => {
    expect(linePhase({ lineOffset: 0 }, 0.3, 0, 4)).toBe(0.3)
    expect(linePhase({ lineOffset: 0 }, 0.3, 3, 4)).toBe(0.3)
  })

  it('spreads the lines evenly around the loop at full offset', () => {
    // Divided by the line count, so one full travelling wave crosses the block
    // whether there are two lines or nine. A fixed delay would do nothing at all
    // on a short shape and blur into noise on a tall one.
    expect(linePhase({ lineOffset: 1 }, 0, 1, 4)).toBeCloseTo(-0.25, 9)
    expect(linePhase({ lineOffset: 1 }, 0, 1, 8)).toBeCloseTo(-0.125, 9)
  })

  it('does nothing to a single line', () => {
    expect(linePhase({ lineOffset: 1 }, 0.3, 0, 1)).toBe(0.3)
  })

  it('changes the artwork, and still closes the loop', () => {
    for (const preset of CARRIED) {
      const config = { ...defaultConfig(preset.id), lineOffset: 0.6 }
      const together = animationFrames(shapeWith(preset.id), 6).map((f) => f.path)
      const staggered = animationFrames(shapeWith(preset.id, config), 6).map((f) => f.path)
      expect(staggered, `${preset.label} ignores the line offset`).not.toEqual(together)

      const object = shapeWith(preset.id, config)
      const source = prepareFrames(object)
      if (!source) continue
      expect(frameAt(object, source, 0).path, `${preset.label} does not close its loop`).toBe(
        frameAt(object, source, 1).path,
      )
    }
  })

  it('keeps the text exact however far the lines are offset', () => {
    const object = shapeWith('wave', { ...defaultConfig('wave'), lineOffset: 1 })
    const fitted = fitObject(object)
    expect(fitted.ok).toBe(true)
    if (!fitted.ok || !fitted.layout) return
    const texts = fitted.layout.lines.map((line) => line.characters.join(''))
    expect(verifyExactText(TEXT, texts, 'word').ok).toBe(true)
  })
})

describe('preset definitions', () => {
  it('gives every preset a default for each of its controls', () => {
    for (const preset of ANIMATIONS) {
      const config = defaultConfig(preset.id)
      for (const control of preset.controls) {
        expect(config[control.key], `${preset.label}/${control.key}`).toBe(control.value)
        if (control.kind === 'colour') {
          expect(control.value, `${preset.label}/${control.key}`).toMatch(/^#[0-9a-f]{6}$/i)
        } else if (control.kind === 'choice') {
          // A choice has to start on one of the things it offers.
          expect(control.options.map((o) => o.value)).toContain(control.value)
        } else {
          expect(control.value).toBeGreaterThanOrEqual(control.min)
          expect(control.value).toBeLessThanOrEqual(control.max)
        }
      }
    }
  })

  it('falls back to the still preset for an unknown id', () => {
    expect(animationById('nonsense' as AnimationPreset).id).toBe('none')
  })

  it('starts a new document still', () => {
    expect(createEmptyDocument().defaults.animation.preset).toBe('none')
    expect(createEmptyDocument().defaults.animation.textColour.effect).toBe('none')
  })

  it('moves spiral text with every preset, not just some of them', () => {
    /*
     * Half the picker used to be dead in spiral mode.
     *
     * The spiral is not drawn through the patch, so the frame terms that reach
     * block text through the warp field — the wave, the boil's noise, the sway's
     * shear — reached nothing at all, and the sweep's deformer shift had no rows
     * to move. Wave, boil, sway and sweep could all be chosen, showed their
     * sliders, and did nothing whatever to the artwork.
     *
     * Checked by rendering: a preset that leaves the path byte-identical across
     * the loop is not animating anything, whatever its settings say.
     */
    const fitted = fitTextToShape({
      text: TEXT,
      shapePath: SHAPE,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: documentDefaults.typography.lineSpacing,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'ring',
    turns: 'many',
      seed: 5,
    } as Parameters<typeof fitTextToShape>[0])
    expect(fitted.ok).toBe(true)
    if (!fitted.ok) return

    for (const preset of CARRIED) {
      const config = defaultConfig(preset.id)
      const frames = [0, 0.25, 0.5, 0.75].map((phase) =>
        renderFrame(fitted.layout!, (line, count) =>
          preset.frame(config, linePhase(config, phase, line, count), 5),
        ),
      )
      expect(new Set(frames).size, `${preset.label} does nothing to spiral text`).toBeGreaterThan(1)
      for (const frame of frames) expect(frame.length, preset.label).toBeGreaterThan(0)
    }
  })

  it('shakes spiral letters off the run, never along it', () => {
    /*
     * There is nowhere along a spiral for a letter to go. The slots are laid end
     * to end at `gap: 0`, so the letters are already touching, and jitter's
     * sideways component slid them far enough to break the words apart while
     * their neighbours stayed put. Off the line there is room, and the shake
     * survives there as a shimmer.
     */
    const fitted = fitTextToShape({
      text: TEXT,
      shapePath: SHAPE,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: documentDefaults.typography.lineSpacing,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'ring',
    turns: 'many',
      seed: 5,
    } as Parameters<typeof fitTextToShape>[0])
    expect(fitted.ok).toBe(true)
    if (!fitted.ok) return

    const sideways = animationById('jitter').frame(defaultConfig('jitter'), 0.3, 5)
    const offset = sideways.letterOffset
    expect(offset).toBeTruthy()
    // The preset itself does offer a sideways component...
    expect(Math.abs(offset!(3).x)).toBeGreaterThan(0)

    // ...and it still moves the type, off the line rather than along it.
    const still = renderFrame(fitted.layout!, STATIC_FRAME)
    const shaken = renderFrame(fitted.layout!, () => sideways)
    expect(shaken).not.toBe(still)

    // Held along the run: dropping the sideways component changes nothing.
    const radial = renderFrame(fitted.layout!, () => ({
      ...sideways,
      letterOffset: (i: number) => ({ x: 0, y: offset!(i).y }),
    }))
    expect(radial).toBe(shaken)
  })

  it('leaves a still spiral exactly as the fit drew it', () => {
    // The other half: the frame terms are a DELTA. The layout carries the
    // object's own distortion settings, which are a boundary-warp control and
    // are not offered in spiral mode — folding those in here rather than only
    // the frame's would deform every spiral that is not animating at all.
    const fitted = fitTextToShape({
      text: TEXT,
      shapePath: SHAPE,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: documentDefaults.typography.lineSpacing,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'ring',
    turns: 'many',
      distortion: { ...documentDefaults.distortion },
      seed: 5,
    } as Parameters<typeof fitTextToShape>[0])
    expect(fitted.ok).toBe(true)
    if (!fitted.ok) return
    expect(renderFrame(fitted.layout!, STATIC_FRAME)).toBe(fitted.path)
  })

  it('carries no colour among the motion presets', () => {
    // Colour has its own tab. While it was a motion preset a sticker could
    // shimmer or bounce but never both.
    for (const preset of ANIMATIONS) {
      expect(preset.controls.every((c) => c.kind === 'number'), preset.label).toBe(true)
    }
  })
})

/** The Loop length slider's own range, from `AnimatePanel`. */
const LOOP_MIN = 1
const LOOP_MAX = 30

describe('the loop a preset starts with', () => {
  /*
   * Loop length is half of how fast an animation looks — the other half is
   * whatever the preset's own control says — and one default cannot serve every
   * preset. A boil or a jitter is a texture, and a couple of seconds is a
   * shimmer. Travel is not a texture: it carries the words the whole way round
   * the shape, so the loop length IS the reading speed, and the same couple of
   * seconds puts a sentence past faster than anyone can take it in.
   */
  it('gives travel a long one and leaves the wobbles alone', () => {
    const fallback = documentDefaults.animation.loopDuration
    expect(defaultLoop('travel', fallback), 'long enough to read').toBeGreaterThan(8)
    for (const id of ['boil', 'jitter', 'bounce', 'pop', 'wave'] as const) {
      expect(defaultLoop(id, fallback), id).toBe(fallback)
    }
  })

  it('keeps every declared loop inside the slider that has to reach it', () => {
    // A default the control cannot get back to is a trap: pick the preset, nudge
    // the slider, and the value you started from is gone.
    for (const preset of ANIMATIONS) {
      const loop = defaultLoop(preset.id, documentDefaults.animation.loopDuration)
      expect(loop, `${preset.id} above the floor`).toBeGreaterThanOrEqual(LOOP_MIN)
      expect(loop, `${preset.id} below the ceiling`).toBeLessThanOrEqual(LOOP_MAX)
    }
  })
})
