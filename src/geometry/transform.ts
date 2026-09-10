import type { Rect, Transform2D, Vec2 } from '../types/document'
import type { Mat2D } from '../types/geometry'
import { DEG_TO_RAD, RAD_TO_DEG } from '../utils/math'

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0]

export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

export function invert(m: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (det === 0 || !Number.isFinite(det)) {
    throw new Error('Cannot invert a singular matrix')
  }
  const id = 1 / det
  return [d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id]
}

export function applyToPoint(m: Mat2D, p: Vec2): Vec2 {
  const [a, b, c, d, e, f] = m
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }
}

/** Applies rotation and scale but ignores translation — for directions and deltas. */
export function applyToVector(m: Mat2D, v: Vec2): Vec2 {
  const [a, b, c, d] = m
  return { x: a * v.x + c * v.y, y: b * v.x + d * v.y }
}

/**
 * Compose a transform into a matrix.
 * Order: translate(x, y) -> rotate(rotation) -> scale(scaleX, scaleY) with flips.
 */
export function compose(t: Transform2D): Mat2D {
  const rad = t.rotation * DEG_TO_RAD
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = t.scaleX * (t.flipX ? -1 : 1)
  const sy = t.scaleY * (t.flipY ? -1 : 1)
  return [cos * sx, sin * sx, -sin * sy, cos * sy, t.x, t.y]
}

/** Inverse of `compose`. */
export function decompose(m: Mat2D): Transform2D {
  const [a, b, c, d, e, f] = m
  const rotation = Math.atan2(b, a) * RAD_TO_DEG
  const scaleX = Math.hypot(a, b)
  // Signed area determines whether one axis is mirrored.
  const det = a * d - b * c
  const scaleYMagnitude = Math.hypot(c, d)
  const flipY = det < 0
  return {
    x: e,
    y: f,
    scaleX,
    scaleY: scaleYMagnitude,
    rotation,
    flipX: false,
    flipY,
  }
}

/** Axis-aligned bounding box of `r` after transformation — the hull of its 4 corners. */
export function transformBounds(m: Mat2D, r: Rect): Rect {
  const corners: Vec2[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const corner of corners) {
    const p = applyToPoint(m, corner)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function identityTransform(x = 0, y = 0): Transform2D {
  return { x, y, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }
}
