import { primeImage, type ImageSource } from './imageCache'
import type { ImageAsset } from '../types/paint'

/**
 * A picture from the user's disk into a document asset.
 *
 * Sized down on the way in: the document lives in the browser's storage, a
 * few megabytes for everything, and a phone photo is that on its own. The
 * longest side is capped, a picture with any transparency stays a PNG and
 * anything else becomes a JPEG. The asset is named from its bytes, so the
 * same picture imported twice — or pasted from another project — is one
 * asset, not two.
 */

export const IMAGE_MAX_EDGE = 1600
export const IMAGE_JPEG_QUALITY = 0.85

/** A size that fits within `maxEdge` on its longest side, in proportion. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!(longest > maxEdge) || !(longest > 0)) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** FNV-1a over a string, as hex: stable, cheap, and enough to name a picture by. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const assetIdFor = (src: string): string => `img_${fnv1a(src)}_${src.length.toString(36)}`

/** Ask for a picture file; null when the dialog is dismissed. */
export function pickImageFile(input: HTMLInputElement): Promise<File | null> {
  return new Promise((resolve) => {
    const done = (): void => {
      input.removeEventListener('change', done)
      window.removeEventListener('focus', later)
      resolve(input.files?.[0] ?? null)
      input.value = ''
    }
    // A dismissed dialog fires no event at all; the window coming back does.
    const later = (): void => {
      setTimeout(() => {
        if (input.files && input.files.length > 0) return
        done()
      }, 300)
    }
    input.addEventListener('change', done)
    window.addEventListener('focus', later, { once: true })
    input.click()
  })
}

export async function decodeImage(file: Blob): Promise<ImageSource> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file) as Promise<ImageSource>
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<ImageSource>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Not a picture.'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Whether any sampled pixel is not fully opaque. */
export function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  const step = Math.max(1, Math.floor(Math.max(canvas.width, canvas.height) / 64))
  for (let y = 0; y < canvas.height; y += step) {
    const row = ctx.getImageData(0, y, canvas.width, 1).data
    for (let x = 3; x < row.length; x += 4 * step) if (row[x]! < 255) return true
  }
  return false
}

/** The picture drawn at a size, on a canvas of its own. */
export function drawScaled(source: ImageSource, size: { width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas here.')
  ctx.drawImage(source, 0, 0, size.width, size.height)
  return canvas
}

export function assetFromCanvas(canvas: HTMLCanvasElement, alpha: boolean): ImageAsset {
  const src = alpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY)
  return { id: assetIdFor(src), src, width: canvas.width, height: canvas.height }
}

/** A file into an asset, sized down and named by its bytes; the cache is primed with it. */
export async function importImageFile(file: File): Promise<ImageAsset> {
  const decoded = await decodeImage(file)
  const size = fitWithin(
    (decoded as { naturalWidth?: number; width: number }).naturalWidth || decoded.width,
    (decoded as { naturalHeight?: number; height: number }).naturalHeight || decoded.height,
    IMAGE_MAX_EDGE,
  )
  const canvas = drawScaled(decoded, size)
  const alpha = /png|webp|gif|svg/i.test(file.type) && hasAlpha(canvas)
  const asset = assetFromCanvas(canvas, alpha)
  primeImage(asset.id, canvas)
  return asset
}
