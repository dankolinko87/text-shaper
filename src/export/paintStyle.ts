import { placementOf } from '../geometry/imagePlacement'
import { imageFor, loadImageSource, sizeOf } from '../editor/imageCache'
import { gradientEnds, radialEnds, type FillPaint } from '../typography/colour'
import { resolvePaint } from '../typography/paint'
import type { Rect } from '../types/document'
import type { ImageAsset, Paint } from '../types/paint'

/**
 * A described fill into something a 2D canvas can paint with — the export's
 * half of `editor/paintFill.ts`.
 *
 * The box is in the SAME coordinates the path is drawn in, so a gradient or
 * a picture is placed by the artwork's own geometry rather than by the
 * output size — a 256px and a 768px export then differ only in resolution.
 */
export function paintStyle(
  ctx: CanvasRenderingContext2D,
  paint: FillPaint,
  box: Rect,
): string | CanvasGradient | CanvasPattern {
  if (paint.kind === 'solid') return paint.colour
  if (paint.kind === 'image') {
    const source = imageFor(paint.asset)
    if (!source) return 'transparent'
    const pattern = ctx.createPattern(source, 'no-repeat')
    if (!pattern) return 'transparent'
    const place = placementOf(box, sizeOf(source), paint.crop)
    pattern.setTransform(new DOMMatrix([place.scale, 0, 0, place.scale, box.x + place.x, box.y + place.y]))
    return pattern
  }

  let gradient: CanvasGradient
  if (paint.shape === 'radial') {
    const ends = radialEnds(paint.centre, paint.radius)
    // The radius is a share of the box's own diagonal, so an oval box gets an
    // oval-ish reach rather than a circle cropped by the narrow side.
    const reach = ends.r2 * Math.hypot(box.width, box.height)
    gradient = ctx.createRadialGradient(
      box.x + ends.x1 * box.width,
      box.y + ends.y1 * box.height,
      0,
      box.x + ends.x2 * box.width,
      box.y + ends.y2 * box.height,
      Math.max(0.001, reach),
    )
  } else {
    const ends = gradientEnds(paint.angle, paint.offset, paint.spread)
    gradient = ctx.createLinearGradient(
      box.x + ends.x1 * box.width,
      box.y + ends.y1 * box.height,
      box.x + ends.x2 * box.width,
      box.y + ends.y2 * box.height,
    )
  }
  for (const stop of paint.stops) gradient.addColorStop(stop.at, stop.colour)
  return gradient
}

/** A stored paint at rest as a canvas style, or `fallback` for none. */
export function styleOf(
  ctx: CanvasRenderingContext2D,
  paint: Paint | null | undefined,
  box: Rect,
  fallback = 'transparent',
): string | CanvasGradient | CanvasPattern {
  const resolved = resolvePaint(paint, 0)
  return resolved ? paintStyle(ctx, resolved, box) : fallback
}

/** The alpha a paint asks for beyond its colours: a picture's own opacity. */
export function paintAlpha(paint: FillPaint | Paint | null | undefined): number {
  return paint && typeof paint === 'object' && paint.kind === 'image' ? (paint.opacity ?? 1) : 1
}

/** Every picture these paints could need, decoded before a single frame is drawn. */
export async function loadAssets(assets: Readonly<Record<string, ImageAsset>> | undefined): Promise<void> {
  if (!assets) return
  await Promise.all(Object.values(assets).map((asset) => loadImageSource(asset).catch(() => undefined)))
}
