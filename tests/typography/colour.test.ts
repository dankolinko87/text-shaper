import { describe, expect, it } from 'vitest'

import { createEmptyDocument } from '../../src/state/defaults'
import {
  COLOUR_EFFECTS,
  alphaOf,
  colourEffectById,
  defaultColourConfig,
  formatHex,
  gradientEnds,
  mixColours,
  paintAt,
  parseHex,
  samePaint,
  stopColourAt,
  withAlpha,
  type FillPaint,
} from '../../src/typography/colour'
import type { ColourConfigValue, ColourEffect } from '../../src/types/document'

const NEAR_BLACK = '#101014'
const WARM = '#e0552f'

const settings = (
  effect: ColourEffect,
  config: Record<string, ColourConfigValue> = {},
  base: string = NEAR_BLACK,
) => ({
  effect,
  config: { ...defaultColourConfig(effect, base), ...config },
})

/** The colours a paint actually puts on the artwork, first to last. */
function coloursOf(paint: FillPaint): string[] {
  return paint.kind === 'solid' ? [paint.colour] : paint.stops.map((stop) => stop.colour)
}

describe('every colour effect', () => {
  const MOVING = COLOUR_EFFECTS.filter((effect) => effect.id !== 'none')

  it('starts on the artwork’s own colour', () => {
    // Choosing an effect must not change what the still artwork looks like —
    // otherwise picking one silently repaints the shape.
    for (const effect of MOVING) {
      const paint = paintAt(settings(effect.id), 0, NEAR_BLACK)
      expect(coloursOf(paint)[0], effect.label).toBe(NEAR_BLACK)
    }
  })

  it('closes its loop', () => {
    for (const effect of MOVING) {
      const at = (phase: number) => paintAt(settings(effect.id), phase, NEAR_BLACK)
      expect(samePaint(at(0), at(1)), `${effect.label} does not close its loop`).toBe(true)
    }
  })

  it('visibly changes through the loop, once it is asked to move', () => {
    for (const effect of MOVING) {
      // The gradient is the one effect that is an appearance in its own right,
      // so it holds still until a motion is chosen. Every other one IS a motion.
      const config: Record<string, string | number> =
        effect.id === 'gradient' ? { motion: 'sweep' } : {}
      const seen = new Set(
        [0, 0.2, 0.4, 0.6, 0.8].map((phase) =>
          JSON.stringify(paintAt(settings(effect.id, config), phase, NEAR_BLACK)),
        ),
      )
      expect(seen.size, `${effect.label} does nothing`).toBeGreaterThan(1)
    }
  })

  it('moves a NEAR-BLACK fill, which a hue rotation could not', () => {
    // The bug this replaced. Rotating a hue preserves saturation, and the stock
    // near-black has almost none: a 150-degree turn moved it four parts in 255,
    // so the effect appeared completely dead.
    const far = paintAt(settings('cycle'), 0.5, NEAR_BLACK)
    expect(far.kind).toBe('solid')
    if (far.kind !== 'solid') return
    expect(Number.parseInt(far.colour.slice(1, 3), 16)).toBeGreaterThan(0x60)
  })

  it('gives every control a default inside its own range', () => {
    for (const effect of COLOUR_EFFECTS) {
      const config = defaultColourConfig(effect.id)
      for (const control of effect.controls) {
        expect(config[control.key], `${effect.label}/${control.key}`).toEqual(control.value)
        if (control.kind === 'stops') {
          expect(control.value.length).toBeGreaterThanOrEqual(control.min)
          expect(control.value.length).toBeLessThanOrEqual(control.max)
          expect(control.value[0]?.at).toBe(0)
          expect(control.value[control.value.length - 1]?.at).toBe(1)
          for (const stop of control.value) {
            expect(stop.colour).toMatch(/^#[0-9a-f]{6}$/i)
            expect(stop.at).toBeGreaterThanOrEqual(0)
            expect(stop.at).toBeLessThanOrEqual(1)
          }
        } else if (control.kind === 'colour') {
          expect(control.value, `${effect.label}/${control.key}`).toMatch(/^#[0-9a-f]{6}$/i)
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

  it('emits usable colours at either end of every control', () => {
    for (const effect of MOVING) {
      for (const extreme of ['min', 'max'] as const) {
        const config: Record<string, ColourConfigValue> = {}
        for (const control of effect.controls) {
          config[control.key] = control.kind === 'number' ? control[extreme] : control.value
        }
        for (const phase of [0, 0.33, 0.66]) {
          for (const colour of coloursOf(paintAt({ effect: effect.id, config }, phase, NEAR_BLACK))) {
            expect(colour, `${effect.label} at ${extreme}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
          }
        }
      }
    }
  })
})

describe('flicker', () => {
  it('blinks between exactly two shades', () => {
    const shades = new Set(
      Array.from({ length: 12 }, (_, i) => {
        const paint = paintAt(settings('flicker', { beats: 3 }), i / 12, NEAR_BLACK)
        return paint.kind === 'solid' ? paint.colour : ''
      }),
    )
    expect(shades).toEqual(new Set([NEAR_BLACK, WARM]))
  })

  it('lands back on the first shade for any whole number of beats', () => {
    // A whole number of beats is the entire reason the loop closes.
    for (const beats of [1, 2, 3, 5, 8]) {
      const config = settings('flicker', { beats })
      expect(samePaint(paintAt(config, 0, NEAR_BLACK), paintAt(config, 1, NEAR_BLACK))).toBe(true)
    }
  })
})

/** The blend fraction at a point of the box, as the painters compute it. */
function blendAt(paint: FillPaint, x: number, y: number): number {
  if (paint.kind !== 'gradient') return 0
  if (paint.shape === 'radial') {
    const away = Math.hypot(x - paint.centre.x, y - paint.centre.y)
    return Math.min(1, away / Math.max(1e-6, paint.radius * Math.SQRT1_2))
  }
  const e = gradientEnds(paint.angle, paint.offset, paint.spread)
  const dx = e.x2 - e.x1
  const dy = e.y2 - e.y1
  const length = dx * dx + dy * dy || 1
  return Math.min(1, Math.max(0, ((x - e.x1) * dx + (y - e.y1) * dy) / length))
}

describe('the gradient', () => {
  it('describes its stops rather than resolving one colour', () => {
    // The editor and the GIF encoder each build their own kind of paint from
    // this. Resolving it here would leave them free to disagree.
    const paint = paintAt(settings('gradient'), 0.25, NEAR_BLACK)
    expect(paint.kind).toBe('gradient')
    if (paint.kind !== 'gradient') return
    expect(paint.stops).toEqual([
      { at: 0, colour: NEAR_BLACK },
      { at: 1, colour: WARM },
    ])
  })

  it('starts a fresh gradient on the artwork’s own colour, whatever the base', () => {
    const config = defaultColourConfig('gradient', '#336699')
    expect((config['stops'] as { colour: string }[])[0]?.colour).toBe('#336699')
    // A copy per object: the descriptor's own list is never handed out.
    expect(config['stops']).not.toBe(defaultColourConfig('gradient', '#336699')['stops'])
  })

  it('blends through every stop in order, along the axis', () => {
    const stops = [
      { at: 0, colour: '#000000' },
      { at: 0.5, colour: '#ff0000' },
      { at: 1, colour: '#ffffff' },
    ]
    const paint = paintAt(settings('gradient', { stops, angle: 0 }), 0, NEAR_BLACK)
    if (paint.kind !== 'gradient') throw new Error('expected a gradient')
    const at = (x: number) => stopColourAt(paint.stops, blendAt(paint, x, 0.5))
    expect(at(0)).toBe('#000000')
    expect(at(0.25)).toBe('#800000')
    expect(at(0.75)).toBe('#ff8080')
    expect(at(1)).toBe('#ffffff')
  })

  it('paints unsorted stops in order, and clamps a stray position', () => {
    const paint = paintAt(
      settings('gradient', {
        stops: [
          { at: 1.4, colour: '#ffffff' },
          { at: 0, colour: '#000000' },
        ],
      }),
      0,
      NEAR_BLACK,
    )
    if (paint.kind !== 'gradient') throw new Error('expected a gradient')
    expect(paint.stops.map((stop) => stop.at)).toEqual([0, 1])
    expect(paint.stops[0]?.colour).toBe('#000000')
  })

  it('still paints a config that predates stops as the picture it had', () => {
    // Between a document loading and its migration, nothing may look wrong.
    const paint = paintAt({ effect: 'gradient', config: { to: '#00ff00' } }, 0, NEAR_BLACK)
    if (paint.kind !== 'gradient') throw new Error('expected a gradient')
    expect(paint.stops).toEqual([
      { at: 0, colour: NEAR_BLACK },
      { at: 1, colour: '#00ff00' },
    ])
  })

  it('keeps the opacity of a stop, and of a cycle’s second colour', () => {
    const faded = paintAt(
      settings('gradient', {
        stops: [
          { at: 0, colour: '#000000' },
          { at: 1, colour: '#e0552f80' },
        ],
      }),
      0,
      NEAR_BLACK,
    )
    expect(coloursOf(faded)[1]).toBe('#e0552f80')
    const cycled = paintAt(settings('cycle', { to: '#e0552f80' }), 0.5, NEAR_BLACK)
    expect(coloursOf(cycled)[0]).toBe('#e0552f80')
  })

  it('offers travel only once there is a motion to travel with', () => {
    const travel = colourEffectById('gradient').controls.find((control) => control.key === 'travel')
    expect(travel?.when?.({})).toBe(false)
    expect(travel?.when?.({ motion: 'still' })).toBe(false)
    expect(travel?.when?.({ motion: 'sweep' })).toBe(true)
  })

  it('is still unless a motion is asked for', () => {
    // A gradient is an appearance first. Choosing one and setting its angle
    // should give exactly that and hold it — which used to mean finding a
    // control called Turns and taking it to zero.
    for (const shape of ['linear', 'radial']) {
      const config = settings('gradient', { shape, angle: 45 })
      for (const phase of [0.25, 0.5, 0.75, 1]) {
        expect(
          samePaint(paintAt(config, 0, NEAR_BLACK), paintAt(config, phase, NEAR_BLACK)),
          `${shape} at ${phase}`,
        ).toBe(true)
      }
    }
  })

  it('holds the angle it was given, at every angle', () => {
    // A spin overruled this: the picture came from the phase, so the angle
    // control did nothing you could see on a moving gradient.
    for (const angle of [0, 45, 120, 300]) {
      const paint = paintAt(settings('gradient', { angle }), 0, NEAR_BLACK)
      expect(paint.kind === 'gradient' && paint.shape === 'linear').toBe(true)
      if (paint.kind !== 'gradient' || paint.shape !== 'linear') return
      expect(paint.angle).toBeCloseTo(angle, 9)
    }
  })

  it('moves when a motion is asked for, and comes back', () => {
    for (const shape of ['linear', 'radial']) {
      for (const motion of ['sweep', 'hover', 'pulse']) {
        const config = settings('gradient', { shape, motion, travel: 1 })
        const start = paintAt(config, 0, NEAR_BLACK)
        // It really moves...
        const moved = [0.25, 0.5, 0.75].some(
          (phase) => !samePaint(start, paintAt(config, phase, NEAR_BLACK)),
        )
        expect(moved, `${shape}/${motion} never moves`).toBe(true)
        // ...and the loop closes on the same numbers, not merely the same look.
        expect(
          samePaint(start, paintAt(config, 1, NEAR_BLACK)),
          `${shape}/${motion} does not close`,
        ).toBe(true)
      }
    }
  })

  it('starts every motion at rest, so switching one on changes nothing yet', () => {
    // The same rule the cycle follows: phase 0 is the artwork you already had.
    for (const shape of ['linear', 'radial']) {
      const still = paintAt(settings('gradient', { shape, motion: 'still' }), 0, NEAR_BLACK)
      for (const motion of ['sweep', 'hover', 'pulse']) {
        const moving = paintAt(settings('gradient', { shape, motion, travel: 1 }), 0, NEAR_BLACK)
        expect(samePaint(still, moving), `${shape}/${motion}`).toBe(true)
      }
    }
  })

  it('moves the picture enough to see, whichever motion is chosen', () => {
    /*
     * The bug this catches is not "it does nothing" — every motion did
     * something. It is "it does so little that it reads as doing nothing".
     *
     * Hover and pulse shifted the blend by about 6% of the box against side to
     * side's 23% at the same Travel setting, a quarter as much, and were
     * reported as broken. Measured as the average change in the blend fraction
     * across the box, which is what the eye is actually judging.
     */
    const grid: [number, number][] = []
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) grid.push([i / 6, j / 6])

    for (const shape of ['linear', 'radial']) {
      for (const motion of ['sweep', 'hover', 'pulse']) {
        const config = { shape, motion, travel: 0.5, angle: 0 }
        const at = (phase: number) => paintAt(settings('gradient', config), phase, NEAR_BLACK)
        const base = grid.map(([x, y]) => blendAt(at(0), x, y))

        let strongest = 0
        for (const phase of [0.2, 0.4, 0.6, 0.8]) {
          const now = at(phase)
          const mean =
            grid.reduce((sum, [x, y], i) => sum + Math.abs(blendAt(now, x, y) - (base[i] ?? 0)), 0) /
            grid.length
          strongest = Math.max(strongest, mean)
        }
        expect(strongest, `${shape}/${motion} shifts only ${(strongest * 100).toFixed(0)}%`).toBeGreaterThan(0.08)
      }
    }
  })

  it('offers a radial shape, centred and reaching out', () => {
    const paint = paintAt(settings('gradient', { shape: 'radial' }), 0, NEAR_BLACK)
    expect(paint.kind === 'gradient' && paint.shape === 'radial').toBe(true)
    if (paint.kind !== 'gradient' || paint.shape !== 'radial') return
    expect(paint.centre.x).toBeCloseTo(0.5, 9)
    expect(paint.centre.y).toBeCloseTo(0.5, 9)
    expect(paint.radius).toBeGreaterThan(0)
  })

  it('spans the box it is given, corner to corner', () => {
    // Both ends must reach past the middle, or a diagonal gradient runs out of
    // colour before it reaches the corners.
    const flat = gradientEnds(0)
    expect(flat.x1).toBeCloseTo(0, 9)
    expect(flat.x2).toBeCloseTo(1, 9)
    expect(flat.y1).toBeCloseTo(0.5, 9)

    const diagonal = gradientEnds(45)
    expect(diagonal.x1).toBeLessThan(0.5)
    expect(diagonal.y1).toBeLessThan(0.5)
    expect(diagonal.x2).toBeGreaterThan(0.5)
    expect(diagonal.y2).toBeGreaterThan(0.5)
  })

  it('turns the same way for every angle', () => {
    const a = gradientEnds(90)
    expect(a.y2).toBeGreaterThan(a.y1)
    const b = gradientEnds(270)
    expect(b.y2).toBeLessThan(b.y1)
  })
})

describe('mixing colours', () => {
  it('lands on each end and the middle', () => {
    expect(mixColours('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixColours('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixColours('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('clamps rather than running past the ends', () => {
    expect(mixColours('#000000', '#ffffff', -2)).toBe('#000000')
    expect(mixColours('#000000', '#ffffff', 5)).toBe('#ffffff')
  })

  it('returns a malformed colour unchanged rather than throwing', () => {
    expect(mixColours('not a colour', '#ffffff', 0.5)).toBe('not a colour')
    expect(mixColours('#ffffff', 'nonsense', 0.5)).toBe('#ffffff')
  })
})

describe('effect definitions', () => {
  it('falls back to none for an unknown id', () => {
    expect(colourEffectById('nonsense' as ColourEffect).id).toBe('none')
  })

  it('treats missing settings as no effect at all', () => {
    // Objects from an older document may have none, and a crash on load would be
    // a far worse outcome than a flat colour.
    expect(paintAt(undefined, 0.5, NEAR_BLACK)).toEqual({ kind: 'solid', colour: NEAR_BLACK })
  })

  it('starts a new document with no effect', () => {
    const defaults = createEmptyDocument().defaults.animation
    expect(defaults.textColour.effect).toBe('none')
    expect(defaults.shapeColour.effect).toBe('none')
  })
})

describe('transparency', () => {
  /*
   * Six digits where six will do.
   *
   * The property that lets transparency arrive without disturbing anything: a
   * colour that was never made translucent has to come back out of every one of
   * these exactly as it went in, or every document, every render-cache key and
   * every recorded fixture changes the day the alpha channel is added.
   */
  it('leaves an opaque colour alone, in every direction', () => {
    for (const colour of [NEAR_BLACK, WARM, '#ffffff', '#000000']) {
      expect(withAlpha(colour, 1)).toBe(colour)
      expect(alphaOf(colour)).toBe(1)
      const parsed = parseHex(colour)!
      expect(formatHex(parsed[0], parsed[1], parsed[2], parsed[3])).toBe(colour)
      expect(mixColours(colour, colour, 0.5)).toBe(colour)
    }
  })

  it('reads and writes the alpha channel', () => {
    expect(alphaOf('#e0552f80')).toBeCloseTo(128 / 255, 4)
    expect(alphaOf('#e0552f00')).toBe(0)
    expect(withAlpha(WARM, 0)).toBe('#e0552f00')
    expect(withAlpha('#e0552f00', 1)).toBe(WARM)
    // Shorthand, because the hex field accepts what a person types.
    expect(parseHex('#abc')).toEqual([170, 187, 204, 255])
    expect(parseHex('#abcd')).toEqual([170, 187, 204, 221])
    expect(parseHex('nonsense')).toBeNull()
    expect(alphaOf('nonsense')).toBe(1)
  })

  /*
   * The bug that would have shipped with the control.
   *
   * `mixColours` parsed six digits and returned the colour it started from for
   * anything else — so every colour effect would have been dead on a translucent
   * fill. Not visibly broken: just a control that does nothing, which is worse.
   */
  it('carries the effects across a translucent fill', () => {
    const half = withAlpha(NEAR_BLACK, 0.5)
    const mixed = mixColours(half, WARM, 0.5)
    expect(mixed).not.toBe(half)
    // Halfway to an opaque colour is halfway to opaque.
    expect(alphaOf(mixed)).toBeCloseTo(0.75, 2)

    const painted = paintAt(settings('cycle', { to: WARM }), 0.5, half)
    expect(coloursOf(painted)[0]).not.toBe(half)
  })

  it('interpolates alpha as its own channel', () => {
    expect(alphaOf(mixColours(withAlpha(WARM, 0), WARM, 0))).toBe(0)
    expect(alphaOf(mixColours(withAlpha(WARM, 0), WARM, 1))).toBe(1)
    expect(alphaOf(mixColours(withAlpha(WARM, 0), WARM, 0.5))).toBeCloseTo(0.5, 2)
  })
})
