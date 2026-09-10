import type { Rect, Vec2 } from '../types/document'
import { clamp } from '../utils/math'

/**
 * Pure zoom/pan maths, deliberately extracted from Fabric so it can be unit
 * tested with no DOM. `RectLike` is a plain 4-number struct for the same reason.
 */

export interface ViewportState {
  zoom: number
  panX: number
  panY: number
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

export function screenToArtboard(v: ViewportState, rect: RectLike, clientX: number, clientY: number): Vec2 {
  const canvasX = clientX - rect.left
  const canvasY = clientY - rect.top
  return canvasToArtboard(v, { x: canvasX, y: canvasY })
}

export function canvasToArtboard(v: ViewportState, p: Vec2): Vec2 {
  return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom }
}

export function artboardToCanvas(v: ViewportState, p: Vec2): Vec2 {
  return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY }
}

/**
 * Zoom so that the artboard point currently under `anchorCanvas` stays under it.
 * This is what makes wheel-zoom feel anchored to the cursor rather than the origin.
 */
export function zoomAtPoint(v: ViewportState, anchorCanvas: Vec2, nextZoom: number): ViewportState {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
  const before = canvasToArtboard(v, anchorCanvas)
  const panX = anchorCanvas.x - before.x * zoom
  const panY = anchorCanvas.y - before.y * zoom
  return { zoom, panX, panY }
}

/** Centre `target` in a canvas of the given size, with uniform padding. */
export function fitToRect(
  canvasWidth: number,
  canvasHeight: number,
  target: Rect,
  padding: number,
): ViewportState {
  const availableW = Math.max(1, canvasWidth - padding * 2)
  const availableH = Math.max(1, canvasHeight - padding * 2)
  const safeW = target.width > 0 ? target.width : 1
  const safeH = target.height > 0 ? target.height : 1
  const zoom = clamp(Math.min(availableW / safeW, availableH / safeH), MIN_ZOOM, MAX_ZOOM)
  const panX = (canvasWidth - target.width * zoom) / 2 - target.x * zoom
  const panY = (canvasHeight - target.height * zoom) / 2 - target.y * zoom
  return { zoom, panX, panY }
}
