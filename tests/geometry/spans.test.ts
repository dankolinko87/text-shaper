import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper, insetPath } from '../../src/geometry/clipper'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { calculateTextSpans, widestSpan } from '../../src/geometry/spans'

afterEach(() => {
  resetPaperScope()
})

function circlePath(cx: number, cy: number, r: number): string {
  return withPaper((scope) => {
    const c = new scope.Path.Circle({ center: [cx, cy], radius: r })
    const d = c.pathData
    c.remove()
    return d
  })
}

function donutPath(): string {
  return withPaper((scope) => {
    const outer = new scope.Path.Circle({ center: [300, 300], radius: 150 })
    const inner = new scope.Path.Circle({ center: [300, 300], radius: 70 })
    const donut = outer.subtract(inner)
    const d = donut.pathData
    donut.remove()
    return d
  })
}

function rectPath(x: number, y: number, w: number, h: number): string {
  return withPaper((scope) => {
    const r = new scope.Path.Rectangle({ from: [x, y], to: [x + w, y + h] })
    const d = r.pathData
    r.remove()
    return d
  })
}

describe('calculateTextSpans', () => {
  it('finds one span per scanline in a convex shape', () => {
    const lines = calculateTextSpans(circlePath(300, 300, 150), {
      sampleCount: 20,
      minSpanWidth: 4,
    })
    expect(lines.length).toBeGreaterThan(15)
    for (const line of lines) expect(line.spans).toHaveLength(1)
  })

  it('span widths follow the shape — widest at a circle centre', () => {
    const lines = calculateTextSpans(circlePath(300, 300, 150), {
      sampleCount: 21,
      minSpanWidth: 1,
    })
    const widths = lines.map((l) => {
      const s = widestSpan(l)
      return s ? s.x1 - s.x0 : 0
    })
    const middle = widths[Math.floor(widths.length / 2)] ?? 0
    const first = widths[0] ?? 0
    const last = widths[widths.length - 1] ?? 0
    expect(middle).toBeGreaterThan(first)
    expect(middle).toBeGreaterThan(last)
    // Widest span approaches the diameter.
    expect(middle).toBeGreaterThan(280)
    expect(middle).toBeLessThanOrEqual(300.01)
  })

  it('finds multiple spans through a concave shape', () => {
    const lines = calculateTextSpans(donutPath(), { sampleCount: 21, minSpanWidth: 1 })
    // The scanline through the middle must cross the hole, giving two spans.
    const multi = lines.filter((l) => l.spans.length === 2)
    expect(multi.length).toBeGreaterThan(0)
  })

  it('drops spans too narrow to hold readable type', () => {
    const lines = calculateTextSpans(circlePath(300, 300, 150), {
      sampleCount: 40,
      minSpanWidth: 100,
    })
    for (const line of lines) {
      for (const span of line.spans) expect(span.x1 - span.x0).toBeGreaterThanOrEqual(100)
    }
  })

  it('returns nothing for empty input', () => {
    expect(calculateTextSpans('')).toEqual([])
  })
})

describe('insetPath', () => {
  beforeAll(async () => {
    await initClipper()
  })

  it('insets a rectangle by the padding on every side', () => {
    const result = insetPath(rectPath(0, 0, 200, 100), 20)
    expect(result.collapsed).toBe(false)
    expect(result.path).not.toBeNull()
    if (!result.path) return

    const bounds = withPaper((scope) => {
      const item = new scope.CompoundPath(result.path as string)
      const b = { x: item.bounds.x, y: item.bounds.y, w: item.bounds.width, h: item.bounds.height }
      item.remove()
      return b
    })
    expect(bounds.x).toBeCloseTo(20, 0)
    expect(bounds.y).toBeCloseTo(20, 0)
    expect(bounds.w).toBeCloseTo(160, 0)
    expect(bounds.h).toBeCloseTo(60, 0)
  })

  it('reports collapse when padding exceeds half the shape', () => {
    const result = insetPath(rectPath(0, 0, 100, 100), 60)
    expect(result.collapsed).toBe(true)
    expect(result.path).toBeNull()
  })

  it('is a no-op at zero padding', () => {
    const data = rectPath(0, 0, 100, 100)
    const result = insetPath(data, 0)
    expect(result.collapsed).toBe(false)
    expect(result.path).toBe(data)
  })

  it('preserves a hole when insetting a donut', () => {
    const result = insetPath(donutPath(), 10)
    expect(result.collapsed).toBe(false)
    if (!result.path) return
    const area = withPaper((scope) => {
      const item = new scope.CompoundPath(result.path as string)
      const a = Math.abs(item.area)
      item.remove()
      return a
    })
    // Inset outer radius 140, inset hole radius 80 -> the hole must still be
    // subtracted, so the area stays well below the solid disc.
    expect(area).toBeLessThan(Math.PI * 140 * 140 * 0.85)
    expect(area).toBeGreaterThan(0)
  })
})
