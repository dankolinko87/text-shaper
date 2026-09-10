import { describe, expect, it } from 'vitest'

import { splitTransform } from '../../src/editor/transformIntent'
import type { Transform2D } from '../../src/types/document'

function t(over: Partial<Transform2D> = {}): Transform2D {
  return {
    x: 100,
    y: 200,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    ...over,
  }
}

describe('splitTransform', () => {
  it('bakes a resize into the outline', () => {
    const split = splitTransform(t({ scaleX: 1.6, scaleY: 0.8 }))
    expect(split.bake).toEqual({
      scaleX: 1.6,
      scaleY: 0.8,
      rotation: 0,
      flipX: false,
      flipY: false,
    })
    expect(split.transform.scaleX).toBe(1)
    expect(split.transform.scaleY).toBe(1)
  })

  it('never bakes rotation', () => {
    // Rows are functions y = f(x) spanning the container. Rotating one shrinks
    // the x it covers while the shape's width grows — at 45 degrees a divider
    // reaches half the shape, at 75 degrees a fifth — and at 90 degrees a
    // horizontal row becomes vertical and cannot be written as a function of x
    // at all. So rotation stays on the object at every angle.
    for (const rotation of [1, 15, 45, 75, 90, 135, -30]) {
      const split = splitTransform(t({ rotation }))
      expect(split.bake, `${rotation}deg was baked`).toBeNull()
      expect(split.transform.rotation).toBe(rotation)
    }
  })

  it('keeps the rotation when a rotated shape is also resized', () => {
    const split = splitTransform(t({ rotation: 40, scaleX: 2 }))
    expect(split.transform.rotation).toBe(40)
    expect(split.bake?.rotation).toBe(0)
    expect(split.bake?.scaleX).toBe(2)
  })

  it('treats a plain move as a move', () => {
    const split = splitTransform(t({ x: 900, y: 40 }))
    expect(split.bake).toBeNull()
    expect(split.transform.x).toBe(900)
  })

  it('ignores float jitter on the scale', () => {
    // Fabric nudges these by tiny amounts, and rebuilding the outline for one
    // would rewrite the geometry every time a handle was touched.
    expect(splitTransform(t({ scaleX: 1 + 1e-9 })).bake).toBeNull()
  })

  it('bakes a flip', () => {
    expect(splitTransform(t({ flipX: true })).bake?.flipX).toBe(true)
    expect(splitTransform(t({ flipX: true })).transform.flipX).toBe(false)
  })
})
