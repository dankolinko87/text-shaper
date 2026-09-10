import type { PathData, Rect, Vec2 } from '../types/document'
import type { Mat2D } from '../types/geometry'
import { withPaper } from './paperContext'
import { itemArea } from './regions'

export interface ValidationResult {
  valid: boolean
  reason?: 'empty' | 'not-finite' | 'zero-area'
}

/**
 * Parse an SVG path string into a paper item *inside an active scope*.
 * Callers must already be within `withPaper`.
 */
export function parsePathInScope(scope: paper.PaperScope, data: PathData): paper.PathItem {
  return new scope.CompoundPath(data)
}

export function pathBounds(data: PathData): Rect {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const b = item.bounds
    const rect: Rect = { x: b.x, y: b.y, width: b.width, height: b.height }
    item.remove()
    return rect
  })
}

export function pathArea(data: PathData): number {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const area = Math.abs(itemArea(item))
    item.remove()
    return area
  })
}

/** Reject NaN/Infinity and degenerate geometry before it reaches the clipper or renderer. */
export function validatePath(data: PathData): ValidationResult {
  if (!data || data.trim().length === 0) return { valid: false, reason: 'empty' }
  if (/(NaN|Infinity)/.test(data)) return { valid: false, reason: 'not-finite' }
  const area = pathArea(data)
  if (!Number.isFinite(area) || area <= 0) return { valid: false, reason: 'zero-area' }
  return { valid: true }
}

/**
 * Simplify a path by refitting Béziers to a tolerance.
 * Used to produce `simplifiedRenderPath` for responsive interactive preview.
 */
/**
 * Whether a point lies inside a filled path.
 *
 * Uses the same nonzero rule the rest of the pipeline fills with, so a donut's
 * hole counts as outside — which is what anyone pointing at it means.
 */
export function pathContainsPoint(data: PathData, point: Vec2): boolean {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    item.fillRule = 'nonzero'
    const inside = item.contains(new scope.Point(point.x, point.y))
    item.remove()
    return inside
  })
}

export function simplifyPath(data: PathData, tolerance: number): PathData {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    applyToPaths(item, (p) => p.simplify(tolerance))
    const out = item.pathData
    item.remove()
    return out
  })
}

/** Close every open subpath. */
export function closePath(data: PathData): PathData {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    applyToPaths(item, (p) => {
      p.closed = true
    })
    const out = item.pathData
    item.remove()
    return out
  })
}

/** Smooth the boundary with G1-continuous handles. */
export function smoothPath(data: PathData): PathData {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    applyToPaths(item, (p) => p.smooth({ type: 'continuous' }))
    const out = item.pathData
    item.remove()
    return out
  })
}

/**
 * Apply a matrix to path data, returning the transformed outline.
 *
 * Used to BAKE a resize or rotation into the container itself. Left on the
 * object's transform, a scale is applied to the rendered group, which stretches
 * the container and the letterforms together as one picture — the type is not
 * re-fitted, it is just distorted along with everything else. Baking the matrix
 * into the outline and clearing the transform means the shape genuinely changed,
 * so the text is laid out again to suit it.
 */
export function transformPathData(data: PathData, m: Mat2D): PathData {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    item.transform(new scope.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]))
    const out = item.pathData
    item.remove()
    return /(NaN|Infinity)/.test(out) ? data : out
  })
}

/**
 * Split long curves until none is longer than `maxSegment`, keeping the shape.
 *
 * Subdivision is exact — the new anchors lie ON the original curve — so this
 * changes nothing about how the path looks. What it changes is how much there is
 * to grab hold of: a shape animation moves control points, and an ellipse drawn
 * as four cubics has only twelve of them, far too few for a ripple to read as
 * anything but a lurch.
 */
export function subdividePath(data: PathData, maxSegment: number): PathData {
  if (!(maxSegment > 0)) return data
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    applyToPaths(item, (path) => {
      // Bounded rather than while-true: a degenerate curve can report a length
      // that never falls, and an unbounded split would hang the frame.
      for (let pass = 0; pass < 6; pass++) {
        const long = path.curves.filter((curve) => curve.length > maxSegment)
        if (long.length === 0) break
        for (const curve of long) curve.divideAtTime(0.5)
      }
    })
    const out = item.pathData
    item.remove()
    return /(NaN|Infinity)/.test(out) ? data : out
  })
}

/**
 * Move every point of a path through `move`, returning new path data.
 *
 * Anchors and control points alike, which is what makes a smooth deformation of
 * the plane come out as a smooth deformation of the outline.
 *
 * Everything is resolved to ABSOLUTE points first. Relative commands are the
 * norm, not an edge case — paper emits them for anything it has touched — and a
 * relative offset cannot be mapped as it stands, because a bending of the plane
 * moves the point it is measured from as well as the point itself. The
 * shorthands are expanded for the same reason: `S` and `T` infer a control point
 * by reflection, and the reflection of a moved point is not the moved reflection.
 *
 * Arcs are refused rather than guessed at, and null comes back so the caller can
 * fall back to the outline it already had.
 */
export function mapPathPoints(data: PathData, move: (point: Vec2) => Vec2): PathData | null {
  const tokens = data.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null

  const out: string[] = []
  let cursor = { x: 0, y: 0 }
  /** Where the current subpath began, which `Z` returns to. */
  let anchor = { x: 0, y: 0 }
  /** The previous curve's second control point, for the reflection shorthands. */
  let reflected: Vec2 | null = null
  let command = ''
  let index = 0

  const num = (): number => Number(tokens[index++])
  const emit = (letter: string, points: Vec2[]): void => {
    const moved = points.map(move)
    if (moved.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError()
    out.push(letter + moved.map((p) => `${round(p.x)} ${round(p.y)}`).join(' '))
  }

  try {
    while (index < tokens.length) {
      const token = tokens[index] as string
      if (/[A-Za-z]/.test(token)) {
        command = token
        index += 1
        if (command === 'Z' || command === 'z') {
          out.push('Z')
          cursor = anchor
          reflected = null
          continue
        }
        if (command === 'A' || command === 'a') return null
        continue
      }
      if (command === '') return null

      // An implicit repeat: more coordinates after one command letter. A repeated
      // `M` continues as a line, which is what the specification says.
      const relative = command === command.toLowerCase()
      const base = relative ? cursor : { x: 0, y: 0 }
      const point = (): Vec2 => {
        const x = base.x + num()
        const y = base.y + num()
        return { x, y }
      }

      switch (command.toUpperCase()) {
        case 'M': {
          const to = point()
          emit('M', [to])
          cursor = to
          anchor = to
          reflected = null
          command = relative ? 'l' : 'L'
          break
        }
        case 'L': {
          const to = point()
          emit('L', [to])
          cursor = to
          reflected = null
          break
        }
        case 'H': {
          const to = { x: base.x + num(), y: cursor.y }
          emit('L', [to])
          cursor = to
          reflected = null
          break
        }
        case 'V': {
          const to = { x: cursor.x, y: base.y + num() }
          emit('L', [to])
          cursor = to
          reflected = null
          break
        }
        case 'C': {
          const c1 = point()
          const c2 = point()
          const to = point()
          emit('C', [c1, c2, to])
          cursor = to
          reflected = c2
          break
        }
        case 'S': {
          // The missing control is this curve's start reflected through the last
          // one's — worked out here, in the original coordinates, before moving.
          const c1: Vec2 = reflected
            ? { x: cursor.x * 2 - reflected.x, y: cursor.y * 2 - reflected.y }
            : cursor
          const c2 = point()
          const to = point()
          emit('C', [c1, c2, to])
          cursor = to
          reflected = c2
          break
        }
        case 'Q': {
          const c = point()
          const to = point()
          emit('Q', [c, to])
          cursor = to
          reflected = c
          break
        }
        case 'T': {
          const c: Vec2 = reflected
            ? { x: cursor.x * 2 - reflected.x, y: cursor.y * 2 - reflected.y }
            : cursor
          const to = point()
          emit('Q', [c, to])
          cursor = to
          reflected = c
          break
        }
        default:
          return null
      }
    }
  } catch {
    return null
  }

  const joined = out.join('')
  return /(NaN|Infinity)/.test(joined) ? null : joined
}

/** Two decimals: below what any of this is drawn at, and it halves the string. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Translate a path by a delta, returning new path data. */
export function translatePath(data: PathData, delta: Vec2): PathData {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    item.translate(new scope.Point(delta.x, delta.y))
    const out = item.pathData
    item.remove()
    return out
  })
}

/** Run `fn` over every concrete Path in an item, whether it is simple or compound. */
export function applyToPaths(item: paper.PathItem, fn: (path: paper.Path) => void): void {
  const compound = item as paper.CompoundPath
  const children = compound.children as paper.Path[] | undefined
  if (children && children.length > 0) {
    for (const child of children) fn(child)
  } else {
    fn(item as paper.Path)
  }
}
