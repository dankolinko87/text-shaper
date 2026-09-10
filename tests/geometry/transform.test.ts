import { describe, expect, it } from 'vitest'

import {
  applyToPoint,
  applyToVector,
  compose,
  decompose,
  identityTransform,
  invert,
  multiply,
  transformBounds,
  IDENTITY,
} from '../../src/geometry/transform'
import type { Transform2D } from '../../src/types/document'

const cases: Transform2D[] = [
  identityTransform(),
  { x: 120, y: -40, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
  { x: 10, y: 20, scaleX: 2, scaleY: 0.5, rotation: 37, flipX: false, flipY: false },
  { x: -300, y: 88, scaleX: 0.25, scaleY: 3, rotation: -145, flipX: false, flipY: false },
  { x: 0, y: 0, scaleX: 1.5, scaleY: 1.5, rotation: 90, flipX: false, flipY: false },
]

describe('transform', () => {
  it('round-trips compose -> decompose', () => {
    for (const t of cases) {
      const back = decompose(compose(t))
      expect(back.x).toBeCloseTo(t.x, 6)
      expect(back.y).toBeCloseTo(t.y, 6)
      expect(back.scaleX).toBeCloseTo(t.scaleX, 6)
      expect(back.scaleY).toBeCloseTo(t.scaleY, 6)
      // Rotation is modular; compare via its sine and cosine.
      expect(Math.cos((back.rotation * Math.PI) / 180)).toBeCloseTo(
        Math.cos((t.rotation * Math.PI) / 180),
        6,
      )
      expect(Math.sin((back.rotation * Math.PI) / 180)).toBeCloseTo(
        Math.sin((t.rotation * Math.PI) / 180),
        6,
      )
    }
  })

  it('inverts a matrix so point mapping round-trips', () => {
    for (const t of cases) {
      const m = compose(t)
      const inv = invert(m)
      const p = { x: 17.5, y: -93.25 }
      const back = applyToPoint(inv, applyToPoint(m, p))
      expect(back.x).toBeCloseTo(p.x, 6)
      expect(back.y).toBeCloseTo(p.y, 6)
    }
  })

  it('throws when inverting a singular matrix', () => {
    expect(() => invert([0, 0, 0, 0, 0, 0])).toThrow(/singular/i)
  })

  it('multiplies associatively', () => {
    const a = compose(cases[2] as Transform2D)
    const b = compose(cases[3] as Transform2D)
    const c = compose(cases[4] as Transform2D)
    const left = multiply(multiply(a, b), c)
    const right = multiply(a, multiply(b, c))
    for (let i = 0; i < 6; i++) {
      expect(left[i] as number).toBeCloseTo(right[i] as number, 6)
    }
  })

  it('treats identity as a no-op', () => {
    const p = { x: 3, y: 4 }
    expect(applyToPoint(IDENTITY, p)).toEqual(p)
  })

  it('ignores translation for vectors', () => {
    const m = compose({
      x: 500,
      y: 500,
      scaleX: 2,
      scaleY: 2,
      rotation: 0,
      flipX: false,
      flipY: false,
    })
    const v = applyToVector(m, { x: 1, y: 0 })
    expect(v.x).toBeCloseTo(2, 6)
    expect(v.y).toBeCloseTo(0, 6)
  })

  it('computes the axis-aligned hull of a rotated rect', () => {
    const m = compose({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 45,
      flipX: false,
      flipY: false,
    })
    const b = transformBounds(m, { x: -50, y: -50, width: 100, height: 100 })
    const diagonal = Math.sqrt(2) * 100
    expect(b.width).toBeCloseTo(diagonal, 4)
    expect(b.height).toBeCloseTo(diagonal, 4)
  })
})
