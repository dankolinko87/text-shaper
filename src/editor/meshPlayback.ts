import { dashArrayFor, strokePaint, strokeReach } from '../geometry/stroke'
import { emitGlyph, type GlyphRest } from '../mesh/glyph'
import {
  cellMap,
  edgesOf,
  insetPolygon,
  polygonBounds,
  rimLoops,
  roundedPolygonCommands,
  type PathCommand,
} from '../mesh/mesh'
import type { EvaluatedMeshFrame } from '../mesh/timeline'
import type { MeshBackdrop, PositionedStroke, Rect, Stroke, Vec2 } from '../types/document'
import type { MeshTile, MeshTileLayout } from '../types/mesh'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'

/**
 * Painting a mesh frame onto the group the renderer built.
 *
 * The mosaic's painter moves rectangles and scales fixed outlines, because a
 * tile is always a rectangle there. A mesh tile is a polygon, and a letter
 * inside it is poured through the polygon's map — so a frame here REWRITES
 * paths: the numbers of each child's command array are replaced in place
 * (no allocation, no parsing), its box recomputed, and the child stood where
 * that box now is. Two things keep it cheap: a tile whose polygons did not
 * move since the last frame is left alone, and a tile whose glyph polygon is
 * an axis-aligned rectangle is moved and scaled like a mosaic's — a fresh grid
 * costs what a mosaic costs.
 *
 * Children are positioned RELATIVE TO THE GROUP'S CENTRE, which Fabric puts at
 * the centre of the children's box. A mesh's bounds grow as it is extruded,
 * so the centre is not the origin, and every position written here subtracts
 * it. The renderer stamps it on the group as `localCentre`.
 */

/** What the renderer leaves on a glyph child for the painter. */
export interface GlyphMark {
  rest: GlyphRest
  /** Where the letter's box sits in the unit square, for the rectangle fast path. */
  unitCentre: Vec2
  /** The rectangle the commands were last emitted for, or null when they were poured through a warp. */
  builtRect: Rect | null
  /** The command array the child draws — rewritten in place. */
  commands: PathCommand[]
}

/** A Fabric path child, as much of one as this file needs to know about. */
export interface PathChild {
  get(key: string): unknown
  set(key: string, value: unknown): void
  set(values: Record<string, unknown>): void
  path?: unknown
  pathOffset?: Vec2
  setDimensions?: () => void
  setCoords?: () => void
  clipPath?: PathChild | undefined
  inverted?: boolean
}

export interface MeshGroup {
  getObjects(): PathChild[]
  clipPath?: PathChild | undefined
}

/** What one frame remembers for the next: which tiles stood still. */
export interface MeshPaintCache {
  lastLayout: Map<string, string>
}

export const newPaintCache = (): MeshPaintCache => ({ lastLayout: new Map() })

/** Give a child new commands, recompute its box, and stand it where the box is. */
export function placeCommands(child: PathChild, commands: PathCommand[], centre: Vec2): void {
  child.path = commands
  child.setDimensions?.()
  const offset = child.pathOffset ?? { x: 0, y: 0 }
  child.set({ left: offset.x - centre.x, top: offset.y - centre.y, dirty: true })
  child.setCoords?.()
}

/** Commands moved by an offset — for the clip, whose frame is the group's centre. */
export function shiftCommands(commands: readonly PathCommand[], by: Vec2): PathCommand[] {
  return commands.map((command) => {
    const out: PathCommand = [command[0] as string]
    for (let i = 1; i < command.length; i += 2) {
      out.push((command[i] as number) - by.x, (command[i + 1] as number) - by.y)
    }
    return out
  })
}

/** Every tile's structural polygon, as one path: the backdrop with no seams. */
export function backdropCommands(
  shape: MeshBackdrop,
  tiles: readonly MeshTile[],
  nodes: Readonly<Record<string, Vec2>>,
  radius: number,
  padding: number,
): PathCommand[] {
  // The silhouette itself, grown by the padding: one even-odd fill, so a hole
  // stays a hole and every gap between tiles is covered.
  return silhouetteCommands(shape, tiles, nodes, radius, Math.max(0, padding))
}

/**
 * The outline everything outside the tiles follows — the backdrop, the clip
 * and the border — for either shape: the box round every node, grown by the
 * outset and rounded at its corners, or the rim loops.
 */
export function silhouetteCommands(
  shape: MeshBackdrop,
  tiles: readonly MeshTile[],
  nodes: Readonly<Record<string, Vec2>>,
  radius: number,
  outset = 0,
): PathCommand[] {
  if (shape !== 'box') return rimCommands(tiles, nodes, radius, outset)
  const points = Object.values(nodes)
  if (points.length === 0) return []
  const box = polygonBounds(points)
  const corners: Vec2[] = [
    { x: box.x - outset, y: box.y - outset },
    { x: box.x + box.width + outset, y: box.y - outset },
    { x: box.x + box.width + outset, y: box.y + box.height + outset },
    { x: box.x - outset, y: box.y + box.height + outset },
  ]
  return roundedPolygonCommands(corners, radius)
}

/** Every edge of the mesh once: the lines kept as artwork. */
export function linesCommands(tiles: readonly MeshTile[], nodes: Readonly<Record<string, Vec2>>): PathCommand[] {
  const out: PathCommand[] = []
  for (const edge of edgesOf(tiles).values()) {
    const a = nodes[edge.a]
    const b = nodes[edge.b]
    if (!a || !b) continue
    out.push(['M', a.x, a.y], ['L', b.x, b.y])
  }
  return out
}

/**
 * The silhouette: every rim loop, rounded, optionally pushed outward — for
 * the clip, which has to make room for a border that reaches past the rim.
 */
export function rimCommands(
  tiles: readonly MeshTile[],
  nodes: Readonly<Record<string, Vec2>>,
  radius: number,
  outset = 0,
): PathCommand[] {
  const out: PathCommand[] = []
  for (const loop of rimLoops(tiles)) {
    const points = loop.map((id) => nodes[id] ?? { x: 0, y: 0 })
    const grown =
      outset > 0
        ? (insetPolygon(points, points.map(() => -outset)) ?? points)
        : points
    out.push(...roundedPolygonCommands(grown, radius))
  }
  return out
}

/** The mesh's lines: a plain centred stroke, or nothing. */
export function applyLines(child: PathChild, lines: Stroke | null): void {
  if (!lines || !(lines.width > 0)) {
    child.set({ stroke: 'transparent', strokeWidth: 0, dirty: true })
    return
  }
  child.set({
    stroke: lines.colour,
    strokeWidth: lines.width,
    strokeDashArray: dashArrayFor(lines),
    dirty: true,
  })
}

/**
 * The silhouette's border, positioned the way `strokeChild` positions one: a
 * centred stroke at double width with half of it masked away, the mask being
 * the same loops. Centre needs no mask; the child keeps it but is told not to
 * use it, so a border can change position mid-transition without a rebuild.
 */
export function applyOutline(child: PathChild, mask: PathChild | undefined, stroke: PositionedStroke | null): void {
  if (!stroke || !(stroke.width > 0)) {
    child.set({ stroke: 'transparent', strokeWidth: 0, dirty: true })
    return
  }
  const { width, clip } = strokePaint(stroke)
  child.set({
    stroke: stroke.colour,
    strokeWidth: width,
    strokeDashArray: dashArrayFor(stroke),
    dirty: true,
  })
  if (mask) {
    mask.inverted = clip === 'outside'
    child.clipPath = clip === 'none' ? undefined : mask
  }
}

/** A tile's polygons, as one string — what "did it move" compares. */
function layoutKey(layout: MeshTileLayout, radius: number): string {
  const parts: string[] = [radius.toFixed(3)]
  for (const p of layout.visible) parts.push(p.x.toFixed(3), p.y.toFixed(3))
  for (const p of layout.glyph) parts.push(p.x.toFixed(3), p.y.toFixed(3))
  return parts.join(',')
}

/** Put one evaluated frame on screen. */
export function paintMeshFrame(
  group: MeshGroup,
  frame: EvaluatedMeshFrame,
  tiles: readonly MeshTile[],
  centre: Vec2,
  cache: MeshPaintCache,
): void {
  // Which outline each tile shows — the mosaic's rule, word for word.
  const chosen = new Map<string, string | null>()
  for (const child of group.getObjects()) {
    if (child.get('role') !== 'glyph') continue
    const leafId = child.get('leafId')
    const key = child.get('glyphKey')
    if (typeof leafId !== 'string' || typeof key !== 'string') continue
    const wanted = frame.glyphKeys[leafId]
    if (wanted === undefined) {
      chosen.set(leafId, null)
      continue
    }
    const already = chosen.get(leafId)
    if (already === wanted) continue
    if (already === undefined || already === null || key === wanted) chosen.set(leafId, key)
  }

  const moved = new Map<string, boolean>()
  for (const [id, layout] of frame.tileLayouts) {
    const key = layoutKey(layout, frame.corners.tileRadius)
    moved.set(id, cache.lastLayout.get(id) !== key)
    cache.lastLayout.set(id, key)
  }

  let outlineMask: PathChild | undefined
  for (const child of group.getObjects()) {
    const role = child.get('role')

    if (role === 'backdrop') {
      placeCommands(
        child,
        backdropCommands(
          frame.backdrop,
          tiles,
          frame.nodes,
          frame.corners.outerRadius,
          frame.spacing.outerPadding ?? 0,
        ),
        centre,
      )
      child.set({ fill: frame.background ?? 'transparent' })
      continue
    }
    if (role === 'lines') {
      placeCommands(child, linesCommands(tiles, frame.nodes), centre)
      applyLines(child, frame.lines)
      continue
    }
    if (role === 'outline') {
      const loops = silhouetteCommands(
        frame.backdrop,
        tiles,
        frame.nodes,
        frame.corners.outerRadius,
        frame.spacing.outerPadding ?? 0,
      )
      placeCommands(child, loops, centre)
      outlineMask = (child.get('mask') as PathChild | undefined) ?? child.clipPath
      if (outlineMask) {
        outlineMask.path = loops
        outlineMask.setDimensions?.()
        outlineMask.set({ left: 0, top: 0, dirty: true })
      }
      applyOutline(child, outlineMask, frame.stroke)
      continue
    }

    if (role !== 'tile' && role !== 'glyph') continue
    const leafId = child.get('leafId')
    if (typeof leafId !== 'string') continue
    const layout = frame.tileLayouts.get(leafId)
    if (!layout) continue

    if (role === 'tile') {
      if (moved.get(leafId)) {
        placeCommands(child, roundedPolygonCommands(layout.visible, frame.corners.tileRadius), centre)
      }
      child.set({ fill: frame.tileColours[leafId] ?? 'transparent' })
      continue
    }

    const key = child.get('glyphKey')
    const wanted = typeof key !== 'string' ? true : chosen.get(leafId) === key
    const mark = child.get('mesh') as GlyphMark | undefined
    if (!wanted || !mark) {
      child.set({ visible: false })
      continue
    }
    const map = cellMap(layout)
    if (!map) {
      child.set({ visible: false })
      continue
    }
    child.set({ visible: true, fill: frame.glyphColours[leafId] ?? DEFAULT_GLYPH_COLOUR })
    if (!moved.get(leafId)) continue

    const rect = layout.rect
    if (rect && mark.builtRect && mark.builtRect.width > 0 && mark.builtRect.height > 0) {
      // A rectangle: the outline built for one rectangle is moved and scaled
      // into another, which is the same map either way.
      child.set({
        left: rect.x + mark.unitCentre.x * rect.width - centre.x,
        top: rect.y + mark.unitCentre.y * rect.height - centre.y,
        scaleX: rect.width / mark.builtRect.width,
        scaleY: rect.height / mark.builtRect.height,
        dirty: true,
      })
      child.setCoords?.()
      continue
    }
    // Anything else is poured through the cell, and the pour is what the child
    // now draws — at scale one, so a rectangle after this starts from a
    // rectangle again.
    emitGlyph(mark.rest, map, mark.commands)
    placeCommands(child, mark.commands, centre)
    child.set({ scaleX: 1, scaleY: 1 })
    mark.builtRect = rect ? { ...rect } : null
  }

  // The clip last: the silhouette grown by the border's reach, in the group's
  // own frame.
  const clip = group.clipPath
  if (clip) {
    const reach = strokeReach(frame.stroke)
    const padding = frame.spacing.outerPadding ?? 0
    const loops = shiftCommands(
      silhouetteCommands(frame.backdrop, tiles, frame.nodes, frame.corners.outerRadius + reach, padding + reach),
      centre,
    )
    clip.path = loops
    clip.setDimensions?.()
    const offset = clip.pathOffset ?? { x: 0, y: 0 }
    clip.set({ left: offset.x, top: offset.y, dirty: true })
  }
}
