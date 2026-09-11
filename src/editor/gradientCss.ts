import { sortStops } from '../typography/colour'
import type { GradientStop } from '../types/document'

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
