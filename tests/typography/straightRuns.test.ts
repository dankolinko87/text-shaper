import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { beforeAll, describe, expect, it } from 'vitest'

import { registerFont } from '../../src/typography/fontRegistry'
import { renderLine } from '../../src/typography/glyphs'
import type { WarpFn } from '../../src/typography/warp'

const FONT_ID = 'anton'

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const buffer = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  )
})

const BULGE = 60

/**
 * A field that is zero at both ends of a span and maximal in the middle.
 *
 * The span is the LETTER's own width, so the peak falls between the endpoints
 * of its arms rather than on one of them. That is what makes the test decisive:
 * a straight run emitted as its two endpoints alone passes through this field
 * completely unchanged, because both of its endpoints sit where the field is
 * zero.
 */
function bulgeAcross(x0: number, x1: number): WarpFn {
  const span = x1 - x0
  return (x, y) => ({
    x,
    y: y - BULGE * Math.sin((Math.PI * Math.min(Math.max(x - x0, 0), span)) / span),
  })
}

function extent(path: string): { x0: number; x1: number; yMin: number; yMax: number } {
  const numbers = path.match(/-?\d+(\.\d+)?/g) ?? []
  let x0 = Infinity
  let x1 = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = Number(numbers[i])
    const y = Number(numbers[i + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    yMin = Math.min(yMin, y)
    yMax = Math.max(yMax, y)
  }
  return { x0, x1, yMin, yMax }
}

function plain(text: string): string {
  return renderLine(text, {
    fontId: FONT_ID,
    size: 200,
    x: 0,
    y: 200,
    letterSpacing: 0,
    horizontalScale: 1,
  }).path
}

/** Render `text` through a bulge spanning exactly its own inked width. */
function render(text: string, divisions: number): string {
  const ink = extent(plain(text))
  const warp = bulgeAcross(ink.x0, ink.x1)
  return renderLine(text, {
    fontId: FONT_ID,
    size: 200,
    x: 0,
    y: 200,
    letterSpacing: 0,
    horizontalScale: 1,
    warp,
    maxSegment: divisions > 0 ? (ink.x1 - ink.x0) / divisions : 0,
  }).path
}

describe('straight runs under a warp field', () => {
  it('bends a letter built from straight runs', () => {
    // "E" is stems and arms: long straight segments with no interior points.
    // Warping only the points it is given left every one of those runs as a
    // straight chord across the field, so an E ignored the shape's curves
    // while a round letter followed them.
    const unsplit = extent(render('E', 0))
    const split = extent(render('E', 64))

    // The field lifts by up to BULGE, and only a point sampled between the
    // endpoints of a run can see any of it.
    expect(unsplit.yMin - split.yMin).toBeGreaterThan(BULGE * 0.5)
  })

  it('bends straight-run and curved letters by comparable amounts', () => {
    // The point of the fix: how far a letter follows the shape must depend on
    // the shape, not on how many points the typeface spent on that letter.
    // Measured as the lift each letter gains over its own unwarped position.
    const liftOf = (text: string, divisions: number): number =>
      extent(plain(text)).yMin - extent(render(text, divisions)).yMin

    expect(liftOf('E', 64)).toBeGreaterThan(BULGE * 0.6)
    expect(Math.abs(liftOf('E', 64) - liftOf('O', 64))).toBeLessThan(BULGE * 0.35)

    // Before the fix the two letters diverged sharply, because only the round
    // one had interior points for the field to act on.
    expect(liftOf('O', 0) - liftOf('E', 0)).toBeGreaterThan(BULGE * 0.4)
  })

  it('leaves output unchanged when no field is active', () => {
    const withBudget = renderLine('E', {
      fontId: FONT_ID,
      size: 200,
      x: 0,
      y: 200,
      letterSpacing: 0,
      horizontalScale: 1,
      maxSegment: 20,
    }).path
    const noBudget = renderLine('E', {
      fontId: FONT_ID,
      size: 200,
      x: 0,
      y: 200,
      letterSpacing: 0,
      horizontalScale: 1,
    }).path

    expect(withBudget).toBe(noBudget)
  })

  it('emits no non-finite coordinates when splitting', () => {
    expect(render('EFHLT', 64)).not.toMatch(/NaN|Infinity/)
  })
})
