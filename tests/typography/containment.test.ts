import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper, insetPath } from '../../src/geometry/clipper'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { itemArea } from '../../src/geometry/regions'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'
import type { DistortionSettings, Vec2 } from '../../src/types/document'

const FONT_ID = 'anton'

beforeAll(async () => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const buffer = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  )
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

function blob(cx: number, cy: number, rx: number, ry: number, lobes: number, amp: number): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2
    const k = 1 + amp * Math.sin(a * lobes)
    pts.push({ x: cx + rx * k * Math.cos(a), y: cy + ry * k * Math.sin(a) })
  }
  return pts
}

/**
 * The fraction of the text's ink that falls outside the container.
 *
 * Computed as a real boolean subtraction rather than a bounding-box check,
 * because a bounding box would happily pass text that pokes out through a
 * concave edge while staying inside the overall extents.
 */
function escapedFraction(textPath: string, shapePath: string): number {
  if (!textPath) return 0
  return withPaper((scope) => {
    const text = new scope.CompoundPath(textPath)
    const shape = new scope.CompoundPath(shapePath)
    const total = Math.abs(itemArea(text))
    if (total === 0) {
      text.remove()
      shape.remove()
      return 0
    }
    const outside = text.subtract(shape)
    const escaped = Math.abs(itemArea(outside))
    outside.remove()
    text.remove()
    shape.remove()
    return escaped / total
  })
}

interface Case {
  name: string
  stroke: Vec2[]
  text: string
}

/**
 * The shapes and texts below include the case from the bug report: a rounded
 * blob with lowercase-heavy text full of ascenders and descenders, which is
 * what pushed the final line out through the bottom of the container.
 */
const CASES: Case[] = [
  { name: 'ellipse / sentence', stroke: blob(400, 300, 300, 220, 1, 0), text: 'Typography becomes the shape itself' },
  { name: 'ellipse / single word', stroke: blob(400, 300, 300, 220, 1, 0), text: 'BOLD' },
  { name: 'ellipse / descenders', stroke: blob(400, 300, 300, 220, 1, 0), text: 'jh gckjcvljvhkvjcv ljgclc ljhvljh ljh v jvh' },
  { name: 'blob / long text', stroke: blob(400, 300, 280, 250, 3, 0.16), text: 'The shape controls how the text is distributed but never what it says' },
  { name: 'blob / descenders', stroke: blob(420, 320, 300, 240, 2, 0.12), text: 'gjpqy jjgg ppyy qqjj gypq' },
  { name: 'tall narrow', stroke: blob(400, 300, 150, 280, 1, 0), text: 'Narrow column of set type' },
  { name: 'wide flat', stroke: blob(400, 300, 340, 120, 2, 0.08), text: 'The exact text appears once and only once' },
]

describe('text containment', () => {
  for (const testCase of CASES) {
    it(`keeps the text inside the shape — ${testCase.name}`, () => {
      const shape = strokeToShapePath(testCase.stroke)
      expect(shape.ok).toBe(true)
      if (!shape.ok) return

      const inset = insetPath(shape.pathData, 16)
      const region = inset.collapsed || !inset.path ? shape.pathData : inset.path

      const fit = fitTextToShape({
        text: testCase.text,
        shapePath: region,
        fontId: FONT_ID,
        flowMode: 'word',
        lineSpacing: 1,
        letterSpacing: 0,
        quality: 'final',
      })
      expect(fit.ok).toBe(true)
      if (!fit.ok) return

      // The text must still be exactly what was typed...
      expect(verifyExactText(testCase.text, fit.lines.map((l) => l.text), 'word').ok).toBe(true)

      // ...and it must sit inside the container it was fitted to. A small
      // tolerance allows for glyph overshoot (round letters and the tips of
      // diagonals sit fractionally outside their metric box by design).
      const escaped = escapedFraction(fit.path, shape.pathData)
      expect(escaped, `${(escaped * 100).toFixed(1)}% of ink escaped the shape`).toBeLessThan(0.02)
    })
  }

  it('keeps packed, warped text strictly inside the outline', () => {
    // The packing modes reach for the shape's full width at each line's
    // mid-line, so without the warp their lines would overhang the outline.
    // The warp maps each line into the room the shape actually leaves at every
    // column, which is what pulls those ends back in — the type meets the
    // boundary exactly instead of crossing it.
    const distortion: DistortionSettings = {
      horizontal: 0.14,
      vertical: 0,
      boundaryInfluence: 1,
      glyphScaleVariation: 0.35,
      glyphRotation: 0.8,
      waveAmount: 0,
      waveFrequency: 1,
      shear: 0,
      noiseAmount: 0,
      noiseScale: 1,
    }

    for (const testCase of CASES) {
      const shape = strokeToShapePath(testCase.stroke)
      expect(shape.ok).toBe(true)
      if (!shape.ok) continue

      const inset = insetPath(shape.pathData, 4)
      const region = inset.collapsed || !inset.path ? shape.pathData : inset.path

      const fit = fitTextToShape({
        text: testCase.text,
        shapePath: region,
        fontId: FONT_ID,
        flowMode: 'word',
        lineSpacing: 1.14,
        letterSpacing: 0,
        quality: 'final',
        fittingMode: 'boundary-warp',
        distortion,
        seed: 11,
      })
      if (!fit.ok) continue

      expect(verifyExactText(testCase.text, fit.lines.map((l) => l.text), 'word').ok).toBe(true)

      const escaped = escapedFraction(fit.path, shape.pathData)
      expect(
        escaped,
        `${testCase.name}: ${(escaped * 100).toFixed(1)}% of ink escaped the outline`,
      ).toBeLessThan(0.01)
    }
  })

  it('places every line inside the shape bounds vertically', () => {
    const shape = strokeToShapePath(blob(400, 300, 300, 220, 1, 0))
    expect(shape.ok).toBe(true)
    if (!shape.ok) return

    const fit = fitTextToShape({
      text: 'jh gckjcvljvhkvjcv ljgclc ljhvljh ljh v jvh',
      shapePath: shape.pathData,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: 1,
      letterSpacing: 0,
      quality: 'final',
    })
    expect(fit.ok).toBe(true)
    if (!fit.ok) return

    const b = shape.localBounds
    for (const line of fit.lines) {
      expect(line.y).toBeGreaterThan(b.y)
      expect(line.y).toBeLessThan(b.y + b.height)
    }
  })

  it('sizes text from real ink, not the font’s looser line box', () => {
    // Anton's line height is ~1.505em while capitals ink only ~0.875em. Sizing
    // by the line height drew text about 40% smaller than its band, which left
    // shapes looking half-empty.
    const shape = strokeToShapePath(blob(400, 300, 300, 220, 1, 0))
    expect(shape.ok).toBe(true)
    if (!shape.ok) return

    const fit = fitTextToShape({
      text: 'FILL THIS SHAPE COMPLETELY',
      shapePath: shape.pathData,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: 1,
      letterSpacing: 0,
      quality: 'final',
    })
    expect(fit.ok).toBe(true)
    if (!fit.ok) return

    const inkHeight = withPaper((scope) => {
      const item = new scope.CompoundPath(fit.path)
      const height = item.bounds.height
      item.remove()
      return height
    })
    // The ink should occupy most of the shape's height, not a token band in it.
    expect(inkHeight / shape.localBounds.height).toBeGreaterThan(0.6)
  })
})
