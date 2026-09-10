import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope, pathBounds, smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { runAt, runToPath } from '../../src/geometry/run'
import { buildSpiral, type Spiral } from '../../src/geometry/spiral'
import type { Vec2 } from '../../src/types/document'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const TRIANGLE = PRIMITIVES.find((p) => p.id === 'triangle')!.build(680, 600)
/**
 * Something hand-drawn: lopsided, but smooth all the way round.
 *
 * Smoothed from a rough polygon rather than written by hand — a closed path
 * whose last segment meets its first at an angle has a corner in it, and a
 * corner is the thing the smoothness tests are trying not to measure.
 */
const BLOB = smoothPath(
  'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
)

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/** How far a point sits from a path. */
function distanceToPath(data: string, point: Vec2): number {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const children = (item as unknown as { children?: { getNearestPoint(p: unknown): Vec2 }[] })
      .children
    const target =
      children && children.length > 0
        ? children[0]!
        : (item as unknown as { getNearestPoint(p: unknown): Vec2 })
    const near = target.getNearestPoint(new scope.Point(point.x, point.y))
    item.remove()
    return distance(point, near)
  })
}

/**
 * The tightest heading change along the run, as a dot product.
 *
 * 1 is dead straight, 0 is a right-angle turn, negative is doubling back.
 *
 * Measured over a LETTER'S WIDTH rather than between neighbouring samples. The
 * clipper returns each offset as a polygon, so at the innermost turns — where a
 * sample step is a third of a unit — the heading flicks by degrees at every
 * facet corner. That is real, and it is also invisible: what decides whether
 * type shears is how far the heading moves across a whole glyph.
 */
function sharpestTurn(spiral: Spiral, step = 10): number {
  let worst = 1
  for (let s = step; s < spiral.total; s += step) {
    const a = runAt(spiral, s - step).tangent
    const b = runAt(spiral, s).tangent
    worst = Math.min(worst, a.x * b.x + a.y * b.y)
  }
  return worst
}

/**
 * Arc length of the outermost turn.
 *
 * The run holds the same number of samples per turn, so the first turn ends at
 * the sample index one turn in.
 */
function firstTurnLength(spiral: Spiral): number {
  const perTurn = Math.round((spiral.points.length - 1) / spiral.turns)
  return spiral.distances[perTurn] as number
}

/** The largest jump between consecutive samples of the run. */
function biggestStep(spiral: Spiral): number {
  let worst = 0
  for (let i = 1; i < spiral.points.length; i++) {
    worst = Math.max(worst, distance(spiral.points[i - 1] as Vec2, spiral.points[i] as Vec2))
  }
  return worst
}

describe('winding a shape inward', () => {
  it('makes a run out of every primitive shape', () => {
    for (const primitive of PRIMITIVES) {
      const spiral = buildSpiral({ shapePath: primitive.build(680, 600), pitch: 40 })
      expect(spiral, primitive.label).not.toBeNull()
      expect(spiral!.turns, primitive.label).toBeGreaterThan(0)
      expect(spiral!.total, primitive.label).toBeGreaterThan(100)
    }
  })

  it('joins its turns without a jump — the whole risk of a spiral', () => {
    // Offsetting does not preserve where a path begins: on an ellipse the
    // outline starts at (-340, 0) and its first offset at (16, -260), so turns
    // joined as they arrive fling the text 440 units across the shape. A run
    // that never steps further than its own pitch has no such seam in it.
    for (const [label, shape] of [
      ['ellipse', ELLIPSE],
      ['triangle', TRIANGLE],
      ['blob', BLOB],
    ] as const) {
      const spiral = buildSpiral({ shapePath: shape, pitch: 40 })!
      expect(biggestStep(spiral), `${label} jumps at a seam`).toBeLessThan(spiral.pitch)
    }
  })

  it('moves inward by one pitch per turn', () => {
    // What makes it a spiral rather than a ring: after one full turn the run is
    // a pitch further in, not back where it started.
    //
    // Measured against the FIRST turn's own length, not the average. Outer
    // turns are much longer than inner ones — on this ellipse the outermost is
    // about twice the mean — so an average would land barely half way round.
    const spiral = buildSpiral({ shapePath: ELLIPSE, pitch: 40 })!
    const perTurn = spiral.total / spiral.turns
    const firstTurn = firstTurnLength(spiral)
    expect(firstTurn).toBeGreaterThan(perTurn)

    const start = runAt(spiral, 0).point
    const gap = distance(start, runAt(spiral, firstTurn).point)
    expect(gap).toBeGreaterThan(spiral.pitch * 0.5)
    expect(gap).toBeLessThan(spiral.pitch * 1.6)
  })

  it('keeps every point inside the shape it came from', () => {
    const bounds = pathBounds(BLOB)
    const spiral = buildSpiral({ shapePath: BLOB, pitch: 30 })!
    for (const p of spiral.points) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.x - 1)
      expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
      expect(p.y).toBeGreaterThanOrEqual(bounds.y - 1)
      expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1)
    }
  })

  it('lays its first turn on the outline the user drew', () => {
    // The outermost turn is the shape itself, wobbles and all — not a tidied
    // circle fitted to it. Checked against the OUTLINE rather than the bounding
    // box: a drawn shape rarely starts at one of its own extremes, so a start
    // point far from the box can still be exactly on the path.
    const spiral = buildSpiral({ shapePath: BLOB, pitch: 30 })!
    const perTurn = Math.round(spiral.points.length / spiral.turns)
    for (let i = 0; i < perTurn; i += 40) {
      const p = spiral.points[i] as Vec2
      // Drifting inward as it goes, so only the very start is exactly on it.
      const allowance = 1 + (i / perTurn) * spiral.pitch
      expect(distanceToPath(BLOB, p)).toBeLessThan(allowance)
    }
  })

  it('winds tighter as the pitch narrows', () => {
    const wide = buildSpiral({ shapePath: ELLIPSE, pitch: 80 })!
    const tight = buildSpiral({ shapePath: ELLIPSE, pitch: 20 })!
    expect(tight.turns).toBeGreaterThan(wide.turns)
    expect(tight.total).toBeGreaterThan(wide.total)
  })

  it('leaves the middle alone when asked', () => {
    const full = buildSpiral({ shapePath: ELLIPSE, pitch: 30 })!
    const holed = buildSpiral({ shapePath: ELLIPSE, pitch: 30, centreHole: 0.5 })!
    expect(holed.turns).toBeLessThan(full.turns)
    expect(holed.total).toBeLessThan(full.total)
  })

  it('starts further in when padded', () => {
    const flush = buildSpiral({ shapePath: ELLIPSE, pitch: 30 })!
    const padded = buildSpiral({ shapePath: ELLIPSE, pitch: 30, padding: 60 })!
    const bounds = pathBounds(ELLIPSE)
    const start = runAt(padded, 0).point
    expect(distance(runAt(flush, 0).point, start)).toBeGreaterThan(20)
    expect(start.x).toBeGreaterThan(bounds.x + 40)
  })

  it('refuses a shape with no room rather than returning a degenerate run', () => {
    // One ring is a closed loop, not a spiral. The caller has to be able to tell
    // the difference without inspecting the result.
    expect(buildSpiral({ shapePath: ELLIPSE, pitch: 400 })).toBeNull()
    expect(buildSpiral({ shapePath: ELLIPSE, pitch: 0 })).toBeNull()
    expect(buildSpiral({ shapePath: ELLIPSE, pitch: -20 })).toBeNull()
    expect(buildSpiral({ shapePath: ELLIPSE, pitch: 30, padding: 5000 })).toBeNull()
  })
})

describe('reading a position off the run', () => {
  it('runs from one end to the other', () => {
    const spiral = buildSpiral({ shapePath: ELLIPSE, pitch: 40 })!
    expect(runAt(spiral, 0).point).toEqual(spiral.points[0])
    const end = runAt(spiral, spiral.total).point
    const last = spiral.points[spiral.points.length - 1] as Vec2
    expect(distance(end, last)).toBeLessThan(0.01)
  })

  it('advances at the rate the distance says', () => {
    // The arc-length table is what lets the packer treat the run as a plain
    // horizontal span. If a step of n units moved the point by something other
    // than n, every letter after it would land in the wrong place.
    const spiral = buildSpiral({ shapePath: ELLIPSE, pitch: 40 })!
    for (const s of [50, 300, 900, spiral.total * 0.75]) {
      const a = runAt(spiral, s).point
      const b = runAt(spiral, s + 20).point
      expect(distance(a, b)).toBeGreaterThan(19)
      expect(distance(a, b)).toBeLessThan(21)
    }
  })

  it('clamps at both ends rather than wrapping', () => {
    // The run has two ends, unlike every closed path elsewhere in the engine. A
    // character pushed past the end must pile up there, not reappear at the start.
    const spiral = buildSpiral({ shapePath: ELLIPSE, pitch: 40 })!
    expect(runAt(spiral, -500).point).toEqual(runAt(spiral, 0).point)
    expect(runAt(spiral, spiral.total + 500).point).toEqual(runAt(spiral, spiral.total).point)
  })

  it('gives a unit tangent everywhere along the run', () => {
    const spiral = buildSpiral({ shapePath: BLOB, pitch: 30 })!
    for (let i = 0; i <= 40; i++) {
      const { tangent } = runAt(spiral, (i / 40) * spiral.total)
      expect(Math.hypot(tangent.x, tangent.y)).toBeCloseTo(1, 6)
    }
  })

  it('holds a steady heading on a smooth shape', () => {
    // A tangent that jumped between samples would flip a letter mid-word.
    for (const [label, shape] of [
      ['ellipse', ELLIPSE],
      ['blob', BLOB],
    ] as const) {
      const spiral = buildSpiral({ shapePath: shape, pitch: 40 })!
      expect(sharpestTurn(spiral), label).toBeGreaterThan(0.9)
    }
  })

  it('winds a flattened ellipse most of the way in', () => {
    /*
     * The regression this file's cusp guard was rewritten for.
     *
     * The guard used to measure how much a turn had tightened over a whole
     * pitch, which on a flattened ellipse rises steadily — the inner offsets of
     * an ellipse are relatively more elongated than the ellipse itself, with no
     * cusp anywhere. It read that as damage and stopped the run several turns
     * early, so the middle of the shape stayed empty however the centre-hole
     * setting was set. Flatter shapes were hit hardest, which is why a nearly
     * round test ellipse never showed it.
     */
    const flat = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(630, 435)
    const spiral = buildSpiral({ shapePath: flat, pitch: 30 })!
    expect(spiral.turns).toBeGreaterThanOrEqual(5)
    // Within a couple of turns of the middle, rather than stopping halfway.
    expect(spiral.reach - spiral.depth).toBeLessThan(spiral.pitch * 2.5)
  })

  it('turns hard at a corner but never doubles back', () => {
    // A triangle's corners genuinely reverse the heading by 120 degrees, and
    // that is the shape following the shape — the type fans around the corner
    // exactly as it should. What must never happen is the run folding back on
    // itself, which would draw a word over the one before it.
    const spiral = buildSpiral({ shapePath: TRIANGLE, pitch: 40 })!
    const sharpest = sharpestTurn(spiral)
    expect(sharpest, 'a corner should be visible in the heading').toBeLessThan(0.9)
    expect(sharpest, 'but the run must not fold back').toBeGreaterThan(-0.75)
  })
})

describe('the run as geometry', () => {
  it('emits a drawable path with no bad numbers', () => {
    for (const primitive of PRIMITIVES) {
      const spiral = buildSpiral({ shapePath: primitive.build(680, 600), pitch: 40 })!
      const path = runToPath(spiral)
      expect(path.startsWith('M'), primitive.label).toBe(true)
      expect(path, primitive.label).not.toMatch(/NaN|Infinity/)
    }
  })

  it('is deterministic', () => {
    const a = buildSpiral({ shapePath: BLOB, pitch: 30 })!
    const b = buildSpiral({ shapePath: BLOB, pitch: 30 })!
    expect(runToPath(a)).toBe(runToPath(b))
  })
})
