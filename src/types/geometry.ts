import type { Vec2 } from './document'

/**
 * 2D affine matrix in SVG/canvas order:
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 */
export type Mat2D = readonly [a: number, b: number, c: number, d: number, e: number, f: number]

/** A horizontal run of interior space at a given y, in object-local coordinates. */
export interface Span {
  y: number
  x0: number
  x1: number
}

/** All spans found on one scanline. A concave shape can yield several. */
export interface Scanline {
  y: number
  spans: Span[]
}

export interface StrokePoint extends Vec2 {
  /** Milliseconds, from the pointer event. */
  t: number
}
