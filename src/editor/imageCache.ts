import { useUiStore } from '../state/uiStore'
import type { ImageAsset } from '../types/paint'

/**
 * The pictures the document refers to, decoded and ready to draw.
 *
 * A paint names an asset by id; the renderer needs something a canvas can
 * draw. Decoding is asynchronous in a browser, so a picture is asked for
 * synchronously — and answered with null until it has arrived — while the
 * decode runs behind. When it lands, the ui store's image revision moves,
 * the canvas syncs again, and the content key (which says whether the
 * picture is ready) rebuilds the group that was waiting for it. Tests prime
 * the cache with a node canvas and never decode.
 */

export type ImageSource = CanvasImageSource & { width: number; height: number }

const sources = new Map<string, ImageSource>()
const pending = new Map<string, Promise<ImageSource>>()

/** The picture for an asset, or null while it is still arriving. */
export function imageFor(assetId: string): ImageSource | null {
  return sources.get(assetId) ?? null
}

export const imageReady = (assetId: string): boolean => sources.has(assetId)

/** The pixel size of a decoded picture, whatever kind of source it is. */
export function sizeOf(source: ImageSource): { width: number; height: number } {
  const image = source as { naturalWidth?: number; naturalHeight?: number; width: number; height: number }
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }
}

/** Hand the cache a picture already decoded — an import, or a test's canvas. */
export function primeImage(assetId: string, source: ImageSource): void {
  sources.set(assetId, source)
  pending.delete(assetId)
}

/** Decode an asset's picture, once, and say when it has arrived. */
export function loadImageSource(asset: ImageAsset): Promise<ImageSource> {
  const known = sources.get(asset.id)
  if (known) return Promise.resolve(known)
  const inFlight = pending.get(asset.id)
  if (inFlight) return inFlight
  if (typeof Image === 'undefined') return Promise.reject(new Error('No picture decoder here.'))
  const promise = new Promise<ImageSource>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      sources.set(asset.id, image)
      pending.delete(asset.id)
      useUiStore.getState().bumpImageRevision()
      resolve(image)
    }
    image.onerror = () => {
      pending.delete(asset.id)
      reject(new Error(`Could not decode picture ${asset.id}.`))
    }
    image.src = asset.src
  })
  pending.set(asset.id, promise)
  return promise
}

/** Start decoding every picture the document holds that is not here yet. */
export function ensureImagesLoaded(assets: Readonly<Record<string, ImageAsset>>): void {
  for (const asset of Object.values(assets)) {
    if (sources.has(asset.id) || pending.has(asset.id)) continue
    loadImageSource(asset).catch(() => {})
  }
}

export function forgetImages(): void {
  sources.clear()
  pending.clear()
}
