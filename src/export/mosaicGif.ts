import { GIFEncoder, applyPalette, quantize } from 'gifenc'

import { glyphInRect } from '../mosaic/glyph'
import { dashArrayFor, strokeBand, strokeReach } from '../geometry/stroke'
import { glyphReferenceRects } from '../editor/mosaicPlayback'
import {
  authoredTimeFor,
  evaluateMosaicAtTime,
  playbackDuration,
} from '../mosaic/timeline'
import type { LetterMosaicObject, Rect } from '../types/document'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'
import { ARTBOARD_BACKGROUND } from '../state/defaults'

/**
 * A letter mosaic, written out as an animated GIF.
 *
 * Separate from `gif.ts` because the two have nothing in common below the
 * encoder: a typography object animates by deforming one outline over a preset
 * loop, while a mosaic is a timeline of authored states with its own evaluator.
 * What they DO share is the encoder and the framing, and those are the parts
 * this file borrows.
 *
 * Every frame comes from `evaluateMosaicAtTime` — the same function the canvas
 * plays through — so an export cannot drift away from the preview. That is the
 * whole reason the evaluator is a pure function of the object and a time.
 */

/** Share of the frame left empty around the artwork, matching `gif.ts`. */
const MARGIN = 0.06

export type MosaicGifBackground = 'transparent' | 'solid'

export interface MosaicGifOptions {
  object: LetterMosaicObject
  /** Square output, in pixels. */
  size: number
  frames: number
  background: MosaicGifBackground
  name: string
  /** Colour behind the artwork when the background is solid. */
  artboard?: string
}

export async function exportMosaicGif(options: MosaicGifOptions): Promise<void> {
  const bytes = await renderMosaicGif(options)
  download(bytes, `${safeName(options.name)}.gif`)
}

/** The encoded bytes, separated from the download so it can be inspected. */
export async function renderMosaicGif(options: MosaicGifOptions): Promise<Uint8Array> {
  const { object, size, frames, background } = options
  if (object.tiles.length === 0) throw new Error('Nothing to export — this mosaic has no tiles.')

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a drawing surface.')

  /*
   * Framed on the mosaic's own box, which every state is laid into.
   *
   * No need to measure the states, unlike a typography export that has to find
   * the widest the artwork ever gets: a mosaic's tiles are a partition of this
   * rectangle and nothing can reach outside it. So the framing is fixed, and the
   * composition does not drift about inside the frame while it plays.
   */
  const box = object.localBounds
  /*
   * Grown by whatever the border reaches outside the silhouette, so an outside
   * band is not sliced off at the edge of the GIF. `strokeReach` is the single
   * source for that number, here as on the canvas — and it is taken across
   * every state, because a border that only state three has still has to fit.
   */
  const reach = Math.max(0, ...object.states.map((state) => strokeReach(state.stroke ?? null)))
  const extent = (Math.max(box.width, box.height) || 1) + reach * 2
  const scale = (size * (1 - MARGIN * 2)) / extent
  const centreX = box.x + box.width / 2
  const centreY = box.y + box.height / 2

  /*
   * Outlines cut once, then mapped into each frame's rectangle.
   *
   * The same trick the canvas uses: build at the largest rectangle a tile
   * reaches across every state and the residual scale is never above 1, so
   * nothing is magnified. Here it also saves cutting the same letter again for
   * every frame — at forty-eight frames that is the difference between a
   * moment and a wait.
   */
  const references = glyphReferenceRects(object)
  const outlines = new Map<string, Path2D>()
  const outlineFor = (leafId: string, char: string, fontId: string): Path2D | null => {
    const key = `${leafId}|${char}|${fontId}`
    const seen = outlines.get(key)
    if (seen) return seen
    const reference = references.get(leafId)
    if (!reference || !(reference.width > 0) || !(reference.height > 0)) return null
    const data = glyphInRect(fontId, char, reference)
    if (!data) return null
    const path = new Path2D(data)
    outlines.set(key, path)
    return path
  }

  const encoder = GIFEncoder()
  const duration = playbackDuration(object)
  const count = Math.max(1, Math.round(frames))
  const delay = Math.max(20, Math.round(duration / count))

  for (let index = 0; index < count; index++) {
    /*
     * Sampled across the loop WITHOUT repeating its ends.
     *
     * The last frame sits one step before the duration rather than on it: at
     * exactly the duration a looping mosaic is back at its start, so including
     * both would hold the first composition for two frames every time round.
     */
    const wall = (duration * index) / count
    const frame = evaluateMosaicAtTime(object, authoredTimeFor(object, wall))

    ctx.clearRect(0, 0, size, size)
    if (background === 'solid') {
      ctx.fillStyle = options.artboard ?? ARTBOARD_BACKGROUND
      ctx.fillRect(0, 0, size, size)
    }

    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.scale(scale, scale)
    ctx.translate(-centreX, -centreY)

    // The rounded outline, as a clip — the same shape the canvas applies, so a
    // letter reaching the edge is cut by the curve here too.
    const outer = Math.max(0, frame.corners.outerRadius)
    if (outer > 0) {
      ctx.beginPath()
      roundedRect(ctx, box, fitRadius(outer, box.width, box.height))
      ctx.clip()
    }

    /*
     * The backdrop, inside the clip and under everything.
     *
     * Drawn on the mosaic's own box rather than a union of the tiles, because
     * what it is FOR is the ground no tile covers — the outer padding and the
     * gaps. The clip above has already been taken, so the outer radius rounds it
     * exactly as it does on the canvas.
     */
    if (frame.background) {
      ctx.fillStyle = frame.background
      ctx.fillRect(box.x, box.y, box.width, box.height)
    }

    for (const tile of object.tiles) {
      const layout = frame.tileLayouts.get(tile.id)
      if (!layout) continue

      const fill = frame.tileColours[tile.id] ?? null
      if (fill) {
        const rect = layout.visible
        ctx.fillStyle = fill
        ctx.beginPath()
        roundedRect(ctx, rect, fitRadius(frame.corners.tileRadius, rect.width, rect.height))
        ctx.fill()
      }

      const char = frame.chars[tile.id]
      if (!char) continue
      const outline = outlineFor(tile.id, char, frame.font.fontId)
      const reference = references.get(tile.id)
      if (!outline || !reference) continue
      const rect = layout.glyph
      if (!(rect.width > 0) || !(rect.height > 0)) continue

      ctx.save()
      // Translation and two scales, mapping the rectangle the outline was cut
      // for onto the one this frame asks for — the same affine the canvas uses.
      ctx.translate(rect.x, rect.y)
      ctx.scale(rect.width / reference.width, rect.height / reference.height)
      ctx.translate(-reference.x, -reference.y)
      ctx.fillStyle = frame.glyphColours[tile.id] ?? DEFAULT_GLYPH_COLOUR
      ctx.fill(outline, 'nonzero')
      ctx.restore()
    }

    /*
     * The composition's edge, last and inside the same clip.
     *
     * Double width because the clip above takes the outer half, exactly as the
     * group clip does on the canvas — so the export draws the border the same
     * distance inside the silhouette that the preview did.
     */
    if (frame.stroke && frame.stroke.width > 0) {
      /*
       * The band's own rectangle, from the same sum the canvas uses — a
       * position is a different rounded rect here, not a clipped stroke. Drawn
       * OUTSIDE the clip taken above, because a centred or outside band lies
       * partly beyond the silhouette and the clip would cut it away.
       */
      ctx.restore()
      ctx.save()
      ctx.translate(size / 2, size / 2)
      ctx.scale(scale, scale)
      ctx.translate(-centreX, -centreY)

      const band = strokeBand(box, fitRadius(outer, box.width, box.height), frame.stroke)
      ctx.beginPath()
      roundedRect(ctx, band.box, band.radius)
      ctx.lineWidth = frame.stroke.width
      ctx.strokeStyle = frame.stroke.colour
      ctx.setLineDash(dashArrayFor(frame.stroke) ?? [])
      ctx.stroke()
      ctx.setLineDash([])
    }

    ctx.restore()

    const pixels = ctx.getImageData(0, 0, size, size).data
    // `rgba4444` keeps alpha through quantisation, which is what lets the
    // cut-out background survive into the palette.
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

/** A radius that fits the rectangle it is drawn on — half the shorter side. */
function fitRadius(radius: number, width: number, height: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return 0
  return Math.min(radius, Math.max(0, width) / 2, Math.max(0, height) / 2)
}

/** A rectangle with equal corners, as a path on the given context. */
function roundedRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const w = Math.max(0, rect.width)
  const h = Math.max(0, rect.height)
  if (radius <= 0) {
    ctx.rect(rect.x, rect.y, w, h)
    return
  }
  const r = Math.min(radius, w / 2, h / 2)
  ctx.moveTo(rect.x + r, rect.y)
  ctx.arcTo(rect.x + w, rect.y, rect.x + w, rect.y + h, r)
  ctx.arcTo(rect.x + w, rect.y + h, rect.x, rect.y + h, r)
  ctx.arcTo(rect.x, rect.y + h, rect.x, rect.y, r)
  ctx.arcTo(rect.x, rect.y, rect.x + w, rect.y, r)
  ctx.closePath()
}

function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')
  return cleaned || 'mosaic'
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
