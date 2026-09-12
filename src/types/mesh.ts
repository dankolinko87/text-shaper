import type { Easing } from '../anim/easing'
import type { OutlinePatch } from '../geometry/patch'
import type { FontSettings, PositionedStroke, Rect, Stroke, Vec2 } from './document'
import {
  MOSAIC_DEFAULT_EASING,
  MOSAIC_DEFAULT_HOLD_MS,
  MOSAIC_DEFAULT_TRANSITION_MS,
  MOSAIC_MAX_STATES,
  MOSAIC_MIN_STATES,
  MOSAIC_MIN_TRANSITION_MS,
} from './mosaic'

/**
 * The mesh: letters in the cells of a grid whose corners are free.
 *
 * A mosaic's geometry is LINES — a tile names four coordinates, and a corner
 * is the implicit crossing of two of them. That is exactly right for a grid
 * that stays a grid, and exactly wrong for a poster whose cells have been
 * sheared, whose edges have been bent by an extra point, and whose grid has
 * been broken by extruding an edge or cutting a tile in two. Those change
 * the TOPOLOGY, and lines have no vocabulary for it.
 *
 * So a mesh is nodes and rings. A node has an identity and, in every state, a
 * position. A tile is a ring of nodes — a polygon — and alignment is a shared
 * node rather than a shared line: drag a corner and every tile that meets at
 * it follows. A bend point is a ring member that is not a corner. A
 * T-junction is a node in one tile's ring that is a corner of another. What
 * every state shares is the topology; what differs is where the nodes are.
 *
 * Everything that is not geometry — the letters, the colours, the backdrop,
 * the border, the font, the gap and inset, the corner radii, the timing — is
 * the mosaic's, field for field, so the store actions and panel sections that
 * write those serve both kinds.
 */

/** A node's identity. Its position lives in every state. */
export interface MeshNode {
  id: string
}

/**
 * One cell: a ring of node ids, walked the way the outline of a patch runs —
 * clockwise on screen, which is POSITIVE signed area with y pointing down.
 *
 * `corners` are four ring members, in ring order, that the letter's map hangs
 * from: the first is where the glyph's top-left goes, then top-right,
 * bottom-right, bottom-left. Stored rather than derived, so the map is the
 * same in every state and cannot flip mid-transition. A triangle repeats its
 * tip. Every other ring member is a bend point on the side between two
 * corners.
 */
export interface MeshTile {
  id: string
  ring: string[]
  corners: [string, string, string, string]
}

export interface MeshState {
  id: string
  /** Where every node sits, in the object's local units. Every state names every node. */
  nodes: Record<string, Vec2>
  /** By tile id. */
  glyphColour: Record<string, string>
  /** By tile id. Null draws no background at all, which is not the same as white. */
  tileColour: Record<string, string | null>
  /** Behind the whole composition, gaps included; null is no backdrop. */
  background: string | null
  /** The silhouette's own edge, along the rim of the mesh; null draws none. */
  stroke: PositionedStroke | null
  /**
   * The mesh's own lines, drawn once per edge — the grid kept as artwork.
   *
   * A plain `Stroke`, not a positioned one: an edge between two tiles has no
   * inside, so it is always drawn down its centre.
   */
  lines: Stroke | null
  /** What is written in each tile, by tile id. Absent means an empty tile. */
  chars: Record<string, string>
  font: FontSettings
  /** Between neighbouring tiles, in object-local units. */
  gap: number
  /** Between a glyph and the inside edge of its tile. */
  glyphInset: number
  /**
   * How far the backdrop and the silhouette reach past the rim — the mosaic's
   * outer padding. The one place a backdrop shows once the tiles are filled
   * and the gap is closed.
   */
  outerPadding: number
  tileRadius: number
  outerRadius: number
  holdMs: number
  transitionMs: number
  easing: Easing
}

/** The same limits as the mosaic's, for the same reasons. */
export const MESH_MIN_STATES = MOSAIC_MIN_STATES
export const MESH_MAX_STATES = MOSAIC_MAX_STATES
export const MESH_DEFAULT_STATES = 3
export const MESH_MIN_TRANSITION_MS = MOSAIC_MIN_TRANSITION_MS
export const MESH_DEFAULT_HOLD_MS = MOSAIC_DEFAULT_HOLD_MS
export const MESH_DEFAULT_TRANSITION_MS = MOSAIC_DEFAULT_TRANSITION_MS
export const MESH_DEFAULT_EASING = MOSAIC_DEFAULT_EASING

/** A new mesh's cell, in object-local units. */
export const MESH_CELL = 120
/** The most cells a mesh is seeded with on one side. */
export const MESH_MAX_SIDE = 20

export const MESH_DEFAULT_SPACING = {
  gap: 6,
  glyphInset: 6,
  outerPadding: 0,
} as const

export const MESH_DEFAULT_CORNERS = {
  tileRadius: 0,
  outerRadius: 0,
} as const

export interface MeshSpacing {
  gap: number
  glyphInset: number
  /** Past the rim, for the backdrop and the silhouette. Nothing when unsaid. */
  outerPadding?: number
  /** Below this, an inset polygon collapses to its centroid instead of drawing as a sliver. */
  minimumVisibleSize?: number
}

export interface MeshCorners {
  tileRadius: number
  outerRadius: number
}

/**
 * One tile's three polygons, each inset from the one before it, and what the
 * letter needs to be poured into the last.
 *
 * `structural` is the ring as placed; `visible` is that inset by half a gap on
 * every interior side; `glyph` is that inset by the glyph inset. All three
 * have the ring's length, so a point of one corresponds to a point of the
 * others — unless an inset collapsed a polygon, when every point is its
 * centroid.
 *
 * `cornerIndices` are the tile's corners as indices into those polygons.
 * `rect` is set when the glyph polygon is an axis-aligned rectangle whose
 * corners sit in the expected order, which is the case that needs no warp at
 * all. `patch` is built only for a ring with bend points; a plain quad is
 * mapped bilinearly, which is what a Coons patch with straight sides is.
 */
export interface MeshTileLayout {
  structural: Vec2[]
  visible: Vec2[]
  glyph: Vec2[]
  bounds: Rect
  centre: Vec2
  cornerIndices: [number, number, number, number]
  rect: Rect | null
  patch: OutlinePatch | null
}
