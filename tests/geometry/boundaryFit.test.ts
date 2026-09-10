import { describe, expect, it } from 'vitest'

import { evaluateDivider, removeControlPoint } from '../../src/geometry/grid'
import type { GridDivider } from '../../src/types/document'

/**
 * Properties of the curve every boundary and divider is drawn with.
 *
 * Fidelity to the outline and how many handles a shape opens with are now
 * properties of the patch, and live in `patch.test.ts`. What is left here is the
 * interpolation itself, which the patch's edges and the row dividers both rely
 * on.
 */

describe('the divider curve', () => {
  it('never leaves the range of its own control points', () => {
    // Shape preservation. Catmull-Rom overshoots between control points, and
    // since the patch's edges ARE the container's outline, an overshoot drew the
    // boundary outside the shape it describes — by as much as 5.7% of the
    // height on a diamond.
    const curve: GridDivider = {
      id: 'c',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 200, y: 100 },
        { x: 300, y: 100 },
      ],
    }
    for (let x = 0; x <= 300; x += 2) {
      const y = evaluateDivider(curve, x)
      expect(y).toBeGreaterThanOrEqual(-0.001)
      expect(y).toBeLessThanOrEqual(100.001)
    }
  })

  it('passes exactly through every control point', () => {
    const curve: GridDivider = {
      id: 'c',
      points: [
        { x: 0, y: 10 },
        { x: 50, y: -40 },
        { x: 90, y: 25 },
        { x: 160, y: 0 },
      ],
    }
    for (const p of curve.points) {
      expect(evaluateDivider(curve, p.x)).toBeCloseTo(p.y, 6)
    }
  })

  it('flattens at a turning point rather than swinging past it', () => {
    // A local extremum sits ON the control point, which is what keeps the
    // boundary inside the shape.
    const curve: GridDivider = {
      id: 'c',
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 60 },
        { x: 100, y: 0 },
      ],
    }
    let highest = -Infinity
    for (let x = 0; x <= 100; x += 1) highest = Math.max(highest, evaluateDivider(curve, x))
    expect(highest).toBeCloseTo(60, 3)
  })
})

describe('removeControlPoint', () => {
  const curve: GridDivider = {
    id: 'c',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
      { x: 30, y: 5 },
    ],
  }

  it('removes an interior point', () => {
    expect(removeControlPoint(curve, 1)?.points).toHaveLength(3)
  })

  it('refuses the end points, which pin the curve span', () => {
    expect(removeControlPoint(curve, 0)).toBeNull()
    expect(removeControlPoint(curve, 3)).toBeNull()
  })

  it('allows reducing to a straight line but no further', () => {
    // Two points still describe a curve — a straight one — and a point can be
    // added back to bend it again.
    const three: GridDivider = { id: 'c', points: curve.points.slice(0, 3) }
    expect(removeControlPoint(three, 1)?.points).toHaveLength(2)
    const two: GridDivider = { id: 'c', points: curve.points.slice(0, 2) }
    expect(removeControlPoint(two, 0)).toBeNull()
  })
})
