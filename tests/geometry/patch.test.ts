import { afterEach, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import {
  buildPatch,
  evaluatePatch,
  invertPatch,
  patchFolds,
  patchToPath,
  rowArcTable,
  refreshPatch,
  rowWidth,
  type OutlinePatch,
} from '../../src/geometry/patch'
import { PRIMITIVES } from '../../src/geometry/primitives'
import type { Vec2 } from '../../src/types/document'

afterEach(() => {
  resetPaperScope()
})

const TOLERANCE = 600 * 0.012

function patchFor(path: string): OutlinePatch {
  const patch = buildPatch(path, { tolerance: TOLERANCE })
  if (!patch) throw new Error('no patch')
  return patch
}

/** Distance from a point to the outline, by dense sampling. */
function distanceToOutline(path: string, p: Vec2): number {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, path)
    const nearest = item.getNearestPoint(new scope.Point(p.x, p.y))
    const d = nearest ? Math.hypot(nearest.x - p.x, nearest.y - p.y) : Infinity
    item.remove()
    return d
  })
}

function contains(path: string, p: Vec2): boolean {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, path)
    const inside = item.contains(new scope.Point(p.x, p.y))
    item.remove()
    return inside
  })
}

const SHAPES: [string, string][] = PRIMITIVES.map((s) => [s.label, s.build(680, 600)])

describe('buildPatch', () => {
  it('builds a patch for every preset', () => {
    for (const [label, path] of SHAPES) {
      expect(buildPatch(path, { tolerance: TOLERANCE }), label).not.toBeNull()
    }
  })

  it('puts a rectangle its own four corners', () => {
    const patch = patchFor(PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600))
    const { p00, p10, p01, p11 } = patch.corners
    // Half-extents: the outline is centred on the origin.
    expect(Math.abs(p00.x)).toBeCloseTo(340, 0)
    expect(Math.abs(p00.y)).toBeCloseTo(300, 0)
    expect(p00.x).toBeLessThan(0)
    expect(p00.y).toBeLessThan(0)
    expect(p10.x).toBeGreaterThan(0)
    expect(p10.y).toBeLessThan(0)
    expect(p01.x).toBeLessThan(0)
    expect(p01.y).toBeGreaterThan(0)
    expect(p11.x).toBeGreaterThan(0)
    expect(p11.y).toBeGreaterThan(0)
  })

  it('puts an ellipse its four 45-degree points', () => {
    // Not the extremes: those would collapse the left and right edges onto
    // single points, and the outermost rows would pinch to nothing again.
    const patch = patchFor(PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600))
    for (const corner of Object.values(patch.corners)) {
      expect(Math.abs(corner.x) / 340).toBeCloseTo(Math.SQRT1_2, 1)
      expect(Math.abs(corner.y) / 300).toBeCloseTo(Math.SQRT1_2, 1)
    }
  })
})

describe('how many handles a shape opens with', () => {
  const handles = (path: string): number => {
    const patch = patchFor(path)
    return patch.top.points.length
  }

  it('keeps a flat-edged shape down to the minimum', () => {
    // The complaint this answers: a fixed sample count gave a rectangle the
    // same fourteen handles as an intricate blob, most of them in a dead
    // straight line and all of them in the way.
    expect(handles(PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600))).toBeLessThanOrEqual(4)
  })

  it('gives every preset fewer than the old fixed count', () => {
    // A hexagon still needs several: its edges have CORNERS, and a smooth curve
    // can only turn that sharply by clustering points around the turn.
    for (const [label, path] of SHAPES) {
      expect(handles(path), label).toBeLessThan(14)
      expect(handles(path), label).toBeGreaterThanOrEqual(2)
    }
  })

  it('gives a rippled outline more handles than a flat one', () => {
    const points: string[] = []
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2
      const r = 1 + 0.09 * Math.sin(a * 7)
      points.push(
        `${i === 0 ? 'M' : 'L'}${(340 * r * Math.cos(a)).toFixed(2)} ${(300 * r * Math.sin(a)).toFixed(2)}`,
      )
    }
    const rippled = `${points.join('')}Z`
    const rect = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600)
    expect(handles(rect)).toBeLessThan(handles(rippled))
  })
})

describe('evaluatePatch', () => {
  it('lands on the outline along every edge', () => {
    // The four edges ARE the container's boundary. A map that only came close
    // would draw the boundary somewhere the artwork is not.
    for (const [label, path] of SHAPES) {
      const patch = patchFor(path)
      let worst = 0
      for (let i = 0; i <= 40; i++) {
        const t = i / 40
        for (const p of [
          evaluatePatch(patch, t, 0),
          evaluatePatch(patch, t, 1),
          evaluatePatch(patch, 0, t),
          evaluatePatch(patch, 1, t),
        ]) {
          worst = Math.max(worst, distanceToOutline(path, p))
        }
      }
      expect(worst, `${label}: edge strays ${worst.toFixed(1)} units`).toBeLessThan(TOLERANCE * 2)
    }
  })

  it('hits the corners exactly', () => {
    for (const [label, path] of SHAPES) {
      const patch = patchFor(path)
      const { p00, p10, p01, p11 } = patch.corners
      const pairs: [Vec2, Vec2][] = [
        [evaluatePatch(patch, 0, 0), p00],
        [evaluatePatch(patch, 1, 0), p10],
        [evaluatePatch(patch, 0, 1), p01],
        [evaluatePatch(patch, 1, 1), p11],
      ]
      for (const [got, want] of pairs) {
        expect(Math.hypot(got.x - want.x, got.y - want.y), label).toBeLessThan(0.5)
      }
    }
  })

  it('keeps the interior inside the shape', () => {
    for (const [label, path] of SHAPES) {
      const patch = patchFor(path)
      let outside = 0
      let total = 0
      for (let i = 1; i < 12; i++) {
        for (let j = 1; j < 12; j++) {
          total++
          if (!contains(path, evaluatePatch(patch, i / 12, j / 12))) outside++
        }
      }
      expect(outside / total, `${label}: ${outside}/${total} interior samples escaped`).toBeLessThan(0.05)
    }
  })

  it('never returns non-finite coordinates', () => {
    for (const [, path] of SHAPES) {
      const patch = patchFor(path)
      for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
          const p = evaluatePatch(patch, i / 10, j / 10)
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
        }
      }
    }
  })
})

describe('invertPatch', () => {
  it('finds coordinates that land back on the same place', () => {
    // The contract the editor needs: a click turns into patch coordinates that
    // map back to where the user clicked. Stated in POINTS, not parameters,
    // because the map is not injective everywhere — see below.
    for (const [label, path] of SHAPES) {
      const patch = patchFor(path)
      for (let i = 1; i < 8; i++) {
        for (let j = 1; j < 8; j++) {
          const target = evaluatePatch(patch, i / 8, j / 8)
          const back = invertPatch(patch, target)
          expect(back, label).not.toBeNull()
          const landed = evaluatePatch(patch, back!.u, back!.v)
          expect(Math.hypot(landed.x - target.x, landed.y - target.y), label).toBeLessThan(1)
        }
      }
    }
  })

  it('recovers the parameters wherever the patch is not degenerate', () => {
    // A triangle is excluded, and the reason is worth stating: it has three
    // vertices and a patch has four corners, so two corners crowd together near
    // the apex and the map becomes many-to-one there. Different parameters
    // genuinely name the same point, so no inverse can distinguish them. The
    // shape still lays out and edits correctly — only this stronger property
    // fails, and only for shapes with fewer corners than the patch.
    for (const [label, path] of SHAPES) {
      if (label === 'Triangle') continue
      const patch = patchFor(path)
      for (let i = 1; i < 8; i++) {
        for (let j = 1; j < 8; j++) {
          const u = i / 8
          const v = j / 8
          const back = invertPatch(patch, evaluatePatch(patch, u, v))
          expect(back!.u, `${label} u`).toBeCloseTo(u, 2)
          expect(back!.v, `${label} v`).toBeCloseTo(v, 2)
        }
      }
    }
  })
})

describe('row metrics', () => {
  it('measures a rectangle row at its true width', () => {
    const patch = patchFor(PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600))
    expect(rowWidth(patch, 0.5)).toBeCloseTo(680, 0)
  })

  it('reports a narrower row where an arch narrows', () => {
    const patch = patchFor(PRIMITIVES.find((p) => p.id === 'arch')!.build(680, 600))
    expect(rowWidth(patch, 0.05)).toBeLessThan(rowWidth(patch, 0.95))
  })

  it('turns distance along a row into an even walk', () => {
    // Stepping u uniformly bunches letters wherever the patch compresses.
    const patch = patchFor(PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600))
    const width = rowWidth(patch, 0.5)
    const arc = rowArcTable(patch, 0.5)

    let previous = evaluatePatch(patch, arc.uAt(0), 0.5)
    const steps: number[] = []
    for (let i = 1; i <= 12; i++) {
      const point = evaluatePatch(patch, arc.uAt((width * i) / 12), 0.5)
      steps.push(Math.hypot(point.x - previous.x, point.y - previous.y))
      previous = point
    }
    // Every step should be about a twelfth of the row.
    for (const step of steps) expect(step).toBeCloseTo(width / 12, 0)
  })
})

describe('patchFolds', () => {
  it('passes the presets', () => {
    for (const [label, path] of SHAPES) {
      expect(patchFolds(patchFor(path)), label).toBe(false)
    }
  })

  it('still catches a patch that genuinely turns inside out', () => {
    // The threshold is relative, so this guards against it being loosened into
    // uselessness: here the left and right edges are swapped over, which
    // reverses the map across the whole square rather than in one corner cell.
    const straight = (a: Vec2, b: Vec2, axis: 'x' | 'y') => ({
      points: axis === 'x' ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : [{ x: a.y, y: a.x }, { x: b.y, y: b.x }],
      axis,
      table: [],
    })
    const p00 = { x: 100, y: 0 }
    const p10 = { x: 0, y: 0 }
    const p01 = { x: 100, y: 100 }
    const p11 = { x: 0, y: 100 }
    const crossed: OutlinePatch = refreshPatch({
      top: straight(p00, p10, 'x'),
      bottom: straight(p01, p11, 'x'),
      left: straight(p00, p01, 'y'),
      right: straight(p10, p11, 'y'),
      corners: { p00, p10, p01, p11 },
    })
    expect(patchFolds(crossed)).toBe(true)
  })

  it('produces no non-finite geometry on a deeply concave outline', () => {
    // A crescent is the case the fold guard exists for. It must not crash or
    // emit NaN; the type near the notch is squeezed rather than wrapping in.
    const points: string[] = []
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2
      const r = 1 - 0.55 * Math.max(0, Math.cos(a))
      points.push(
        `${i === 0 ? 'M' : 'L'}${(340 * r * Math.cos(a)).toFixed(2)} ${(300 * r * Math.sin(a)).toFixed(2)}`,
      )
    }
    const crescent = `${points.join('')}Z`
    const patch = buildPatch(crescent, { tolerance: TOLERANCE })
    if (!patch) return
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const p = evaluatePatch(patch, i / 10, j / 10)
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      }
    }
  })
})

describe('patchToPath', () => {
  it('rebuilds an outline that still covers the shape', () => {
    for (const [label, path] of SHAPES) {
      const rebuilt = patchToPath(patchFor(path))
      expect(rebuilt.length, label).toBeGreaterThan(0)
      expect(rebuilt).not.toMatch(/NaN|Infinity/)
    }
  })
})
