import { loadAssets, paintAlpha, paintStyle } from './paintStyle'
import type { ImageAsset } from '../types/paint'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'


import { pathBounds } from '../geometry/path'
import { animationFrames, fitObject } from '../typography/objectFit'
import type { DocumentObject, Rect } from '../types/document'
import { strokeReach } from '../geometry/stroke'
import { strokeOnContext } from './stroke'
import { ARTBOARD_BACKGROUND } from '../state/defaults'

/**
 * Animated GIF export.
 *
 * Frames are drawn with `Path2D` straight onto an offscreen canvas rather than
 * through Fabric. The engine's own output is already SVG path data, so this is
 * the short way round, and it keeps export independent of whatever the editor's
 * canvas happens to be showing — no scroll position, no selection handles, no
 * zoom level leaking into the file.
 *
 * GIF suits this artwork unusually well: it is two or three flat colours, so the
 * palette is tiny and the result is crisp rather than dithered.
 */

export type GifBackground = 'transparent' | 'solid'

export interface GifExportOptions {
  object: DocumentObject
  /** Square output, in pixels. */
  size: number
  frames: number
  background: GifBackground
  name: string
  /** The pictures the object's paints refer to. */
  assets?: Readonly<Record<string, ImageAsset>>
  /** Colour behind the artwork when the background is solid. */
  artboard?: string
}

/** Share of the frame left empty around the artwork. */
const MARGIN = 0.06

export async function exportGif(options: GifExportOptions): Promise<void> {
  const bytes = await renderGif(options)
  download(bytes, `${safeName(options.name)}.gif`)
}

/** The encoded bytes, separated from the download so it can be inspected. */
export async function renderGif(options: GifExportOptions): Promise<Uint8Array> {
  await loadAssets(options.assets)
  const { object, size, frames, background } = options
  /*
   * Typography only, for now, and it says so rather than failing oddly.
   *
   * A mosaic's animation is a timeline of authored states with its own
   * evaluator, not a preset sampled over one loop, so nothing below applies to
   * it. Exporting one is the last step of the mosaic work; until then a clear
   * refusal beats reading a shape's fields off something that has none.
   */
  if (object.kind !== 'typography') {
    throw new Error('Exporting a letter mosaic is not built yet.')
  }
  const sequence = animationFrames(object, frames)
  if (sequence.length === 0) throw new Error('Nothing to export — add some text first.')

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a drawing surface.')

  // Framed on the WIDEST the container ever gets, not on its resting size — a
  // pulse or a bulge grows past the resting outline, and framing on that would
  // clip the shape at its largest.
  const drawn = union([
    pathBounds(object.currentSourcePath),
    ...sequence.flatMap((frame) => (frame.shapePath ? [pathBounds(frame.shapePath)] : [])),
  ])
  /*
   * And grown by however far the border reaches OUTSIDE that.
   *
   * A centred border puts half its width past the outline and an outside one
   * puts all of it; framed on the shape alone, either would be sliced off at
   * the edge of the GIF. `strokeReach` is the single source for the number, so
   * this and the canvas cannot disagree about it.
   */
  const reach = strokeReach(object.appearance.containerStroke)
  const bounds = {
    x: drawn.x - reach,
    y: drawn.y - reach,
    width: drawn.width + reach * 2,
    height: drawn.height + reach * 2,
  }
  const extent = Math.max(bounds.width, bounds.height) || 1
  const scale = (size * (1 - MARGIN * 2)) / extent
  const centreX = bounds.x + bounds.width / 2
  const centreY = bounds.y + bounds.height / 2

  // Gradients span each element's RESTING box, measured once. Re-measuring per
  // frame would rescale the gradient as the shape breathed, which reads as the
  // colours sloshing about inside the artwork rather than the artwork moving.
  const still = fitObject(object)
  const shapeBox = pathBounds(object.currentSourcePath)
  const textBox = still.ok && still.path.length > 0 ? pathBounds(still.path) : shapeBox

  const encoder = GIFEncoder()
  const delay = Math.max(20, Math.round((object.animation.loopDuration * 1000) / sequence.length))
  const container = new Path2D(object.currentSourcePath)
  const border = object.appearance.containerStroke

  for (const frame of sequence) {
    ctx.clearRect(0, 0, size, size)
    if (background === 'solid') {
      ctx.fillStyle = options.artboard ?? ARTBOARD_BACKGROUND
      ctx.fillRect(0, 0, size, size)
    }

    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.scale(scale, scale)
    ctx.translate(-centreX, -centreY)

    // The deformed outline when the shape has a preset of its own, otherwise
    // the resting one. `nonzero` is what keeps counters and holes open, here as
    // everywhere.
    const shape = frame.shapePath ? new Path2D(frame.shapePath) : container
    if (frame.shapeFill) {
      ctx.fillStyle = paintStyle(ctx, frame.shapeFill, shapeBox)
      ctx.globalAlpha = paintAlpha(frame.shapeFill)
      ctx.fill(shape, 'nonzero')
      ctx.globalAlpha = 1
    }
    /*
     * The border on the same outline, straight after the fill it belongs to and
     * before the words — the order the canvas draws them in.
     */
    if (border) strokeOnContext(ctx, shape, border, bounds)
    if (frame.path.length > 0) {
      ctx.fillStyle = paintStyle(ctx, frame.textFill, textBox)
      ctx.globalAlpha = paintAlpha(frame.textFill)
      ctx.fill(new Path2D(frame.path), 'nonzero')
      ctx.globalAlpha = 1
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


/** The smallest box holding all of them. */
function union(boxes: Rect[]): Rect {
  const first = boxes[0] as Rect
  let minX = first.x
  let minY = first.y
  let maxX = first.x + first.width
  let maxY = first.y + first.height
  for (const box of boxes.slice(1)) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function safeName(name: string): string {
  const trimmed = name.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  return trimmed.length > 0 ? trimmed.toLowerCase() : 'sticker'
}

function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: revoking immediately can cancel the download in
  // some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
