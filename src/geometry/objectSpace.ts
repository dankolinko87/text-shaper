import type { Transform2D, Vec2 } from '../types/document'
import type { Mat2D } from '../types/geometry'
import { applyToPoint, applyToVector, compose, invert } from './transform'

/**
 * Conversions between object-local space (where all path geometry is stored)
 * and artboard space (where objects are positioned).
 *
 * Phase 4's brush reshaping depends entirely on this: pointer coordinates are
 * converted screen -> artboard -> local before ANY geometry edit, which is what
 * keeps reshaping correct after an object has been moved, scaled, or rotated.
 * Editing in artboard space and inverse-transforming the result instead would
 * accumulate error and destroy the meaning of `originalSourcePath`.
 */

export function objectToArtboard(t: Transform2D): Mat2D {
  return compose(t)
}

export function artboardToObject(t: Transform2D): Mat2D {
  return invert(compose(t))
}

export function pointArtboardToObject(t: Transform2D, p: Vec2): Vec2 {
  return applyToPoint(artboardToObject(t), p)
}

export function pointObjectToArtboard(t: Transform2D, p: Vec2): Vec2 {
  return applyToPoint(objectToArtboard(t), p)
}

export function vectorArtboardToObject(t: Transform2D, v: Vec2): Vec2 {
  return applyToVector(artboardToObject(t), v)
}

export function vectorObjectToArtboard(t: Transform2D, v: Vec2): Vec2 {
  return applyToVector(objectToArtboard(t), v)
}
