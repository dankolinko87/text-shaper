import type { PathData, PathOutline, Rect, Vec2 } from '../types/document'
import { itemToOutline } from './outline'
import { withPaper } from './paperContext'
import { itemArea, keepSignificantRegions } from './regions'
import {
  polylineLength,
  resamplePolyline,
  smoothClosedPolyline,
  smoothOpenPolyline,
} from './resample'

export interface StrokeToShapeOptions {
  /** Arc-length spacing for resampling, in artboard units. */
  resampleSpacing: number
  /** Bézier-refit tolerance, in artboard units. */
  simplifyTolerance: number
  smooth: boolean
  /** Strokes enclosing less area than this are rejected as accidental. */
  minArea: number
  minPoints: number
  /** Positive-area regions below this fraction of the largest are dropped as fragments. */
  minRegionAreaRatio: number
}

export const DEFAULT_STROKE_OPTIONS: StrokeToShapeOptions = {
  resampleSpacing: 2,
  // Held below paper's cliff, with room to spare. `simplify` drops an ellipse
  // from 7 fitted segments to 5 somewhere between 0.5 and 0.8, and those 5
  // cannot describe the curve — it loses 11% of its WIDTH while the area barely
  // moves, so an area check does not see it happen. Measured again after the
  // filtering below changed: 0.5 is still clean, 0.8 is over the edge.
  //
  // The number is a SQUARED distance — paper compares it against `dx*dx+dy*dy`
  // — so this is about seven tenths of a unit of licence, not a half.
  simplifyTolerance: 0.5,
  smooth: true,
  minArea: 120,
  minPoints: 4,
  minRegionAreaRatio: 0.02,
}


/**
 * A drawn LINE's own settings.
 *
 * Separate from a shape's because the two are different problems. A line is
 * judged on how closely it follows the hand — it has no area to preserve and no
 * point count to keep down for editing, and it smooths with a large fixed window
 * of its own. Sharing the shape's tolerance meant loosening the shape fit
 * dragged every line off its own stroke.
 */
export const DEFAULT_LINE_OPTIONS: StrokeToShapeOptions = {
  ...DEFAULT_STROKE_OPTIONS,
  simplifyTolerance: 0.2,
}

/** Passes of the moving average for a line, which smooths its own way. */
const LINE_SMOOTHING_PASSES = 2

/**
 * Moving-average window used to take hand tremor out of a stroke, as a fraction
 * of the stroke's own size.
 *
 * A FRACTION, not a fixed number of samples, and that is the whole point. A
 * fixed window is a different amount of smoothing depending on how big the shape
 * is: at five samples it ate a small drawing — ten per cent of its area — while
 * barely touching a large one, so the point count climbed with the size of the
 * gesture. A big ellipse came out with ninety-five points and a warning that it
 * could not be edited by hand.
 *
 * Three per cent of the longer side keeps the same gesture giving the same
 * result at any scale: measured across radii from 30 to 450, the count stays
 * between eleven and eighteen instead of running from eight to ninety.
 */
const SMOOTHING_FRACTION = 0.03

/**
 * Passes of the moving average. Three rather than two: a second pass is what
 * turns a boxy average into something close to Gaussian, and the third buys the
 * last of the tremor back for nothing measurable — on a drawn ellipse it is the
 * difference between losing 2.6% of the area and losing 0.8%.
 */
const SMOOTHING_PASSES = 3

/** The window for one stroke, in samples, never smaller than one. */
function smoothingRadius(points: readonly Vec2[], spacing: number): number {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const extent = Math.max(maxX - minX, maxY - minY)
  if (!Number.isFinite(extent) || extent <= 0) return 1
  return Math.max(1, Math.round((SMOOTHING_FRACTION * extent) / Math.max(spacing, 1e-6)))
}

export type StrokeToShapeResult =
  | {
      ok: true
      /** Closed path in object-local space, bbox-centred on (0,0). */
      pathData: PathData
      /**
       * Always false: this pipeline closes the stroke and judges it by area.
       *
       * Carried on the RESULT rather than left for the caller to state, because
       * the pipeline is the only thing that knows and a caller that has to
       * remember will eventually not. One did: every line the line tool drew
       * came out a filled shape, because the field it needed to pass was
       * optional and the default was the other answer.
       */
      open: false
      /**
       * The same geometry as editable nodes — the fit's own anchors and handles.
       *
       * One subpath per lobe, because the pipeline keeps every significant
       * region on purpose: a freehand shape is legitimately a donut or a figure
       * eight, and a flat node list would drop a hole on the first edit.
       */
      outline: PathOutline
      localBounds: Rect
      /** Where to place `transform.x/y` so the shape lands where it was drawn. */
      artboardCenter: Vec2
      area: number
      /** True when disconnected fragments were discarded. */
      discardedRegions: boolean
    }
  | { ok: false; reason: 'too-few-points' | 'too-small' | 'degenerate' }

/**
 * The Phase 1 freehand pipeline, in full.
 *
 * Steps, per the spec's shape-creation sequence: capture -> smooth and simplify
 * -> close -> detect invalid geometry -> repair self-intersections -> remove
 * tiny fragments. Padding/inset and text fitting happen downstream.
 *
 * Pure: takes plain points, returns plain data. It never touches Fabric, React,
 * or the store, and all of its paper.js use is confined to one `withPaper` call.
 */
export function strokeToShapePath(
  points: readonly Vec2[],
  options: StrokeToShapeOptions = DEFAULT_STROKE_OPTIONS,
): StrokeToShapeResult {
  if (points.length < options.minPoints) return { ok: false, reason: 'too-few-points' }

  // 1. Uniform arc-length resampling, so smoothing and simplification are
  //    independent of drawing speed and input device sample rate.
  const resampled = resamplePolyline(points, options.resampleSpacing)
  if (resampled.length < options.minPoints) return { ok: false, reason: 'too-few-points' }

  // 2. Low-pass the POINTS to remove hand tremor. This has to come before the
  //    Bézier fit: filtering here takes a jittery stroke from ~540 fitted
  //    segments to ~37 with 0.1% area error, whereas smoothing the fitted
  //    handles afterwards left the tremor in place and distorted the shape.
  const smoothed = options.smooth
    ? smoothClosedPolyline(
        resampled,
        smoothingRadius(resampled, options.resampleSpacing),
        SMOOTHING_PASSES,
      )
    : resampled

  return withPaper((scope) => {
    // 3. Build a closed path and fit Béziers to it.
    const path = new scope.Path({
      segments: smoothed.map((p) => new scope.Point(p.x, p.y)),
      closed: true,
    })

    path.simplify(options.simplifyTolerance)

    // 4. Repair self-intersections. Uniting a path with itself resolves
    //    figure-eights into correctly wound, non-self-intersecting regions.
    let resolved: paper.PathItem
    try {
      resolved = path.unite(path)
    } catch {
      path.remove()
      return { ok: false, reason: 'degenerate' }
    }
    path.remove()

    if (!resolved || resolved.isEmpty()) {
      resolved?.remove()
      return { ok: false, reason: 'degenerate' }
    }

    // 5. Drop tiny disconnected fragments, preserving holes.
    //
    //    `keepLargestOnly` is deliberately false here. The spec's
    //    "retain the largest region" rule is about a shape that BECOMES
    //    disconnected through erasing (Phase 4). At creation time, a
    //    deliberately drawn multi-lobed stroke — a figure eight, say — is the
    //    user's intent, and keeping only the biggest lobe would silently delete
    //    half of what they drew. So we keep every significant region and drop
    //    only slivers.
    const filtered = keepSignificantRegions(resolved, {
      minAreaRatio: options.minRegionAreaRatio,
      keepLargestOnly: false,
    })
    const item = filtered.item

    // 6. Validity gates.
    const area = Math.abs(itemArea(item))
    if (!Number.isFinite(area) || area < options.minArea) {
      item.remove()
      return { ok: false, reason: area === 0 || !Number.isFinite(area) ? 'degenerate' : 'too-small' }
    }

    // 7. Normalise winding so Phase 2's inset offset and Phase 3's scanline
    //    inside/outside tests can rely on a single convention.
    //
    //    This MUST be done at the whole-item level, never per subpath. Boolean
    //    ops give outer contours and holes opposite windings, and that
    //    relationship is what makes a hole subtract under the nonzero fill rule.
    //    Forcing every subpath to one direction destroys it: a donut's hole
    //    stops being subtracted and fills in solid. Reversing the whole item
    //    flips every subpath together and preserves the relationship.
    if (itemArea(item) < 0) item.reverse()

    // 8. Recentre: translate so the bbox centre sits at local (0,0), and report
    //    the artboard position separately. The local origin is fixed here for
    //    the object's lifetime — see the note on TypographyObject.
    const bounds = item.bounds
    const center: Vec2 = { x: bounds.center.x, y: bounds.center.y }
    item.translate(new scope.Point(-center.x, -center.y))

    const localBoundsRect = item.bounds
    const localBounds: Rect = {
      x: localBoundsRect.x,
      y: localBoundsRect.y,
      width: localBoundsRect.width,
      height: localBoundsRect.height,
    }
    const pathData = item.pathData
    // Off the ITEM, not off the string it just produced: `pathData` is written
    // at five decimal places and the fit's handles are worth keeping whole.
    const outline = itemToOutline(item)
    item.remove()

    if (!pathData || pathData.length === 0) return { ok: false, reason: 'degenerate' }
    if (!outline) return { ok: false, reason: 'degenerate' }

    return {
      ok: true,
      pathData,
      open: false as const,
      outline,
      localBounds,
      artboardCenter: center,
      area,
      discardedRegions: filtered.discardedRegions,
    }
  })
}

/**
 * The same capture, kept OPEN: a line to write along rather than a shape to
 * fill.
 *
 * Everything the closed pipeline does after the fit exists to make a REGION —
 * closing the path, uniting it with itself to resolve figure-eights into wound
 * contours, dropping fragments by area, normalising the winding so an inset
 * offset knows which way is in. None of it means anything for a line, and the
 * area gate would reject one outright: a stroke that doubles back encloses
 * nothing.
 *
 * So this keeps the parts that are about the DRAWING — resampling, the low-pass
 * that takes the hand out of the stroke, the Bézier fit — and stops there.
 *
 * It sets those three itself rather than reading them from `options`, which is
 * consulted only for `minPoints` and `smooth`. A shape and a line want opposite
 * things from the same steps: a shape is the artwork and is fitted faithfully,
 * a line is a guide for letters and is filtered until it is a curve. See the
 * constants below.
 */
export function strokeToLinePath(
  points: readonly Vec2[],
  options: StrokeToShapeOptions = DEFAULT_LINE_OPTIONS,
): StrokeToLineResult {
  if (points.length < options.minPoints) return { ok: false, reason: 'too-few-points' }

  /*
   * Everything below is measured against the stroke's OWN LENGTH, which is the
   * one difference from the closed pipeline that is not about being open.
   *
   * A shape's tolerances are absolute because a shape is the artwork: two units
   * of error is two units wherever it lands. A line is not the artwork — the
   * letters are — and the hand that drew it wobbles by a roughly fixed number of
   * SCREEN pixels however far the canvas is zoomed. Measuring in artboard units
   * therefore made the same gesture come out clean when zoomed in and lumpy when
   * zoomed out. A share of the length is the same filter either way, and it
   * costs nothing: the resampling below already normalises the point spacing, so
   * making that spacing proportional makes every step after it proportional too.
   */
  const length = polylineLength(points)
  if (!(length > 0)) return { ok: false, reason: 'too-few-points' }

  const resampled = resamplePolyline(points, length / LINE_SAMPLES)
  if (resampled.length < options.minPoints) return { ok: false, reason: 'too-few-points' }

  // Clamped at the ends rather than wrapped: an open line's far end has nothing
  // to do with its near one, and averaging them together would pull the whole
  // stroke toward its own middle.
  const smoothed = options.smooth
    ? smoothOpenPolyline(resampled, LINE_SMOOTHING, LINE_SMOOTHING_PASSES)
    : resampled

  return withPaper((scope) => {
    /*
     * Fitted at a fixed size and scaled back, rather than fitted where it was
     * drawn with a tolerance worked out from its length.
     *
     * Those two ought to be the same thing and are not, because paper's fitter
     * carries a term of `Math.max(error, error * error)` — so the tolerance
     * behaves one way below 1 and another way above it, and the fit of a gesture
     * stops being similar to the fit of the same gesture five times the size.
     * Measured: 6 anchors at full size and 8 at a fifth of it. Normalising the
     * curve first puts the tolerance on the same side of that fold every time.
     */
    const k = LINE_FIT_LENGTH / length
    const path = new scope.Path({
      segments: smoothed.map((p) => new scope.Point(p.x * k, p.y * k)),
      closed: false,
    })
    path.simplify((LINE_FIT_ERROR * LINE_FIT_LENGTH) ** 2)
    path.scale(1 / k, new scope.Point(0, 0))

    /*
     * A line has to be long enough to write on, and a stroke that went nowhere
     * is a stray click. Judged by LENGTH, not by area: a line encloses none, and
     * the closed pipeline's area gate would throw out every line ever drawn.
     */
    if (!(path.length >= MIN_LINE_LENGTH) || path.segments.length < 2) {
      path.remove()
      return { ok: false, reason: 'too-small' as const }
    }

    const bounds = path.bounds
    const center: Vec2 = { x: bounds.center.x, y: bounds.center.y }
    path.translate(new scope.Point(-center.x, -center.y))

    const local = path.bounds
    const anchors: Vec2[] = path.segments.map((segment) => ({
      x: segment.point.x,
      y: segment.point.y,
    }))
    const outline = itemToOutline(path)
    const pathData = path.pathData
    path.remove()

    if (!pathData || pathData.length === 0) return { ok: false, reason: 'degenerate' as const }
    if (!outline) return { ok: false, reason: 'degenerate' as const }

    return {
      ok: true as const,
      pathData,
      open: true as const,
      anchors,
      outline,
      localBounds: {
        x: local.x,
        y: local.y,
        width: local.width,
        height: local.height,
      },
      artboardCenter: center,
    }
  })
}

/**
 * How many samples a drawn line is resampled to, whatever its length.
 *
 * Fine enough that the smoothing window below is a smooth curve rather than a
 * stencil, and coarse enough that the whole pipeline is a few hundred points.
 */
const LINE_SAMPLES = 400

/**
 * The low-pass window for a line, in samples either side — so 18/400 of its
 * length, about 4% each way.
 *
 * Far wider than a shape's, and deliberately. The closed pipeline filters only
 * hand TREMOR, because anything more would round off a corner that is part of
 * the drawing. A line has no corners to protect and every wobble in it is
 * printed straight into the letters standing on it, so it is filtered until it
 * is a curve rather than a record of a gesture. Measured on a drawn S: the
 * shape's window leaves 20 anchors and the letters visibly kinked, this one
 * leaves 5 and stays within a unit of the same curve.
 */
const LINE_SMOOTHING = 18

/**
 * How far the fitted curve may sit from the smoothed points, as a share of the
 * stroke's length. On a 900-unit line, three and a half units.
 *
 * Note what goes into `simplify`: paper compares SQUARED distances against the
 * number it is given, so a tolerance of 0.2 — the shape pipeline's, and what
 * this used to be — is not a fifth of a unit but a twentieth. That is why
 * loosening it in the obvious range did nothing: the whole span from 0.2 to 8
 * is under three units of licence, and a hand-drawn line needs more than that
 * before the fit will drop an anchor.
 */
const LINE_FIT_ERROR = 0.004

/** The length every line is normalised to before it is fitted. See below. */
const LINE_FIT_LENGTH = 1000

/**
 * Shortest stroke that counts as a line, in artboard units.
 *
 * The open counterpart to `minArea`. Below this it is a stray click rather than
 * something to write along.
 */
const MIN_LINE_LENGTH = 40

export type StrokeToLineResult =
  | {
      ok: true
      /** OPEN path in object-local space, bbox-centred on (0,0). */
      pathData: PathData
      /** Always true — see the note on the closed pipeline's own flag. */
      open: true
      /**
       * The Bézier fit's own anchor points, for dragging.
       *
       * A handful, not the hundreds the raw stroke had: the fit is what turns a
       * captured stroke into something with a shape you can take hold of.
       */
      anchors: Vec2[]
      /**
       * The same anchors WITH the handles the fit worked out.
       *
       * `anchors` is what point editing used before there was anywhere to keep a
       * handle; it survives only until the editor reads this instead. The
       * difference is that moving one node here changes one pair of segments,
       * where rebuilding a curve from bare anchors reshapes the whole line.
       */
      outline: PathOutline
      localBounds: Rect
      /** Where to place `transform.x/y` so the line lands where it was drawn. */
      artboardCenter: Vec2
    }
  | { ok: false; reason: 'too-few-points' | 'too-small' | 'degenerate' }
