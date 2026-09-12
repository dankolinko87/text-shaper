import { sortStops } from '../typography/colour'
import { solidOf } from '../typography/paint'
import type { GradientStop } from '../types/document'
import type { ImageAsset, Paint } from '../types/paint'

/**
 * A gradient's stops as CSS, left to right — for the bar the editor shows and
 * the chip a shut lid shows. The angle and motion are the canvas's business;
 * here the question is only "which colours, in what order".
 */
export function gradientCss(stops: readonly GradientStop[]): string {
  const run = sortStops(stops)
    .map((stop) => `${stop.colour} ${Math.round(stop.at * 1000) / 10}%`)
    .join(', ')
  return `linear-gradient(90deg, ${run})`
}

/** Any paint as a CSS background: the colour, the run of stops, or the picture itself when its asset is to hand. */
export function paintCss(paint: Paint | null | undefined, assets?: Readonly<Record<string, ImageAsset>>): string {
  if (!paint) return 'transparent'
  if (typeof paint === 'string') return paint
  if (paint.kind === 'gradient') return gradientCss(paint.stops)
  const asset = assets?.[paint.asset]
  return asset ? `url("${asset.src}") center / cover` : solidOf(paint)
}
