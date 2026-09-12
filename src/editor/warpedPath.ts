import { Path } from 'fabric'

import { sourceRectOf } from '../geometry/imagePlacement'
import { drawWarpedImage, subdivisionsFor, type CellMap, type WarpContext } from '../geometry/warpImage'
import { cellMap, polygonBounds } from '../mesh/mesh'
import { resolvePaint } from '../typography/paint'
import type { MeshTileLayout } from '../types/mesh'
import type { ImageCrop, Paint } from '../types/paint'
import { imageFor, sizeOf, type ImageSource } from './imageCache'
import { fabricPaint } from './paintFill'

/**
 * A mesh cell's path that can wear a picture bent with the cell.
 *
 * A tile or a letter in a mesh is a warped polygon, and a picture in it has
 * to bend the same way the letters are poured — through the cell's own map.
 * No Fabric fill can do that, so this child draws it itself: its outline as
 * a clip, then the picture through `drawWarpedImage`. With no picture it is
 * an ordinary path. Every mesh child already renders without a cache, so
 * the warp runs once per pass and needs no invalidation of its own.
 */

/** The picture a child wears, and the map it bends through, for this frame. */
export interface Picture {
  source: ImageSource
  crop: ImageCrop
  opacity: number
  map: CellMap
  n: number
  /** The cell's box, which the picture covers before it is bent. */
  box: { width: number; height: number }
}

export class WarpedPath extends Path {
  static override type = 'WarpedPath'
  picture: Picture | null = null

  override _render(ctx: CanvasRenderingContext2D): void {
    const picture = this.picture
    if (!picture) {
      super._render(ctx)
      return
    }
    ctx.save()
    this._renderPathCommands(ctx)
    ctx.clip(this.fillRule)
    ctx.globalAlpha *= picture.opacity
    const rect = sourceRectOf(picture.box, sizeOf(picture.source), picture.crop)
    drawWarpedImage(
      ctx as unknown as WarpContext,
      { image: picture.source, ...rect },
      picture.map,
      picture.n,
      this.pathOffset,
    )
    ctx.restore()
  }
}

/** As much of a warped path as the painter needs to know about. */
export interface PicturedChild {
  picture: Picture | null
  set(values: Record<string, unknown>): void
}

/**
 * Put a paint on a mesh cell's child: a colour or a gradient as a fill, a
 * picture as the warp through this frame's layout. The picture's box is the
 * cell's, so the crop means what it means on a tile: cover, then pan and
 * zoom.
 */
export function applyMeshPaint(
  child: PicturedChild,
  paint: Paint | null | undefined,
  layout: MeshTileLayout,
  which: 'tile' | 'glyph',
  fallback = 'transparent',
): void {
  const resolved = resolvePaint(paint, 0)
  if (resolved?.kind === 'image') {
    const source = imageFor(resolved.asset)
    const map = cellMap(layout, which === 'tile' ? 'visible' : 'glyph')
    if (source && map) {
      const polygon = which === 'tile' ? layout.visible : layout.glyph
      child.picture = {
        source,
        crop: resolved.crop,
        opacity: resolved.opacity,
        map,
        n: subdivisionsFor(layout),
        box: polygonBounds(polygon),
      }
      child.set({ fill: 'transparent', opacity: 1, dirty: true })
      return
    }
    child.picture = null
    child.set({ fill: 'transparent', opacity: 1, dirty: true })
    return
  }
  child.picture = null
  child.set({ fill: resolved ? fabricPaint(resolved) : fallback, opacity: 1, dirty: true })
}
