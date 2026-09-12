import type { Vec2 } from '../types/document'

/**
 * A picture bent through a map, drawn on a 2D context.
 *
 * A mesh cell is a warped quad, and the letters in it are poured through
 * `cellMap` — the unit square onto the cell. A picture in the same cell has
 * to go the same way, or it would sit flat in a cell that is not. No canvas
 * draws a curved image directly, so the unit square is cut into an n×n grid,
 * every corner goes through the map, and each little cell is two triangles,
 * each one an affine transform of the matching triangle of picture pixels:
 * clip to the triangle, set the transform, draw. Dense enough, the straight
 * pieces read as the curve, exactly as a sampled path does.
 *
 * One routine for the Fabric child, the GIF exporters and the thumbnails,
 * so the picture bends the same way everywhere.
 */

/** The picture, and the part of it in pixels that fills the unit square. */
export interface WarpSource {
  image: CanvasImageSource
  sx: number
  sy: number
  sw: number
  sh: number
}

export type CellMap = (u: number, v: number) => Vec2

/** The part of a 2D context the warp needs — a node canvas has it too. */
export interface WarpContext {
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  clip(): void
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void
  drawImage(image: CanvasImageSource, dx: number, dy: number): void
}

/**
 * How finely to cut a cell: a rectangle needs no cutting at all, a plain
 * quad bends only a little, a patch with bent sides needs the most.
 */
export function subdivisionsFor(layout: { rect: unknown | null; patch: unknown | null }): number {
  if (layout.rect) return 1
  if (layout.patch) return 12
  return 8
}

/**
 * Grown from the centroid by this much, a triangle hides the seam to its
 * neighbour. Both sides draw the same pixels along their shared edge, so the
 * overlap shows nothing; too little of it and the two softened edges do not
 * add up to solid.
 */
const SEAM = 0.75

/** Draw `source` so its pixel rect lands on the unit square mapped through `map`. */
export function drawWarpedImage(
  ctx: WarpContext,
  source: WarpSource,
  map: CellMap,
  n: number,
  /** Subtracted from every mapped point — a child drawn in its own centred space. */
  shift: Vec2 = { x: 0, y: 0 },
): void {
  const steps = Math.max(1, Math.floor(n))
  const stride = steps + 1
  const grid: Vec2[] = new Array(stride * stride)
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const p = map(i / steps, j / steps)
      grid[j * stride + i] = { x: p.x - shift.x, y: p.y - shift.y }
    }
  }
  const cellW = source.sw / steps
  const cellH = source.sh / steps
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const a = grid[j * stride + i]!
      const b = grid[j * stride + i + 1]!
      const c = grid[(j + 1) * stride + i + 1]!
      const d = grid[(j + 1) * stride + i]!
      const x0 = source.sx + i * cellW
      const y0 = source.sy + j * cellH
      const x1 = x0 + cellW
      const y1 = y0 + cellH
      drawTriangle(ctx, source.image, x0, y0, x1, y0, x1, y1, a, b, c)
      drawTriangle(ctx, source.image, x0, y0, x1, y1, x0, y1, a, c, d)
    }
  }
}

/**
 * One triangle of picture pixels (s0, s1, s2) onto one mapped triangle (p0,
 * p1, p2): the affine M with M·s = p, solved from the two edge vectors.
 */
function drawTriangle(
  ctx: WarpContext,
  image: CanvasImageSource,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
): void {
  const ax = sx1 - sx0
  const ay = sy1 - sy0
  const bx = sx2 - sx0
  const by = sy2 - sy0
  const det = ax * by - ay * bx
  if (Math.abs(det) < 1e-12) return
  const ux = p1.x - p0.x
  const uy = p1.y - p0.y
  const vx = p2.x - p0.x
  const vy = p2.y - p0.y
  // Columns of M: where the picture's x and y unit vectors go.
  const a = (ux * by - vx * ay) / det
  const b = (uy * by - vy * ay) / det
  const c = (vx * ax - ux * bx) / det
  const d = (vy * ax - uy * bx) / det
  const e = p0.x - a * sx0 - c * sy0
  const f = p0.y - b * sx0 - d * sy0

  const [g0, g1, g2] = outset(p0, p1, p2, SEAM)

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(g0.x, g0.y)
  ctx.lineTo(g1.x, g1.y)
  ctx.lineTo(g2.x, g2.y)
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, b, c, d, e, f)
  ctx.drawImage(image, 0, 0)
  ctx.restore()
}

/**
 * The triangle with every edge pushed out by `by`, edges staying parallel to
 * themselves — so the overlap with a neighbour is `by` wide all along the
 * shared edge, corners included. Pushing the corners out from the centroid
 * instead thinned the overlap towards every corner, and the two softened
 * edges there did not add up to solid.
 */
function outset(p0: Vec2, p1: Vec2, p2: Vec2, by: number): [Vec2, Vec2, Vec2] {
  const corners = [p0, p1, p2]
  const out: Vec2[] = []
  for (let k = 0; k < 3; k++) {
    const p = corners[k]!
    const prev = corners[(k + 2) % 3]!
    const next = corners[(k + 1) % 3]!
    // Unit normals of the two edges at this corner, pointing away from the
    // opposite corner; the corner moves along their sum, far enough that both
    // edges shift by `by`.
    const nIn = awayNormal(prev, p, next)
    const nOut = awayNormal(p, next, prev)
    const sx = nIn.x + nOut.x
    const sy = nIn.y + nOut.y
    const dot = sx * nIn.x + sy * nIn.y
    if (Math.abs(dot) < 1e-9) {
      out.push(p)
      continue
    }
    const t = by / dot
    out.push({ x: p.x + sx * t, y: p.y + sy * t })
  }
  return out as [Vec2, Vec2, Vec2]
}

/** The unit normal of edge a→b that points away from `other`. */
function awayNormal(a: Vec2, b: Vec2, other: Vec2): Vec2 {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const length = Math.hypot(ex, ey)
  if (length < 1e-12) return { x: 0, y: 0 }
  let nx = -ey / length
  let ny = ex / length
  if (nx * (other.x - a.x) + ny * (other.y - a.y) > 0) {
    nx = -nx
    ny = -ny
  }
  return { x: nx, y: ny }
}
