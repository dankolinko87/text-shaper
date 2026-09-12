import { readingOrder } from '../mosaic/order'
import type { FontSettings, MeshObject, Vec2 } from '../types/document'
import type { MeshCorners, MeshSpacing, MeshState, MeshTile, MeshTileLayout } from '../types/mesh'
import { MESH_DEFAULT_CORNERS, MESH_DEFAULT_SPACING } from '../types/mesh'
import { edgesOf, interiorOf, pointInPolygon, tileLayout, type Positions } from './mesh'

/**
 * From node positions to the polygons on screen, and the questions a mesh
 * object is asked by hand — the mesh's `mosaic/layout.ts` and
 * `mosaic/tiles.ts` in one, because a mesh has less to say than a mosaic:
 * there are no coordinates to read across a box, only points.
 */

/** Every tile's polygons, for one set of positions. */
export function layoutMesh(
  tiles: readonly MeshTile[],
  positions: Positions,
  spacing: MeshSpacing,
): Map<string, MeshTileLayout> {
  const interior = interiorOf(edgesOf(tiles))
  const out = new Map<string, MeshTileLayout>()
  for (const tile of tiles) out.set(tile.id, tileLayout(tile, positions, spacing, interior))
  return out
}

/**
 * The state being looked at, or the LAST if the index has gone stale — the
 * rule the mosaic settled on, for the reason it gives: every panel clamps the
 * shown index that way, and the canvas must draw what the picker names.
 */
export function activeMeshState(object: MeshObject, at = 0): MeshState | undefined {
  if (object.states.length === 0) return undefined
  const index = Math.min(Math.max(0, Math.floor(at)), object.states.length - 1)
  return object.states[index]
}

export function meshSpacing(object: MeshObject, at = 0): MeshSpacing {
  const state = activeMeshState(object, at)
  return {
    gap: state?.gap ?? MESH_DEFAULT_SPACING.gap,
    glyphInset: state?.glyphInset ?? MESH_DEFAULT_SPACING.glyphInset,
    outerPadding: state?.outerPadding ?? MESH_DEFAULT_SPACING.outerPadding,
  }
}

export function meshCorners(object: MeshObject, at = 0): MeshCorners {
  const state = activeMeshState(object, at)
  return {
    tileRadius: state?.tileRadius ?? MESH_DEFAULT_CORNERS.tileRadius,
    outerRadius: state?.outerRadius ?? MESH_DEFAULT_CORNERS.outerRadius,
  }
}

export function meshChars(object: MeshObject, at = 0): Record<string, string> {
  return activeMeshState(object, at)?.chars ?? {}
}

export function meshFont(object: MeshObject, at = 0): FontSettings | undefined {
  return activeMeshState(object, at)?.font
}

/** This mesh's tiles, in its own local space, for the state being looked at. */
export function meshTiles(object: MeshObject, at = 0): Map<string, MeshTileLayout> {
  const state = activeMeshState(object, at)
  return layoutMesh(object.tiles, state?.nodes ?? {}, meshSpacing(object, at))
}

/**
 * The tile under a point, in the mesh's own space — against the STRUCTURAL
 * polygons, which cover the mesh, so a press in a gap still lands on the
 * tile the gap belongs to. In the state given, which must be the one on
 * screen: where a tile is is a question about a state.
 */
export function meshTileAt(object: MeshObject, point: Vec2, at = 0): string | null {
  for (const [id, tile] of meshTiles(object, at)) {
    if (pointInPolygon(point, tile.structural)) return id
  }
  return null
}

/** Every tile, in reading order — what "the whole mesh" means. */
export function allMeshTiles(object: MeshObject, at = 0): string[] {
  return readingOrder(meshTiles(object, at))
}

/** The first tile in reading order — where a new mesh's caret goes. */
export function firstMeshTile(object: MeshObject, at = 0): string | null {
  return allMeshTiles(object, at)[0] ?? null
}

/** The tiles a colour edit writes to: the ones picked, or every one when none is. */
export function meshColourTargets(
  object: MeshObject,
  at: number,
  selection: readonly string[],
): string[] {
  return selection.length > 0 ? [...selection] : allMeshTiles(object, at)
}
