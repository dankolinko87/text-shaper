import { Gradient, Pattern, type FabricObject } from 'fabric'

import { placementOf } from '../geometry/imagePlacement'
import { gradientEnds, radialEnds, type FillPaint } from '../typography/colour'
import { resolvePaint } from '../typography/paint'
import type { Vec2 } from '../types/document'
import type { Paint } from '../types/paint'
import { imageFor, sizeOf } from './imageCache'

/** The box a fill is placed in: its size, and where it sits relative to the child's own box. */
export interface FillBox {
  size: { width: number; height: number }
  /** The box's top-left minus the child's box top-left, in the child's units. Zero when they coincide. */
  offset?: Vec2
}

export type FabricFill = string | Gradient<'linear'> | Gradient<'radial'> | Pattern

/**
 * A described fill into a Fabric paint.
 *
 * `percentage` units rather than pixels for a gradient: the coordinates then
 * span the object's own bounding box, which is exactly what `gradientEnds`
 * describes and what the GIF encoder measures against. Pixel units would
 * need the path's offset, which the animation loop deliberately leaves stale
 * as it swaps path data in place.
 *
 * A picture is a pattern placed by `placementOf` in the box the surface
 * gives. Fabric anchors a pattern at the child's own box top-left, so a fill
 * whose box is not the child's — a letter cut for a reference rectangle —
 * says how far apart the two are. With no box, or no picture yet, it draws
 * as nothing; the content key rebuilds the group once the picture arrives.
 */
export function fabricPaint(paint: FillPaint, box?: FillBox): FabricFill {
  if (paint.kind === 'solid') return paint.colour
  if (paint.kind === 'image') {
    const source = imageFor(paint.asset)
    if (!source || !box) return 'transparent'
    const place = placementOf(box.size, sizeOf(source), paint.crop)
    return new Pattern({
      source,
      repeat: 'no-repeat',
      patternTransform: [
        place.scale,
        0,
        0,
        place.scale,
        place.x + (box.offset?.x ?? 0),
        place.y + (box.offset?.y ?? 0),
      ],
    })
  }
  const colorStops = paint.stops.map((stop) => ({ offset: stop.at, color: stop.colour }))
  if (paint.shape === 'radial') {
    return new Gradient({
      type: 'radial',
      gradientUnits: 'percentage',
      coords: radialEnds(paint.centre, paint.radius),
      colorStops,
    })
  }
  return new Gradient({
    type: 'linear',
    gradientUnits: 'percentage',
    coords: gradientEnds(paint.angle, paint.offset, paint.spread),
    colorStops,
  })
}

/** A stored paint at rest as a Fabric fill, or `fallback` for none. */
export function fillOf(
  paint: Paint | null | undefined,
  fallback: FabricFill = 'transparent',
  box?: FillBox,
): FabricFill {
  const resolved = resolvePaint(paint, 0)
  return resolved ? fabricPaint(resolved, box) : fallback
}

/** The box of a child as built: its own width and height, nothing offset. */
export function boxOfChild(child: FabricObject): FillBox {
  return { size: { width: child.width || 1, height: child.height || 1 } }
}

/**
 * Put a resolved paint on a child: its fill, and its opacity — the one alpha
 * a picture has, reset to full for anything else so a picture that becomes
 * a colour does not stay faint.
 */
export function applyPaint(
  child: FabricObject,
  paint: FillPaint | null,
  box: FillBox,
  fallback: FabricFill = 'transparent',
): void {
  child.set({
    fill: paint ? fabricPaint(paint, box) : fallback,
    opacity: paint?.kind === 'image' ? paint.opacity : 1,
  })
}
