import type { Transform2D } from '../types/document'

/**
 * What a finished drag should mean: reshaping, or just placing.
 *
 * RESIZING changes what the shape IS, so it is folded into the outline and the
 * text is fitted again — stretch a container and the type re-flows to suit it.
 *
 * ROTATION deliberately is NOT. It stays on the object and turns the whole
 * piece, container and type together.
 *
 * That asymmetry is forced by the row model rather than chosen for taste. A row
 * boundary is a function y = f(x) spanning the container's width, and rotating
 * one shrinks the x it covers while the shape's own width grows: at 45 degrees a
 * divider reaches half the shape, at 75 degrees a fifth, and beyond its range the
 * curve flattens out so the row stops bounding anything. At 90 degrees a
 * horizontal row becomes vertical and cannot be written as a function of x at
 * all. Baking rotation therefore degrades continuously into geometry the layout
 * cannot represent — so it is not baked, at any angle.
 */

/** Below this, a scale is Fabric's float jitter rather than a real resize. */
const SCALE_EPSILON = 1e-4

export interface BakedScale {
  scaleX: number
  scaleY: number
  rotation: number
  flipX: boolean
  flipY: boolean
}

export interface TransformSplit {
  /** What to store on the object. */
  transform: Transform2D
  /** Folded into the outline, or null when the gesture only moved or turned it. */
  bake: BakedScale | null
}

export function splitTransform(next: Transform2D): TransformSplit {
  const resized =
    Math.abs(next.scaleX - 1) > SCALE_EPSILON ||
    Math.abs(next.scaleY - 1) > SCALE_EPSILON ||
    next.flipX ||
    next.flipY

  if (!resized) return { transform: next, bake: null }

  return {
    // Rotation is carried through untouched; only the scale is taken off.
    transform: { ...next, scaleX: 1, scaleY: 1, flipX: false, flipY: false },
    bake: {
      scaleX: next.scaleX,
      scaleY: next.scaleY,
      rotation: 0,
      flipX: next.flipX,
      flipY: next.flipY,
    },
  }
}
