import type { ImageCrop } from '../types/paint'

/**
 * Where a picture sits in the box it fills.
 *
 * The one rule behind every image fill, on every surface: the picture COVERS
 * the box — scaled up until nothing of the box shows through, and never
 * pushed so far that an edge of the box is bare. A crop is measured from that
 * cover placement, so the same crop means the same picture whatever size the
 * box is, and a box that grows or a picture that is replaced keeps its crop.
 *
 * Pure: the Fabric pattern, the warped mesh cell, the GIF exporter, the SVG
 * thumbnail and the crop layer all ask this one function, so they cannot
 * disagree about where the picture is.
 */

export interface Size {
  width: number
  height: number
}

export interface Placement {
  /** The picture's top-left, relative to the box's top-left. */
  x: number
  y: number
  /** The picture's drawn size. */
  width: number
  height: number
  /** Picture pixels to box units. */
  scale: number
}

const clamp = (value: number, low: number, high: number): number =>
  low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value))

/** The scale at which the picture just covers the box. */
export function coverScale(box: Size, image: Size): number {
  if (!(image.width > 0) || !(image.height > 0)) return 1
  return Math.max(box.width / image.width, box.height / image.height)
}

/** Where the picture lands in the box, always covering it. */
export function placementOf(box: Size, image: Size, crop: ImageCrop): Placement {
  const scale = coverScale(box, image) * Math.max(1, crop.scale)
  const width = image.width * scale
  const height = image.height * scale
  // Centred, then moved by the crop; clamped so the box stays covered.
  const x = clamp((box.width - width) / 2 + crop.x * box.width, box.width - width, 0)
  const y = clamp((box.height - height) / 2 + crop.y * box.height, box.height - height, 0)
  return { x, y, width, height, scale }
}

/** The part of the picture the box shows, in picture pixels. */
export function sourceRectOf(
  box: Size,
  image: Size,
  crop: ImageCrop,
): { sx: number; sy: number; sw: number; sh: number } {
  const place = placementOf(box, image, crop)
  // `0 - x` rather than `-x`: a picture sitting exactly on the box's edge
  // must read as zero, not as a negative zero that fails an exact compare.
  return {
    sx: (0 - place.x) / place.scale,
    sy: (0 - place.y) / place.scale,
    sw: box.width / place.scale,
    sh: box.height / place.scale,
  }
}

/** The matrix that puts picture pixels where the placement says, relative to the box's top-left. */
export function patternTransformOf(place: Placement): [number, number, number, number, number, number] {
  return [place.scale, 0, 0, place.scale, place.x, place.y]
}

/** The crop moved by a delta in box units. */
export function cropFromDelta(crop: ImageCrop, box: Size, dx: number, dy: number): ImageCrop {
  return {
    scale: crop.scale,
    x: crop.x + (box.width > 0 ? dx / box.width : 0),
    y: crop.y + (box.height > 0 ? dy / box.height : 0),
  }
}

export const MAX_CROP_SCALE = 8

/** The crop zoomed by a factor, never below cover nor past `MAX_CROP_SCALE`. */
export function cropZoomed(crop: ImageCrop, factor: number): ImageCrop {
  return { ...crop, scale: clamp(crop.scale * factor, 1, MAX_CROP_SCALE) }
}
