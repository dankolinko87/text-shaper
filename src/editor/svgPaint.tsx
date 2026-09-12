import type { ReactElement } from 'react'

import { placementOf } from '../geometry/imagePlacement'
import { gradientEnds, radialEnds, type FillPaint } from '../typography/colour'
import { resolvePaint } from '../typography/paint'
import type { Rect } from '../types/document'
import type { ImageAsset, Paint } from '../types/paint'

/** A paint as stored, or one already resolved for a moment of the loop. */
export type AnyPaint = Paint | FillPaint

/** A paint of either kind as a resolved one, at rest for a stored one. */
function resolved(paint: AnyPaint): FillPaint | null {
  if (typeof paint === 'string') return { kind: 'solid', colour: paint }
  if (paint.kind === 'solid') return paint
  if (paint.kind === 'gradient' && ('offset' in paint || 'centre' in paint)) return paint
  if (paint.kind === 'image' && typeof paint.opacity === 'number') return paint as FillPaint
  return resolvePaint(paint as Paint, 0)
}

/**
 * Paints for an inline SVG: a fill string per part, and the defs the
 * gradients and pictures need, gathered as the picture is drawn. The state
 * thumbnails draw with this so a gradient or a picture on a tile, a letter
 * or a background looks in the rail as it does on the canvas rather than as
 * its first colour.
 */
export interface SvgPaints {
  /** What to put in `fill` (or `stroke`) for this paint, in the box it fills. */
  fill(paint: AnyPaint | null | undefined, box?: Rect): string | undefined
  /** The `<defs>` children the fills so far refer to. */
  defs(): ReactElement[]
}

export function svgPaints(prefix: string, assets: Readonly<Record<string, ImageAsset>> = {}): SvgPaints {
  const defs: ReactElement[] = []
  return {
    fill(paint, box) {
      if (paint === null || paint === undefined) return undefined
      if (typeof paint === 'string') return paint
      const now = resolved(paint)
      if (!now) return undefined
      if (now.kind === 'solid') return now.colour
      const id = `${prefix}-p${defs.length}`
      if (now.kind === 'image') {
        const asset = assets[now.asset]
        if (!asset || !box) return '#888888'
        const place = placementOf(box, asset, now.crop)
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
            <image href={asset.src} width={place.width} height={place.height} preserveAspectRatio="none" opacity={now.opacity} />
          </pattern>,
        )
        return `url(#${id})`
      }
      const stops = now.stops.map((stop, i) => (
        <stop key={i} offset={stop.at} stopColor={stop.colour} />
      ))
      if (now.shape === 'radial') {
        const ends = radialEnds(now.centre, now.radius)
        defs.push(
          <radialGradient key={id} id={id} gradientUnits="objectBoundingBox" cx={ends.x2} cy={ends.y2} r={ends.r2 * 0.7071}>
            {stops}
          </radialGradient>,
        )
      } else {
        const ends = gradientEnds(now.angle, now.offset, now.spread)
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
