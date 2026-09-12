import { Group, Path, Rect as FabricRect, type FabricObject, type TComplexPathData } from 'fabric'

import { strokeReach } from '../geometry/stroke'
import { emitGlyph, glyphRest } from '../mesh/glyph'
import { layoutMesh } from '../mesh/layout'
import { cellMap, roundedPolygonCommands, commandsToPath, type PathCommand } from '../mesh/mesh'
import { isFontLoaded } from '../typography/fontRegistry'
import type { FontSettings, MeshObject, PositionedStroke, Rect, Vec2 } from '../types/document'
import { MESH_DEFAULT_CORNERS, MESH_DEFAULT_SPACING } from '../types/mesh'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'
import {
  applyLines,
  applyOutline,
  backdropCommands,
  linesCommands,
  silhouetteCommands,
  shiftCommands,
  type GlyphMark,
} from './meshPlayback'
import { emptyGround, groundRadius } from './invitations'
import { fillOf } from './paintFill'
import { WarpedPath, applyMeshPaint } from './warpedPath'
import { finishGroup, fontKey } from './renderer'
import { strokeChild } from './strokePaint'

/**
 * A mesh as a Fabric group — the mesh's `buildMosaicGroup`.
 *
 * Every child is a `Path` in the object's local units: a backdrop of every
 * tile's structural polygon, a rounded polygon per tile, a letter per (tile,
 * character, font) poured through the tile's map, the mesh's lines, and the
 * silhouette's border; the group is clipped to the rim. All of them carry a
 * `role`, and the letters carry the rest outline they were poured from, so
 * that playback can rewrite them in place — see `meshPlayback.ts`.
 *
 * The group's centre is the centre of `localBounds`, pinned by a transparent
 * rectangle grown by the widest border any state reaches, so that a border
 * poking past the rim never shifts where Fabric puts the centre. That centre
 * is what every positioned child is measured from once the group exists.
 */

const asPath = (commands: PathCommand[]): TComplexPathData =>
  commands as unknown as TComplexPathData

/** A border the outline child starts with when no state has one yet: invisible, inside. */
const NO_BORDER: PositionedStroke = { colour: 'transparent', width: 0, position: 'inside', dash: null }

/** Where the letter's box sits in the unit square: the mean of the rest points. */
function unitCentreOf(points: readonly { type: string; x: number; y: number }[]): Vec2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.type === 'Z') continue
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX)) return { x: 0.5, y: 0.5 }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** The furthest the backdrop reaches past the rim in any state. */
function widestPadding(object: MeshObject): number {
  let padding = 0
  for (const state of object.states) padding = Math.max(padding, state.outerPadding ?? 0)
  return padding
}

/** The widest a border reaches past the rim in any state. */
function widestReach(object: MeshObject): number {
  let reach = 0
  for (const state of object.states) reach = Math.max(reach, strokeReach(state.stroke ?? null))
  return reach
}

export function buildMeshGroup(
  object: MeshObject,
  at: number,
  ground: string | null = emptyGround(object),
): Group {
  const state = object.states[at] ?? object.states[0]
  const positions = state?.nodes ?? {}
  const spacing = {
    gap: state?.gap ?? MESH_DEFAULT_SPACING.gap,
    glyphInset: state?.glyphInset ?? MESH_DEFAULT_SPACING.glyphInset,
    outerPadding: state?.outerPadding ?? MESH_DEFAULT_SPACING.outerPadding,
  }
  const corners = {
    tileRadius: state?.tileRadius ?? MESH_DEFAULT_CORNERS.tileRadius,
    outerRadius: state?.outerRadius ?? MESH_DEFAULT_CORNERS.outerRadius,
  }
  const layouts = layoutMesh(object.tiles, positions, spacing)
  const bounds = object.localBounds
  const centre: Vec2 = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const reach = widestReach(object) + widestPadding(object)

  const fonts = new Map<string, FontSettings>()
  for (const each of object.states) fonts.set(fontKey(each.font), each.font)
  if (state) fonts.set(fontKey(state.font), state.font)

  const children: FabricObject[] = []

  // The box, pinning the group's centre whatever is drawn inside it.
  const extent = new FabricRect({
    left: centre.x,
    top: centre.y,
    width: bounds.width + reach * 2,
    height: bounds.height + reach * 2,
    originX: 'center',
    originY: 'center',
    fill: 'transparent',
    strokeWidth: 0,
    objectCaching: false,
    evented: false,
  })
  extent.set('role', 'extent')
  children.push(extent)

  // The backdrop: the silhouette grown by the padding, as one fill. An empty
  // mesh stands on a light, rounded ground (`emptyGround`); the rounding is
  // the ground's and is kept through playback (`restRadius`) the way the
  // colour is.
  const restRadius = ground ? groundRadius(bounds.width, bounds.height) : 0
  const backdrop = new Path(
    asPath(
      backdropCommands(
        object.backdrop,
        object.tiles,
        positions,
        Math.max(corners.outerRadius, restRadius),
        spacing.outerPadding,
      ),
    ),
    {
      fill: fillOf(state?.background, ground ?? 'transparent'),
      strokeWidth: 0,
      objectCaching: false,
      evented: false,
    },
  )
  backdrop.fillRule = 'evenodd'
  backdrop.set('restFill', ground ?? 'transparent')
  backdrop.set('restRadius', restRadius)
  backdrop.set('role', 'backdrop')
  children.push(backdrop)

  for (const tile of object.tiles) {
    const layout = layouts.get(tile.id)
    if (!layout) continue

    const colour = state?.tileColour[tile.id] ?? null
    const shape = new WarpedPath(asPath(roundedPolygonCommands(layout.visible, corners.tileRadius)), {
      strokeWidth: 0,
      objectCaching: false,
      evented: false,
    })
    shape.set('role', 'tile')
    shape.set('leafId', tile.id)
    applyMeshPaint(shape, colour, layout, 'tile')
    children.push(shape)

    // Every letter this tile shows in any state, in every font: cut once,
    // chosen per frame — the mosaic's rule.
    const written = new Set<string>()
    for (const each of object.states) {
      const char = each.chars[tile.id]
      if (char) written.add(char)
    }
    if (written.size === 0) continue
    const map = cellMap(layout)
    const shownKey = state ? `${state.chars[tile.id] ?? ''}|${fontKey(state.font)}` : ''

    for (const char of written) {
      for (const font of fonts.values()) {
        const rest = glyphRest(font.fontId, char)
        if (!rest) continue
        const key = `${char}|${fontKey(font)}`
        const commands: PathCommand[] = []
        // Poured now, so the static picture is right without a frame.
        if (map) emitGlyph(rest, map, commands)
        const glyph = new WarpedPath(asPath(commands.length > 0 ? commands : [['M', 0, 0], ['Z']]), {
          strokeWidth: 0,
          objectCaching: false,
          evented: false,
          visible: key === shownKey && map !== null,
        })
        glyph.fillRule = 'nonzero'
        glyph.set('role', 'glyph')
        glyph.set('leafId', tile.id)
        glyph.set('glyphKey', key)
        applyMeshPaint(glyph, state?.glyphColour[tile.id] ?? DEFAULT_GLYPH_COLOUR, layout, 'glyph')
        const mark: GlyphMark = {
          rest,
          unitCentre: unitCentreOf(rest.points),
          builtRect: layout.rect ? { ...layout.rect } : null,
          commands: glyph.path as unknown as PathCommand[],
        }
        glyph.set('mesh', mark)
        children.push(glyph)
      }
    }
  }

  // The lines, above the letters: the grid kept as artwork, or nothing.
  const lines = new Path(asPath(linesCommands(object.tiles, positions)), {
    fill: 'transparent',
    strokeWidth: 0,
    strokeUniform: false,
    objectCaching: false,
    evented: false,
  })
  lines.set('role', 'lines')
  applyLines(lines, state?.lines ?? null)
  children.push(lines)

  // The silhouette's border, on top, through the same child a shape's border
  // uses — masked for inside and outside — and always attached.
  const loops = silhouetteCommands(
    object.backdrop,
    object.tiles,
    positions,
    corners.outerRadius,
    spacing.outerPadding,
  )
  const outline = strokeChild(commandsToPath(loops), state?.stroke ?? NO_BORDER)
  outline.set('role', 'outline')
  outline.set('mask', outline.clipPath)
  applyOutline(outline as never, outline.clipPath as never, state?.stroke ?? null)
  children.push(outline)

  const group = finishGroup(object, children, centre)

  const clipReach = strokeReach(state?.stroke ?? null)
  const clip = new Path(
    asPath(
      shiftCommands(
        silhouetteCommands(
          object.backdrop,
          object.tiles,
          positions,
          corners.outerRadius + clipReach,
          spacing.outerPadding + clipReach,
        ),
        centre,
      ),
    ),
    { objectCaching: false },
  )
  clip.fillRule = 'evenodd'
  group.clipPath = clip

  return group
}

/** Everything about the mesh that changes what is DRAWN, as one string. */
export function meshContentKey(object: MeshObject, at: number): string {
  const state = object.states[at] ?? object.states[0]
  const bounds: Rect = object.localBounds
  return [
    at,
    object.states.map((each) => (isFontLoaded(each.font.fontId) ? '1' : '0')).join(''),
    object.states.map((each) => fontKey(each.font)).join(','),
    object.states.map((each) => JSON.stringify(each.chars)).join(';'),
    JSON.stringify(object.tiles),
    JSON.stringify(state?.nodes ?? {}),
    state?.gap ?? 0,
    state?.glyphInset ?? 0,
    state?.outerPadding ?? 0,
    widestPadding(object),
    object.backdrop,
    state?.tileRadius ?? 0,
    state?.outerRadius ?? 0,
    JSON.stringify(state?.stroke ?? null),
    JSON.stringify(state?.lines ?? null),
    state?.background ?? '',
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    object.opacity,
    widestReach(object),
    JSON.stringify(state?.glyphColour ?? {}),
    JSON.stringify(state?.tileColour ?? {}),
  ].join('|')
}
