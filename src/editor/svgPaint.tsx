import type { ReactElement } from 'react'

import { placementOf } from '../geometry/imagePlacement'
import { gradientEnds, radialEnds } from '../typography/colour'
import { resolvePaint, solidOf } from '../typography/paint'
import type { Rect } from '../types/document'
import type { ImageAsset, Paint } from '../types/paint'

/**
 * Paints for an inline SVG: a fill string per part, and the defs the
 * gradients and pictures need, gathered as the picture is drawn. The state
 * thumbnails draw with this so a gradient or a picture on a tile, a letter
 * or a background looks in the rail as it does on the canvas rather than as
 * its first colour.
 */
export interface SvgPaints {
  /** What to put in `fill` (or `stroke`) for this paint, in the box it fills. */
  fill(paint: Paint | null | undefined, box?: Rect): string | undefined
  /** The `<defs>` children the fills so far refer to. */
  defs(): ReactElement[]
}

export function svgPaints(prefix: string, assets: Readonly<Record<string, ImageAsset>> = {}): SvgPaints {
  const defs: ReactElement[] = []
  return {
    fill(paint, box) {
      if (paint === null || paint === undefined) return undefined
      if (typeof paint === 'string') return paint
      const resolved = resolvePaint(paint, 0)
      if (!resolved) return undefined
      const id = `${prefix}-p${defs.length}`
      if (resolved.kind === 'image') {
        const asset = assets[resolved.asset]
        if (!asset || !box) return solidOf(paint)
        const place = placementOf(box, asset, resolved.crop)
        defs.push(
          <pattern
            key={id}
            id={id}
            patternUnits="userSpaceOnUse"
            x={box.x + place.x}
            y={box.y + place.y}
            width={place.width}
            height={place.height}
          >
            <image href={asset.src} width={place.width} height={place.height} preserveAspectRatio="none" opacity={resolved.opacity} />
          </pattern>,
        )
        return `url(#${id})`
      }
      if (resolved.kind !== 'gradient') return solidOf(paint)
      const stops = resolved.stops.map((stop, i) => (
        <stop key={i} offset={stop.at} stopColor={stop.colour} />
      ))
      if (resolved.shape === 'radial') {
        const ends = radialEnds(resolved.centre, resolved.radius)
        defs.push(
          <radialGradient key={id} id={id} gradientUnits="objectBoundingBox" cx={ends.x2} cy={ends.y2} r={ends.r2 * 0.7071}>
            {stops}
          </radialGradient>,
        )
      } else {
        const ends = gradientEnds(resolved.angle, resolved.offset, resolved.spread)
        defs.push(
          <linearGradient key={id} id={id} gradientUnits="objectBoundingBox" x1={ends.x1} y1={ends.y1} x2={ends.x2} y2={ends.y2}>
            {stops}
          </linearGradient>,
        )
      }
      return `url(#${id})`
    },
    defs: () => defs,
  }
}
