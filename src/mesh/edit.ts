import { snapPosition, snaps } from '../mosaic/snap'
import type { Vec2 } from '../types/document'
import type { MeshSpacing, MeshTile } from '../types/mesh'
import {
  MINIMUM_VISIBLE,
  collinearChain,
  distanceToSegment,
  edgesOf,
  isSimple,
  polygonArea,
  segmentsIntersect,
  type Positions,
} from './mesh'

/**
 * Reshaping a mesh by hand: which handle is under the pointer, what a drag on
 * it moves, and where the nodes may go.
 *
 * Pure, like the mosaic's `boundaries.ts`: the layer asks these questions
 * with the pointer in the mesh's own space and writes back what they answer.
 * A handle is a NODE or an EDGE. Dragging a node moves it; dragging an edge
 * moves its two nodes and the straight run they belong to, so a fresh grid's
 * divider moves as one line until a corner has been pulled out of it. Every
 * move is snapped to the object's grid and then held back to the last point
 * at which no cell folds — the same shape as `moveEdge`'s answer, `positions`
 * and whether they fell short of the pointer.
 */

/** Reach of a hit test, in the mesh's own units, one per axis: see `MosaicLayer`'s `at`. */
export interface Tolerance {
  x: number
  y: number
}

export type MeshHandle =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; a: string; b: string }

export const sameHandle = (p: MeshHandle | null, q: MeshHandle | null): boolean => {
  if (!p || !q) return p === q
  if (p.kind === 'node') return q.kind === 'node' && p.id === q.id
  return q.kind === 'edge' && ((p.a === q.a && p.b === q.b) || (p.a === q.b && p.b === q.a))
}

/** Every node that appears in a ring, once. */
export function nodesOf(tiles: readonly MeshTile[]): string[] {
  const seen = new Set<string>()
  for (const tile of tiles) for (const id of tile.ring) seen.add(id)
  return [...seen]
}

/**
 * The node under a point, or null.
 *
 * Measured per axis in tolerance units, so the reach is a circle on SCREEN
 * whatever the object's scale; the nearest wins when two are within reach.
 */
export function nodeAt(
  positions: Positions,
  ids: readonly string[],
  point: Vec2,
  tolerance: Tolerance,
): string | null {
  let best: string | null = null
  let bestScore = 1
  for (const id of ids) {
    const p = positions[id]
    if (!p) continue
    const dx = (p.x - point.x) / (tolerance.x || 1)
    const dy = (p.y - point.y) / (tolerance.y || 1)
    const score = dx * dx + dy * dy
    if (score <= bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

/**
 * The edge under a point, or null — the nearest segment within reach, in the
 * same screen-shaped units as `nodeAt`.
 */
export function edgeAt(
  positions: Positions,
  edges: readonly (readonly [string, string])[],
  point: Vec2,
  tolerance: Tolerance,
): [string, string] | null {
  const sx = 1 / (tolerance.x || 1)
  const sy = 1 / (tolerance.y || 1)
  const scaled = (p: Vec2): Vec2 => ({ x: p.x * sx, y: p.y * sy })
  const q = scaled(point)
  let best: [string, string] | null = null
  let bestScore = 1
  for (const [a, b] of edges) {
    const p = positions[a]
    const r = positions[b]
    if (!p || !r) continue
    const score = distanceToSegment(q, scaled(p), scaled(r))
    if (score <= bestScore) {
      bestScore = score
      best = [a, b]
    }
  }
  return best
}

/** The handle under a point: a node before an edge, because a node sits on every edge it ends. */
export function handleAt(
  tiles: readonly MeshTile[],
  positions: Positions,
  point: Vec2,
  tolerance: Tolerance,
): MeshHandle | null {
  const node = nodeAt(positions, nodesOf(tiles), point, tolerance)
  if (node) return { kind: 'node', id: node }
  const edges = [...edgesOf(tiles).values()].map((edge) => [edge.a, edge.b] as const)
  const edge = edgeAt(positions, edges, point, tolerance)
  return edge ? { kind: 'edge', a: edge[0], b: edge[1] } : null
}

/**
 * The nodes a drag on a handle moves.
 *
 * A node moves itself — and everything picked with it, when it is one of the
 * picked. An edge moves the straight run it belongs to, or only its own two
 * nodes when the drag is limited to the segment.
 */
export function nodesMovedBy(
  tiles: readonly MeshTile[],
  positions: Positions,
  handle: MeshHandle,
  options: { picked?: readonly string[]; segmentOnly?: boolean } = {},
): string[] {
  if (handle.kind === 'node') {
    const picked = options.picked ?? []
    return picked.includes(handle.id) ? [...new Set(picked)] : [handle.id]
  }
  if (options.segmentOnly) return [handle.a, handle.b]
  const out = new Set<string>()
  for (const [a, b] of collinearChain(tiles, positions, [handle.a, handle.b])) {
    out.add(a)
    out.add(b)
  }
  return [...out]
}

/* --------------------------------------------------------------- legality */

const EPSILON = 1e-9

/** The thickness a cell must keep so that its insets leave a letter somewhere to go. */
export function thicknessFloor(spacing: MeshSpacing): number {
  return Math.max(MINIMUM_VISIBLE, spacing.minimumVisibleSize ?? 0) + 2 * Math.max(0, spacing.glyphInset) + Math.max(0, spacing.gap)
}

const distanceToLine = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length
}

/** Positive turns only: the corner quad walked clockwise with y down, without a reflex corner or a fold. */
function convexAndPositive(quad: readonly Vec2[]): boolean {
  const n = quad.length
  for (let i = 0; i < n; i++) {
    const a = quad[i] as Vec2
    const b = quad[(i + 1) % n] as Vec2
    const c = quad[(i + 2) % n] as Vec2
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross < -EPSILON) return false
  }
  return polygonArea(quad) > EPSILON
}

/**
 * Whether every tile touching a moved node is still a cell a letter can be
 * poured into, and whether any moved edge has been dragged across another.
 *
 * Rings simple, of positive area; the corner quad convex and thick enough
 * everywhere for the insets; no edge at a moved node crossing an edge of any
 * tile that shares a node with a touched tile. `floor` is what
 * `thicknessFloor` gives for the state's spacing.
 */
export function legal(
  tiles: readonly MeshTile[],
  positions: Positions,
  moved: ReadonlySet<string>,
  floor: number,
): boolean {
  const touched = tiles.filter((tile) => tile.ring.some((id) => moved.has(id)))
  const at = (id: string): Vec2 | undefined => positions[id]

  for (const tile of touched) {
    const ring = tile.ring.map(at)
    if (ring.some((p) => !p)) return false
    const points = ring as Vec2[]
    if (!(polygonArea(points) > EPSILON) || !isSimple(points)) return false

    const corners = tile.corners.map(at)
    if (corners.some((p) => !p)) return false
    // A triangle repeats its tip: three distinct corners still make a cell.
    const distinct = corners.filter(
      (p, i) => corners.findIndex((q) => q === p || (q && p && q.x === p.x && q.y === p.y)) === i,
    ) as Vec2[]
    if (distinct.length < 3) return false
    if (!convexAndPositive(distinct)) return false
    const n = distinct.length
    for (let i = 0; i < n; i++) {
      const a = distinct[i] as Vec2
      const b = distinct[(i + 1) % n] as Vec2
      for (let j = 0; j < n; j++) {
        if (j === i || j === (i + 1) % n) continue
        if (distanceToLine(distinct[j] as Vec2, a, b) < floor) return false
      }
    }
  }

  // Crossings: every edge at a moved node against every edge nearby.
  const nearbyNodes = new Set<string>()
  for (const tile of touched) for (const id of tile.ring) nearbyNodes.add(id)
  const nearby = tiles.filter((tile) => tile.ring.some((id) => nearbyNodes.has(id)))
  const nearbyEdges = [...edgesOf(nearby).values()]
  const movedEdges = nearbyEdges.filter((edge) => moved.has(edge.a) || moved.has(edge.b))
  for (const m of movedEdges) {
    const a = at(m.a)
    const b = at(m.b)
    if (!a || !b) return false
    for (const other of nearbyEdges) {
      if (other.key === m.key) continue
      if (other.a === m.a || other.a === m.b || other.b === m.a || other.b === m.b) continue
      const c = at(other.a)
      const d = at(other.b)
      if (!c || !d) return false
      if (segmentsIntersect(a, b, c, d)) return false
    }
  }
  return true
}

/* ------------------------------------------------------------------- drag */

export interface DragResult {
  /** Every moved node's position for this offset — all of them, so a frame that returns to the start still writes it. */
  updates: { id: string; at: Vec2 }[]
  /** Whether any of them is somewhere other than where it began. */
  moved: boolean
  /** Fell short of the pointer: a cell would have folded. */
  clamped: boolean
}

const BISECTION_STEPS = 10

/**
 * Where the moved nodes go for a pointer offset of `delta` from where the
 * drag began.
 *
 * Rigid: every node in `moved` takes the same offset, so a chain stays a
 * chain and a picked group keeps its shape. Snapped by the `primary` node —
 * the one grabbed — so it lands on the grid and the rest follow at their
 * distance. Then legality: if the snapped place folds a cell, the offset is
 * bisected between nothing and the wanted offset, the furthest legal one
 * kept, and snapped again only if that stays legal. `before` is where the
 * nodes were at pointer-down, which every frame starts from.
 */
export function dragNodes(
  tiles: readonly MeshTile[],
  before: Positions,
  moved: readonly string[],
  primary: string,
  delta: Vec2,
  options: { snapStep?: number; spacing: MeshSpacing },
): DragResult {
  const set = new Set(moved)
  const floor = thicknessFloor(options.spacing)
  const step = options.snapStep
  const origin = before[primary] ?? { x: 0, y: 0 }

  const place = (offset: Vec2): Positions => {
    const next: Record<string, Vec2> = { ...before }
    for (const id of set) {
      const p = before[id]
      if (p) next[id] = { x: p.x + offset.x, y: p.y + offset.y }
    }
    return next
  }
  const snapped = (offset: Vec2): Vec2 =>
    snaps(step)
      ? {
          x: snapPosition(origin.x + offset.x, step) - origin.x,
          y: snapPosition(origin.y + offset.y, step) - origin.y,
        }
      : offset
  const ok = (offset: Vec2): boolean => legal(tiles, place(offset), set, floor)

  let offset = snapped(delta)
  let clamped = false
  if (!ok(offset)) {
    clamped = true
    // The furthest legal point on the way from nothing to the pointer.
    let low = 0
    let high = 1
    if (!ok({ x: 0, y: 0 })) {
      offset = { x: 0, y: 0 }
    } else {
      for (let i = 0; i < BISECTION_STEPS; i++) {
        const mid = (low + high) / 2
        if (ok({ x: delta.x * mid, y: delta.y * mid })) low = mid
        else high = mid
      }
      offset = { x: delta.x * low, y: delta.y * low }
      const onGrid = snapped(offset)
      if (ok(onGrid)) offset = onGrid
    }
  }

  const placed = place(offset)
  const updates: { id: string; at: Vec2 }[] = []
  let anyMoved = false
  for (const id of set) {
    const was = before[id]
    const now = placed[id]
    if (!was || !now) continue
    if (was.x !== now.x || was.y !== now.y) anyMoved = true
    updates.push({ id, at: now })
  }
  return { updates, moved: anyMoved, clamped }
}
