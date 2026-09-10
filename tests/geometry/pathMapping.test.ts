import { afterEach, describe, expect, it } from 'vitest'

import { resetPaperScope } from '../../src/geometry/paperContext'
import { mapPathPoints, pathArea, pathBounds, subdividePath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import type { Vec2 } from '../../src/types/document'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const ROUNDED = PRIMITIVES.find((p) => p.id === 'rounded')!.build(680, 600)

afterEach(() => {
  resetPaperScope()
})

const identity = (p: Vec2): Vec2 => p

/** How many anchors and control points a path offers to a deformation. */
function pointCount(data: PathData): number {
  return (data.match(/-?\d*\.?\d+/g) ?? []).length / 2
}

type PathData = string

describe('subdividing an outline', () => {
  it('keeps the shape it was given', () => {
    for (const primitive of PRIMITIVES) {
      const original = primitive.build(680, 600)
      const dense = subdividePath(original, 12)
      const before = pathBounds(original)
      const after = pathBounds(dense)
      expect(after.x, primitive.label).toBeCloseTo(before.x, 2)
      expect(after.y, primitive.label).toBeCloseTo(before.y, 2)
      expect(after.width, primitive.label).toBeCloseTo(before.width, 2)
      expect(after.height, primitive.label).toBeCloseTo(before.height, 2)
      // Area is the sharper test: bounds would survive a shape collapsing
      // inward between its extremes.
      expect(pathArea(dense), primitive.label).toBeCloseTo(pathArea(original), 0)
    }
  })

  it('actually adds points to grab hold of', () => {
    // The whole reason it exists. An ellipse ships as four cubics, which is far
    // too coarse for a ripple to read as anything but a lurch.
    expect(pointCount(subdividePath(ELLIPSE, 12))).toBeGreaterThan(pointCount(ELLIPSE) * 10)
  })

  it('leaves a path alone when asked for no detail', () => {
    expect(subdividePath(ELLIPSE, 0)).toBe(ELLIPSE)
    expect(subdividePath(ELLIPSE, Number.NaN)).toBe(ELLIPSE)
  })
})

describe('mapping the points of a path', () => {
  it('returns the same geometry under an identity map', () => {
    for (const primitive of PRIMITIVES) {
      const original = primitive.build(680, 600)
      const mapped = mapPathPoints(original, identity)
      expect(mapped, primitive.label).not.toBeNull()
      expect(pathArea(mapped!), primitive.label).toBeCloseTo(pathArea(original), 0)
    }
  })

  it('reads the relative commands paper actually emits', () => {
    // The failure this was written for: everything paper has touched comes back
    // in relative form, and a relative offset cannot be mapped as it stands —
    // a bending of the plane moves the point it is measured from too.
    const dense = subdividePath(ELLIPSE, 12)
    expect(dense).toMatch(/[a-z]/)
    const mapped = mapPathPoints(dense, identity)
    expect(mapped).not.toBeNull()
    expect(pathArea(mapped!)).toBeCloseTo(pathArea(ELLIPSE), 0)
  })

  it('carries a quadratic path through', () => {
    // The rounded rectangle is built from Q segments, which take one control
    // point rather than two.
    const mapped = mapPathPoints(ROUNDED, identity)
    expect(mapped).not.toBeNull()
    expect(pathArea(mapped!)).toBeCloseTo(pathArea(ROUNDED), 0)
  })

  it('moves every point, not only the anchors', () => {
    const scaled = mapPathPoints(ELLIPSE, (p) => ({ x: p.x * 2, y: p.y * 2 }))
    expect(scaled).not.toBeNull()
    const bounds = pathBounds(scaled!)
    expect(bounds.width).toBeCloseTo(1360, 1)
    expect(bounds.height).toBeCloseTo(1200, 1)
    // A map that reached the anchors but not the controls would still double the
    // bounds while bulging the curves between them, so check the area too.
    expect(pathArea(scaled!)).toBeCloseTo(pathArea(ELLIPSE) * 4, -2)
  })

  it('expands the reflection shorthands rather than mis-reflecting them', () => {
    // S infers its first control by reflecting the previous one. Reflecting
    // AFTER a non-linear map is not the same as mapping the reflection, so the
    // shorthand has to be resolved in the original coordinates.
    const withShorthand = 'M0 0C10 0 20 10 20 20S30 40 40 40Z'
    const explicit = 'M0 0C10 0 20 10 20 20C20 30 30 40 40 40Z'
    expect(mapPathPoints(withShorthand, identity)).toBe(mapPathPoints(explicit, identity))
  })

  it('resolves the axis shorthands to plain lines', () => {
    expect(mapPathPoints('M0 0H10V10H0Z', identity)).toBe(
      mapPathPoints('M0 0L10 0L10 10L0 10Z', identity),
    )
  })

  it('treats coordinates after a moveto as a line, per the specification', () => {
    expect(mapPathPoints('M0 0 10 0 10 10Z', identity)).toBe(
      mapPathPoints('M0 0L10 0L10 10Z', identity),
    )
  })

  it('sends Z back to the start of the subpath', () => {
    // Two subpaths, the second written relative to where the first closed. Get
    // the closing wrong and the hole lands somewhere else entirely.
    const mapped = mapPathPoints('M0 0L100 0L100 100L0 100Zm20 20l60 0l0 60l-60 0z', identity)
    expect(mapped).toBe('M0 0L100 0L100 100L0 100ZM20 20L80 20L80 80L20 80Z')
  })

  it('refuses an arc rather than guessing at it', () => {
    expect(mapPathPoints('M0 0A50 50 0 0 1 100 0Z', identity)).toBeNull()
  })

  it('refuses rather than emitting a path full of NaN', () => {
    expect(mapPathPoints(ELLIPSE, () => ({ x: Number.NaN, y: 0 }))).toBeNull()
    expect(mapPathPoints('', identity)).toBeNull()
    expect(mapPathPoints('10 20L30 40', identity)).toBeNull()
  })
})
