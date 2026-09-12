import type { PathData, PathNode, PathOutline, PathSubpath, Vec2 } from '../types/document'
import type { Mat2D } from '../types/geometry'
import { withPaper } from './paperContext'
import { applyToPaths, parsePathInScope, simplifyPath } from './path'
import { distanceToPolyline } from './resample'
import { samplePath } from './run'
import { applyToPoint, applyToVector } from './transform'

/**
 * The boundary between a path STRING and the points someone can take hold of.
 *
 * Its own module rather than more of `path.ts`, for two reasons. `path.ts` is
 * string-in, string-out; this is the one place the two representations meet, and
 * it will grow every node operation that needs paper. And `src/editor/**` is
 * forbidden from importing paper at all — see `.oxlintrc.json` — so the overlay
 * has to reach node editing through a module here, not the other way round.
 *
 * The model is paper's own: a segment is an anchor with two handles measured
 * from it. Keeping the same shape means `pathToOutline` is a copy rather than a
 * translation, and there is nothing in between for the two to drift over.
 */

/** How far off collinear a pair of handles may sit and still count as smooth. */
const SMOOTH_TOLERANCE = Math.sin((1 * Math.PI) / 180)
/** Shorter than this and a handle is not there at all. */
const HANDLE_EPSILON = 1e-6
/** Decimal places in emitted path data, matching what `path.ts` already emits. */
const PLACES = 100
/**
 * How near a closed path's last anchor must be to its first to be the same one.
 *
 * One unit of the precision this module writes at, so the criterion is "closer
 * together than they could be written down apart". The gap being closed is not
 * float residue — it is the accumulated rounding of a chain of RELATIVE curve
 * commands, which lands a few parts in 100000 away from where it started, so an
 * epsilon sized for doubles misses it entirely.
 */
const CLOSING_TOLERANCE = 1 / PLACES

function round(value: number): number {
  return Math.round(value * PLACES) / PLACES
}

const zero = (): Vec2 => ({ x: 0, y: 0 })

/**
 * Whether a node's handles are collinear, and so whether the curve runs through
 * it without a kink.
 *
 * The stored `smooth` flag is what the editor acts on; this is how that flag is
 * first guessed, and how a test can catch a writer that leaves the flag set
 * while pulling the handles apart.
 *
 * An ANGLE rather than a distance, because handle lengths in this tool span
 * three orders of magnitude — a glyph curve is a few units, a drawn line's
 * handles are hundreds — and any absolute epsilon that suits one misclassifies
 * the other. One degree, which at the two decimal places emitted below leaves
 * room to spare even on the shortest handle worth having.
 */
export function isSmoothAt(node: PathNode): boolean {
  const { handleIn: a, handleOut: b } = node
  const lengthA = Math.hypot(a.x, a.y)
  const lengthB = Math.hypot(b.x, b.y)
  if (lengthA < HANDLE_EPSILON || lengthB < HANDLE_EPSILON) return false
  // Opposed, not merely parallel: two handles pointing the same way are a cusp.
  if (a.x * b.x + a.y * b.y >= 0) return false
  const cross = Math.abs(a.x * b.y - a.y * b.x)
  return cross <= SMOOTH_TOLERANCE * lengthA * lengthB
}

/**
 * The nodes as SVG path data.
 *
 * Built by hand rather than through paper, which is a deliberate choice on four
 * counts. It runs on every pointer sample of a drag and every mouse move while
 * the pen rubber-bands, and a parse-and-serialise per frame is not something to
 * spend a frame on. paper emits RELATIVE commands for anything it has touched,
 * and `mapPathPoints` carries a long note on why relatives are a hazard here.
 * The arithmetic is trivial and testable without a scope. And it is
 * deterministic, which matters because tests assert on the string.
 *
 * A segment with no handles is emitted as `L` rather than a cubic with the
 * control points sitting on the anchors. That is not only shorter: it is what
 * makes a plain M/L polyline round-trip through here byte for byte.
 */
export function outlineToPath(outline: PathOutline): PathData {
  const parts: string[] = []

  for (const subpath of outline.subpaths) {
    const nodes = subpath.nodes
    if (nodes.length < 2) continue

    const first = nodes[0] as PathNode
    parts.push(`M${round(first.point.x)} ${round(first.point.y)}`)

    const steps = subpath.closed ? nodes.length : nodes.length - 1
    for (let i = 0; i < steps; i++) {
      const from = nodes[i] as PathNode
      const to = nodes[(i + 1) % nodes.length] as PathNode
      const step = segment(from, to)
      /*
       * `Z` already draws a straight line back to the start, so a straight wrap
       * segment must not also be written out — `...L0 80L0 0Z` and `...L0 80Z`
       * draw the same square, but only the second is what came in, and a writer
       * that lengthens its input by a command each time it is read is not a
       * round trip. A CURVED wrap still has to be emitted; `Z` then closes a
       * gap of zero length, which is what paper does too.
       */
      const wrap = subpath.closed && i === steps - 1
      if (wrap && step.startsWith('L')) continue
      parts.push(step)
    }

    if (subpath.closed) parts.push('Z')
  }

  return parts.join('')
}

/** One step from anchor to anchor, straight where there are no handles to bend it. */
function segment(from: PathNode, to: PathNode): string {
  const out = from.handleOut
  const into = to.handleIn
  const straight =
    Math.abs(out.x) < HANDLE_EPSILON &&
    Math.abs(out.y) < HANDLE_EPSILON &&
    Math.abs(into.x) < HANDLE_EPSILON &&
    Math.abs(into.y) < HANDLE_EPSILON

  if (straight) return `L${round(to.point.x)} ${round(to.point.y)}`

  const c1x = round(from.point.x + out.x)
  const c1y = round(from.point.y + out.y)
  const c2x = round(to.point.x + into.x)
  const c2y = round(to.point.y + into.y)
  return `C${c1x} ${c1y} ${c2x} ${c2y} ${round(to.point.x)} ${round(to.point.y)}`
}

/**
 * Read path data back as editable nodes, or null when it is not worth editing.
 *
 * Through paper, because paper has already solved the parsing: relative
 * commands, the `H`/`V` shorthands, the `S`/`T` reflections and quadratics all
 * arrive here as plain cubic segments. `mapPathPoints` had to hand-roll that and
 * it is not worth a second copy.
 *
 * Arcs are ACCEPTED rather than refused — paper turns them into cubics on the
 * way in. That is strictly better than the status quo, where `mapPathPoints`
 * gives up on an arc and the shape animation falls back: an outline read through
 * here comes out arc-free, so the next thing to touch the path has an easier
 * time than the last.
 */
export function pathToOutline(data: PathData): PathOutline | null {
  if (!data || data.trim().length === 0) return null
  if (/(NaN|Infinity)/.test(data)) return null

  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const outline = itemToOutline(item)
    item.remove()
    return outline
  })
}

/**
 * The same conversion, on an item that is already in hand.
 *
 * Split out because `withPaper` is NOT re-entrant — its `finally` empties the
 * active layer, so an inner call would destroy the outer call's items. The
 * creation pipeline in `strokeToPath.ts` holds a fitted path inside its own
 * scope and must read the nodes off THAT, not off the string it is about to
 * serialise: the string is written at five decimal places, and a fit's handles
 * are worth keeping at full precision.
 *
 * Callers own the item and are responsible for removing it.
 */
export function itemToOutline(item: paper.PathItem): PathOutline | null {
  const subpaths: PathSubpath[] = []

  applyToPaths(item, (path) => {
    // A lone `M` parses as a one-segment path. There is no curve in that.
    if (path.segments.length < 2) return
    const nodes: PathNode[] = path.segments.map((segment) => {
      const node: PathNode = {
        point: { x: segment.point.x, y: segment.point.y },
        handleIn: { x: segment.handleIn.x, y: segment.handleIn.y },
        handleOut: { x: segment.handleOut.x, y: segment.handleOut.y },
        smooth: false,
      }
      node.smooth = isSmoothAt(node)
      return node
    })
    const closed = path.closed === true
    if (closed) foldClosingNode(nodes)
    if (nodes.length >= 2) subpaths.push({ nodes, closed })
  })

  if (subpaths.length === 0) return null
  return { subpaths }
}

/**
 * Drop a closed path's duplicated closing anchor, folding its handle into the
 * first node.
 *
 * A closed path is written out as a curve back to the start point AND a `Z` —
 * that is correct SVG, and paper's own serialiser does it. Reading it back gives
 * a spurious final segment sitting on the first one, because paper joins the two
 * at a tolerance of zero and the round trip through relative commands leaves
 * about 1e-14 between them.
 *
 * Harmless while a path was only ever a string. Not harmless now: it would put
 * two markers in the same place on every freehand shape, and dragging one would
 * leave the other behind at the seam.
 *
 * The first node keeps its own `handleOut` and inherits the closing curve's
 * `handleIn`, which is exactly the segment paper would have produced had the
 * join succeeded.
 */
function foldClosingNode(nodes: PathNode[]): void {
  if (nodes.length <= 2) return
  const first = nodes[0] as PathNode
  const last = nodes[nodes.length - 1] as PathNode
  const gap = Math.hypot(last.point.x - first.point.x, last.point.y - first.point.y)
  if (gap >= CLOSING_TOLERANCE) return
  first.handleIn = { ...last.handleIn }
  first.smooth = isSmoothAt(first)
  nodes.pop()
}

/**
 * Carry an outline through a matrix, alongside the path it describes.
 *
 * Anchors take the whole transform; handles take the LINEAR part only, because
 * they are measured from their anchor rather than from the origin — translating
 * them as well would push every handle across the artboard. `applyToVector`
 * already draws that distinction and is the reason relative handles are the
 * right storage.
 */
export function transformOutline(outline: PathOutline, m: Mat2D): PathOutline {
  return {
    subpaths: outline.subpaths.map((subpath) => ({
      closed: subpath.closed,
      nodes: subpath.nodes.map((node) => ({
        point: applyToPoint(m, node.point),
        handleIn: applyToVector(m, node.handleIn),
        handleOut: applyToVector(m, node.handleOut),
        smooth: node.smooth,
      })),
    })),
  }
}

/** A deep copy, for holding an outline still while it is being dragged. */
export function copyOutline(outline: PathOutline): PathOutline {
  return {
    subpaths: outline.subpaths.map((subpath) => ({
      closed: subpath.closed,
      nodes: subpath.nodes.map((node) => ({
        point: { ...node.point },
        handleIn: { ...node.handleIn },
        handleOut: { ...node.handleOut },
        smooth: node.smooth,
      })),
    })),
  }
}

/** A node with no handles: a plain kink at a point. */
export function cornerAt(point: Vec2): PathNode {
  return { point: { ...point }, handleIn: zero(), handleOut: zero(), smooth: false }
}

/** One subpath as a paper path, at full precision. */
function toPaperPath(scope: paper.PaperScope, subpath: PathSubpath): paper.Path {
  return new scope.Path({
    segments: subpath.nodes.map(
      (node) =>
        new scope.Segment(
          new scope.Point(node.point.x, node.point.y),
          new scope.Point(node.handleIn.x, node.handleIn.y),
          new scope.Point(node.handleOut.x, node.handleOut.y),
        ),
    ),
    closed: subpath.closed,
    insert: false,
  })
}

/* ------------------------------------------------------------------ *
 * Node operations
 * ------------------------------------------------------------------ */

/** Which node, in which contour. */
export interface NodeRef {
  subpath: number
  node: number
}

/**
 * Fewest nodes a contour can be reduced to.
 *
 * Two: a curve still runs between two points, and there is nothing below that.
 * `strokeToLinePath` refuses anything shorter for the same reason.
 */
export const MIN_NODES = 2

export function nodeAt(outline: PathOutline, ref: NodeRef): PathNode | null {
  return outline.subpaths[ref.subpath]?.nodes[ref.node] ?? null
}

/**
 * Rewrite one node, leaving every other byte of the outline as it was.
 *
 * The whole point of storing nodes rather than bare anchors. The old editor kept
 * anchors alone and rebuilt the curve through them with `smoothPath` on every
 * edit, so a tangent was re-guessed at every point and moving one of them
 * reshaped the entire line — including the parts nowhere near the pointer.
 */
function withNode(
  outline: PathOutline,
  ref: NodeRef,
  fn: (node: PathNode) => PathNode,
): PathOutline {
  const next = copyOutline(outline)
  const subpath = next.subpaths[ref.subpath]
  const node = subpath?.nodes[ref.node]
  if (!subpath || !node) return outline
  subpath.nodes[ref.node] = fn(node)
  return next
}

/** Move an anchor. Its handles ride along, being measured from it. */
export function moveNode(outline: PathOutline, ref: NodeRef, to: Vec2): PathOutline {
  return withNode(outline, ref, (node) => ({ ...node, point: { ...to } }))
}

export const sameRef = (a: NodeRef, b: NodeRef): boolean =>
  a.subpath === b.subpath && a.node === b.node

/**
 * Move several anchors by one offset — a picked set dragged or nudged as a
 * body. Rigid: every handle rides with its own anchor and nothing turns, so
 * the curve between two moved points travels unchanged and the curve between
 * a moved point and a still one is the only thing that reshapes.
 */
export function moveNodes(outline: PathOutline, refs: readonly NodeRef[], delta: Vec2): PathOutline {
  if (refs.length === 0 || (delta.x === 0 && delta.y === 0)) return outline
  let next = outline
  for (const ref of refs) {
    const node = nodeAt(next, ref)
    if (!node) continue
    next = moveNode(next, ref, { x: node.point.x + delta.x, y: node.point.y + delta.y })
  }
  return next
}

/**
 * Take several nodes away at once — Delete on a picked set.
 *
 * Highest index first within a contour, so removing one does not shift the
 * others out from under their refs. Each removal is `removeNode`'s, floor and
 * all: what cannot be spared stays, and null means nothing went.
 */
export function removeNodes(outline: PathOutline, refs: readonly NodeRef[]): PathOutline | null {
  const order = [...refs].sort((a, b) => b.subpath - a.subpath || b.node - a.node)
  let next: PathOutline = outline
  let removed = 0
  for (const ref of order) {
    const kept = removeNode(next, ref)
    if (!kept) continue
    next = kept
    removed++
  }
  return removed > 0 ? next : null
}

/**
 * Whether a point is inside a polygon — the even-odd rule, which is what a
 * lasso means: cross the loop an odd number of times on the way out and you
 * were in it, however the loop was drawn.
 */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    const crosses = a.y > point.y !== b.y > point.y
    if (!crosses) continue
    const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (point.x < x) inside = !inside
  }
  return inside
}

/** Every anchor inside a lasso's loop. Fewer than three points is no loop. */
export function nodesInPolygon(outline: PathOutline, polygon: readonly Vec2[]): NodeRef[] {
  if (polygon.length < 3) return []
  const out: NodeRef[] = []
  outline.subpaths.forEach((subpath, s) => {
    subpath.nodes.forEach((node, n) => {
      if (pointInPolygon(node.point, polygon)) out.push({ subpath: s, node: n })
    })
  })
  return out
}

/** Every anchor inside the box with corners `a` and `b`, edges included. */
export function nodesWithin(outline: PathOutline, a: Vec2, b: Vec2): NodeRef[] {
  const left = Math.min(a.x, b.x)
  const right = Math.max(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const bottom = Math.max(a.y, b.y)
  const out: NodeRef[] = []
  outline.subpaths.forEach((subpath, s) => {
    subpath.nodes.forEach((node, n) => {
      const p = node.point
      if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) out.push({ subpath: s, node: n })
    })
  })
  return out
}

/**
 * Move one handle, in the space its anchor sits in.
 *
 * On a smooth node the opposite handle FOLLOWS — it rotates to stay opposite and
 * keeps its own length. That is G1 continuity, and keeping the length is what
 * separates it from mirroring: the two sides of a fitted curve are rarely the
 * same length, and forcing them equal would reshape the neighbouring segment
 * every time the user touched this one.
 *
 * `breaking` sets only the dragged side and drops the node to a corner, which is
 * the Alt gesture. It is a real change to what the node IS, so callers label its
 * history entry accordingly.
 */
export function moveHandle(
  outline: PathOutline,
  ref: NodeRef,
  side: 'in' | 'out',
  to: Vec2,
  breaking = false,
): PathOutline {
  return withNode(outline, ref, (node) => {
    const moved: PathNode = {
      ...node,
      handleIn: side === 'in' ? { ...to } : { ...node.handleIn },
      handleOut: side === 'out' ? { ...to } : { ...node.handleOut },
    }
    if (breaking) return { ...moved, smooth: false }
    if (!node.smooth) return moved

    const opposite = side === 'in' ? node.handleOut : node.handleIn
    const length = Math.hypot(opposite.x, opposite.y)
    const reach = Math.hypot(to.x, to.y)
    // A handle dragged onto its own anchor has no direction to be opposite to.
    // Leave the other side alone rather than collapsing it too.
    if (length < HANDLE_EPSILON || reach < HANDLE_EPSILON) return moved

    const turned = { x: (-to.x / reach) * length, y: (-to.y / reach) * length }
    return side === 'in' ? { ...moved, handleOut: turned } : { ...moved, handleIn: turned }
  })
}

/**
 * Corner to smooth and back.
 *
 * Smooth -> corner FLIPS THE FLAG AND LEAVES THE GEOMETRY ALONE. Zeroing the
 * handles would straighten both neighbouring segments, which is a far bigger
 * change than the one being asked for — the point becomes free to kink, it does
 * not become a kink.
 *
 * Corner -> smooth has to invent handles, and takes the tangent from the chord
 * between the neighbours (Catmull-Rom), each handle a third of the way to its
 * own neighbour. That is the standard construction and it is what makes the
 * result look like the curve someone expected rather than a random bulge.
 *
 * At an OPEN path's endpoint it does nothing: there is only one segment there,
 * so there is no kink to take out. The one handle it has still drags.
 */
export function toggleSmooth(outline: PathOutline, ref: NodeRef): PathOutline {
  const subpath = outline.subpaths[ref.subpath]
  const node = subpath?.nodes[ref.node]
  if (!subpath || !node) return outline

  if (node.smooth) return withNode(outline, ref, (n) => ({ ...n, smooth: false }))

  const nodes = subpath.nodes
  const count = nodes.length
  const hasPrev = subpath.closed || ref.node > 0
  const hasNext = subpath.closed || ref.node < count - 1
  if (!hasPrev || !hasNext) return outline

  const prev = nodes[(ref.node - 1 + count) % count] as PathNode
  const next = nodes[(ref.node + 1) % count] as PathNode
  const chord = { x: next.point.x - prev.point.x, y: next.point.y - prev.point.y }
  const span = Math.hypot(chord.x, chord.y)
  if (span < HANDLE_EPSILON) return outline

  const unit = { x: chord.x / span, y: chord.y / span }
  const back = Math.hypot(node.point.x - prev.point.x, node.point.y - prev.point.y) / 3
  const forward = Math.hypot(next.point.x - node.point.x, next.point.y - node.point.y) / 3
  return withNode(outline, ref, (n) => ({
    ...n,
    handleIn: { x: -unit.x * back, y: -unit.y * back },
    handleOut: { x: unit.x * forward, y: unit.y * forward },
    smooth: true,
  }))
}

/**
 * Take a node away, or null when it cannot be spared.
 *
 * Null rather than the unchanged outline, because the caller has to know the
 * difference: falling through to "then add one instead" on a double-click that
 * meant "take this one away" would be a nasty surprise. A contour that runs out
 * of nodes entirely takes its subpath with it.
 */
export function removeNode(outline: PathOutline, ref: NodeRef): PathOutline | null {
  const subpath = outline.subpaths[ref.subpath]
  if (!subpath || !subpath.nodes[ref.node]) return null
  if (subpath.nodes.length <= MIN_NODES) {
    // The last contour is the object's geometry. Emptying it would leave nothing
    // to select, so the floor holds there even though other contours may go.
    if (outline.subpaths.length <= 1) return null
    const next = copyOutline(outline)
    next.subpaths.splice(ref.subpath, 1)
    return next
  }
  const next = copyOutline(outline)
  next.subpaths[ref.subpath]!.nodes.splice(ref.node, 1)
  return next
}

/**
 * Put a node on the curve where the pointer is, WITHOUT changing the curve.
 *
 * Through paper's `divideAtTime`, which splits a cubic into two cubics that
 * trace exactly the same path — de Casteljau, so it is exact by construction
 * rather than by tolerance. It also rewrites the two NEIGHBOURS' handles, which
 * is the part a hand-rolled insert always forgets and the reason the old editor
 * moved the whole line whenever a point was added.
 *
 * `reach` is in object units, so a caller working in scene coordinates divides
 * its screen tolerance by the zoom first.
 *
 * Authored `smooth` flags are carried across by index rather than re-derived,
 * because they are authored: a node the user made a corner must not silently
 * become smooth again because the curve through it happens to look straight.
 */
export function insertNodeOn(
  outline: PathOutline,
  at: Vec2,
  reach: number,
): { outline: PathOutline; ref: NodeRef } | null {
  if (outline.subpaths.length === 0) return null

  return withPaper((scope) => {
    // Built from the NODES, not from the path string they would serialise to.
    // Going through the string would round every coordinate in the outline to
    // the two places it is written at, so adding a point at one end of a curve
    // would nudge every anchor at the other end. An insert must touch the two
    // segments it splits and nothing else.
    const paths = outline.subpaths.map((subpath) => toPaperPath(scope, subpath))
    const item: paper.PathItem =
      paths.length === 1
        ? (paths[0] as paper.Path)
        : new scope.CompoundPath({ children: paths, insert: false })

    const location = item.getNearestLocation(new scope.Point(at.x, at.y))
    if (!location || location.distance > reach) {
      item.remove()
      return null
    }

    const subpath = paths.indexOf(location.path as paper.Path)
    const curve = location.curve
    if (subpath < 0 || !curve) {
      item.remove()
      return null
    }
    // Dividing curve `k` puts the new segment at index `k + 1`.
    const index = curve.index + 1
    /*
     * Nothing to divide when the pointer landed on an end of the curve — there
     * is a node there already. paper says so by returning null, and refusing is
     * the right answer: the alternative is a second node stacked on the first,
     * which is the thing `foldClosingNode` exists to clean up.
     */
    if (!curve.divideAtTime(location.time)) {
      item.remove()
      return null
    }

    const divided = itemToOutline(item)
    item.remove()
    if (!divided) return null

    const target = divided.subpaths[subpath]
    const before = outline.subpaths[subpath]
    if (!target || !before || target.nodes.length !== before.nodes.length + 1) return null

    /*
     * The flags, spliced around the new node. Dividing a curve leaves both
     * neighbours' tangent DIRECTIONS untouched — only the handle lengths change
     * — so a node that was smooth still is, and one that was a corner still is.
     */
    for (let i = 0; i < target.nodes.length; i++) {
      if (i === index) continue
      const from = before.nodes[i < index ? i : i - 1]
      if (from) (target.nodes[i] as PathNode).smooth = from.smooth
    }
    for (let i = 0; i < divided.subpaths.length; i++) {
      if (i === subpath) continue
      const to = divided.subpaths[i]
      const source = outline.subpaths[i]
      if (!to || !source || to.nodes.length !== source.nodes.length) continue
      to.nodes.forEach((node, k) => {
        node.smooth = (source.nodes[k] as PathNode).smooth
      })
    }

    return { outline: divided, ref: { subpath, node: index } }
  })
}

/**
 * How far apart two paths are, at their worst point.
 *
 * Both sampled and each point of one measured against the other's polyline, so
 * this answers the question a bounding box cannot: did the CURVE move, anywhere
 * along its length. Symmetric, because one path can hug another and still cut a
 * corner off it.
 */
export function pathDeviation(a: PathData, b: PathData, spacing = 2): number {
  const one = samplePath(a, spacing)
  const two = samplePath(b, spacing)
  if (!one || !two) return Infinity

  let worst = 0
  for (const p of one) worst = Math.max(worst, distanceToPolyline(p, two))
  for (const p of two) worst = Math.max(worst, distanceToPolyline(p, one))
  return worst
}

/**
 * Refit a path that has too many points to be edited by hand — but only if the
 * refit does not move it.
 *
 * The grid rewrites an edge as a polyline of several hundred points, and a shape
 * in that state has nothing anyone can take hold of: one marker every few units
 * is a wall of dots. The same Bézier fit that turns a captured stroke into a
 * handful of anchors will reduce it.
 *
 * What it will NOT do is reduce it quietly at the cost of the drawing. paper's
 * fitter distorts a closed path near its seam — measured at over two per cent of
 * the width of a circle, at every tolerance, always in the axis the seam sits on
 * — so the result is measured against the original and thrown away if it moved.
 * A shape that visibly changed the moment its points were opened would be worse
 * than one that could not be opened at all.
 *
 * Null means "no better answer than what you had".
 */
export function refitDensePath(
  data: PathData,
  tolerance: number,
  allowedDrift: number,
): { path: PathData; outline: PathOutline } | null {
  const before = pathToOutline(data)
  if (!before) return null

  const path = simplifyPath(data, tolerance)
  const outline = path ? pathToOutline(path) : null
  if (!outline) return null

  const was = before.subpaths.reduce((n, s) => n + s.nodes.length, 0)
  const now = outline.subpaths.reduce((n, s) => n + s.nodes.length, 0)
  if (now >= was) return null
  if (pathDeviation(data, path) > allowedDrift) return null

  return { path, outline }
}

/* ------------------------------------------------------- blending outlines */

/**
 * Whether two outlines describe the same SHAPE OF PATH — not the same shape.
 *
 * The structural invariant a morph rests on: subpath count, node count per
 * subpath, and whether each is closed. Nodes have no id, so two states blend
 * node *i* against node *i*, and that only means anything if *i* names the same
 * node in both. Topology is object-level for exactly this reason — every state
 * shares it, the way every state of a mosaic shares its tiles.
 */
export function sameTopology(a: PathOutline, b: PathOutline): boolean {
  if (a.subpaths.length !== b.subpaths.length) return false
  for (let i = 0; i < a.subpaths.length; i++) {
    const x = a.subpaths[i] as PathSubpath
    const y = b.subpaths[i] as PathSubpath
    if (x.closed !== y.closed) return false
    if (x.nodes.length !== y.nodes.length) return false
  }
  return true
}

/**
 * One outline on the way to another.
 *
 * Anchors and both handles are interpolated, which is the whole of a morph: a
 * Bézier whose control points travel in straight lines sweeps smoothly between
 * the two curves, and needs no resampling, no arc-length matching and no
 * geometry engine. It is a handful of lerps, so it is cheap enough to run every
 * frame — which is what lets the shape animate at all.
 *
 * Returns NULL rather than nonsense when the topologies differ. Blending a
 * four-node square against a five-node blob by index would pair points that
 * have nothing to do with each other and produce a shape neither state asked
 * for; refusing says so, and the caller falls back to drawing an endpoint.
 *
 * `smooth` is a CUT at the halfway mark. It is authored metadata — what the user
 * said about a node, not what the curve does — and the handles already carry the
 * geometry, so there is nothing to interpolate and nothing lost by switching.
 */
export function blendOutline(a: PathOutline, b: PathOutline, t: number): PathOutline | null {
  if (t <= 0) return a
  if (t >= 1) return b
  if (!sameTopology(a, b)) return null

  const mix = (from: Vec2, to: Vec2): Vec2 => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  })

  return {
    subpaths: a.subpaths.map((subpath, i) => {
      const other = b.subpaths[i] as PathSubpath
      return {
        closed: subpath.closed,
        nodes: subpath.nodes.map((node, j) => {
          const to = other.nodes[j] as PathNode
          return {
            point: mix(node.point, to.point),
            handleIn: mix(node.handleIn, to.handleIn),
            handleOut: mix(node.handleOut, to.handleOut),
            smooth: t < 0.5 ? node.smooth : to.smooth,
          }
        }),
      }
    }),
  }
}

/** Whether two outlines are the same outline, to within a tolerance. */
export function sameOutline(
  a: PathOutline | undefined,
  b: PathOutline | undefined,
  tolerance = 1e-9,
): boolean {
  if (!a || !b) return a === b
  if (!sameTopology(a, b)) return false
  for (let i = 0; i < a.subpaths.length; i++) {
    const x = (a.subpaths[i] as PathSubpath).nodes
    const y = (b.subpaths[i] as PathSubpath).nodes
    for (let j = 0; j < x.length; j++) {
      const p = x[j] as PathNode
      const q = y[j] as PathNode
      for (const key of ['point', 'handleIn', 'handleOut'] as const) {
        if (Math.abs(p[key].x - q[key].x) > tolerance) return false
        if (Math.abs(p[key].y - q[key].y) > tolerance) return false
      }
    }
  }
  return true
}
