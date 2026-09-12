import type { Canvas as FabricCanvas } from 'fabric'

import { contentBounds, type RenderedObject } from './renderer'

/**
 * The editor's canvas, reachable from outside the editor — for the one thing
 * outside it that needs a picture: a project's card.
 *
 * Set by `Canvas` when it builds its Fabric canvas and forgotten when it
 * goes. Dev already hangs the canvas on `window.__canvas`; this is the
 * production-safe door to the same thing, with the render cache beside it
 * so the crop can be asked of the artwork rather than the whole stage.
 */

interface Live {
  canvas: FabricCanvas
  rendered: () => Map<string, RenderedObject>
}

let live: Live | null = null
/** True while a snapshot is being rendered — see `isExporting`. */
let exporting = false

/**
 * Whether the render happening now is a snapshot, not the screen.
 *
 * The export renders through the live canvas, and Fabric announces it like
 * any render — with the snapshot's viewport in place. Everything that
 * follows the canvas by listening for renders asks this first, and sits out
 * a render that is not the one on screen.
 */
export function isExporting(): boolean {
  return exporting
}

export function setLiveCanvas(canvas: FabricCanvas | null, rendered?: () => Map<string, RenderedObject>): void {
  live = canvas && rendered ? { canvas, rendered } : null
}

export function liveCanvas(): Live | null {
  return live
}

/** How wide a snapshot is made; a card is a third of that on a normal screen. */
export const SNAPSHOT_WIDTH = 640
/** The most the artwork is scaled up to reach that width — artwork drawn tiny stays a small picture. */
const MAX_UPSCALE = 4

/**
 * A picture of the artwork as it stands: the union of what is drawn, cropped
 * from the live canvas, with the editing furniture (outlines, handles,
 * plates) left out. Null when nothing is drawn or there is no canvas yet.
 *
 * `contentBounds` answers in ARTBOARD units; Fabric's export crops in screen
 * pixels at the current viewport. The box is carried through the viewport
 * transform first — without that, any zoom but one crops the wrong region —
 * and the multiplier then brings the picture to the card's width, since the
 * export re-renders the vectors rather than copying pixels.
 */
export function snapshotArtwork(): string | null {
  if (!live) return null
  const bounds = contentBounds(live.rendered())
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null
  const vt = live.canvas.viewportTransform
  const left = bounds.x * vt[0] + vt[4]
  const top = bounds.y * vt[3] + vt[5]
  const width = bounds.width * vt[0]
  const height = bounds.height * vt[3]
  if (!(width > 0) || !(height > 0)) return null
  const multiplier = Math.min(MAX_UPSCALE, SNAPSHOT_WIDTH / width)
  exporting = true
  try {
    return live.canvas.toDataURL({
      format: 'png',
      multiplier,
      left,
      top,
      width,
      height,
      filter: (object) => Boolean(object.get('shapeId') || object.get('statedId')),
    })
  } catch {
    return null
  } finally {
    exporting = false
  }
}
