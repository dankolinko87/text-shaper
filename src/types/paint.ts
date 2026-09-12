import type { ColorValue, GradientStop } from './document'

/**
 * What a thing is painted with: a colour, a gradient, or a picture.
 *
 * One model for every fill in the app — a shape's type and body, a banner,
 * a border, a tile, a letter, an object's background, a frame's — so every
 * colour input offers the same three and every renderer draws them the same
 * way. A solid stays the plain hex string it always was: the whole document
 * compares colours with `===`, and a string keeps that true.
 */

export type GradientMotion = 'still' | 'sweep' | 'hover' | 'pulse'

export interface GradientPaint {
  kind: 'gradient'
  shape: 'linear' | 'radial'
  /** At least two, at most eight; a colour may carry opacity. */
  stops: GradientStop[]
  /** Degrees, clockwise from pointing right. Points the way a radial middle travels. */
  angle: number
  /** How the blend moves over a shape's loop. Absent is still; only a shape's fills move. */
  motion?: GradientMotion
  /** How far the motion goes, 0..1. Meaningful only with a motion. */
  travel?: number
}

/**
 * Where a picture sits in the box it fills, relative to COVER.
 *
 * `scale` multiplies the cover scale — 1 is exactly covering, centred; `x`
 * and `y` move the picture's centre off the box's, as a share of the box's
 * width and height. Kept as fractions so a box that changes size, or a
 * picture that is replaced, keeps the crop that was made.
 */
export interface ImageCrop {
  scale: number
  x: number
  y: number
}

export interface ImagePaint {
  kind: 'image'
  /** Which picture: a key into the document's assets. */
  asset: string
  crop: ImageCrop
  /** 0..1; absent is 1. The one alpha a picture has. */
  opacity?: number
}

/** A picture the document carries, kept inline so a project stays one JSON string. */
export interface ImageAsset {
  id: string
  /** `data:image/png;base64,…` or `data:image/jpeg;base64,…`, already sized down on import. */
  src: string
  /** Pixel size of `src`, so placing needs no decoding. */
  width: number
  height: number
}

/** A fill as stored: a hex colour, or a described gradient or picture. */
export type Paint = ColorValue | GradientPaint | ImagePaint
/** What a line may be painted with: no picture on an edge. */
export type StrokePaint = ColorValue | GradientPaint
export type PaintKind = 'solid' | 'gradient' | 'image'

export const DEFAULT_CROP: ImageCrop = { scale: 1, x: 0, y: 0 }
