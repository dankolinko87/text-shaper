import { afterEach, describe, expect, it } from 'vitest'

import { resetPaperScope } from '../../src/geometry/paperContext'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { distanceToPolyline } from '../../src/geometry/resample'
import { samplePath } from '../../src/geometry/run'
import type { Vec2 } from '../../src/types/document'

/**
 * Whether a click is "on the path".
 *
 * The question the point editor asks on every double-click, and the one that
 * decides between adding a point and leaving the mode. Getting it wrong in the
 * strict direction is the dangerous one: a click that IS on the curve but reads
 * as a miss throws the user out of the mode they were working in.
 *
 * The overlay draws the curve as a polyline sampled every `GUIDE_SPACING` object
 * units and measures against that, so the error to bound is how far a sampled
 * chord sags away from the curve it is standing in for.
 */

/** The overlay's own sampling interval, in object units. */
const GUIDE_SPACING = 3
/** Its hit radius, in screen pixels. */
const CURVE_HIT_RADIUS = 8

afterEach(() => {
  resetPaperScope()
})

describe('telling a click on the curve from a click off it', () => {
  it('measures a point on the curve as being on it, at every zoom', () => {
    /*
     * The chord between two samples cuts inside the curve it stands for, so a
     * point exactly on the curve is a little way from the polyline. That sag
     * grows with the sampling interval and shrinks with the radius, and it has
     * to stay far below the hit radius even where the radius is at its tightest
     * — at maximum zoom, where 8 screen pixels are a fraction of a unit.
     */
    const circle = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(480, 480)
    const dense = samplePath(circle, GUIDE_SPACING)!
    // Points BETWEEN the samples, which is where the sag is worst.
    const onCurve = samplePath(circle, GUIDE_SPACING / 2)!

    let worst = 0
    for (const p of onCurve) worst = Math.max(worst, distanceToPolyline(p, dense))

    const tightest = CURVE_HIT_RADIUS / 8 // eight-times zoom, the tight end
    expect(worst, 'sag between samples').toBeLessThan(tightest / 10)
  })

  it('measures a point well off the curve as being off it', () => {
    // The other direction, so the test cannot pass by measuring everything as
    // close: the centre of a circle of radius 240 is 240 from its edge.
    const circle = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(480, 480)
    const dense = samplePath(circle, GUIDE_SPACING)!
    expect(distanceToPolyline({ x: 0, y: 0 }, dense)).toBeCloseTo(240, 0)
  })

  it('measures to the segments, not to the nearest sample', () => {
    // Halfway along a 100-unit segment, a point 1 unit off the line is 1 unit
    // away — not the 50 that the nearer of its two endpoints would report.
    const line: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(distanceToPolyline({ x: 50, y: 1 }, line)).toBeCloseTo(1, 9)
    // And past the end it falls back to the endpoint, rather than to the
    // infinite line the segment lies on.
    expect(distanceToPolyline({ x: 130, y: 0 }, line)).toBeCloseTo(30, 9)
  })

  it('says nothing is near an empty or single-point polyline', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity)
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Infinity)
  })
})
