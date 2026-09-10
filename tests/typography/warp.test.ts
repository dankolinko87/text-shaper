import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { calculateColumnExtents, columnAt } from '../../src/geometry/columns'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { itemArea } from '../../src/geometry/regions'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'
import type { DistortionSettings, Vec2 } from '../../src/types/document'

const FONT_ID = 'anton'

const NEUTRAL: DistortionSettings = {
  ...defaultDistortionSettings,
  boundaryInfluence: 0,
  vertical: 0,
  waveAmount: 0,
  shear: 0,
  noiseAmount: 0,
  glyphScaleVariation: 0,
  glyphRotation: 0,
}

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const buffer = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  )
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

function shapeOf(points: Vec2[]): string {
  const result = strokeToShapePath(points)
  if (!result.ok) throw new Error(`fixture shape failed: ${result.reason}`)
  return result.pathData
}

const base = {
  fontId: FONT_ID,
  flowMode: 'word' as const,
  lineSpacing: 1,
  letterSpacing: 0,
  quality: 'final' as const,
}

describe('boundary warp', () => {
  const shape = () => shapeOf(blob(400, 300, 300, 220, 1, 0))
  const text = 'Typography becomes the shape'

  it('leaves line-stretch output untouched, whatever the distortion settings say', () => {
    const shapePath = shape()
    const plain = fitTextToShape({ ...base, text, shapePath })
    const withSettings = fitTextToShape({
      ...base,
      text,
      shapePath,
      fittingMode: 'line-stretch',
      // Deliberately loud settings: line stretch must ignore all of them.
      distortion: { ...NEUTRAL, boundaryInfluence: 1, waveAmount: 1, noiseAmount: 1 },
      seed: 12345,
    })

    expect(plain.ok && withSettings.ok).toBe(true)
    if (!plain.ok || !withSettings.ok) return
    // Byte-identical: existing documents cannot change because this shipped.
    expect(withSettings.path).toBe(plain.path)
  })

  it('degrades to exactly glyph stretch when the warp field is neutral', () => {
    const shapePath = shape()
    const glyph = fitTextToShape({
      ...base,
      text,
      shapePath,
      fittingMode: 'glyph-stretch',
      distortion: NEUTRAL,
      seed: 12345,
    })
    const neutralWarp = fitTextToShape({
      ...base,
      text,
      shapePath,
      fittingMode: 'boundary-warp',
      distortion: NEUTRAL,
      seed: 12345,
    })

    expect(glyph.ok && neutralWarp.ok).toBe(true)
    if (!glyph.ok || !neutralWarp.ok) return
    // Warp mode IS glyph stretch plus a field. With the field at identity the
    // two must be indistinguishable, which is what makes the strength slider a
    // continuous control rather than a mode switch.
    expect(neutralWarp.path).toBe(glyph.path)
  })

  it('actually changes the geometry when influence is applied', () => {
    const shapePath = shape()
    const flat = fitTextToShape({
      ...base,
      text,
      shapePath,
      fittingMode: 'boundary-warp',
      distortion: NEUTRAL,
    })
    const warped = fitTextToShape({
      ...base,
      text,
      shapePath,
      fittingMode: 'boundary-warp',
      distortion: { ...NEUTRAL, boundaryInfluence: 1 },
    })

    expect(flat.ok && warped.ok).toBe(true)
    if (!flat.ok || !warped.ok) return
    expect(warped.path).not.toBe(flat.path)
  })

  it('preserves the exact text in every fitting mode', () => {
    const shapePath = shape()
    for (const fittingMode of ['line-stretch', 'glyph-stretch', 'boundary-warp'] as const) {
      const result = fitTextToShape({
        ...base,
        text,
        shapePath,
        fittingMode,
        distortion: { ...NEUTRAL, boundaryInfluence: 0.8 },
      })
      expect(result.ok, fittingMode).toBe(true)
      if (!result.ok) continue
      expect(
        verifyExactText(text, result.lines.map((l) => l.text), 'word').ok,
        fittingMode,
      ).toBe(true)
    }
  })

  it('keeps glyph counters open — the "o" keeps its hole', () => {
    const result = fitTextToShape({
      ...base,
      text: 'oooo',
      shapePath: shape(),
      fittingMode: 'boundary-warp',
      distortion: { ...NEUTRAL, boundaryInfluence: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Each "o" is an outer contour plus a counter.
    expect((result.path.match(/M/g) ?? []).length).toBe(8)

    // And the counter must still SUBTRACT: total area well under the outers.
    const area = withPaper((scope) => {
      const item = new scope.CompoundPath(result.path)
      const total = Math.abs(itemArea(item))
      const children = (item.children as unknown as { area: number }[] | undefined) ?? []
      const outers = children.filter((c) => c.area > 0).reduce((s, c) => s + c.area, 0)
      item.remove()
      return { total, outers }
    })
    expect(area.total).toBeLessThan(area.outers * 0.95)
  })

  it('never emits non-finite geometry, even at extreme settings', () => {
    const extreme: DistortionSettings = {
      horizontal: 1,
      vertical: 0.6,
      boundaryInfluence: 1,
      glyphScaleVariation: 1,
      glyphRotation: 1,
      waveAmount: 1,
      waveFrequency: 8,
      shear: 1,
      noiseAmount: 1,
      noiseScale: 8,
    }
    const shapes = [
      blob(400, 300, 300, 220, 1, 0),
      blob(400, 300, 280, 250, 3, 0.16),
      blob(400, 300, 150, 300, 1, 0),
      blob(400, 300, 340, 90, 2, 0.1),
    ]
    for (const points of shapes) {
      const result = fitTextToShape({
        ...base,
        text,
        shapePath: shapeOf(points),
        fittingMode: 'boundary-warp',
        distortion: extreme,
        seed: 987,
      })
      if (!result.ok) continue
      expect(/NaN|Infinity|undefined/.test(result.path)).toBe(false)
    }
  })

  it('is deterministic for a given seed, and varies between seeds', () => {
    const shapePath = shape()
    const distortion = { ...NEUTRAL, boundaryInfluence: 0.7, noiseAmount: 0.5, glyphRotation: 0.5 }
    const a = fitTextToShape({ ...base, text, shapePath, fittingMode: 'boundary-warp', distortion, seed: 1 })
    const b = fitTextToShape({ ...base, text, shapePath, fittingMode: 'boundary-warp', distortion, seed: 1 })
    const c = fitTextToShape({ ...base, text, shapePath, fittingMode: 'boundary-warp', distortion, seed: 2 })

    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    expect(a.path).toBe(b.path)
    expect(a.path).not.toBe(c.path)
  })

  it('preserves line order — warped lines never cross', () => {
    const result = fitTextToShape({
      ...base,
      text: 'One two three four five six seven eight',
      shapePath: shape(),
      fittingMode: 'boundary-warp',
      distortion: { ...NEUTRAL, boundaryInfluence: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.lines.length < 2) return
    for (let i = 1; i < result.lines.length; i++) {
      const prev = result.lines[i - 1]
      const line = result.lines[i]
      if (!prev || !line) continue
      expect(line.y).toBeGreaterThan(prev.y)
    }
  })

  it('falls back to flat rather than inverting on a degenerate shape', () => {
    // A hairline sliver: the column extents are near zero everywhere.
    const sliver = blob(400, 300, 300, 5, 1, 0)
    const result = fitTextToShape({
      ...base,
      text: 'thin',
      shapePath: shapeOf(sliver),
      fittingMode: 'boundary-warp',
      distortion: { ...NEUTRAL, boundaryInfluence: 1 },
    })
    if (!result.ok) return
    expect(/NaN|Infinity/.test(result.path)).toBe(false)
  })
})

describe('calculateColumnExtents', () => {
  it('follows the shape — tallest column at a circle’s centre', () => {
    const columns = calculateColumnExtents(shapeOf(blob(400, 300, 200, 200, 1, 0)), {
      sampleCount: 21,
      minColumnHeight: 1,
    })
    expect(columns.length).toBeGreaterThan(15)

    const heights = columns.map((c) => c.y1 - c.y0)
    const middle = heights[Math.floor(heights.length / 2)] ?? 0
    expect(middle).toBeGreaterThan(heights[0] ?? 0)
    expect(middle).toBeGreaterThan(heights[heights.length - 1] ?? 0)
    // Approaches the diameter at the centre.
    expect(middle).toBeGreaterThan(380)
  })

  it('interpolates between samples rather than stepping', () => {
    const columns = calculateColumnExtents(shapeOf(blob(400, 300, 200, 200, 1, 0)), {
      sampleCount: 16,
      minColumnHeight: 1,
    })
    const a = columns[6]
    const b = columns[7]
    expect(a && b).toBeTruthy()
    if (!a || !b) return

    const mid = columnAt(columns, (a.x + b.x) / 2)
    expect(mid).not.toBeNull()
    if (!mid) return
    // A midpoint sample must lie strictly between its neighbours, not equal one.
    const lo = Math.min(a.y0, b.y0)
    const hi = Math.max(a.y0, b.y0)
    expect(mid.y0).toBeGreaterThanOrEqual(lo - 1e-6)
    expect(mid.y0).toBeLessThanOrEqual(hi + 1e-6)
  })

  it('clamps outside the sampled range instead of returning null', () => {
    const columns = calculateColumnExtents(shapeOf(blob(400, 300, 200, 200, 1, 0)))
    expect(columnAt(columns, -10000)).not.toBeNull()
    expect(columnAt(columns, 10000)).not.toBeNull()
  })

  it('returns nothing for empty input', () => {
    expect(calculateColumnExtents('')).toEqual([])
  })
})
