import { loadAssets, paintAlpha, styleOf } from './paintStyle'
import { drawWarpedImage, subdivisionsFor } from '../geometry/warpImage'
import { sourceRectOf } from '../geometry/imagePlacement'
import { imageFor, sizeOf } from '../editor/imageCache'
import { isImagePaint } from '../typography/paint'
import type { ImageAsset, ImagePaint } from '../types/paint'
import type { MeshTileLayout } from '../types/mesh'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'

import { dashArrayFor, strokeReach } from '../geometry/stroke'
import { glyphPath2D, glyphRest } from '../mesh/glyph'
import { cellMap, edgesOf, polygonBounds, roundedPolygonCommands, type PathCommand } from '../mesh/mesh'
import { silhouetteCommands } from '../editor/meshPlayback'
import { evaluateMeshAtTime, meshAuthoredTimeFor, meshPlaybackDuration } from '../mesh/timeline'
import { ARTBOARD_BACKGROUND } from '../state/defaults'
import type { MeshObject, Rect, Vec2 } from '../types/document'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'

/**
 * A mesh, written out as an animated GIF — the mesh's `mosaicGif.ts`. Every
 * frame comes from `evaluateMeshAtTime`, the function the canvas plays
 * through, so an export cannot drift from the preview; the letters are poured
 * through each cell's map at full size, frame by frame.
 */

const MARGIN = 0.06

export type MeshGifBackground = 'transparent' | 'solid'

export interface MeshGifOptions {
  object: MeshObject
  size: number
  frames: number
  background: MeshGifBackground
  name: string
  /** The pictures the mesh's paints refer to. */
  assets?: Readonly<Record<string, ImageAsset>>
  artboard?: string
}

export async function exportMeshGif(options: MeshGifOptions): Promise<void> {
  const bytes = await renderMeshGif(options)
  download(bytes, `${safeName(options.name)}.gif`)
}

export async function renderMeshGif(options: MeshGifOptions): Promise<Uint8Array> {
  const { object, size, frames, background } = options
  await loadAssets(options.assets)
  if (object.tiles.length === 0) throw new Error('Nothing to export — this mesh has no tiles.')

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a drawing surface.')

  // Framed on the box every state's nodes sit in, grown by the widest border.
  const box = object.localBounds
  const reach = Math.max(
    0,
    ...object.states.map((state) => strokeReach(state.stroke ?? null) + (state.outerPadding ?? 0)),
  )
  const extent = (Math.max(box.width, box.height) || 1) + reach * 2
  const scale = (size * (1 - MARGIN * 2)) / extent
  const centreX = box.x + box.width / 2
  const centreY = box.y + box.height / 2

  const encoder = GIFEncoder()
  const duration = meshPlaybackDuration(object)
  const count = Math.max(1, Math.round(frames))
  const delay = Math.max(20, Math.round(duration / count))

  const trace = (commands: PathCommand[]): void => {
    for (const command of commands) {
      if (command[0] === 'M') ctx.moveTo(command[1] as number, command[2] as number)
      else if (command[0] === 'L') ctx.lineTo(command[1] as number, command[2] as number)
      else if (command[0] === 'Q') {
        ctx.quadraticCurveTo(
          command[1] as number,
          command[2] as number,
          command[3] as number,
          command[4] as number,
        )
      } else if (command[0] === 'Z') ctx.closePath()
    }
  }

  for (let index = 0; index < count; index++) {
    const wall = (duration * index) / count
    const frame = evaluateMeshAtTime(object, meshAuthoredTimeFor(object, wall))
    const nodes = frame.nodes

    ctx.clearRect(0, 0, size, size)
    if (background === 'solid') {
      ctx.fillStyle = options.artboard ?? ARTBOARD_BACKGROUND
      ctx.fillRect(0, 0, size, size)
    }

    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.scale(scale, scale)
    ctx.translate(-centreX, -centreY)

    // The silhouette grown by the padding: the clip, the backdrop and the border.
    const padding = frame.spacing.outerPadding ?? 0
    const silhouette = silhouetteCommands(frame.backdrop, object.tiles, nodes, frame.corners.outerRadius, padding)

    // The rim as the clip, rounded like the canvas rounds it; holes stay holes.
    ctx.save()
    ctx.beginPath()
    trace(silhouette)
    ctx.clip('evenodd')

    if (frame.background) {
      ctx.fillStyle = styleOf(ctx, frame.background, boxOf(silhouette))
      ctx.globalAlpha = paintAlpha(frame.background)
      ctx.beginPath()
      trace(silhouette)
      ctx.fill('evenodd')
      ctx.globalAlpha = 1
    }

    for (const tile of object.tiles) {
      const layout = frame.tileLayouts.get(tile.id)
      if (!layout) continue

      const fill = frame.tileColours[tile.id] ?? null
      if (fill) {
        ctx.beginPath()
        trace(roundedPolygonCommands(layout.visible, frame.corners.tileRadius))
        if (isImagePaint(fill)) warpInto(ctx, fill, layout, 'tile')
        else {
          ctx.fillStyle = styleOf(ctx, fill, polygonBounds(layout.visible))
          ctx.fill()
        }
      }

      const char = frame.chars[tile.id]
      if (!char) continue
      const rest = glyphRest(frame.font.fontId, char)
      const map = cellMap(layout)
      if (!rest || !map) continue
      const letter = frame.glyphColours[tile.id] ?? DEFAULT_GLYPH_COLOUR
      ctx.beginPath()
      glyphPath2D(rest, map, ctx)
      if (isImagePaint(letter)) warpInto(ctx, letter, layout, 'glyph', 'nonzero')
      else {
        ctx.fillStyle = styleOf(ctx, letter, polygonBounds(layout.glyph))
        ctx.fill('nonzero')
      }
    }

    if (frame.lines && frame.lines.width > 0) {
      ctx.beginPath()
      for (const edge of edgesOf(object.tiles).values()) {
        const a = nodes[edge.a]
        const b = nodes[edge.b]
        if (!a || !b) continue
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.lineWidth = frame.lines.width
      ctx.strokeStyle = styleOf(ctx, frame.lines.colour, boxOf(silhouette))
      ctx.setLineDash(dashArrayFor(frame.lines) ?? [])
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()

    // The border, positioned the way the canvas positions it: a doubled
    // centred stroke with half of it clipped away, or a plain centred one.
    if (frame.stroke && frame.stroke.width > 0) {
      const position = frame.stroke.position
      ctx.save()
      ctx.beginPath()
      trace(silhouette)
      if (position === 'inside') ctx.clip('evenodd')
      else if (position === 'outside') {
        // Everything but the silhouette: the same loops with a frame around them.
        const pad = extent
        ctx.rect(centreX - pad, centreY - pad, pad * 2, pad * 2)
        ctx.clip('evenodd')
      }
      ctx.beginPath()
      trace(silhouette)
      ctx.lineWidth = position === 'centre' ? frame.stroke.width : frame.stroke.width * 2
      ctx.strokeStyle = styleOf(ctx, frame.stroke.colour, boxOf(silhouette))
      ctx.setLineDash(dashArrayFor(frame.stroke) ?? [])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }

    ctx.restore()

    const pixels = ctx.getImageData(0, 0, size, size).data
    const format = background === 'transparent' ? 'rgba4444' : 'rgb565'
    const palette = quantize(pixels, 256, { format })
    const indexed = applyPalette(pixels, palette, format)
    const transparentIndex =
      background === 'transparent' ? palette.findIndex((entry) => (entry[3] ?? 255) < 128) : -1

    encoder.writeFrame(indexed, size, size, {
      palette,
      delay,
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {}),
    })
  }

  encoder.finish()
  return encoder.bytes()
}

function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')
  return cleaned || 'mesh'
}

function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** The box a set of path commands covers, for placing a gradient on the silhouette. */
function boxOf(commands: readonly PathCommand[]): Rect {
  const points: Vec2[] = []
  for (const command of commands) {
    for (let i = 1; i + 1 < command.length; i += 2) {
      const x = command[i]
      const y = command[i + 1]
      if (typeof x === 'number' && typeof y === 'number') points.push({ x, y })
    }
  }
  return points.length > 0 ? polygonBounds(points) : { x: 0, y: 0, width: 1, height: 1 }
}

/**
 * A picture bent through a cell, inside the path just traced: the same warp
 * the canvas draws, clipped to the tile's face or the letter.
 */
function warpInto(
  ctx: CanvasRenderingContext2D,
  paint: ImagePaint,
  layout: MeshTileLayout,
  which: 'tile' | 'glyph',
  rule: CanvasFillRule = 'nonzero',
): void {
  const source = imageFor(paint.asset)
  const map = cellMap(layout, which === 'tile' ? 'visible' : 'glyph')
  if (!source || !map) return
  ctx.save()
  ctx.clip(rule)
  ctx.globalAlpha *= paint.opacity ?? 1
  const box = polygonBounds(which === 'tile' ? layout.visible : layout.glyph)
  drawWarpedImage(ctx, { image: source, ...sourceRectOf(box, sizeOf(source), paint.crop) }, map, subdivisionsFor(layout))
  ctx.restore()
}
