import { sortStops } from '../typography/colour'
import { solidOf } from '../typography/paint'
import type { GradientStop } from '../types/document'
import type { Paint } from '../types/paint'

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

/** Any paint as a CSS background: the colour, the run of stops, or a picture's grey. */
export function paintCss(paint: Paint | null | undefined): string {
  if (!paint) return 'transparent'
  if (typeof paint === 'string') return paint
  if (paint.kind === 'gradient') return gradientCss(paint.stops)
  return solidOf(paint)
}
