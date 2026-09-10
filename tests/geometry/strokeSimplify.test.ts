import { beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import type { Vec2 } from '../../src/types/document'

/**
 * How many points a drawn shape is left holding.
 *
 * A stroke arrives as several hundred samples of a hand that shakes, and what
 * should come out is a shape somebody can edit: a dozen or two points, smoothed
 * enough to look drawn on purpose. What came out instead was a wall of markers —
 * ninety-odd on a large ellipse — because the tremor filter ran with a window of
 * a FIXED number of samples.
 *
 * That is the bug these tests pin. A fixed window is a different amount of
 * smoothing depending on how big the shape is: too much on something small,
 * which shrinks it, and far too little on something large, where the node count
 * then climbs with the size of the drawing. The window is a fraction of the
 * stroke's own extent instead, so the same gesture gives the same result
 * whatever scale it is drawn at.
 */

beforeAll(async () => {
  await initClipper()
})

/** A closed stroke with real hand tremor on it, at a given size. */
function drawnBlob(radius: number): Vec2[] {
  const points: Vec2[] = []
  const samples = Math.max(200, Math.round(radius * 4))
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2
    const r =
      radius +
      radius * 0.09 * Math.sin(a * 3) +
      radius * 0.05 * Math.cos(a * 5) +
      1.5 * Math.sin(a * 37) +
      1.2 * Math.cos(a * 61)
    points.push({ x: radius * 1.5 + r * Math.cos(a), y: radius * 1.5 + r * Math.sin(a) })
  }
  return points
}

/** A drawn ellipse, the shape the fit is most easily made to ruin. */
function drawnEllipse(width: number, height: number): Vec2[] {
  const points: Vec2[] = []
  for (let i = 0; i < 800; i++) {
    const a = (i / 800) * Math.PI * 2
    points.push({
      x: 600 + (width / 2) * Math.cos(a) + Math.sin(a * 43) * 2,
      y: 600 + (height / 2) * Math.sin(a) + Math.cos(a * 51) * 2,
    })
  }
  return points
}

const nodesOf = (stroke: Vec2[]): number => {
  const result = strokeToShapePath(stroke)
  expect(result.ok).toBe(true)
  if (!result.ok) return -1
  return result.outline.subpaths.reduce((n, s) => n + s.nodes.length, 0)
}

const areaErrorOf = (stroke: Vec2[], ideal: number): number => {
  const result = strokeToShapePath(stroke)
  if (!result.ok) return Number.NaN
  return (100 * (result.area - ideal)) / ideal
}

describe('a drawn shape’s point count', () => {
  it('stays small however large the shape is drawn', () => {
    /*
     * The one that mattered. With a fixed window this climbed with the size —
     * eight points at radius 30 and ninety at radius 450 — so the bigger you
     * drew, the less editable what you got.
     */
    for (const radius of [30, 60, 200, 450]) {
      expect(nodesOf(drawnBlob(radius)), `radius ${radius}`).toBeLessThanOrEqual(24)
    }
  })

  it('does not collapse a small shape to nothing', () => {
    // The other end of the same mistake: too much smoothing eats a small shape.
    for (const radius of [30, 60]) {
      const error = areaErrorOf(drawnBlob(radius), Math.PI * radius * radius)
      expect(Math.abs(error), `radius ${radius}`).toBeLessThan(6)
    }
  })

  it('keeps a large drawing faithful while thinning it', () => {
    const radius = 450
    expect(Math.abs(areaErrorOf(drawnBlob(radius), Math.PI * radius * radius))).toBeLessThan(3)
  })
})

describe('an ellipse, which the fit can ruin', () => {
  /*
   * paper's `simplify` has a cliff: pushed a little too far it drops an ellipse
   * from seven fitted segments to five, and five cannot describe the curve — it
   * loses eleven per cent of its WIDTH while the area barely moves, so an area
   * check alone would not catch it. Measured here on both axes for that reason.
   */
  it('keeps its width and height on both a small and a large one', () => {
    for (const [w, h] of [
      [440, 280],
      [900, 600],
    ] as const) {
      const result = strokeToShapePath(drawnEllipse(w, h))
      expect(result.ok).toBe(true)
      if (!result.ok) continue

      expect(Math.abs(result.localBounds.width - w) / w, `${w}x${h} width`).toBeLessThan(0.03)
      expect(Math.abs(result.localBounds.height - h) / h, `${w}x${h} height`).toBeLessThan(0.03)
    }
  })

  it('is left with few enough points to edit', () => {
    expect(nodesOf(drawnEllipse(900, 600))).toBeLessThanOrEqual(20)
  })
})
