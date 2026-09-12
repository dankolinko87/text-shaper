import type { Vec2 } from '../types/document'
import type { MeshNode, MeshState, MeshTile } from '../types/mesh'
import { createId } from '../utils/id'
import {
  edgeKey,
  edgesOf,
  isConvex,
  polygonArea,
  validateMesh,
  type Positions,
} from './mesh'

/**
 * Changing what a mesh IS: its nodes and rings, rather than where they are.
 *
 * Every operation here is pure and total over the states — a node added on
 * an edge is placed on that edge in every state at the same fraction; a tile
 * cut in two is cut in every state along the same ring members; an extrusion
 * adds nodes to every state at each state's own version of the drag. The
 * result is checked by `validateMesh` before it is returned, so a caller
 * never has to ask whether a mesh that came out of here is one.
 */

export interface MeshShape {
  nodes: MeshNode[]
  tiles: MeshTile[]
  states: MeshState[]
}

const nodeId = (): string => createId('mn')
const tileId = (): string => createId('mt')
const EPSILON = 1e-9

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

const withPositions = (
  states: readonly MeshState[],
  place: (state: MeshState, at: number) => Record<string, Vec2>,
): MeshState[] => states.map((state, at) => ({ ...state, nodes: place(state, at) }))

/** The result, or null when what came out is not a mesh. */
function checked(shape: MeshShape): MeshShape | null {
  return validateMesh(shape.nodes, shape.tiles, shape.states).length === 0 ? shape : null
}

/* -------------------------------------------------------------- points */

/** Where a node sits on a tile's ring, walking to `b` from `a` (or back), or -1. */
function edgeIndexIn(ring: readonly string[], a: string, b: string): number {
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % n]
    if ((p === a && q === b) || (p === b && q === a)) return i
  }
  return -1
}

/**
 * A new point on an edge, at fraction `t` of the way from `a` to `b` — in
 * EVERY state, on that state's own edge. It joins the ring of each tile the
 * edge belongs to, between the two, and is a bend point: nobody's corner.
 */
export function addPoint(shape: MeshShape, edge: readonly [string, string], t: number): MeshShape | null {
  const [a, b] = edge
  const fraction = Math.min(1 - EPSILON, Math.max(EPSILON, t))
  const id = nodeId()
  let placed = false
  const tiles = shape.tiles.map((tile) => {
    const at = edgeIndexIn(tile.ring, a, b)
    if (at < 0) return tile
    placed = true
    const ring = [...tile.ring]
    // Inserted after whichever end comes first in the ring's own walk.
    ring.splice(at + 1, 0, id)
    return { ...tile, ring }
  })
  if (!placed) return null
  const states = withPositions(shape.states, (state) => {
    const p = state.nodes[a]
    const q = state.nodes[b]
    return { ...state.nodes, [id]: p && q ? lerp(p, q, fraction) : { x: 0, y: 0 } }
  })
  return checked({ nodes: [...shape.nodes, { id }], tiles, states })
}

/** Whether a node is a bend point: on rings, but nobody's corner. */
export function isBendPoint(tiles: readonly MeshTile[], id: string): boolean {
  let onRing = false
  for (const tile of tiles) {
    if (tile.corners.includes(id)) return false
    if (tile.ring.includes(id)) onRing = true
  }
  return onRing
}

/** A bend point taken out of every ring it is on, and out of every state. */
export function removePoint(shape: MeshShape, id: string): MeshShape | null {
  if (!isBendPoint(shape.tiles, id)) return null
  const tiles = shape.tiles.map((tile) =>
    tile.ring.includes(id) ? { ...tile, ring: tile.ring.filter((each) => each !== id) } : tile,
  )
  if (tiles.some((tile) => tile.ring.length < 3)) return null
  const states = withPositions(shape.states, (state) => {
    const { [id]: _gone, ...rest } = state.nodes
    return rest
  })
  return checked({ nodes: shape.nodes.filter((node) => node.id !== id), tiles, states })
}

/* ------------------------------------------------------------- corners */

/**
 * The rotation of four corners that puts the letter the right way up.
 *
 * The four are in ring order already; what is free is which of them is the
 * letter's top-left. Scored across every state: the glyph's own x-axis
 * (top-left to top-right, bottom-left to bottom-right) should point right,
 * its y-axis down. The rotation with the highest total wins, so a cell that
 * has been turned a little still reads upright, and one turned a lot reads
 * the way it is turned.
 */
export function orientCorners(
  corners: readonly [string, string, string, string],
  states: readonly Pick<MeshState, 'nodes'>[],
): [string, string, string, string] {
  let best = 0
  let bestScore = -Infinity
  for (let r = 0; r < 4; r++) {
    const turned = [0, 1, 2, 3].map((i) => corners[(i + r) % 4] as string)
    let score = 0
    for (const state of states) {
      const [tl, tr, br, bl] = turned.map((id) => state.nodes[id] ?? { x: 0, y: 0 }) as [Vec2, Vec2, Vec2, Vec2]
      score += tr.x - tl.x + (br.x - bl.x) + (bl.y - tl.y) + (br.y - tr.y)
    }
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return [0, 1, 2, 3].map((i) => corners[(i + best) % 4]) as [string, string, string, string]
}

/**
 * Four corners for a ring, two of them given.
 *
 * The other two are chosen from the rest of the ring so that the four, in
 * ring order, make the largest convex quad summed over every state; when no
 * pair is convex everywhere the largest quad is taken anyway. A ring of three
 * repeats its third member as the tip.
 */
export function chooseCorners(
  ring: readonly string[],
  fixed: readonly [string, string],
  states: readonly Pick<MeshState, 'nodes'>[],
): [string, string, string, string] {
  const n = ring.length
  const at = (id: string, state: Pick<MeshState, 'nodes'>): Vec2 => state.nodes[id] ?? { x: 0, y: 0 }
  const inOrder = (ids: readonly string[]): string[] =>
    [...ids].sort((p, q) => ring.indexOf(p) - ring.indexOf(q))

  if (n === 3) {
    const tip = ring.find((id) => !fixed.includes(id)) ?? (ring[2] as string)
    const three = inOrder([fixed[0], fixed[1], tip])
    // The tip repeated, so the letter's bottom edge collapses onto it.
    const quad: [string, string, string, string] = [three[0] as string, three[1] as string, three[2] as string, three[2] as string]
    return orientCorners(quad, states)
  }

  const others = ring.filter((id) => !fixed.includes(id))
  let best: string[] | null = null
  let bestScore = -Infinity
  let bestConvex = false
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const four = inOrder([fixed[0], fixed[1], others[i] as string, others[j] as string])
      let area = 0
      let convex = true
      for (const state of states) {
        const points = four.map((id) => at(id, state))
        area += polygonArea(points)
        if (!isConvex(points)) convex = false
      }
      if ((convex && !bestConvex) || (convex === bestConvex && area > bestScore)) {
        best = four
        bestScore = area
        bestConvex = convex
      }
    }
  }
  const quad = (best ?? inOrder([fixed[0], fixed[1], ...others.slice(0, 2)])) as [string, string, string, string]
  return orientCorners(quad, states)
}

/* ----------------------------------------------------------------- cut */

/** One end of a cut: a point on an edge of the tile, at a fraction along it. */
export interface CutEnd {
  edge: readonly [string, string]
  t: number
}

/**
 * A tile in two, along a line from one of its edges to another.
 *
 * Both ends become points (an end within a hair of a node uses that node),
 * and the ring is split between them. The original keeps its id, its letter
 * and its colours; the new tile inherits the colours, and is empty. Each half
 * takes the two cut ends as corners and chooses two more.
 */
export function cutTile(shape: MeshShape, tileId0: string, entry: CutEnd, exit: CutEnd): MeshShape | null {
  const tile = shape.tiles.find((each) => each.id === tileId0)
  if (!tile) return null
  if (edgeKey(entry.edge[0], entry.edge[1]) === edgeKey(exit.edge[0], exit.edge[1])) return null

  // Ends that land on a node use it; the rest become points.
  const SNAP = 1e-3
  const endNode = (end: CutEnd, current: MeshShape): { shape: MeshShape; id: string } | null => {
    if (end.t <= SNAP) return { shape: current, id: end.edge[0] }
    if (end.t >= 1 - SNAP) return { shape: current, id: end.edge[1] }
    const added = addPoint(current, end.edge, end.t)
    if (!added) return null
    return { shape: added, id: added.nodes[added.nodes.length - 1]?.id as string }
  }
  const first = endNode(entry, shape)
  if (!first) return null
  const second = endNode(exit, first.shape)
  if (!second) return null
  if (first.id === second.id) return null

  const current = second.shape
  const whole = current.tiles.find((each) => each.id === tile.id)
  if (!whole) return null
  const ring = whole.ring
  const i = ring.indexOf(first.id)
  const j = ring.indexOf(second.id)
  if (i < 0 || j < 0) return null

  // Walk from the entry to the exit for one half, and on round to the entry for the other.
  const walk = (from: number, to: number): string[] => {
    const out: string[] = []
    let k = from
    for (;;) {
      out.push(ring[k] as string)
      if (k === to) break
      k = (k + 1) % ring.length
    }
    return out
  }
  const ringA = walk(i, j)
  const ringB = walk(j, i)
  if (ringA.length < 3 || ringB.length < 3) return null

  // The half holding more of the old corners keeps the id; ties go to the first.
  const keepsA = tile.corners.filter((id) => ringA.includes(id)).length
  const keepsB = tile.corners.filter((id) => ringB.includes(id)).length
  const [keptRing, freshRing] = keepsB > keepsA ? [ringB, ringA] : [ringA, ringB]

  const fresh = tileId()
  const kept: MeshTile = {
    id: tile.id,
    ring: keptRing,
    corners: chooseCorners(keptRing, [first.id, second.id], current.states),
  }
  const made: MeshTile = {
    id: fresh,
    ring: freshRing,
    corners: chooseCorners(freshRing, [first.id, second.id], current.states),
  }
  const tiles: MeshTile[] = []
  for (const each of current.tiles) {
    if (each.id !== tile.id) {
      tiles.push(each)
      continue
    }
    tiles.push(kept, made)
  }
  const states = current.states.map((state) => ({
    ...state,
    glyphColour:
      state.glyphColour[tile.id] !== undefined
        ? { ...state.glyphColour, [fresh]: state.glyphColour[tile.id] as string }
        : state.glyphColour,
    tileColour:
      state.tileColour[tile.id] !== undefined
        ? { ...state.tileColour, [fresh]: state.tileColour[tile.id] as string | null }
        : state.tileColour,
  }))
  return checked({ nodes: current.nodes, tiles, states })
}

/* ------------------------------------------------------------- extrude */

/** The rim edge's frame in one state: its unit direction and its outward normal. */
function edgeFrame(a: Vec2, b: Vec2): { along: Vec2; out: Vec2; length: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  const along = length > EPSILON ? { x: dx / length, y: dy / length } : { x: 1, y: 0 }
  // A ring is clockwise on screen, so its inside is to the right of a→b and the
  // outside to the left: the direction turned a quarter anticlockwise.
  return { along, out: { x: along.y, y: -along.x }, length }
}

/** How far along the edge and how far out of it a drag reaches, at least `minimum` out. */
export function extrusionReach(p: Vec2, q: Vec2, delta: Vec2, minimum: number): { along: number; across: number } {
  const frame = edgeFrame(p, q)
  return {
    along: delta.x * frame.along.x + delta.y * frame.along.y,
    across: Math.max(minimum, delta.x * frame.out.x + delta.y * frame.out.y),
  }
}

/** The offset that carries an edge's ends out to the new cell's far side, in one state. */
export function extrusionOffset(p: Vec2, q: Vec2, reach: { along: number; across: number }): Vec2 {
  const own = edgeFrame(p, q)
  return {
    x: own.along.x * reach.along + own.out.x * reach.across,
    y: own.along.y * reach.along + own.out.y * reach.across,
  }
}

/**
 * Where a line drawn across a tile cuts its ring: the crossing just behind
 * where the line was started and the one just ahead, each as an edge and a
 * fraction along it — the two ends `cutTile` takes — with the points
 * themselves for drawing. The line is taken as endless, so a short drag in
 * the right direction still cuts the whole tile. Null when it misses.
 */
export function chordAcross(
  ring: readonly string[],
  positions: Positions,
  from: Vec2,
  to: Vec2,
): { entry: CutEnd; exit: CutEnd; a: Vec2; b: Vec2 } | null {
  const d = { x: to.x - from.x, y: to.y - from.y }
  if (Math.hypot(d.x, d.y) < 1e-6) return null
  const n = ring.length
  const crossings: { s: number; t: number; i: number }[] = []
  for (let i = 0; i < n; i++) {
    const p = positions[ring[i] as string]
    const q = positions[ring[(i + 1) % n] as string]
    if (!p || !q) return null
    const e = { x: q.x - p.x, y: q.y - p.y }
    const denominator = d.x * e.y - d.y * e.x
    if (Math.abs(denominator) < EPSILON) continue
    const w = { x: p.x - from.x, y: p.y - from.y }
    const s = (w.x * e.y - w.y * e.x) / denominator
    const t = (w.x * d.y - w.y * d.x) / denominator
    if (t < -EPSILON || t > 1 + EPSILON) continue
    crossings.push({ s, t: Math.min(1, Math.max(0, t)), i })
  }
  if (crossings.length < 2) return null
  crossings.sort((p, q) => p.s - q.s)
  const behind = crossings.filter((c) => c.s <= 0)
  const ahead = crossings.filter((c) => c.s > 0)
  let entry: { s: number; t: number; i: number } | undefined
  let exit: { s: number; t: number; i: number } | undefined
  if (behind.length > 0 && ahead.length > 0) {
    entry = behind[behind.length - 1]
    exit = ahead[0]
  } else if (ahead.length >= 2) {
    entry = ahead[0]
    exit = ahead[1]
  } else if (behind.length >= 2) {
    entry = behind[behind.length - 2]
    exit = behind[behind.length - 1]
  }
  if (!entry || !exit || entry.i === exit.i) return null
  const end = (c: { t: number; i: number }): CutEnd => ({
    edge: [ring[c.i] as string, ring[(c.i + 1) % n] as string],
    t: c.t,
  })
  const point = (c: { s: number }): Vec2 => ({ x: from.x + d.x * c.s, y: from.y + d.y * c.s })
  return { entry: end(entry), exit: end(exit), a: point(entry), b: point(exit) }
}

/**
 * A new tile grown out of a rim edge.
 *
 * The drag is read in the edge's own frame in the edited state — how far
 * along it and how far out — and rebuilt from every other state's version of
 * the same edge, so the new cell follows the edge wherever each state has put
 * it. `a → b` must be the edge's direction in the ring it belongs to; the new
 * ring runs `b, a, a', b'`, which keeps it clockwise. The cell is at least
 * `minimum` deep.
 */
export function extrudeEdge(
  shape: MeshShape,
  edge: readonly [string, string],
  delta: Vec2,
  editedState: number,
  minimum: number,
): MeshShape | null {
  const [a, b] = edge
  const edges = edgesOf(shape.tiles)
  const found = edges.get(edgeKey(a, b))
  if (!found || found.tiles.length !== 1) return null
  const owner = shape.tiles.find((tile) => tile.id === found.tiles[0])
  if (!owner) return null
  // Read in the owner's walk, so "outward" is away from it.
  const at = edgeIndexIn(owner.ring, a, b)
  if (at < 0) return null
  const from = owner.ring[at] as string
  const to = owner.ring[(at + 1) % owner.ring.length] as string

  const edited = shape.states[editedState] ?? shape.states[0]
  if (!edited) return null
  const p = edited.nodes[from]
  const q = edited.nodes[to]
  if (!p || !q) return null
  const reach = extrusionReach(p, q, delta, minimum)

  const aPrime = nodeId()
  const bPrime = nodeId()
  const states = withPositions(shape.states, (state) => {
    const s = state.nodes[from]
    const e = state.nodes[to]
    if (!s || !e) return state.nodes
    const offset = extrusionOffset(s, e, reach)
    return {
      ...state.nodes,
      [aPrime]: { x: s.x + offset.x, y: s.y + offset.y },
      [bPrime]: { x: e.x + offset.x, y: e.y + offset.y },
    }
  })
  const ring = [to, from, aPrime, bPrime]
  const tile: MeshTile = {
    id: tileId(),
    ring,
    corners: orientCorners([to, from, aPrime, bPrime], states),
  }
  return checked({
    nodes: [...shape.nodes, { id: aPrime }, { id: bPrime }],
    tiles: [...shape.tiles, tile],
    states,
  })
}

/* ---------------------------------------------------------------- tiles */

/** A tile gone, and with it every node nothing else uses; a hole is allowed, an empty mesh is not. */
export function removeTile(shape: MeshShape, id: string): MeshShape | null {
  if (!shape.tiles.some((tile) => tile.id === id)) return null
  const tiles = shape.tiles.filter((tile) => tile.id !== id)
  if (tiles.length === 0) return null
  const used = new Set<string>()
  for (const tile of tiles) for (const node of tile.ring) used.add(node)
  const nodes = shape.nodes.filter((node) => used.has(node.id))
  const states = shape.states.map((state) => {
    const kept: Record<string, Vec2> = {}
    for (const [node, p] of Object.entries(state.nodes)) if (used.has(node)) kept[node] = p
    const { [id]: _c, ...chars } = state.chars
    const { [id]: _g, ...glyphColour } = state.glyphColour
    const { [id]: _t, ...tileColour } = state.tileColour
    return { ...state, nodes: kept, chars, glyphColour, tileColour }
  })
  return checked({ nodes, tiles, states })
}

/* -------------------------------------------------------------- lattice */

export interface Lattice {
  columns: number
  rows: number
  /** Each corner node's crossing, `[column, row]`. */
  at: Map<string, [number, number]>
}

/**
 * The grid the tiles still form, if they do — read off the corners alone, so
 * bend points and dragged positions do not count against it.
 *
 * Every tile is walked from the first: its corners are its top-left,
 * top-right, bottom-right and bottom-left crossings, and a neighbour sharing
 * two of them sits beside it. A node that would have to be at two crossings,
 * or a tile whose corners are not four distinct nodes, means there is no
 * lattice. Holes are fine.
 */
export function latticeOf(tiles: readonly MeshTile[]): Lattice | null {
  if (tiles.length === 0) return null
  const at = new Map<string, [number, number]>()
  const placedTiles = new Set<string>()
  const byNode = new Map<string, MeshTile[]>()
  for (const tile of tiles) {
    if (new Set(tile.corners).size !== 4) return null
    for (const id of tile.corners) {
      const list = byNode.get(id)
      if (list) list.push(tile)
      else byNode.set(id, [tile])
    }
  }

  const place = (tile: MeshTile, column: number, row: number): boolean => {
    const wanted: [string, [number, number]][] = [
      [tile.corners[0], [column, row]],
      [tile.corners[1], [column + 1, row]],
      [tile.corners[2], [column + 1, row + 1]],
      [tile.corners[3], [column, row + 1]],
    ]
    for (const [id, crossing] of wanted) {
      const known = at.get(id)
      if (known && (known[0] !== crossing[0] || known[1] !== crossing[1])) return false
    }
    for (const [id, crossing] of wanted) at.set(id, crossing)
    placedTiles.add(tile.id)
    return true
  }

  const queue: MeshTile[] = [tiles[0] as MeshTile]
  if (!place(tiles[0] as MeshTile, 0, 0)) return null
  while (queue.length > 0) {
    const tile = queue.shift() as MeshTile
    for (const id of tile.corners) {
      for (const next of byNode.get(id) ?? []) {
        if (placedTiles.has(next.id)) continue
        const crossing = at.get(id)
        if (!crossing) continue
        // Where this tile's corner sits tells where its top-left is.
        const index = next.corners.indexOf(id)
        const [column, row] =
          index === 0
            ? crossing
            : index === 1
              ? [crossing[0] - 1, crossing[1]]
              : index === 2
                ? [crossing[0] - 1, crossing[1] - 1]
                : [crossing[0], crossing[1] - 1]
        if (!place(next, column, row)) return null
        queue.push(next)
      }
    }
  }
  if (placedTiles.size !== tiles.length) return null

  // Normalised to start at zero; a lattice that names one crossing twice is not one.
  let minC = Infinity
  let minR = Infinity
  for (const [c, r] of at.values()) {
    minC = Math.min(minC, c)
    minR = Math.min(minR, r)
  }
  const seen = new Set<string>()
  let columns = 0
  let rows = 0
  for (const [id, [c, r]] of at) {
    const crossing: [number, number] = [c - minC, r - minR]
    const key = `${crossing[0]},${crossing[1]}`
    if (seen.has(key)) return null
    seen.add(key)
    at.set(id, crossing)
    columns = Math.max(columns, crossing[0])
    rows = Math.max(rows, crossing[1])
  }
  return { columns, rows, at }
}

/**
 * Every node back on the plain grid, for one state.
 *
 * Corners go to their crossings on a `cell`-sized lattice centred on the
 * origin; a bend point goes to the same fraction of the way along the
 * straight side it bends, measured on the side it is on now.
 */
export function resetPositions(
  tiles: readonly MeshTile[],
  lattice: Lattice,
  current: Positions,
  cell: number,
): Record<string, Vec2> {
  const out: Record<string, Vec2> = {}
  for (const [id, [c, r]] of lattice.at) {
    out[id] = { x: (c - lattice.columns / 2) * cell, y: (r - lattice.rows / 2) * cell }
  }
  for (const tile of tiles) {
    const n = tile.ring.length
    for (let i = 0; i < n; i++) {
      const id = tile.ring[i] as string
      if (out[id]) continue
      // The corners either side of this bend, walking the ring both ways.
      let before = i
      while (!lattice.at.has(tile.ring[before] as string)) before = (before - 1 + n) % n
      let after = i
      while (!lattice.at.has(tile.ring[after] as string)) after = (after + 1) % n
      const a = tile.ring[before] as string
      const b = tile.ring[after] as string
      const p = current[a]
      const q = current[b]
      const here = current[id]
      let t = 0.5
      if (p && q && here) {
        const dx = q.x - p.x
        const dy = q.y - p.y
        const length = dx * dx + dy * dy
        if (length > EPSILON) t = Math.min(1, Math.max(0, ((here.x - p.x) * dx + (here.y - p.y) * dy) / length))
      }
      const ra = out[a] as Vec2
      const rb = out[b] as Vec2
      out[id] = lerp(ra, rb, t)
    }
  }
  return out
}
