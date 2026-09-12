import { createCanvas } from 'canvas'
import { describe, expect, it } from 'vitest'

import { evaluatePatch } from '../../src/geometry/patch'
import { drawWarpedImage, subdivisionsFor, type WarpContext } from '../../src/geometry/warpImage'
import { bilinearQuad, patchFromPolygon } from '../../src/mesh/mesh'
import type { Vec2 } from '../../src/types/document'

/**
 * A picture bent through a map lands where the map says: what was on the
 * left of the picture is on the left of the cell, however the cell bends,
 * and the triangles it is cut into leave no seam between them.
 */

const SIZE = 64

/** Left half red, right half blue, a green band along the bottom. */
function source() {
  const canvas = createCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, SIZE / 2, SIZE)
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(SIZE / 2, 0, SIZE / 2, SIZE)
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, SIZE - 8, SIZE, 8)
  return canvas
}

function target() {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')
  return { canvas, ctx }
}

const pixel = (ctx: ReturnType<typeof target>['ctx'], p: Vec2): [number, number, number, number] => {
  const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data
  return [d[0]!, d[1]!, d[2]!, d[3]!]
}
const isRed = (px: number[]) => px[0]! > 200 && px[2]! < 60 && px[3]! > 200
const isBlue = (px: number[]) => px[2]! > 200 && px[0]! < 60 && px[3]! > 200
const isGreen = (px: number[]) => px[1]! > 200 && px[0]! < 60 && px[3]! > 200

const whole = (image: CanvasImageSource) => ({ image, sx: 0, sy: 0, sw: SIZE, sh: SIZE })

describe('a picture bent through a map', () => {
  it('fills a rectangle as a plain scale', () => {
    const { ctx } = target()
    const rect = { x: 20, y: 30, width: 120, height: 80 }
    const map = (u: number, v: number) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height })
    drawWarpedImage(ctx as unknown as WarpContext, whole(source() as never), map, 1)
    expect(isRed(pixel(ctx, { x: 40, y: 50 }))).toBe(true)
    expect(isBlue(pixel(ctx, { x: 120, y: 50 }))).toBe(true)
    expect(isGreen(pixel(ctx, { x: 80, y: 106 }))).toBe(true)
    // Outside the rectangle, nothing.
    expect(pixel(ctx, { x: 10, y: 10 })[3]).toBe(0)
    expect(pixel(ctx, { x: 150, y: 120 })[3]).toBe(0)
  })

  it('follows a sheared quad, left to left and right to right', () => {
    const { ctx } = target()
    const a = { x: 20, y: 20 }
    const b = { x: 160, y: 50 }
    const c = { x: 180, y: 180 }
    const d = { x: 40, y: 150 }
    const map = (u: number, v: number) => bilinearQuad(a, b, c, d, u, v)
    drawWarpedImage(ctx as unknown as WarpContext, whole(source() as never), map, 8)
    expect(isRed(pixel(ctx, map(0.25, 0.4)))).toBe(true)
    expect(isBlue(pixel(ctx, map(0.75, 0.4)))).toBe(true)
    expect(isGreen(pixel(ctx, map(0.5, 0.95)))).toBe(true)
    // The seam between the halves is where the map puts the picture's middle.
    expect(isRed(pixel(ctx, map(0.47, 0.5)))).toBe(true)
    expect(isBlue(pixel(ctx, map(0.53, 0.5)))).toBe(true)
  })

  it('bends with a patch whose side passes through a bend point', () => {
    const { ctx } = target()
    const ring: Vec2[] = [
      { x: 20, y: 40 },
      { x: 100, y: 10 },
      { x: 180, y: 40 },
      { x: 180, y: 180 },
      { x: 20, y: 180 },
    ]
    const patch = patchFromPolygon(ring, [0, 2, 3, 4])
    const map = (u: number, v: number) => evaluatePatch(patch, u, v)
    drawWarpedImage(ctx as unknown as WarpContext, whole(source() as never), map, 12)
    expect(isRed(pixel(ctx, map(0.2, 0.3)))).toBe(true)
    expect(isBlue(pixel(ctx, map(0.8, 0.3)))).toBe(true)
    // Just under the bent top, where a flat picture would have left a gap.
    expect(isRed(pixel(ctx, map(0.3, 0.05)))).toBe(true)
  })

  it('leaves no seam between its triangles', () => {
    const { ctx } = target()
    const a = { x: 20, y: 20 }
    const b = { x: 170, y: 30 }
    const c = { x: 180, y: 180 }
    const d = { x: 30, y: 170 }
    const map = (u: number, v: number) => bilinearQuad(a, b, c, d, u, v)
    drawWarpedImage(ctx as unknown as WarpContext, whole(source() as never), map, 8)
    // Every point along every INNER grid line and every cell's diagonal is
    // painted solid. The outer edge is the cell's own edge, softened by the
    // canvas like any edge, so it is not a seam and is not probed.
    for (let k = 1; k < 8; k++) {
      for (let t = 0.05; t < 0.96; t += 0.07) {
        const along = pixel(ctx, map(k / 8, t))
        const across = pixel(ctx, map(t, k / 8))
        expect(along[3], `grid line u=${k / 8} at ${t}`).toBeGreaterThan(240)
        expect(across[3], `grid line v=${k / 8} at ${t}`).toBeGreaterThan(240)
      }
    }
    // The main diagonal runs along every cell's own cut.
    for (let t = 0.05; t < 0.96; t += 0.03) {
      expect(pixel(ctx, map(t, t))[3], `diagonal at ${t}`).toBeGreaterThan(240)
    }
  })

  it('shifts every mapped point for a child drawn in its own centred space', () => {
    const { ctx } = target()
    const rect = { x: 100, y: 100, width: 60, height: 60 }
    const map = (u: number, v: number) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height })
    drawWarpedImage(ctx as unknown as WarpContext, whole(source() as never), map, 1, { x: 100, y: 100 })
    expect(isRed(pixel(ctx, { x: 10, y: 10 }))).toBe(true)
    expect(pixel(ctx, { x: 110, y: 110 })[3]).toBe(0)
  })

  it('cuts a rectangle once, a quad a little, a patch the most', () => {
    expect(subdivisionsFor({ rect: {}, patch: null })).toBe(1)
    expect(subdivisionsFor({ rect: null, patch: null })).toBe(8)
    expect(subdivisionsFor({ rect: null, patch: {} })).toBe(12)
  })
})
