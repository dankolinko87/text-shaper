import { describe, expect, it } from 'vitest'

import { createEmptyDocument } from '../../src/state/defaults'
import {
  COLOUR_EFFECTS,
  alphaOf,
  colourEffectById,
  defaultColourConfig,
  formatHex,
  mixColours,
  paintAt,
  parseHex,
  sameFillPaint,
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
  if (paint.kind === 'solid') return [paint.colour]
  if (paint.kind === 'image') return []
  return paint.stops.map((stop) => stop.colour)
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
      expect(sameFillPaint(at(0), at(1)), `${effect.label} does not close its loop`).toBe(true)
    }
  })

  it('visibly changes through the loop', () => {
    for (const effect of MOVING) {
      // Every effect IS a motion: a gradient is a paint of its own now.
      const seen = new Set(
        [0, 0.2, 0.4, 0.6, 0.8].map((phase) =>
          JSON.stringify(paintAt(settings(effect.id), phase, NEAR_BLACK)),
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
      expect(sameFillPaint(paintAt(config, 0, NEAR_BLACK), paintAt(config, 1, NEAR_BLACK))).toBe(true)
    }
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
