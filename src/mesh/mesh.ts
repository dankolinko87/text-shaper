import {
  evaluatePatch,
  tableFromPolyline,
  type OutlinePatch,
  type PatchEdge,
} from '../geometry/patch'
import type { Rect, Vec2 } from '../types/document'
import type { MeshNode, MeshSpacing, MeshState, MeshTile, MeshTileLayout } from '../types/mesh'
import { createId } from '../utils/id'

/**
 * The geometry of a mesh: polygons, insets, the map a letter is poured through,
 * the rim, and the chains a drag follows.
 *
 * Pure, and DOM-free — this runs in the renderer, in the thumbnails, in the GIF
 * exporter and in the tests, and none of them may disagree about where a tile
 * is. A ring is positive signed area with y pointing down (clockwise on screen),
 * which is the way a patch's outline runs; every rule below assumes it, and
 * `validateMesh` enforces it.
 */

export type Positions = Readonly<Record<string, Vec2>>
/** One path command as Fabric and the exporters take it: `['M', x, y]`, `['L', x, y]`, `['Q', cx, cy, x, y]`, `['Z']`. */
export type PathCommand = (string | number)[]

/**
 * Entries in a cell edge's lookup table.
 *
 * A cell is a letter's width and its sides are straight between their points,
 * so sixty-four samples along a side are exact everywhere but at a bend, and
 * within a hair of it there. The container's patch keeps five hundred because
 * a container is a page and its edges are curves.
 */
export const CELL_TABLE = 64
/** Below this, an inset polygon collapses to nothing rather than drawing as a sliver. */
export const MINIMUM_VISIBLE = 2
/** How far a mitred corner may reach past its vertex, as a multiple of the inset. SVG's own default. */
const MITRE_LIMIT = 4
/** Within this many degrees of straight on, an edge continues the one before it. */
const COLLINEAR_DEGREES = 12
const EPSILON = 1e-9
const ORIGIN: Vec2 = { x: 0, y: 0 }

const nodeId = (): string => createId('mn')
const tileId = (): string => createId('mt')

/* ------------------------------------------------------------------ seed */

export interface SeededMesh {
  nodes: MeshNode[]
  tiles: MeshTile[]
  positions: Record<string, Vec2>
}

/**
 * A fresh mesh: a plain `columns × rows` grid, centred on its own origin.
 *
 * Every tile shares its corner nodes with its neighbours, so a new mesh is
 * fully aligned — dragging a corner moves every tile that meets at it. Tiles
 * are emitted row by row, so their order is reading order for a fresh grid.
 */
export function seedMesh(columns: number, rows: number, cell: number): SeededMesh {
  const cols = Math.max(1, Math.floor(columns))
  const count = Math.max(1, Math.floor(rows))

  const nodes: MeshNode[] = []
  const positions: Record<string, Vec2> = {}
  const grid: string[][] = []
  for (let j = 0; j <= count; j++) {
    const row: string[] = []
    for (let i = 0; i <= cols; i++) {
      const id = nodeId()
      nodes.push({ id })
      positions[id] = { x: (i - cols / 2) * cell, y: (j - count / 2) * cell }
      row.push(id)
    }
    grid.push(row)
  }

  const tiles: MeshTile[] = []
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < cols; i++) {
      const tl = grid[j]?.[i]
      const tr = grid[j]?.[i + 1]
      const br = grid[j + 1]?.[i + 1]
      const bl = grid[j + 1]?.[i]
      if (!tl || !tr || !br || !bl) continue
      tiles.push({ id: tileId(), ring: [tl, tr, br, bl], corners: [tl, tr, br, bl] })
    }
  }

  return { nodes, tiles, positions }
}

/* -------------------------------------------------------------- polygons */

/** Signed shoelace area: positive for a ring walked clockwise on screen (y down). */
export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (!a || !b) continue
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** The area centroid, or the mean of the points when there is no area to speak of. */
export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  const n = points.length
  if (n === 0) return { ...ORIGIN }
  const area = polygonArea(points)
  if (Math.abs(area) < EPSILON) {
    let x = 0
    let y = 0
    for (const p of points) {
      x += p.x
      y += p.y
    }
    return { x: x / n, y: y / n }
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (!a || !b) continue
    const cross = a.x * b.y - b.x * a.y
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

export function polygonBounds(points: readonly Vec2[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Even-odd ray cast. A point on an edge may answer either way; callers that care test edges first. */
export function pointInPolygon(point: Vec2, points: readonly Vec2[]): boolean {
  const n = points.length
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[i]
    const b = points[j]
    if (!a || !b) continue
    if (a.y > point.y !== b.y > point.y) {
      const x = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y)
      if (point.x < x) inside = !inside
    }
  }
  return inside
}

const orient = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** Whether `c`, known to be collinear with `ab`, lies within the segment. */
const onSegment = (a: Vec2, b: Vec2, c: Vec2): boolean =>
  c.x >= Math.min(a.x, b.x) - EPSILON &&
  c.x <= Math.max(a.x, b.x) + EPSILON &&
  c.y >= Math.min(a.y, b.y) - EPSILON &&
  c.y <= Math.max(a.y, b.y) + EPSILON

/** Whether two segments cross or touch anywhere, shared endpoints included. */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  const opposite = (p: number, q: number): boolean =>
    (p > EPSILON && q < -EPSILON) || (p < -EPSILON && q > EPSILON)
  if (opposite(o1, o2) && opposite(o3, o4)) return true
  if (Math.abs(o1) <= EPSILON && onSegment(a, b, c)) return true
  if (Math.abs(o2) <= EPSILON && onSegment(a, b, d)) return true
  if (Math.abs(o3) <= EPSILON && onSegment(c, d, a)) return true
  if (Math.abs(o4) <= EPSILON && onSegment(c, d, b)) return true
  return false
}

/**
 * Whether the ring is a simple polygon: no two sides meet except neighbours
 * at their shared vertex, and no neighbour doubles back over the last.
 */
export function isSimple(points: readonly Vec2[]): boolean {
  const n = points.length
  if (n < 3) return false
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (!a || !b) return false
    for (let j = i + 1; j < n; j++) {
      const c = points[j]
      const d = points[(j + 1) % n]
      if (!c || !d) return false
      const adjacent = j === i + 1 || (i === 0 && j === n - 1)
      if (adjacent) {
        // Sharing a vertex is allowed; folding back over the other side is not.
        const shared = j === i + 1 ? b : a
        const farA = j === i + 1 ? a : b
        const farC = j === i + 1 ? d : c
        if (
          Math.abs(orient(shared, farA, farC)) <= EPSILON &&
          (farA.x - shared.x) * (farC.x - shared.x) + (farA.y - shared.y) * (farC.y - shared.y) > EPSILON
        ) {
          return false
        }
        continue
      }
      if (segmentsIntersect(a, b, c, d)) return false
    }
  }
  return true
}

/** Whether every turn goes the same way as the ring's area says it should. */
export function isConvex(points: readonly Vec2[]): boolean {
  const n = points.length
  if (n < 3) return false
  const sign = polygonArea(points) >= 0 ? 1 : -1
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const c = points[(i + 2) % n]
    if (!a || !b || !c) return false
    if (orient(a, b, c) * sign < -EPSILON) return false
  }
  return true
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * The rectangle these four corners are, when they are one — axis-aligned, in
 * the order top-left, top-right, bottom-right, bottom-left, with real area.
 */
export function rectangleOf(corners: readonly Vec2[]): Rect | null {
  if (corners.length !== 4) return null
  const [tl, tr, br, bl] = corners as [Vec2, Vec2, Vec2, Vec2]
  const width = tr.x - tl.x
  const height = bl.y - tl.y
  if (!(width > EPSILON) || !(height > EPSILON)) return null
  const near = (p: number, q: number): boolean => Math.abs(p - q) <= 1e-7 * Math.max(1, Math.abs(p), Math.abs(q))
  if (!near(tl.y, tr.y) || !near(bl.y, br.y) || !near(tl.x, bl.x) || !near(tr.x, br.x)) return null
  return { x: tl.x, y: tl.y, width, height }
}

/* ---------------------------------------------------------------- insets */

export interface InsetOptions {
  mitreLimit?: number
  /** Below this area the result is refused, so a sliver never draws. */
  minimumArea?: number
}

/**
 * The polygon moved inward by a distance per side.
 *
 * Each side is shifted along its inward normal by its inset, and each new
 * vertex is where two shifted sides meet — a mitre. Two collinear sides (a
 * bend point on a straight side) meet nowhere, so their vertex is projected
 * by the mean of the two insets instead. A sharp vertex would send its mitre
 * far past itself, so a mitre is clamped along its own direction at
 * `mitreLimit` times the larger inset — clamped rather than bevelled, because
 * a bevel adds a vertex and everything downstream relies on a point of the
 * inset polygon corresponding to a point of the original.
 *
 * A side SHORTER than the inset is swallowed, not fatal. Two nodes close
 * together — a cut that ended a hair from a node, a point added beside a
 * corner, the tips of two thin cells meeting — make a side the inset runs
 * through and out the other end, reversed. That used to void the whole
 * polygon, so a tile vanished the moment the gap grew past the length of
 * its shortest side, and came back when it shrank. Now both ends of such a
 * side land on the one point where its neighbours' inset lines meet — the
 * vertex a true offset would have — which keeps a point of the inset for
 * every point of the original, as everything downstream relies on.
 *
 * Null when the inset ate the polygon: the area went below the minimum, it
 * turned inside out, or the result crosses itself. The caller collapses to
 * the centroid, which is what the mosaic's `clampRect` does with a rectangle
 * inset past nothing — collapse rather than invert.
 */
export function insetPolygon(
  points: readonly Vec2[],
  insets: readonly number[],
  options: InsetOptions = {},
): Vec2[] | null {
  const n = points.length
  if (n < 3) return null
  const mitreLimit = options.mitreLimit ?? MITRE_LIMIT
  const minimumArea = options.minimumArea ?? 0

  const sign = polygonArea(points) >= 0 ? 1 : -1
  const dirs: Vec2[] = []
  let last: Vec2 = { x: 1, y: 0 }
  for (let i = 0; i < n; i++) {
    const a = points[i] ?? ORIGIN
    const b = points[(i + 1) % n] ?? ORIGIN
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    // A side of no length borrows the direction of the one before it, so a
    // repeated point neither divides by zero nor turns the polygon.
    if (length > EPSILON) last = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    dirs.push(last)
  }
  // The inward normal of a clockwise-on-screen side is its direction turned a
  // quarter turn the same way; a ring the other way round flips it.
  const normals = dirs.map((d) => ({ x: -d.y * sign, y: d.x * sign }))

  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n
    const p = points[i] ?? ORIGIN
    const d1 = dirs[prev] ?? last
    const d2 = dirs[i] ?? last
    const n1 = normals[prev] ?? ORIGIN
    const n2 = normals[i] ?? ORIGIN
    const a = insets[prev] ?? 0
    const b = insets[i] ?? 0
    const cross = d1.x * d2.y - d1.y * d2.x

    if (Math.abs(cross) < 1e-9) {
      const mean = (a + b) / 2
      out.push({ x: p.x + n2.x * mean, y: p.y + n2.y * mean })
      continue
    }

    // Side before: p + a·n1 + s·d1. Side after: p + b·n2 + t·d2. Meet where
    // s·d1 − t·d2 = b·n2 − a·n1; crossing both sides with d2 isolates s.
    const rx = b * n2.x - a * n1.x
    const ry = b * n2.y - a * n1.y
    const s = (rx * d2.y - ry * d2.x) / cross
    let qx = p.x + a * n1.x + s * d1.x
    let qy = p.y + a * n1.y + s * d1.y

    const reach = Math.hypot(qx - p.x, qy - p.y)
    const limit = mitreLimit * Math.max(a, b)
    if (limit > 0 && reach > limit) {
      qx = p.x + ((qx - p.x) * limit) / reach
      qy = p.y + ((qy - p.y) * limit) / reach
    }
    out.push({ x: qx, y: qy })
  }

  if (!insets.some((inset) => inset > 0)) return out

  /*
   * A side that now runs the other way has been inset through itself: its
   * two ends swap places for the point where the sides either side of it
   * meet. One at a time, because swallowing a side moves its neighbours'
   * ends and can shorten the next side past nothing too; a polygon with no
   * sides left to run forward is eaten, which the area check below says.
   */
  const reversed = (i: number): boolean => {
    const a = points[i] ?? ORIGIN
    const b = points[(i + 1) % n] ?? ORIGIN
    const c = out[i] ?? ORIGIN
    const d = out[(i + 1) % n] ?? ORIGIN
    const ox = b.x - a.x
    const oy = b.y - a.y
    if (ox * ox + oy * oy <= EPSILON) return false
    return (d.x - c.x) * ox + (d.y - c.y) * oy < 0
  }
  for (let pass = 0; pass < n; pass++) {
    const i = Array.from({ length: n }, (_, k) => k).find(reversed)
    if (i === undefined) break
    const j = (i + 1) % n
    const before = (i - 1 + n) % n
    const after = (j + 1) % n
    // The side before runs from point `before` to `i`; the side after from `j` to `after`.
    const p1 = points[before] ?? ORIGIN
    const p2 = points[j] ?? ORIGIN
    const d1 = dirs[before] ?? last
    const d2 = dirs[j] ?? last
    const n1 = normals[before] ?? ORIGIN
    const n2 = normals[j] ?? ORIGIN
    const a = insets[before] ?? 0
    const b = insets[j] ?? 0
    const pi = points[i] ?? ORIGIN
    const pj = points[j] ?? ORIGIN
    const anchor = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 }
    const cross = d1.x * d2.y - d1.y * d2.x
    let q: Vec2
    if (Math.abs(cross) < 1e-9) {
      const mean = (a + b) / 2
      q = { x: anchor.x + n2.x * mean, y: anchor.y + n2.y * mean }
    } else {
      const rx = p2.x + b * n2.x - (p1.x + a * n1.x)
      const ry = p2.y + b * n2.y - (p1.y + a * n1.y)
      const s = (rx * d2.y - ry * d2.x) / cross
      q = { x: p1.x + a * n1.x + s * d1.x, y: p1.y + a * n1.y + s * d1.y }
      const reach = Math.hypot(q.x - anchor.x, q.y - anchor.y)
      const limit = mitreLimit * Math.max(a, b)
      if (limit > 0 && reach > limit) {
        q = {
          x: anchor.x + ((q.x - anchor.x) * limit) / reach,
          y: anchor.y + ((q.y - anchor.y) * limit) / reach,
        }
      }
    }
    if (after === before) {
      // A triangle whose one side went: nothing is left to meet.
      return null
    }
    out[i] = { ...q }
    out[j] = { ...q }
  }

  const area = polygonArea(out)
  if (!(area * sign > EPSILON) || Math.abs(area) < minimumArea) return null
  if (Array.from({ length: n }, (_, k) => k).some(reversed)) return null
  // Simplicity is judged with swallowed sides folded away: a repeated point
  // is two sides touching, which is not a crossing.
  const distinct = out.filter((p, i) => {
    const prev = out[(i - 1 + n) % n] ?? ORIGIN
    return Math.abs(p.x - prev.x) > EPSILON || Math.abs(p.y - prev.y) > EPSILON
  })
  if (distinct.length < 3 || !isSimple(distinct)) return null
  return out
}

/** Every point at the centroid: a polygon that has been inset past nothing. */
export function collapsedAt(centre: Vec2, count: number): Vec2[] {
  return Array.from({ length: count }, () => ({ ...centre }))
}

/**
 * As much of an inset as a polygon has room for: up to the shortest distance
 * from its centroid to any side, less whatever must survive — the polygon
 * form of the mosaic's `fittingInset`, and identical to it on a rectangle.
 */
export function fittingInset(points: readonly Vec2[], by: number, minimum: number): number {
  if (!(by > 0)) return 0
  const centre = polygonCentroid(points)
  let inradius = Infinity
  const n = points.length
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (!a || !b) continue
    inradius = Math.min(inradius, distanceToSegment(centre, a, b))
  }
  if (!Number.isFinite(inradius)) return 0
  const room = inradius - minimum / 2
  return Math.max(0, Math.min(by, room))
}

/* ------------------------------------------------------------------ edges */

export interface MeshEdge {
  key: string
  /** The edge's ends, in the direction the FIRST tile that names it walks them. */
  a: string
  b: string
  tiles: string[]
}

export const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Every edge of the mesh, and which tiles it belongs to. */
export function edgesOf(tiles: readonly MeshTile[]): Map<string, MeshEdge> {
  const out = new Map<string, MeshEdge>()
  for (const tile of tiles) {
    const n = tile.ring.length
    for (let i = 0; i < n; i++) {
      const a = tile.ring[i]
      const b = tile.ring[(i + 1) % n]
      if (!a || !b) continue
      const key = edgeKey(a, b)
      const found = out.get(key)
      if (found) found.tiles.push(tile.id)
      else out.set(key, { key, a, b, tiles: [tile.id] })
    }
  }
  return out
}

/** Whether an edge sits between two tiles, asked of a map from `edgesOf`. */
export function interiorOf(edges: ReadonlyMap<string, MeshEdge>): (a: string, b: string) => boolean {
  return (a, b) => (edges.get(edgeKey(a, b))?.tiles.length ?? 0) > 1
}

/**
 * The loops of rim edges — the mesh's silhouette — as node ids.
 *
 * A rim edge belongs to one tile, and is walked the way that tile walks it,
 * so the outer loop comes out with positive area and a hole's loop, whose
 * tiles surround it, with negative — which is exactly what an even-odd clip
 * wants.
 */
export function rimLoops(tiles: readonly MeshTile[]): string[][] {
  const rim = [...edgesOf(tiles).values()].filter((edge) => edge.tiles.length === 1)
  const outgoing = new Map<string, MeshEdge[]>()
  for (const edge of rim) {
    const list = outgoing.get(edge.a)
    if (list) list.push(edge)
    else outgoing.set(edge.a, [edge])
  }

  const used = new Set<string>()
  const loops: string[][] = []
  for (const start of rim) {
    if (used.has(start.key)) continue
    const loop: string[] = []
    let current: MeshEdge | undefined = start
    while (current && !used.has(current.key)) {
      used.add(current.key)
      loop.push(current.a)
      const next: MeshEdge | undefined = (outgoing.get(current.b) ?? []).find(
        (edge) => !used.has(edge.key),
      )
      current = next
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/**
 * The straight run of edges an edge belongs to.
 *
 * From either end, the walk continues through a node only when four edges
 * meet there — the crossing a grid is made of — and only along the edge that
 * carries straight on, within a few degrees. It stops at a T, at a bend, at
 * the rim. On a fresh grid that is the whole divider, so dragging one edge of
 * a column still moves the column; once a corner has been pulled out of line,
 * the chain ends where the line does.
 */
export function collinearChain(
  tiles: readonly MeshTile[],
  positions: Positions,
  edge: readonly [string, string],
  toleranceDegrees = COLLINEAR_DEGREES,
): [string, string][] {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const set = adjacency.get(a)
    if (set) set.add(b)
    else adjacency.set(a, new Set([b]))
  }
  for (const tile of tiles) {
    const n = tile.ring.length
    for (let i = 0; i < n; i++) {
      const a = tile.ring[i]
      const b = tile.ring[(i + 1) % n]
      if (!a || !b) continue
      link(a, b)
      link(b, a)
    }
  }

  const threshold = Math.cos((toleranceDegrees * Math.PI) / 180)
  const unit = (from: string, to: string): Vec2 | null => {
    const a = positions[from]
    const b = positions[to]
    if (!a || !b) return null
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    return length > EPSILON ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null
  }

  const extend = (from: string, to: string): [string, string][] => {
    const out: [string, string][] = []
    const seen = new Set([from, to])
    let prev = from
    let at = to
    for (;;) {
      const around = adjacency.get(at)
      if (!around || around.size !== 4) break
      const d = unit(prev, at)
      if (!d) break
      let best: string | null = null
      let bestDot = threshold
      for (const next of around) {
        if (seen.has(next)) continue
        const e = unit(at, next)
        if (!e) continue
        const dot = d.x * e.x + d.y * e.y
        if (dot > bestDot) {
          bestDot = dot
          best = next
        }
      }
      if (!best) break
      out.push([at, best])
      seen.add(best)
      prev = at
      at = best
    }
    return out
  }

  const forward = extend(edge[0], edge[1])
  const backward = extend(edge[1], edge[0])
  return [
    ...backward.map(([a, b]) => [b, a] as [string, string]).reverse(),
    [edge[0], edge[1]],
    ...forward,
  ]
}

/* ------------------------------------------------------------------ cells */

/**
 * A Coons patch whose four sides are the polylines between the ring's corners.
 *
 * Built from the points alone — no sampling, no curve fit — so its sides are
 * straight between bend points, as the ring is. `evaluatePatch` reads only the
 * tables and the corners, so a patch made here is evaluated exactly as one
 * built from an outline; the control points are kept in the edge's own
 * parameter space as `PatchEdge` documents, in case anything ever refreshes it.
 */
export function patchFromPolygon(
  points: readonly Vec2[],
  corners: readonly [number, number, number, number],
  entries = CELL_TABLE,
): OutlinePatch {
  const n = points.length
  const at = (i: number): Vec2 => points[((i % n) + n) % n] ?? ORIGIN
  /** The ring's points from one index round to another, both included. */
  const side = (from: number, to: number): Vec2[] => {
    const out: Vec2[] = [{ ...at(from) }]
    let i = from
    while (((i % n) + n) % n !== ((to % n) + n) % n && out.length <= n) {
      i++
      out.push({ ...at(i) })
    }
    return out
  }
  const [i0, i1, i2, i3] = corners
  const top = side(i0, i1)
  const right = side(i1, i2)
  const bottom = side(i2, i3).reverse()
  const left = side(i3, i0).reverse()

  const edge = (polyline: Vec2[], axis: 'x' | 'y'): PatchEdge => ({
    points: polyline.map((p) => (axis === 'x' ? { x: p.x, y: p.y } : { x: p.y, y: p.x })),
    axis,
    table: tableFromPolyline(polyline, entries),
  })

  return {
    top: edge(top, 'x'),
    bottom: edge(bottom, 'x'),
    left: edge(left, 'y'),
    right: edge(right, 'y'),
    corners: { p00: { ...at(i0) }, p10: { ...at(i1) }, p11: { ...at(i2) }, p01: { ...at(i3) } },
  }
}

/** The bilinear map of the unit square onto a quad — a Coons patch with straight sides. */
export function bilinearQuad(
  p00: Vec2,
  p10: Vec2,
  p11: Vec2,
  p01: Vec2,
  u: number,
  v: number,
): Vec2 {
  const iu = 1 - u
  const iv = 1 - v
  return {
    x: iu * iv * p00.x + u * iv * p10.x + u * v * p11.x + iu * v * p01.x,
    y: iu * iv * p00.y + u * iv * p10.y + u * v * p11.y + iu * v * p01.y,
  }
}

/**
 * Where the unit square lands in this tile, or null when the polygon has
 * collapsed and there is nothing to draw into.
 *
 * Three cases, cheapest first: an axis-aligned rectangle is a scale and a
 * shift; a plain quad is bilinear; a ring with bend points is the patch.
 *
 * Over the GLYPH polygon by default — where the letters are poured — or over
 * the VISIBLE one, the tile's whole face, for a picture that fills the tile
 * rather than the letter in it. The visible tiers are worked out on demand
 * and kept on the layout, since a patch's tables are not free.
 */
export function cellMap(
  layout: MeshTileLayout,
  which: 'glyph' | 'visible' = 'glyph',
): ((u: number, v: number) => Vec2) | null {
  if (which === 'visible') {
    if (layout.visibleRect === undefined) {
      const [i0, i1, i2, i3] = layout.cornerIndices
      const corners = [i0, i1, i2, i3].map((i) => layout.visible[i] ?? ORIGIN)
      const usable = layout.cornerIndices.every((i) => i >= 0) && polygonArea(layout.visible) > EPSILON
      const rect = usable ? rectangleOf(corners) : null
      layout.visibleRect = rect
      layout.visiblePatch =
        usable && !rect && layout.visible.length > 4
          ? patchFromPolygon(layout.visible, layout.cornerIndices)
          : null
    }
    return mapOver(layout.visible, layout.cornerIndices, layout.visibleRect, layout.visiblePatch ?? null)
  }
  return mapOver(layout.glyph, layout.cornerIndices, layout.rect, layout.patch)
}

function mapOver(
  polygon: readonly Vec2[],
  cornerIndices: readonly [number, number, number, number],
  rect: Rect | null,
  patch: OutlinePatch | null,
): ((u: number, v: number) => Vec2) | null {
  if (rect) return (u, v) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height })
  if (patch) return (u, v) => evaluatePatch(patch, u, v)
  const [i0, i1, i2, i3] = cornerIndices
  const p00 = polygon[i0]
  const p10 = polygon[i1]
  const p11 = polygon[i2]
  const p01 = polygon[i3]
  if (!p00 || !p10 || !p11 || !p01) return null
  if (!(Math.abs(polygonArea(polygon)) > EPSILON)) return null
  return (u, v) => bilinearQuad(p00, p10, p11, p01, u, v)
}

/**
 * One tile's polygons, from the ring's positions.
 *
 * The same three steps the mosaic's layout takes — structural, then inset by
 * half a gap on interior sides, then by the glyph inset — on polygons instead
 * of rectangles, and with the same answer when the polygon is a rectangle.
 */
export function tileLayout(
  tile: MeshTile,
  positions: Positions,
  spacing: MeshSpacing,
  interior: (a: string, b: string) => boolean,
): MeshTileLayout {
  const ring = tile.ring
  const n = ring.length
  const structural = ring.map((id) => ({ ...(positions[id] ?? ORIGIN) }))
  const half = Math.max(0, spacing.gap) / 2
  const minimum = Math.max(0, spacing.minimumVisibleSize ?? 0)
  const minimumArea = minimum * minimum
  const centre = polygonCentroid(structural)

  const insets = ring.map((id, i) => (interior(id, ring[(i + 1) % n] ?? id) ? half : 0))
  const visible = insetPolygon(structural, insets, { minimumArea }) ?? collapsedAt(centre, n)

  const by = fittingInset(visible, spacing.glyphInset, minimum)
  const glyph =
    by > 0
      ? (insetPolygon(visible, ring.map(() => by), { minimumArea }) ??
        collapsedAt(polygonCentroid(visible), n))
      : visible.map((p) => ({ ...p }))

  const cornerIndices = tile.corners.map((id) => ring.indexOf(id)) as [number, number, number, number]
  const cornerPoints = cornerIndices.map((i) => glyph[i] ?? ORIGIN)
  const usable = cornerIndices.every((i) => i >= 0) && polygonArea(glyph) > EPSILON
  const rect = usable ? rectangleOf(cornerPoints) : null
  const patch = usable && !rect && n > 4 ? patchFromPolygon(glyph, cornerIndices) : null

  return {
    structural,
    visible,
    glyph,
    bounds: polygonBounds(structural),
    centre,
    cornerIndices,
    rect,
    patch,
  }
}

/* ------------------------------------------------------------------ paths */

/**
 * A polygon with its corners rounded, as path commands.
 *
 * Every vertex gets an `L` to where its arc starts and a `Q` through the vertex
 * to where it ends, whatever the radius — at zero the arc is a corner with
 * both ends on it. That keeps the command count fixed at `2n + 1`, which is
 * what lets playback rewrite the numbers in place as the radius animates
 * through zero. Each corner's radius is clamped to half the shorter of its two
 * sides, the per-vertex form of the mosaic's `fittedRadius`.
 */
export function roundedPolygonCommands(points: readonly Vec2[], radius: number): PathCommand[] {
  const n = points.length
  const out: PathCommand[] = []
  if (n === 0) return out
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0

  const arcs: { start: Vec2; end: Vec2; vertex: Vec2 }[] = []
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n] ?? ORIGIN
    const p = points[i] ?? ORIGIN
    const next = points[(i + 1) % n] ?? ORIGIN
    const lengthIn = Math.hypot(p.x - prev.x, p.y - prev.y)
    const lengthOut = Math.hypot(next.x - p.x, next.y - p.y)
    const fitted = Math.min(r, lengthIn / 2, lengthOut / 2)
    const start =
      lengthIn > EPSILON
        ? { x: p.x - ((p.x - prev.x) / lengthIn) * fitted, y: p.y - ((p.y - prev.y) / lengthIn) * fitted }
        : { ...p }
    const end =
      lengthOut > EPSILON
        ? { x: p.x + ((next.x - p.x) / lengthOut) * fitted, y: p.y + ((next.y - p.y) / lengthOut) * fitted }
        : { ...p }
    arcs.push({ start, end, vertex: p })
  }

  const first = arcs[0]
  if (!first) return out
  out.push(['M', first.start.x, first.start.y])
  out.push(['Q', first.vertex.x, first.vertex.y, first.end.x, first.end.y])
  for (let i = 1; i < n; i++) {
    const arc = arcs[i]
    if (!arc) continue
    out.push(['L', arc.start.x, arc.start.y])
    out.push(['Q', arc.vertex.x, arc.vertex.y, arc.end.x, arc.end.y])
  }
  out.push(['Z'])
  return out
}

/** Plain polygon commands: `M`, `L`…, `Z`. */
export function polygonCommands(points: readonly Vec2[]): PathCommand[] {
  const out: PathCommand[] = []
  points.forEach((p, i) => out.push([i === 0 ? 'M' : 'L', p.x, p.y]))
  if (points.length > 0) out.push(['Z'])
  return out
}

/** Commands to an SVG `d` string, for the thumbnails. */
export function commandsToPath(commands: readonly PathCommand[], places = 3): string {
  const n = (v: string | number): string =>
    typeof v === 'number' ? Number(v.toFixed(places)).toString() : v
  return commands.map((command) => command.map(n).join(' ')).join(' ')
}

/* -------------------------------------------------------------- the mesh */

/** The box every node of every state sits in — a mesh's `localBounds`. */
export function meshBounds(states: readonly Pick<MeshState, 'nodes'>[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const state of states) {
    for (const p of Object.values(state.nodes)) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Everything a mesh must satisfy, as a list of what it does not.
 *
 * Empty for a sound mesh. The invariants: node ids unique; every ring member a
 * node; rings of at least three; corners four ring members in ring order; no
 * edge in more than two tiles; every state naming every node with finite
 * positions; every ring a simple polygon of positive area in every state.
 */
export function validateMesh(
  nodes: readonly MeshNode[],
  tiles: readonly MeshTile[],
  states: readonly Pick<MeshState, 'id' | 'nodes'>[],
): string[] {
  const problems: string[] = []
  const known = new Set<string>()
  for (const node of nodes) {
    if (known.has(node.id)) problems.push(`node ${node.id} is listed twice`)
    known.add(node.id)
  }

  for (const tile of tiles) {
    if (tile.ring.length < 3) problems.push(`tile ${tile.id} has fewer than three points`)
    for (const id of tile.ring) {
      if (!known.has(id)) problems.push(`tile ${tile.id} names unknown node ${id}`)
    }
    if (new Set(tile.ring).size !== tile.ring.length) {
      problems.push(`tile ${tile.id} repeats a node in its ring`)
    }
    const indices = tile.corners.map((id) => tile.ring.indexOf(id))
    if (indices.some((i) => i < 0)) {
      problems.push(`tile ${tile.id} has a corner that is not in its ring`)
    } else {
      // In ring order, read round the cycle: at most one step back (the
      // wrap), and a triangle may repeat its tip wherever the tip sits.
      let descents = 0
      for (let i = 0; i < 4; i++) {
        if ((indices[(i + 1) % 4] as number) < (indices[i] as number)) descents++
      }
      if (descents > 1 || new Set(indices).size < 3) {
        problems.push(`tile ${tile.id} has corners out of ring order`)
      }
    }
  }

  for (const edge of edgesOf(tiles).values()) {
    if (edge.tiles.length > 2) problems.push(`edge ${edge.key} belongs to ${edge.tiles.length} tiles`)
  }

  for (const state of states) {
    for (const node of nodes) {
      const p = state.nodes[node.id]
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        problems.push(`state ${state.id} does not place node ${node.id}`)
      }
    }
    for (const tile of tiles) {
      const ring = tile.ring.map((id) => state.nodes[id] ?? ORIGIN)
      if (!(polygonArea(ring) > EPSILON)) {
        problems.push(`tile ${tile.id} has no area in state ${state.id}`)
      } else if (!isSimple(ring)) {
        problems.push(`tile ${tile.id} crosses itself in state ${state.id}`)
      }
    }
  }

  return problems
}
