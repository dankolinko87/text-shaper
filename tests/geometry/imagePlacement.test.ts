import { describe, expect, it } from 'vitest'

import {
  coverScale,
  cropFromDelta,
  cropZoomed,
  MAX_CROP_SCALE,
  patternTransformOf,
  placementOf,
  sourceRectOf,
} from '../../src/geometry/imagePlacement'
import { DEFAULT_CROP, type ImageCrop } from '../../src/types/paint'

/**
 * A picture always covers its box: scaled up to it, never pushed off it.
 */

const box = { width: 200, height: 100 }
const wide = { width: 400, height: 100 }
const tall = { width: 100, height: 400 }

const covers = (crop: ImageCrop, image = wide): void => {
  const p = placementOf(box, image, crop)
  expect(p.x).toBeLessThanOrEqual(1e-9)
  expect(p.y).toBeLessThanOrEqual(1e-9)
  expect(p.x + p.width).toBeGreaterThanOrEqual(box.width - 1e-9)
  expect(p.y + p.height).toBeGreaterThanOrEqual(box.height - 1e-9)
}

describe('placing a picture in a box', () => {
  it('covers: the larger of the two ratios, centred', () => {
    expect(coverScale(box, wide)).toBe(1)
    expect(coverScale(box, tall)).toBe(2)
    const p = placementOf(box, tall, DEFAULT_CROP)
    expect(p).toEqual({ x: 0, y: -350, width: 200, height: 800, scale: 2 })
    expect(placementOf(box, wide, DEFAULT_CROP)).toEqual({ x: -100, y: 0, width: 400, height: 100, scale: 1 })
  })

  it('never leaves the box bare, whatever the crop asks', () => {
    covers({ scale: 1, x: 0.9, y: -0.9 })
    covers({ scale: 0.2, x: 0, y: 0 })
    covers({ scale: 3, x: -5, y: 5 }, tall)
    covers({ scale: 1.5, x: 0.1, y: 0.2 }, { width: 200, height: 100 })
  })

  it('moves by the crop within the slack, in box units', () => {
    const p = placementOf(box, wide, { scale: 1, x: 0.25, y: 0 })
    expect(p.x).toBe(-50)
    // A blend of two covering crops still covers.
    covers({ scale: 1.5, x: (0.4 + -0.4) / 2, y: 0 })
  })

  it('names the part of the picture the box shows', () => {
    expect(sourceRectOf(box, wide, DEFAULT_CROP)).toEqual({ sx: 100, sy: 0, sw: 200, sh: 100 })
    expect(sourceRectOf(box, tall, DEFAULT_CROP)).toEqual({ sx: 0, sy: 175, sw: 100, sh: 50 })
  })

  it('is a scale and a shift as a matrix', () => {
    expect(patternTransformOf(placementOf(box, tall, DEFAULT_CROP))).toEqual([2, 0, 0, 2, 0, -350])
  })

  it('pans by a delta in box units and zooms within bounds', () => {
    expect(cropFromDelta(DEFAULT_CROP, box, 50, -25)).toEqual({ scale: 1, x: 0.25, y: -0.25 })
    expect(cropZoomed(DEFAULT_CROP, 2).scale).toBe(2)
    expect(cropZoomed(DEFAULT_CROP, 0.5).scale).toBe(1)
    expect(cropZoomed({ scale: 6, x: 0, y: 0 }, 3).scale).toBe(MAX_CROP_SCALE)
  })
})
