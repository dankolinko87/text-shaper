import type { PathData } from '../types/document'
import { withPaper } from './paperContext'

/**
 * Vertical sampling of a shape: the interior extent at a given x.
 *
 * The mirror image of `spans.ts`, which samples horizontal runs at a given y.
 * Boundary warping needs the other axis — to bend a line's top and bottom edges
 * along the container, it has to know where the container's upper and lower
 * boundary sit at each x the glyphs occupy.
 */

export interface Column {
  x: number
  /** Top of the interior at this x. */
  y0: number
  /** Bottom of the interior at this x. */
  y1: number
}

export interface ColumnOptions {
  /** Number of columns sampled across the shape's width. */
  sampleCount: number
  /** Columns shorter than this are treated as outside the shape. */
  minColumnHeight: number
}

export const DEFAULT_COLUMN_OPTIONS: ColumnOptions = {
  sampleCount: 72,
  minColumnHeight: 2,
}

/**
 * Sample the shape's vertical extent across its width.
 *
 * Where a column crosses the shape more than once — a concave form, or a hole —
 * the TALLEST run is kept. A line of text occupies one continuous band, so the
 * run it can actually live in is the tallest one, and the same choice is made by
 * `widestSpan` on the horizontal axis.
 */
export function calculateColumnExtents(
  data: PathData,
  options: ColumnOptions = DEFAULT_COLUMN_OPTIONS,
): Column[] {
  if (!data || data.trim().length === 0) return []

  return withPaper((scope) => {
    const item = new scope.CompoundPath(data)
    const bounds = item.bounds
    if (bounds.width <= 0 || bounds.height <= 0) {
      item.remove()
      return []
    }

    const columns: Column[] = []
    const count = Math.max(2, Math.floor(options.sampleCount))

    for (let i = 0; i < count; i++) {
      // Sample at column centres, so we never land exactly on the left or right
      // tangent where crossings are numerically unstable.
      const t = (i + 0.5) / count
      const x = bounds.left + bounds.width * t

      const line = new scope.Path.Line(
        new scope.Point(x, bounds.top - 10),
        new scope.Point(x, bounds.bottom + 10),
      )
      const ys = item
        .getIntersections(line)
        .map((c) => c.point.y)
        .sort((a, b) => a - b)
      line.remove()

      let best: Column | null = null
      for (let k = 0; k + 1 < ys.length; k += 2) {
        const y0 = ys[k]
        const y1 = ys[k + 1]
        if (y0 === undefined || y1 === undefined) continue
        if (y1 - y0 < options.minColumnHeight) continue
        if (!best || y1 - y0 > best.y1 - best.y0) best = { x, y0, y1 }
      }
      if (best) columns.push(best)
    }

    item.remove()
    return columns
  })
}

/**
 * How fast an extent collapses beyond the sampled range, as a multiple of the
 * column's own height. Past this distance the extent is a point.
 */
const COLLAPSE_RATE = 1

function collapseTowards(edge: Column, distance: number): Column {
  const height = edge.y1 - edge.y0
  const centre = (edge.y0 + edge.y1) / 2
  if (!(height > 0)) return { x: edge.x, y0: centre, y1: centre }
  const remaining = Math.max(0, 1 - distance / Math.max(1, height * COLLAPSE_RATE))
  const half = (height / 2) * remaining
  return { x: edge.x, y0: centre - half, y1: centre + half }
}

/**
 * The interior extent at an arbitrary x, interpolated between samples.
 *
 * Interpolation matters: stepping between discrete samples would put a visible
 * staircase into every warped edge. Returns null when x falls outside the
 * sampled range, and callers treat that as "do not warp here".
 */
export function columnAt(columns: readonly Column[], x: number): Column | null {
  if (columns.length === 0) return null

  const first = columns[0]
  const last = columns[columns.length - 1]
  if (!first || !last) return null

  // Outside the sampled range the shape has run out. Collapsing towards the
  // edge column's centre rather than repeating its full height is what stops
  // characters escaping past a tapering tip: repeating the last extent handed
  // them far more vertical room than the shape actually has there, and they
  // overhung the outline.
  if (x <= first.x) return collapseTowards(first, first.x - x)
  if (x >= last.x) return collapseTowards(last, x - last.x)

  // Binary search for the bracketing pair.
  let lo = 0
  let hi = columns.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const column = columns[mid]
    if (!column) break
    if (column.x <= x) lo = mid
    else hi = mid
  }

  const a = columns[lo]
  const b = columns[hi]
  if (!a || !b) return null
  if (b.x === a.x) return { x, y0: a.y0, y1: a.y1 }

  const f = (x - a.x) / (b.x - a.x)
  return {
    x,
    y0: a.y0 + (b.y0 - a.y0) * f,
    y1: a.y1 + (b.y1 - a.y1) * f,
  }
}
