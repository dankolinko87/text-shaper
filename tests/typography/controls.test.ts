import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { beforeAll, describe, expect, it } from 'vitest'

import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { measureInkExtent, registerFont } from '../../src/typography/fontRegistry'
import { packLine } from '../../src/typography/packLine'
import type { DistortionSettings } from '../../src/types/document'

const FONT_ID = 'anton'
const SHAPE = 'M60 60 L940 60 L940 740 L60 740 Z'

beforeAll(() => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
})

function fit(letterSpacing: number, distortion: Partial<DistortionSettings> = {}) {
  const r = fitTextToShape({
    text: 'RONESHA IS THE VERY BEST OF ALL',
    shapePath: SHAPE,
    fontId: FONT_ID,
    flowMode: 'word',
    lineSpacing: 1.14,
    letterSpacing,
    quality: 'final',
    fittingMode: 'boundary-warp',
    distortion: { ...defaultDistortionSettings, ...distortion },
    seed: 1,
  })
  if (!r.ok) throw new Error(`fit failed: ${r.reason}`)
  return r
}

describe('letter spacing', () => {
  it('changes the packed layout', () => {
    // The regression: letter spacing was threaded only into `renderLine`, the
    // line-stretch path. Warp and Glyph both go through `packLine`, which never
    // received it — so the control was completely inert in the two modes anyone
    // actually uses, producing byte-identical output at every setting.
    const tight = fit(-0.05).path
    const none = fit(0).path
    const loose = fit(0.3).path

    expect(tight).not.toBe(none)
    expect(loose).not.toBe(none)
  })

  it('widens the gap between characters as it rises', () => {
    // Measured between the DRAWN edges: one character's right ink edge to the
    // next character's left ink edge. Slot pitch is no use here — the slots
    // tile the span by construction, so it barely moves whatever the tracking.
    const meanGap = (letterSpacing: number): number => {
      const chars = Array.from('RONESHA')
      const slots = packLine(chars, {
        fontId: FONT_ID,
        x0: 0,
        x1: 900,
        bandTop: 0,
        bandBottom: 300,
        gap: 0.14,
        letterSpacing,
        variation: 0,
        verticalFill: 1,
        seed: 1,
      })
      const edges = slots.map((s) => {
        const ink = measureInkExtent(FONT_ID, chars[s.index] ?? '')
        return { left: s.x + ink.left * s.scaleX, right: s.x + ink.right * s.scaleX }
      })
      let total = 0
      let n = 0
      for (let i = 1; i < edges.length; i++) {
        const prev = edges[i - 1]
        const cur = edges[i]
        if (!prev || !cur) continue
        total += cur.left - prev.right
        n++
      }
      return n > 0 ? total / n : 0
    }

    expect(meanGap(0.3)).toBeGreaterThan(meanGap(0))
    expect(meanGap(0)).toBeGreaterThan(meanGap(-0.05))
  })

  it('stays finite at the extremes of its range', () => {
    for (const ls of [-0.05, 0, 0.4]) {
      expect(fit(ls).path).not.toMatch(/NaN|Infinity/)
    }
  })
})

describe('width variation', () => {
  it('spreads character widths further as it rises', () => {
    const spread = (variation: number): number => {
      const chars = Array.from('RONESHA')
      const slots = packLine(chars, {
        fontId: FONT_ID,
        x0: 0,
        x1: 900,
        bandTop: 0,
        bandBottom: 300,
        gap: 0.14,
        letterSpacing: 0,
        variation,
        verticalFill: 1,
        seed: 3,
      })
      const widths = slots
        .filter((s) => !s.blank)
        .map((s) => measureInkExtent(FONT_ID, chars[s.index] ?? '').width * s.scaleX)
      return Math.max(...widths) / Math.min(...widths)
    }

    // At full strength one character should be several times its neighbour.
    expect(spread(1)).toBeGreaterThan(3)
    expect(spread(1)).toBeGreaterThan(spread(0.5))
    expect(spread(0.5)).toBeGreaterThan(spread(0))
  })

  it('never drives a character to nothing', () => {
    const chars = Array.from('RONESHA IS THE BEST')
    const slots = packLine(chars, {
      fontId: FONT_ID,
      x0: 0,
      x1: 900,
      bandTop: 0,
      bandBottom: 300,
      gap: 0.14,
      letterSpacing: 0,
      variation: 1,
      verticalFill: 1,
      seed: 9,
    })
    for (const slot of slots) {
      expect(Number.isFinite(slot.x)).toBe(true)
      expect(slot.scaleX).toBeGreaterThan(0)
    }
  })
})

describe('line height variation', () => {
  it('has a range you can actually see', () => {
    // It used to blend only as far as each line's own aspect height. Lines of
    // similar length have similar aspects, so the slider's entire travel bought
    // about 1.8% — indistinguishable from nothing.
    const spread = (vertical: number): number => {
      const sizes = fit(0, { vertical }).lines.map((l) => l.size)
      return Math.max(...sizes) / Math.min(...sizes)
    }

    expect(spread(0)).toBeLessThan(1.05)
    expect(spread(1)).toBeGreaterThan(1.6)
    expect(spread(1)).toBeGreaterThan(spread(0.5))
    expect(spread(0.5)).toBeGreaterThan(spread(0))
  })

  it('never drives a row to nothing', () => {
    const sizes = fit(0, { vertical: 1 }).lines.map((l) => l.size)
    expect(Math.min(...sizes)).toBeGreaterThan(0)
    expect(fit(0, { vertical: 1 }).path).not.toMatch(/NaN|Infinity/)
  })

  it('still works when the shape has dividers on it', () => {
    /*
     * It used not to, and the panel hid the slider because of it: a manual grid
     * set the row boundaries outright and the automatic height search was
     * skipped entirely, so this moved and nothing happened — byte-identical
     * output at 0% and 100%. Dividers deform now and take no part in the layout,
     * so the search runs as it always did.
     */
    const dividers = [
      { id: 'd1', points: [{ x: 0, y: 0.33 }, { x: 0.5, y: 0.33 }, { x: 1, y: 0.33 }] },
      { id: 'd2', points: [{ x: 0, y: 0.66 }, { x: 0.5, y: 0.66 }, { x: 1, y: 0.66 }] },
    ]
    const withGrid = (vertical: number) => {
      const r = fitTextToShape({
        text: 'RONESHA IS THE VERY BEST OF ALL',
        shapePath: SHAPE,
        fontId: FONT_ID,
        flowMode: 'word',
        lineSpacing: 1.14,
        letterSpacing: 0,
        quality: 'final',
        fittingMode: 'boundary-warp',
        distortion: { ...defaultDistortionSettings, vertical },
        seed: 1,
        dividers,
      })
      if (!r.ok) throw new Error('fit failed')
      return r
    }
    expect(withGrid(1).path).not.toBe(withGrid(0).path)
  })
})
