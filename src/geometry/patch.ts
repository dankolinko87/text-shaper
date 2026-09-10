import type { PathData, Vec2 } from '../types/document'
import { clamp, lerp } from '../utils/math'
import { evaluateDivider } from './grid'
import { withPaper } from './paperContext'
import { resamplePolyline } from './resample'
import { applyToPaths, parsePathInScope } from './path'

/**
 * The container outline as a parametric patch.
 *
 * The layout used to model a shape as two curves, `y = f(x)` — one for the top
 * edge and one for the bottom. That gave the whole engine a preferred axis, and
 * it failed wherever the outline turned vertical. On a 680x600 ellipse the
 * sampler stopped 3.5 units short of the left extreme, and at that first column
 * the shape was ALREADY 86.9 units tall: the edge is vertical there, and no
 * function of x can describe it. Inside that strip the model claimed 87 units of
 * room where the shape had 74 and falling to nothing, so type placed there was
 * crushed into a spike. The same defect made rotation impossible to bake, and
 * would have appeared at the top and bottom of every shape as soon as vertical
 * dividers existed.
 *
 * So the shape is described by FOUR edges meeting at four corners, and the
 * interior by a Coons map from the unit square. Each edge is a function along
 * its OWN axis — the top and bottom of x, the left and right of y — so none of
 * them is ever asked to be vertical. Inside the square there are no axes at all:
 * a row is a band of `v`, a column is a band of `u`, and both are just intervals.
 */

/**
 * One side of the patch.
 *
 * Control points are stored in the edge's own PARAMETER SPACE, not in object
 * space: `x` is the parameter and `y` the value. For the top and bottom edges
 * that is literally (x, y); for the left and right edges it is (y, x), so that
 * a near-vertical side is a gentle function rather than an impossible one.
 * `toPoint` converts back.
 *
 * Storing them pre-swapped is what lets all four edges share `evaluateDivider`
 * — including its shape-preserving interpolation, which matters here because an
 * edge that overshot its own control points would draw the container's boundary
 * outside the container.
 */
export interface PatchEdge {
  points: Vec2[]
  /** Which object-space coordinate the `x` of each point holds. */
  axis: 'x' | 'y'
  /**
   * Dense object-space samples, evenly spaced in the edge's own parameter.
   *
   * The map is evaluated once per emitted glyph point — hundreds of thousands
   * of times for a page of type — and running the curve maths there cost 3.7
   * microseconds a call, which turned a 30ms layout into 140ms. The curve is
   * smooth and the table is fine enough that reading it and interpolating is
   * indistinguishable from evaluating it, and about twenty times quicker.
   *
   * Rebuilt by `refreshPatch` whenever the control points move.
   */
  table: Vec2[]
}

/** Entries per edge lookup table. */
const EDGE_TABLE = 512

export interface PatchCorners {
  p00: Vec2
  p10: Vec2
  p01: Vec2
  p11: Vec2
}

export interface OutlinePatch {
  /** P00 → P10, across the top. */
  top: PatchEdge
  /** P01 → P11, across the bottom, in the same direction as the top. */
  bottom: PatchEdge
  /** P00 → P01, down the left. */
  left: PatchEdge
  /** P10 → P11, down the right. */
  right: PatchEdge
  corners: PatchCorners
}

export interface BuildPatchOptions {
  /** Points taken around the outline before the edges are fitted. */
  samples?: number
  /**
   * How far an edge may stray from the sampled outline, in object units.
   * Zero keeps every sample, which is exact but gives no editable handles.
   */
  tolerance?: number
}

const DEFAULT_SAMPLES = 240
/** Samples an edge must keep clear of its neighbours, so no edge is degenerate. */
const MIN_EDGE_SAMPLES = 3
/** Grid used when detecting a fold and when seeding the inverse. */
const FOLD_GRID = 12

export function buildPatch(path: PathData, options: BuildPatchOptions = {}): OutlinePatch | null {
  const outline = sampleOutline(path, options.samples ?? DEFAULT_SAMPLES)
  if (!outline || outline.length < 8) return null

  const corners = findCornerIndices(outline)
  if (!corners) return null

  const { tl, tr, br, bl } = corners
  const n = outline.length
  const at = (i: number): Vec2 => {
    const p = outline[((i % n) + n) % n]
    return p ? { ...p } : { x: 0, y: 0 }
  }

  // The outline runs clockwise from the top-left corner, so walking forward
  // visits top-right, bottom-right and bottom-left in that order. Two of the
  // edges are therefore collected backwards and reversed.
  const topPoints = slice(outline, tl, tr)
  const rightPoints = slice(outline, tr, br)
  const bottomPoints = slice(outline, br, bl).reverse()
  const leftPoints = slice(outline, bl, n + tl).reverse()

  const tolerance = options.tolerance ?? 0
  return refreshPatch({
    top: makeEdge(topPoints, 'x', tolerance),
    bottom: makeEdge(bottomPoints, 'x', tolerance),
    left: makeEdge(leftPoints, 'y', tolerance),
    right: makeEdge(rightPoints, 'y', tolerance),
    corners: { p00: at(tl), p10: at(tr), p11: at(br), p01: at(bl) },
  })
}

/**
 * Rebuild the edge lookup tables after control points or corners have moved.
 *
 * Every edit goes through here, so an edited patch is evaluated exactly as fast
 * as a freshly built one.
 */
export function refreshPatch(patch: OutlinePatch): OutlinePatch {
  const { p00, p10, p01, p11 } = patch.corners
  return {
    ...patch,
    top: withTable(patch.top, p00, p10),
    bottom: withTable(patch.bottom, p01, p11),
    left: withTable(patch.left, p00, p01),
    right: withTable(patch.right, p10, p11),
  }
}

function withTable(edge: PatchEdge, from: Vec2, to: Vec2): PatchEdge {
  const curve = { id: 'edge', points: edge.points }
  // Pushed into a fresh array rather than index-assigned into a pre-sized one:
  // `new Array(n)` starts out HOLEY, and every later read pays a hole check that
  // also stops the reading code being optimised. That alone accounted for most
  // of the cost of evaluating the map.
  const table: Vec2[] = []
  for (let i = 0; i <= EDGE_TABLE; i++) {
    const t = i / EDGE_TABLE
    const parameter = edge.axis === 'x' ? lerp(from.x, to.x, t) : lerp(from.y, to.y, t)
    const value = evaluateDivider(curve, parameter)
    table.push(edge.axis === 'x' ? { x: parameter, y: value } : { x: value, y: parameter })
  }
  return { ...edge, table }
}

/** A point on an edge, at `t` from its start corner to its end corner. */
export function edgePoint(edge: PatchEdge, _from: Vec2, _to: Vec2, t: number): Vec2 {
  const table = edge.table
  const last = table.length - 1
  if (last < 1) return { x: 0, y: 0 }

  const position = clamp(t, 0, 1) * last
  const index = Math.min(last - 1, Math.floor(position))
  const a = table[index]
  const b = table[index + 1]
  if (!a || !b) return a ?? b ?? { x: 0, y: 0 }

  const f = position - index
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/**
 * Map the unit square onto the shape — the bilinearly blended Coons form.
 *
 * The two ruled surfaces between opposite edges are added and the bilinear
 * surface through the four corners subtracted, which is what makes the map agree
 * with each edge exactly along that edge rather than merely near it.
 */
export function evaluatePatch(patch: OutlinePatch, u: number, v: number): Vec2 {
  const cu = u < 0 ? 0 : u > 1 ? 1 : u
  const cv = v < 0 ? 0 : v > 1 ? 1 : v

  // Written out rather than composed from helpers, and reading the tables into
  // plain numbers rather than points. This runs once per emitted glyph point —
  // hundreds of thousands of times for a page of type — and the tidy version,
  // which allocated four intermediate points and a blending closure per call,
  // cost several microseconds each and made a layout five times slower than the
  // one it replaced.
  const topTable = patch.top.table
  const bottomTable = patch.bottom.table
  const leftTable = patch.left.table
  const rightTable = patch.right.table

  const uLast = topTable.length - 1
  const vLast = leftTable.length - 1
  if (uLast < 1 || vLast < 1 || bottomTable.length < 2 || rightTable.length < 2) {
    return { x: 0, y: 0 }
  }

  const up = cu * uLast
  const ui = up < uLast ? up | 0 : uLast - 1
  const uf = up - ui

  const vp = cv * vLast
  const vi = vp < vLast ? vp | 0 : vLast - 1
  const vf = vp - vi

  const t0 = topTable[ui] as Vec2
  const t1 = topTable[ui + 1] as Vec2
  const b0 = bottomTable[ui] as Vec2
  const b1 = bottomTable[ui + 1] as Vec2
  const l0 = leftTable[vi] as Vec2
  const l1 = leftTable[vi + 1] as Vec2
  const r0 = rightTable[vi] as Vec2
  const r1 = rightTable[vi + 1] as Vec2

  const topX = t0.x + (t1.x - t0.x) * uf
  const topY = t0.y + (t1.y - t0.y) * uf
  const bottomX = b0.x + (b1.x - b0.x) * uf
  const bottomY = b0.y + (b1.y - b0.y) * uf
  const leftX = l0.x + (l1.x - l0.x) * vf
  const leftY = l0.y + (l1.y - l0.y) * vf
  const rightX = r0.x + (r1.x - r0.x) * vf
  const rightY = r0.y + (r1.y - r0.y) * vf

  const c = patch.corners
  const iu = 1 - cu
  const iv = 1 - cv
  const w00 = iu * iv
  const w10 = cu * iv
  const w01 = iu * cv
  const w11 = cu * cv

  return {
    x:
      iv * topX + cv * bottomX + iu * leftX + cu * rightX -
      (w00 * c.p00.x + w10 * c.p10.x + w01 * c.p01.x + w11 * c.p11.x),
    y:
      iv * topY + cv * bottomY + iu * leftY + cu * rightY -
      (w00 * c.p00.y + w10 * c.p10.y + w01 * c.p01.y + w11 * c.p11.y),
  }
}

/**
 * Patch coordinates of an object-space point.
 *
 * A coarse grid search for the starting guess, then Newton on the 2x2 Jacobian.
 * Only the editor needs this — turning a click into a place in the grid — so it
 * is allowed to be the expensive direction.
 */
export function invertPatch(patch: OutlinePatch, target: Vec2): { u: number; v: number } | null {
  const distanceAt = (u: number, v: number): number => {
    const p = evaluatePatch(patch, u, v)
    return (p.x - target.x) ** 2 + (p.y - target.y) ** 2
  }

  let bestU = 0.5
  let bestV = 0.5
  let bestDistance = Infinity

  for (let i = 0; i <= SEED_GRID; i++) {
    for (let j = 0; j <= SEED_GRID; j++) {
      const u = i / SEED_GRID
      const v = j / SEED_GRID
      const d = distanceAt(u, v)
      if (d < bestDistance) {
        bestDistance = d
        bestU = u
        bestV = v
      }
    }
  }

  // Damped Newton, keeping the BEST point rather than the last one. Near a
  // corner where two of the patch's own corners crowd together — a triangle's
  // apex, say — the Jacobian is nearly singular and an undamped step flies off
  // across the square; plain Newton landed 21 units from its target there.
  // Halving a step that makes things worse costs nothing and cannot diverge.
  const h = 1e-4
  let u = bestU
  let v = bestV
  for (let iteration = 0; iteration < 32; iteration++) {
    const p = evaluatePatch(patch, u, v)
    const dx = p.x - target.x
    const dy = p.y - target.y
    if (dx * dx + dy * dy < 1e-12) break

    const du = evaluatePatch(patch, Math.min(1, u + h), v)
    const dv = evaluatePatch(patch, u, Math.min(1, v + h))
    const a = (du.x - p.x) / h
    const b = (dv.x - p.x) / h
    const c = (du.y - p.y) / h
    const d = (dv.y - p.y) / h

    const det = a * d - b * c
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break

    const stepU = (d * dx - b * dy) / det
    const stepV = (a * dy - c * dx) / det
    if (!Number.isFinite(stepU) || !Number.isFinite(stepV)) break

    let scale = 1
    let improved = false
    for (let attempt = 0; attempt < 6; attempt++) {
      const tryU = clamp(u - stepU * scale, 0, 1)
      const tryV = clamp(v - stepV * scale, 0, 1)
      const tryDistance = distanceAt(tryU, tryV)
      if (tryDistance < bestDistance) {
        bestDistance = tryDistance
        bestU = tryU
        bestV = tryV
        u = tryU
        v = tryV
        improved = true
        break
      }
      scale /= 2
    }
    if (!improved) break
  }

  const check = evaluatePatch(patch, bestU, bestV)
  if (!Number.isFinite(check.x) || !Number.isFinite(check.y)) return null
  return { u: bestU, v: bestV }
}

/** Resolution of the search that seeds the inverse. */
const SEED_GRID = 24

/**
 * Whether the map folds over itself.
 *
 * A Coons patch on a strongly concave outline — a crescent, a star with deep
 * notches — can turn inside out, and geometry mapped through a folded patch
 * inverts. The Jacobian's sign flipping across the square is the symptom.
 * Callers clamp rather than refuse: the shape still renders, and type near a
 * deep notch is squeezed instead of wrapping into it.
 */
export function patchFolds(patch: OutlinePatch): boolean {
  const h = 1 / FOLD_GRID
  const determinants: number[] = []

  for (let i = 0; i < FOLD_GRID; i++) {
    for (let j = 0; j < FOLD_GRID; j++) {
      const u = i * h
      const v = j * h
      const origin = evaluatePatch(patch, u, v)
      const alongU = evaluatePatch(patch, u + h, v)
      const alongV = evaluatePatch(patch, u, v + h)
      determinants.push(
        (alongU.x - origin.x) * (alongV.y - origin.y) -
          (alongV.x - origin.x) * (alongU.y - origin.y),
      )
    }
  }

  // Judged RELATIVE to how big the cells are, not on sign alone. A convex shape
  // whose corner cell is nearly degenerate produces a determinant of the wrong
  // sign but a rounding error in size — a hexagon reported one cell at -0.04% of
  // the largest — while a genuine fold turns cells fully inside out. Testing the
  // bare sign called those shapes folded and squeezed type that was perfectly
  // well behaved.
  const largest = Math.max(...determinants.map(Math.abs))
  if (!(largest > 0)) return false
  return determinants.some((d) => d < -largest * FOLD_SIGNIFICANCE)
}

/** Share of the largest cell a reversed cell must reach to count as a fold. */
const FOLD_SIGNIFICANCE = 0.02

/** Length of the curve across the patch at height `v` — a row's real width. */
export function rowWidth(patch: OutlinePatch, v: number, samples = 64): number {
  let total = 0
  let previous = evaluatePatch(patch, 0, v)
  for (let i = 1; i <= samples; i++) {
    const point = evaluatePatch(patch, i / samples, v)
    total += Math.hypot(point.x - previous.x, point.y - previous.y)
    previous = point
  }
  return total
}

/** Distance between two heights of the patch at `u` — a row's real height. */
export function rowHeightAt(patch: OutlinePatch, u: number, v0: number, v1: number): number {
  const a = evaluatePatch(patch, u, v0)
  const b = evaluatePatch(patch, u, v1)
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * A table turning distance along a row into the `u` that reaches it.
 *
 * Stepping `u` uniformly bunches letters wherever the patch compresses, because
 * equal steps of the parameter are not equal steps of distance. Layout works in
 * real units, so it needs the inverse.
 */
export interface RowArc {
  /** Total length of the row across the shape. */
  total: number
  /** The `u` that lies `distance` along the row. */
  uAt: (distance: number) => number
  /** How far along the row a given `u` lies. */
  distanceAt: (u: number) => number
}

export function rowArcTable(patch: OutlinePatch, v: number, samples = 64): RowArc {
  const cumulative: number[] = [0]
  let previous = evaluatePatch(patch, 0, v)
  for (let i = 1; i <= samples; i++) {
    const point = evaluatePatch(patch, i / samples, v)
    const last = cumulative[i - 1] ?? 0
    cumulative.push(last + Math.hypot(point.x - previous.x, point.y - previous.y))
    previous = point
  }
  const total = cumulative[samples] ?? 0

  const uAt = (distance: number): number => {
    if (!(total > 0)) return 0
    const target = clamp(distance, 0, total)
    // Walk to the bracketing samples and interpolate inside them.
    let lo = 0
    let hi = samples
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((cumulative[mid] ?? 0) < target) lo = mid + 1
      else hi = mid
    }
    if (lo === 0) return 0
    const before = cumulative[lo - 1] ?? 0
    const after = cumulative[lo] ?? before
    const span = after - before
    const t = span > 0 ? (target - before) / span : 0
    return (lo - 1 + t) / samples
  }

  const distanceAt = (u: number): number => {
    if (!(total > 0)) return 0
    const position = clamp(u, 0, 1) * samples
    const index = Math.min(samples - 1, Math.floor(position))
    const before = cumulative[index] ?? 0
    const after = cumulative[index + 1] ?? before
    return before + (after - before) * (position - index)
  }

  return { total, uAt, distanceAt }
}

/** Rebuild a closed outline from the patch's four edges. */
export function patchToPath(patch: OutlinePatch, samples = 72): PathData {
  const parts: string[] = []
  const push = (p: Vec2, first: boolean): void => {
    parts.push(`${first ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
  }
  const { p00, p10, p01, p11 } = patch.corners

  for (let i = 0; i <= samples; i++) push(edgePoint(patch.top, p00, p10, i / samples), i === 0)
  for (let i = 1; i <= samples; i++) push(edgePoint(patch.right, p10, p11, i / samples), false)
  for (let i = samples - 1; i >= 0; i--) push(edgePoint(patch.bottom, p01, p11, i / samples), false)
  for (let i = samples - 1; i >= 1; i--) push(edgePoint(patch.left, p00, p01, i / samples), false)

  parts.push('Z')
  const out = parts.join('')
  return /(NaN|Infinity)/.test(out) ? '' : out
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/* --- construction --- */

function sampleOutline(path: PathData, count: number): Vec2[] | null {
  if (!path || path.trim().length === 0) return null

  const points = withPaper((scope) => {
    const item = parsePathInScope(scope, path)

    // The largest subpath is the outline; anything else is a hole or a
    // fragment, and the text engine already ignores those.
    let best: paper.Path | null = null
    let bestArea = 0
    applyToPaths(item, (candidate) => {
      const area = Math.abs(candidate.area)
      if (area > bestArea) {
        bestArea = area
        best = candidate
      }
    })

    if (!best) {
      item.remove()
      return null
    }
    const outline = best as paper.Path
    const length = outline.length
    if (!(length > 0)) {
      item.remove()
      return null
    }

    // Flattened in one pass rather than asking for each point in turn:
    // `getPointAt` walks the curve list on every call, and a few hundred of
    // those dominated the cost of building a patch.
    const flat = outline.clone({ insert: false }) as paper.Path
    flat.flatten(Math.max(0.25, length / (count * 4)))
    const points: Vec2[] = flat.segments.map((segment) => ({
      x: segment.point.x,
      y: segment.point.y,
    }))
    flat.remove()
    item.remove()

    // Flattening is adaptive, so a straight edge comes back as its two ends and
    // a rectangle as four points — far too coarse to find corners in or fit an
    // edge to. Resampling evenly restores a uniform density whatever the shape's
    // curvature, and still costs one pass rather than one call per point.
    if (points.length < 2) return null
    const first = points[0]
    if (first) points.push({ ...first })
    const spacing = length / count
    const even = spacing > 0 ? resamplePolyline(points, spacing) : points
    // Drop the duplicated closing point, so the loop is not doubled up.
    if (even.length > 1) even.pop()
    return even
  })

  if (!points || points.length < 8) return null
  // One winding for every shape, so walking forward from the top-left corner
  // always reaches the top-right next.
  return signedArea(points) < 0 ? points.reverse() : points
}

/** Positive when the loop runs clockwise on screen, where y points down. */
function signedArea(points: readonly Vec2[]): number {
  let total = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (!a || !b) continue
    total += a.x * b.y - b.x * a.y
  }
  return total / 2
}

/**
 * Where the four corners of the patch sit on the outline.
 *
 * The point furthest along each DIAGONAL, measured in units of the shape's own
 * width and height — not the four axis extremes, and not the nearest point to
 * each corner of the bounding box.
 *
 * Not the extremes, because those would collapse the left and right edges onto
 * single points: the outermost rows would pinch to nothing at the tips and the
 * type would be crushed there, which is the defect this whole model exists to
 * remove. Diagonals give a rectangle its own corners, an ellipse its four
 * 45-degree points, and leave every edge a real curve for a row to end on.
 *
 * Not nearest-to-the-bounding-box-corner, because that is unstable: along a
 * slanted edge every point is nearly equidistant from the box corner, so the
 * winner moves under the slightest resampling. The editor writes an outline and
 * the layout rebuilds a patch from it, so an unstable rule compounds — measured
 * at 14 units of drift on a hexagon over five rebuilds. Maximising a linear
 * score lands on a VERTEX, which survives resampling exactly.
 *
 * Each corner is searched in the window left by the previous one, which is what
 * guarantees they stay in outline order however irregular the shape.
 */
function findCornerIndices(
  outline: readonly Vec2[],
): { tl: number; tr: number; br: number; bl: number } | null {
  const n = outline.length
  const xs = outline.map((p) => p.x)
  const ys = outline.map((p) => p.y)
  const width = Math.max(1e-6, Math.max(...xs) - Math.min(...xs))
  const height = Math.max(1e-6, Math.max(...ys) - Math.min(...ys))

  /** Furthest along direction (sx, sy), with the axes put on equal footing. */
  const furthest = (sx: number, sy: number, from: number, to: number): number => {
    let best = from
    let bestScore = -Infinity
    for (let i = from; i <= to; i++) {
      const p = outline[((i % n) + n) % n]
      if (!p) continue
      const score = (sx * p.x) / width + (sy * p.y) / height
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  const tl = furthest(-1, -1, 0, n - 1)
  const limit = tl + n - MIN_EDGE_SAMPLES
  const tr = furthest(1, -1, tl + MIN_EDGE_SAMPLES, limit - 2 * MIN_EDGE_SAMPLES)
  const br = furthest(1, 1, tr + MIN_EDGE_SAMPLES, limit - MIN_EDGE_SAMPLES)
  const bl = furthest(-1, 1, br + MIN_EDGE_SAMPLES, limit)

  if (!(tl < tr && tr < br && br < bl && bl < tl + n)) return null
  return { tl, tr, br, bl }
}

/** Outline points from `from` to `to`, inclusive, wrapping as needed. */
function slice(outline: readonly Vec2[], from: number, to: number): Vec2[] {
  const n = outline.length
  const out: Vec2[] = []
  for (let i = from; i <= to; i++) {
    const p = outline[((i % n) + n) % n]
    if (p) out.push({ ...p })
  }
  return out
}

/**
 * Turn a run of outline points into an edge in its own parameter space.
 *
 * Points that step backwards along the parameter are dropped: a side that
 * doubles back is not a function of its axis, and keeping those points would
 * make the curve ambiguous. That is the one shape this model cannot hold — an
 * overhang — and it was already being discarded before.
 */
function makeEdge(points: readonly Vec2[], axis: 'x' | 'y', tolerance: number): PatchEdge {
  const mapped: Vec2[] = points.map((p) =>
    axis === 'x' ? { x: p.x, y: p.y } : { x: p.y, y: p.x },
  )

  const ascending = (mapped[mapped.length - 1]?.x ?? 0) >= (mapped[0]?.x ?? 0)
  const ordered = ascending ? mapped : [...mapped].reverse()

  const monotone: Vec2[] = []
  for (const p of ordered) {
    const previous = monotone[monotone.length - 1]
    if (previous && p.x <= previous.x) continue
    monotone.push(p)
  }
  if (monotone.length < 2) {
    const first = ordered[0] ?? { x: 0, y: 0 }
    const last = ordered[ordered.length - 1] ?? first
    return { points: [{ ...first }, { x: first.x + 1, y: last.y }], axis, table: [] }
  }

  return { points: fitEdgePoints(monotone, tolerance), axis, table: [] }
}

/**
 * Reduce an edge to the control points its own curve needs.
 *
 * Same greedy insertion the row dividers use: start with the two ends, promote
 * whichever sample the current curve misses by the most, repeat. Fitting against
 * the curve rather than against straight chords is what keeps the drawn boundary
 * on the outline instead of bulging past it.
 */
function fitEdgePoints(samples: readonly Vec2[], tolerance: number): Vec2[] {
  if (!(tolerance > 0) || samples.length <= MIN_EDGE_POINTS) {
    return samples.map((p) => ({ ...p }))
  }

  const chosen = [0, samples.length - 1]
  const copy = (i: number): Vec2 => ({ x: samples[i]?.x ?? 0, y: samples[i]?.y ?? 0 })

  while (chosen.length < MAX_EDGE_POINTS) {
    const curve = { id: 'fit', points: chosen.map(copy) }
    let worstIndex = -1
    let worstError = tolerance
    for (let i = 1; i < samples.length - 1; i++) {
      const sample = samples[i]
      if (!sample) continue
      const error = Math.abs(evaluateDivider(curve, sample.x) - sample.y)
      if (error > worstError) {
        worstError = error
        worstIndex = i
      }
    }
    if (worstIndex < 0) break
    chosen.push(worstIndex)
    chosen.sort((a, b) => a - b)
  }

  const points = chosen.map(copy)
  if (points.length >= MIN_EDGE_POINTS) return points

  // A straight edge is fitted exactly by its two ends, which leaves nothing to
  // drag in the middle. The extra point sits on the line and changes nothing.
  const first = points[0] ?? { x: 0, y: 0 }
  const last = points[points.length - 1] ?? first
  return [{ ...first }, { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }, { ...last }]
}

const MIN_EDGE_POINTS = 3
const MAX_EDGE_POINTS = 24
