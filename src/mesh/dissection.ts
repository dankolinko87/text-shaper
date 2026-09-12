import { samePaint } from '../typography/paint'
import type { Paint } from '../types/paint'
import { sameStroke } from '../geometry/stroke'
import { layoutMosaic } from '../mosaic/layout'
import type { FontSettings, LetterMosaicObject, Rect, Vec2 } from '../types/document'
import type { MeshNode, MeshState, MeshTile } from '../types/mesh'
import {
  MESH_DEFAULT_CORNERS,
  MESH_DEFAULT_EASING,
  MESH_DEFAULT_HOLD_MS,
  MESH_DEFAULT_SPACING,
  MESH_DEFAULT_TRANSITION_MS,
} from '../types/mesh'
import { createId } from '../utils/id'

/**
 * A mesh's states: making one, copying one, telling two apart — and making a
 * mesh out of a mosaic. No geometry here beyond reading positions; the
 * polygons are `layout.ts`'s.
 */

const stateId = (): string => createId('mst')
const nodeId = (): string => createId('mn')
const tileId = (): string => createId('mt')

/** The first state of a new mesh: the positions it was seeded with. */
export function initialMeshState(positions: Readonly<Record<string, Vec2>>, font: FontSettings): MeshState {
  return {
    id: stateId(),
    nodes: copyPositions(positions),
    glyphColour: {},
    tileColour: {},
    background: null,
    stroke: null,
    lines: null,
    chars: {},
    font: { ...font },
    ...MESH_DEFAULT_SPACING,
    ...MESH_DEFAULT_CORNERS,
    holdMs: MESH_DEFAULT_HOLD_MS,
    transitionMs: MESH_DEFAULT_TRANSITION_MS,
    easing: MESH_DEFAULT_EASING,
  }
}

const copyPositions = (positions: Readonly<Record<string, Vec2>>): Record<string, Vec2> =>
  Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: p.x, y: p.y }]))

/**
 * A state copied for a new one to start from: fresh id, cloned maps, so that
 * adding a state never makes the mesh jump and never shares a map between two.
 */
export function copyMeshState(state: MeshState): MeshState {
  return {
    ...state,
    id: stateId(),
    nodes: copyPositions(state.nodes),
    glyphColour: { ...state.glyphColour },
    tileColour: { ...state.tileColour },
    chars: { ...state.chars },
  }
}

/**
 * Whether two states describe the same picture — the mosaic's `sameGeometry`,
 * with positions in place of coordinates. The follow rule and the delete
 * prompt both lean on it, so everything that SHOWS counts: geometry, spacing,
 * corners, font, letters, colours, backdrop, border, lines. Timing does not.
 */
export function sameMeshGeometry(a: MeshState, b: MeshState, tolerance = 1e-9): boolean {
  if (
    Math.abs(a.gap - b.gap) > tolerance ||
    Math.abs(a.glyphInset - b.glyphInset) > tolerance ||
    Math.abs(a.tileRadius - b.tileRadius) > tolerance ||
    Math.abs(a.outerRadius - b.outerRadius) > tolerance
  ) {
    return false
  }
  if (
    a.font.fontId !== b.font.fontId ||
    a.font.weight !== b.font.weight ||
    a.font.italic !== b.font.italic
  ) {
    return false
  }

  const written = (state: MeshState): string =>
    Object.entries(state.chars)
      .filter(([, char]) => char !== '')
      .sort(([one], [two]) => (one < two ? -1 : 1))
      .map(([id, char]) => `${id}:${char}`)
      .join('|')
  if (written(a) !== written(b)) return false

  if (!samePaint(a.background ?? null, b.background ?? null)) return false
  if (!sameStroke(a.stroke ?? null, b.stroke ?? null, tolerance)) return false
  if (!sameStroke(a.lines ?? null, b.lines ?? null, tolerance)) return false

  for (const map of ['glyphColour', 'tileColour'] as const) {
    const left = a[map] as Record<string, Paint | null>
    const right = b[map] as Record<string, Paint | null>
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!samePaint(left[key] ?? null, right[key] ?? null)) return false
    }
  }

  const keys = new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])
  for (const key of keys) {
    const one = a.nodes[key]
    const other = b.nodes[key]
    if (!one || !other) return false
    if (Math.hypot(one.x - other.x, one.y - other.y) > tolerance) return false
  }
  return true
}

/**
 * A copy of a mesh's nodes, tiles and states with entirely fresh ids.
 *
 * Ids are unique across the document, so a duplicate that kept them would give
 * two objects the same node and tile ids — and every state keys its positions
 * and colours BY those ids.
 */
export function copyMeshIdentity(
  nodes: readonly MeshNode[],
  tiles: readonly MeshTile[],
  states: readonly MeshState[],
): { nodes: MeshNode[]; tiles: MeshTile[]; states: MeshState[] } {
  const nodeIds = new Map<string, string>()
  const tileIds = new Map<string, string>()
  const node = (id: string): string => {
    const found = nodeIds.get(id)
    if (found) return found
    const fresh = nodeId()
    nodeIds.set(id, fresh)
    return fresh
  }

  const copiedNodes = nodes.map((each) => ({ id: node(each.id) }))
  const copiedTiles = tiles.map((tile) => {
    const id = tileId()
    tileIds.set(tile.id, id)
    return {
      id,
      ring: tile.ring.map(node),
      corners: tile.corners.map(node) as [string, string, string, string],
    }
  })

  const remap = <T>(from: Record<string, T>, map: Map<string, string>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [key, value] of Object.entries(from)) {
      const id = map.get(key)
      if (id) out[id] = value
    }
    return out
  }

  return {
    nodes: copiedNodes,
    tiles: copiedTiles,
    states: states.map((state) => ({
      ...state,
      id: stateId(),
      nodes: copyPositions(remap(state.nodes, nodeIds)),
      glyphColour: remap(state.glyphColour, tileIds),
      tileColour: remap(state.tileColour, tileIds),
      chars: remap(state.chars, tileIds),
    })),
  }
}

/**
 * A mosaic as a mesh: the same picture, with corners it can now move.
 *
 * Every corner the mosaic's lines cross becomes a node named by the pair of
 * lines, so every state agrees on which node is which, and its position in a
 * state is that state's own rectangle corner — padding baked in, since a mesh
 * has no content box to inset. A tile's ring is its four corners, plus any
 * other tile's corner that sits on one of its sides: the T-junction a forked
 * line makes, which in a mesh is simply a point on the side. Tile ids are
 * kept, so the letters and colours keyed by them come across untouched.
 */
export function meshFromMosaic(
  object: LetterMosaicObject,
): { nodes: MeshNode[]; tiles: MeshTile[]; states: MeshState[] } {
  const layouts = object.states.map((state) =>
    layoutMosaic(object.tiles, state.x, state.y, object.localBounds, {
      gap: state.gap,
      outerPadding: state.outerPadding,
      glyphInset: state.glyphInset,
    }),
  )
  const nodeOf = (xId: string, yId: string): string => `mn_${xId}_${yId}`

  // Every corner, positioned in every state.
  const positions: Record<string, Vec2>[] = object.states.map(() => ({}))
  const nodes: MeshNode[] = []
  const seen = new Set<string>()
  const cornersOf = (tile: LetterMosaicObject['tiles'][number]): [string, string, string, string] => [
    nodeOf(tile.left, tile.top),
    nodeOf(tile.right, tile.top),
    nodeOf(tile.right, tile.bottom),
    nodeOf(tile.left, tile.bottom),
  ]
  const cornerPoints = (rect: Rect): [Vec2, Vec2, Vec2, Vec2] => [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]
  for (const tile of object.tiles) {
    const ids = cornersOf(tile)
    ids.forEach((id, corner) => {
      if (!seen.has(id)) {
        seen.add(id)
        nodes.push({ id })
      }
      layouts.forEach((layout, at) => {
        const rect = layout.get(tile.id)?.structural
        const map = positions[at]
        const point = rect ? cornerPoints(rect)[corner] : undefined
        if (point && map) map[id] = point
      })
    })
  }

  /*
   * Rings: the corners, and the other tiles' corners that lie on a side.
   *
   * Decided in state 0 and checked in every other: a forked line puts a
   * corner on a neighbour's side in every state, because each state is a
   * partition. A node that lies on the side in one state and not another
   * would bend that side where the mosaic drew it straight, so it is left out
   * and the side stays as it was.
   */
  const first = positions[0] ?? {}
  const scale = Math.max(1, object.localBounds.width, object.localBounds.height)
  const tolerance = 1e-6 * scale
  const onSide = (map: Record<string, Vec2>, id: string, a: Vec2, b: Vec2): number | null => {
    const p = map[id]
    if (!p) return null
    const horizontal = Math.abs(a.y - b.y) <= tolerance
    if (horizontal) {
      if (Math.abs(p.y - a.y) > tolerance) return null
      const lo = Math.min(a.x, b.x)
      const hi = Math.max(a.x, b.x)
      if (p.x <= lo + tolerance || p.x >= hi - tolerance) return null
      return (p.x - a.x) / (b.x - a.x)
    }
    if (Math.abs(p.x - a.x) > tolerance) return null
    const lo = Math.min(a.y, b.y)
    const hi = Math.max(a.y, b.y)
    if (p.y <= lo + tolerance || p.y >= hi - tolerance) return null
    return (p.y - a.y) / (b.y - a.y)
  }

  const tiles: MeshTile[] = object.tiles.map((tile) => {
    const corners = cornersOf(tile)
    const own = new Set(corners)
    const ring: string[] = []
    for (let side = 0; side < 4; side++) {
      const from = corners[side] as string
      const to = corners[(side + 1) % 4] as string
      ring.push(from)
      const a = first[from]
      const b = first[to]
      if (!a || !b) continue
      const between: { id: string; t: number }[] = []
      for (const node of nodes) {
        if (own.has(node.id)) continue
        const t = onSide(first, node.id, a, b)
        if (t === null) continue
        const everywhere = positions.every((map, at) => {
          if (at === 0) return true
          const fa = map[from]
          const fb = map[to]
          return fa && fb ? onSide(map, node.id, fa, fb) !== null : false
        })
        if (everywhere) between.push({ id: node.id, t })
      }
      between.sort((p, q) => p.t - q.t)
      for (const each of between) ring.push(each.id)
    }
    return { id: tile.id, ring, corners }
  })

  const states: MeshState[] = object.states.map((state, at) => ({
    id: stateId(),
    nodes: positions[at] ?? {},
    glyphColour: { ...state.glyphColour },
    tileColour: { ...state.tileColour },
    background: state.background ?? null,
    stroke: state.stroke ?? null,
    lines: null,
    chars: { ...state.chars },
    font: { ...state.font },
    gap: state.gap,
    glyphInset: state.glyphInset,
    // The mosaic's padding is baked into where the corners sit; kept as the
    // mesh's own, so the backdrop and silhouette still reach as far.
    outerPadding: state.outerPadding,
    tileRadius: state.tileRadius,
    outerRadius: state.outerRadius,
    holdMs: state.holdMs,
    transitionMs: state.transitionMs,
    easing: state.easing,
  }))

  return { nodes, tiles, states }
}
