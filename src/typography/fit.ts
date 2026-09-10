import { dividersOfAxis } from '../geometry/grid'
import { buildPatch } from '../geometry/patch'
import type { FittedLayout, LayoutLine } from './frame'
import { calculateTextSpans, widestSpan } from '../geometry/spans'
import type {
  DistortionSettings,
  FittingMode,
  GridDivider,
  PathData,
  TextFlowMode,
} from '../types/document'
import type { Span } from '../types/geometry'
import { clamp } from '../utils/math'
import { measureInkExtent, measureUnitWidth, unitMetrics } from './fontRegistry'
import { renderLine, renderPackedLine } from './glyphs'
import { packLine } from './packLine'
import { verifyExactText } from './invariant'
import { createWarpField, isIdentityWarp, needsSubdivision } from './warp'
import type { RibbonSlice } from './frame'
import { fitPath } from './pathFit'
import { fitRing } from './ringFit'
import { fitSpiral } from './spiralFit'
import { distributeUnits, splitIntoUnits } from './wrap'

/**
 * PROVISIONAL FITTING ENGINE (Phase 1 vertical slice).
 *
 * This implements LINE STRETCH only: wrap the exact text into lines, then scale
 * each line independently to fill the horizontal span available to it.
 *
 * Phase 3 replaces the candidate generation and scoring in this file with the
 * full engine (multiple line-count search with richer scoring, vertical
 * redistribution, glyph-level fitting). The MODULE INTERFACE — `fitTextToShape`
 * in, `FitResult` out — is intended to stay stable so that rewrite is contained
 * here. What is NOT provisional is the text invariant: every candidate is
 * verified before it can be returned, in this phase and every later one.
 */

export interface FitOptions {
  text: string
  /** Run modes only: once round the shape, or winding into it. */
  turns?: 'one' | 'many'
  /** Object-local path the text must fill — normally the padded inset path. */
  shapePath: PathData
  fontId: string
  flowMode: TextFlowMode
  /** Multiple of the font's natural line height. */
  lineSpacing: number
  /** Em units. */
  letterSpacing: number
  /** Lower sampling density during interactive gestures. */
  quality: 'preview' | 'final'
  /** How the text is fitted to the shape. Defaults to line stretch. */
  fittingMode?: FittingMode
  /** Deformation settings. Ignored unless `fittingMode` is 'boundary-warp'. */
  distortion?: DistortionSettings
  /** Per-object seed, so distortion is deterministic. */
  seed?: number
  /**
   * Manual row boundaries. When present these REPLACE the automatic band
   * search: N dividers give N+1 rows, and each row's edges follow its dividers
   * rather than a flat cut.
   */
  dividers?: readonly GridDivider[]
}

export interface FittedLine {
  text: string
  path: PathData
  /** Baseline y in object-local space. */
  y: number
  size: number
  horizontalScale: number
  span: Span
  /**
   * The row's slice of the container, 0 at the top edge and 1 at the bottom.
   *
   * Reported so the grid editor can open on the rows that are actually on
   * screen. Materialising evenly spaced cuts instead put the dividers where the
   * text was not — rows here run 0.28 / 0.44 / 0.66 while an even split would
   * say 0.25 / 0.50 / 0.75 — so the guides were drawn in the wrong place and the
   * first edit snapped the type across to meet them.
   */
  rowTop: number
  rowBottom: number
}

export interface FitResult {
  ok: true
  lines: FittedLine[]
  /** All lines combined — what gets rendered. */
  path: PathData
  /**
   * Run modes only: the largest the type could be here.
   *
   * Reported so the size control can offer the whole range and no more. It is a
   * property of the shape and the text together, so it moves whenever either
   * does — which makes "enlarge the shape" the real answer to wanting bigger
   * type, rather than a control that promises a size the shape cannot hold.
   */
  autoSize?: number
  /**
   * The banner and the words cut into slices, in the order the run travels.
   *
   * Present only when there is a banner. Laid down alternately, so a run that
   * crosses itself covers what it passes over — see `renderRibbon`.
   */
  ribbon?: RibbonSlice[]
  /**
   * The banner behind the type, when the mode draws one.
   *
   * Its own path because it is its own FILL: a band following the run, with the
   * letters sitting inside it. Only the run modes have one.
   */
  band?: PathData
  /** Set when fitting needed distortion beyond comfortable limits. */
  extremeDistortion: boolean
  lineCount: number
  /**
   * The solved layout, kept so the same words can be redrawn at another moment
   * of an animation loop without being wrapped and packed again.
   *
   * Present only for the packing modes with a live warp — those are the ones
   * that can be animated, and the only mode the editor offers.
   */
  layout?: FittedLayout
}

export interface FitFailure {
  ok: false
  reason: 'no-space' | 'empty-text' | 'font-not-loaded' | 'invariant-violated'
  message: string
}

export type FitOutcome = FitResult | FitFailure

/** Horizontal scale beyond these bounds triggers the extreme-distortion warning. */
const COMFORTABLE_SCALE_MIN = 0.55
const COMFORTABLE_SCALE_MAX = 2.2
/**
 * Straight runs are split so that no piece spans more than this fraction of the
 * container's width. Finer than the boundary is sampled would buy nothing;
 * coarser leaves visible chords across curved edges.
 */
const SEGMENTS_ACROSS_SHAPE = 64

/** Hard safety bounds, so geometry never inverts or explodes. */
const HARD_SCALE_MIN = 0.05
const HARD_SCALE_MAX = 12

/**
 * How far past each line's own aspect the height variation may push, at 100%.
 *
 * Stopping at the aspect heights made the control almost inert: the rows of a
 * given text differ in aspect only as much as their word lengths happen to
 * differ, so the slider's whole travel bought a few percent.
 */
const HEIGHT_VARIATION_RANGE = 2.6
/** No row may fall below this share of an even split, however hard it is pushed. */
const MIN_BAND_FRACTION = 0.22

/**
 * How far a patch edge may stray from the outline, relative to the shape.
 *
 * The same 1.2% the grid editor fits its boundaries at, so the curve the type
 * follows and the curve the user drags are the same curve.
 */
function patchTolerance(scanlines: ReturnType<typeof calculateTextSpans>): number {
  const first = scanlines[0]
  const last = scanlines[scanlines.length - 1]
  const height = first && last ? Math.abs(last.y - first.y) : 0
  return height > 0 ? height * 0.012 : 0
}

/**
 * Fractions of the shape's height the text block may occupy, in preference
 * order — a fallback ladder, tried in turn until one produces a valid layout.
 *
 * Filling completely is the goal and is always tried first. The reduced fills
 * exist only to rescue shapes whose pinched extremes cannot hold a line at all;
 * they are never chosen because they scored better, because a shrunken block
 * leaves a margin the warp cannot close.
 */
const VERTICAL_FILL_CANDIDATES = [1, 0.94, 0.88]

export function fitTextToShape(options: FitOptions): FitOutcome {
  const { text, shapePath, fontId, flowMode } = options

  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'empty-text', message: 'Enter text to fill this shape.' }
  }
  if (!shapePath || shapePath.trim().length === 0) {
    return { ok: false, reason: 'no-space', message: 'Not enough space for text.' }
  }

  // Sizing and centring are driven by per-line ink extents rather than these
  // metrics; the call stands as the font-loaded guard for the whole fit.
  try {
    unitMetrics(fontId)
  } catch {
    return { ok: false, reason: 'font-not-loaded', message: 'Font is still loading.' }
  }

  /*
   * Text along a run leaves before any of the row machinery below: no scanlines,
   * no candidate counts, no band scoring. It is drawn along a line offset from
   * the outline rather than through the patch, and there are no rows to search
   * for — one line, and a size to set it at.
   *
   * One turn is a lap around the shape, more winds into it. Two builders and one
   * fit; see `runFit.ts`.
   */
  if (options.fittingMode === 'ring') {
    return options.turns === 'many' ? fitSpiral(options) : fitRing(options)
  }
  // A drawn line is the run, exactly as drawn. Nothing is offset from anything.
  if (options.fittingMode === 'path') return fitPath(options)

  const sampleCount = options.quality === 'final' ? 96 : 32
  const scanlines = calculateTextSpans(shapePath, { sampleCount, minSpanWidth: 4 })
  if (scanlines.length === 0) {
    return { ok: false, reason: 'no-space', message: 'Not enough space for text.' }
  }

  const { units, separator } = splitIntoUnits(text, flowMode)
  if (units.length === 0) {
    return { ok: false, reason: 'empty-text', message: 'Enter text to fill this shape.' }
  }

  // A manual grid fixes the row count outright: N dividers give N+1 rows, and
  // the search has nothing left to choose. PRESERVE LINES fixes it too.
  const grid = usableGrid(options.dividers)
  const candidateCounts =
    flowMode === 'preserve-lines'
      ? [units.length]
      : buildCandidateCounts(units.length, scanlines.length)

  const shapeArea = estimateShapeArea(scanlines)
  let best: { score: number; candidate: Candidate } | null = null

  for (const lineCount of candidateCounts) {
    // The reduced fills are a FALLBACK LADDER, not alternatives to be scored
    // against a full fill. Scoring them let the engine decide to shrink the
    // block: it regularly preferred 0.94, which put a margin at the top and
    // bottom that no amount of warping could close, while the sides still ran
    // to the outline — so the type looked tight at the sides and loose above
    // and below. The first fill that yields a valid layout wins, and filling
    // completely is always tried first.
    let candidate: Candidate | null = null
    for (const fillFraction of VERTICAL_FILL_CANDIDATES) {
      const built = buildCandidate(units, separator, lineCount, fillFraction, scanlines, options)
      if (!built) continue

      // The invariant is checked BEFORE scoring, so a layout that loses or
      // duplicates text can never win regardless of how well it fills the shape.
      // Blank cells contribute nothing and must not be read as lost text.
      const written = built.lineTexts.filter((line) => line.length > 0)
      if (!verifyExactText(text, written, flowMode).ok) continue

      candidate = built
      break
    }
    if (!candidate) continue

    const score = scoreCandidate(candidate, shapeArea)
    if (!best || score > best.score) best = { score, candidate }
  }

  if (!best) {
    return { ok: false, reason: 'no-space', message: 'Not enough space for text.' }
  }

  const chosen = best.candidate
  const lines: FittedLine[] = []
  const parts: string[] = []
  let extremeDistortion = false

  const mode = options.fittingMode ?? 'line-stretch'
  const distortion = options.distortion
  const seed = options.seed ?? 0

  // The container as a map from the unit square, built once for the whole
  // block. Where it cannot be built — a shape too degenerate to give four
  // corners — the warp is simply skipped and the type is set flat, which is the
  // same fallback as an identity distortion.
  const wantsWarp =
    mode === 'boundary-warp' && distortion !== undefined && !isIdentityWarp(distortion)
  const patch = wantsWarp
    ? buildPatch(shapePath, {
        samples: options.quality === 'final' ? 240 : 96,
        tolerance: patchTolerance(scanlines),
      })
    : null
  const warping = patch !== null
  const subdivide = warping && distortion !== undefined && needsSubdivision(distortion)

  // Longest straight run a glyph may emit before it is split, so that stems and
  // arms bend with the boundary instead of cutting across it. Derived from the
  // container's own width, because that is the scale over which the boundary
  // varies: a wider shape needs finer splitting to track the same curvature.
  // Zero when nothing is warping, which leaves the undistorted output untouched.
  const shapeSpan = patch
    ? Math.abs(patch.corners.p11.x - patch.corners.p00.x) +
      Math.abs(patch.corners.p10.x - patch.corners.p01.x)
    : 0
  const maxSegment = shapeSpan > 0 ? shapeSpan / SEGMENTS_ACROSS_SHAPE : 0

  // The per-character controls, mapped onto the existing distortion fields.
  const layoutLines: LayoutLine[] = []

  const characterGap = clamp(distortion?.horizontal ?? 0.06, 0, 0.5)
  const characterVariation = clamp(distortion?.glyphScaleVariation ?? 0, 0, 1)
  const characterVerticalFill = clamp(distortion?.glyphRotation ?? 0, 0, 1)

  for (let i = 0; i < chosen.lines.length; i++) {
    const line = chosen.lines[i]
    if (!line) continue

    if (line.horizontalScale < COMFORTABLE_SCALE_MIN || line.horizontalScale > COMFORTABLE_SCALE_MAX) {
      extremeDistortion = true
    }

    // GLYPH STRETCH distributes the surplus between glyphs instead of scaling
    // the whole line, so the two non-default modes share one mechanism.
    //
    // It only applies when the line has room to SPARE. A line that has to be
    // squeezed cannot be squeezed by adding tracking, and treating it as though
    // it could left the line wider than its span — it overflowed into the
    // pinched ends of the shape, where the warp field then crushed the outer
    // glyphs. Those lines fall back to scaling, which can compress.
    const available = line.span.x1 - line.span.x0
    const canDistribute =
      (mode === 'glyph-stretch' || mode === 'boundary-warp') && line.horizontalScale >= 1
    const horizontalScale = canDistribute ? 1 : line.horizontalScale
    const naturalAtSize = line.horizontalScale > 0 ? available / line.horizontalScale : available
    const extraWidth = canDistribute ? Math.max(0, available - naturalAtSize) : 0

    const warp =
      warping && patch && distortion
        ? createWarpField({
            patch,
            bandTop: line.bandTop,
            bandBottom: line.bandBottom,
            bandLeft: line.span.x0,
            bandRight: line.span.x1,
            // A row's edges are the container's own, at this fraction of the way
            // down the patch. Dividers do not bound rows any more; they deform
            // whatever rows the layout chose.
            rowTop: line.rowTopFraction,
            rowBottom: line.rowBottomFraction,
            // Deformers change proportion after the layout has been decided, and
            // take no part in deciding which words are in which row.
            ...(grid && grid.columns.length > 0 ? { columnDeformers: grid.columns } : {}),
            ...(grid && grid.rows.length > 0 ? { rowDeformers: grid.rows } : {}),
            distortion,
            seed,
          })
        : undefined

    // PER-CHARACTER PACKING is the default. Every character is given its own
    // slot in the line and scaled independently in x and y to fill it, so the
    // letterforms themselves carry the shape instead of a line of evenly
    // proportioned type sitting inside it.
    let run
    if (mode === 'boundary-warp' || mode === 'glyph-stretch') {
      const characters = Array.from(line.text)
      const slots = packLine(characters, {
        fontId,
        x0: line.span.x0,
        x1: line.span.x1,
        bandTop: line.bandTop,
        bandBottom: line.bandBottom,
        gap: characterGap,
        letterSpacing: options.letterSpacing,
        variation: characterVariation,
        verticalFill: characterVerticalFill,
        seed,
      })
      run = renderPackedLine({ fontId, slots, characters, warp, subdivide, maxSegment })

      // Everything an animation frame needs to draw this line again, without
      // deciding any of it a second time.
      layoutLines.push({
        characters,
        slots,
        bandTop: line.bandTop,
        bandBottom: line.bandBottom,
        span: line.span,
        rowTop: line.rowTopFraction,
        rowBottom: line.rowBottomFraction,
      })
    } else {
      run = renderLine(line.text, {
        fontId,
        size: line.size,
        x: line.span.x0,
        y: line.y,
        letterSpacing: options.letterSpacing,
        horizontalScale,
        extraWidth,
        warp,
        subdivide,
        maxSegment,
        seed,
      })
    }
    if (run.path.length > 0) parts.push(run.path)
    lines.push({
      text: line.text,
      path: run.path,
      y: line.y,
      size: line.size,
      horizontalScale: line.horizontalScale,
      span: line.span,
      rowTop: line.rowTopFraction,
      rowBottom: line.rowBottomFraction,
    })
  }

  // Final guard: the rendered lines must still reconstruct the source exactly.
  const finalCheck = verifyExactText(
    text,
    lines.map((l) => l.text).filter((line) => line.length > 0),
    flowMode,
  )
  if (!finalCheck.ok) {
    return { ok: false, reason: 'invariant-violated', message: finalCheck.detail }
  }

  return {
    ok: true,
    lines,
    path: parts.join(''),
    extremeDistortion,
    ...(patch && distortion && layoutLines.length > 0
      ? {
          layout: {
            patch,
            fontId,
            subdivide,
            maxSegment,
            distortion,
            seed,
            deformers: grid?.columns ?? [],
            rowDeformers: grid?.rows ?? [],
            lines: layoutLines,
          } satisfies FittedLayout,
        }
      : {}),
    lineCount: lines.length,
  }
}

interface CandidateLine {
  text: string
  y: number
  size: number
  horizontalScale: number
  span: Span
  /** The line's flat band, which the warp field remaps onto the container. */
  bandTop: number
  bandBottom: number
  /**
   * Where the row sits in the container's height, 0 at the shape's top edge and
   * 1 at its bottom. This is the slice the warp gives the row, so it is taken
   * from the row's WHOLE height rather than its ink band — the line-spacing
   * inset belongs between rows, not between the type and the outline.
   */
  rowTopFraction: number
  rowBottomFraction: number
  /** Which row this line is, so the grid's boundaries can be found. */
  rowIndex: number
}

interface Candidate {
  lines: CandidateLine[]
  lineTexts: string[]
  /** Ink height of each line in object units, for coverage scoring. */
  inkHeightPx: number
  /** Vertical extent of the whole block, for placing lines within the shape. */
  blockTop: number
  blockBottom: number
}

/** Line counts worth testing, cheapest useful search for the Phase 1 slice. */
/**
 * The manual grid, but only while the text can actually fill it.
 *
 * A grid describes rows, and a row needs something to put in it. When the text
 * is shortened below the number of rows the grid provides, the grid cannot be
 * honoured as written — and the old behaviour was the worst of both: the row
 * COUNT was clamped down to the number of words while the cuts were left alone,
 * so the text was handed the topmost band and sat in a strip across the top of
 * the shape with everything below it empty.
 *
 * Falling back to the automatic layout is deliberately not destructive. The
 * dividers stay on the object, so lengthening the text again brings the user's
 * grid straight back; it is only set aside while there is too little text to
 * honour it.
 */
interface UsableGrid {
  /** Row deformers, top to bottom: they change how TALL the type is. */
  rows: GridDivider[]
  /** Column deformers, left to right: they change how WIDE the type is. */
  columns: GridDivider[]
}

/**
 * The dividers, split by axis. Both axes are DEFORMERS.
 *
 * A column changes how wide the type is across the shape; a row changes how
 * tall it is down the shape. Neither decides how many lines there are or which
 * words go on them — the layout does that, and it does it from the text and the
 * outline alone.
 *
 * A row divider used to do both jobs, and the second one was the trouble.
 * Drawing one repaginated the text; deleting a word repaginated it again, or
 * switched the whole grid off because two rows could not be filled by one word.
 * A divider is a decision about the SHAPE of the type, and it stopped being a
 * decision about its content.
 */
function usableGrid(dividers: readonly GridDivider[] | undefined): UsableGrid | null {
  if (!dividers || dividers.length === 0) return null
  return {
    rows: dividersOfAxis(dividers, 'row'),
    columns: dividersOfAxis(dividers, 'column'),
  }
}

function buildCandidateCounts(unitCount: number, scanlineCount: number): number[] {
  const max = Math.min(unitCount, Math.max(1, Math.floor(scanlineCount / 2)), 14)
  const counts: number[] = []
  for (let n = 1; n <= max; n++) counts.push(n)
  return counts
}

function buildCandidate(
  units: readonly string[],
  separator: string,
  lineCount: number,
  fillFraction: number,
  scanlines: ReturnType<typeof calculateTextSpans>,
  options: FitOptions,
): Candidate | null {
  const shapeTop = scanlines[0]?.y ?? 0
  const shapeBottom = scanlines[scanlines.length - 1]?.y ?? 0
  const shapeHeight = Math.max(1, shapeBottom - shapeTop)

  // A line can only be given a band if there is a unit to put in it.
  const targetLines = Math.min(lineCount, units.length)
  if (targetLines < 1) return null

  // The packing modes reach for the shape's full width at each line's mid-line,
  // so the type is cut by the outline rather than tucked inside it. LINE STRETCH
  // stays strictly contained — it is the safe mode, and its guarantee is tested.
  const packing =
    options.fittingMode === 'glyph-stretch' || options.fittingMode === 'boundary-warp'
  const reach: 'fit' | 'edge' = packing ? 'edge' : 'fit'

  // How far line heights may differ from one another. 0 is a uniform stack;
  // 1 sizes every line purely by its own aspect, which swings them hard.
  const heightVariation = clamp(options.distortion?.vertical ?? 0, 0, 1)

  // The text fills the WHOLE shape, top to bottom. `fillFraction` shrinks the
  // block inside that, and exists only so the search can back off in shapes
  // where filling completely would be absurd — the default is to fill.
  const totalHeight = shapeHeight * fillFraction
  const top = shapeTop + (shapeHeight - totalHeight) / 2
  const evenBand = totalHeight / targetLines
  const spacing = Math.max(0.5, options.lineSpacing)

  // Phase 1 — a provisional even split decides WHAT goes on each line.
  //
  // Only ROWS take part in this. Vertical deformers change how wide the type
  // is, not which words there are, so they are applied later by the warp and
  // have no say here at all.
  const distributed = distributeUnits(
    units,
    bandWeights(scanlines, top, evenBand, targetLines),
    targetLines,
  )
  if (distributed.length !== targetLines) return null

  const lineTexts = distributed.map((unitsOnLine) => unitsOnLine.join(separator))

  // Natural proportions of each CELL, in em, at size 1.
  // Natural proportions of each line, in em, at size 1.
  const naturalWidths: number[] = []
  const inkHeights: number[] = []
  for (const lineText of lineTexts) {
    const width = measureUnitWidth(options.fontId, lineText)
    const ink = measureInkExtent(options.fontId, lineText)
    if (!(width > 0) || !(ink.height > 0)) return null
    naturalWidths.push(width)
    inkHeights.push(ink.height)
  }

  // Phase 2 — LINE HEIGHTS VARY, so every character lands at a similar aspect.
  //
  // Equal bands force a three-letter line and a ten-letter line to the same
  // height, which stretches the short one into a blob and squeezes the long one
  // flat. Instead each line is sized to exactly fill its own span, and the whole
  // stack is then scaled to fill the shape's height. A short line therefore
  // becomes a TALL line, which is what makes the block read as one solid mass of
  // type rather than as evenly-set lines of text.
  //
  // The span depends on where the band sits and the band depends on the size, so
  // this iterates: an even split, then a re-measure against the bands it implies.
  let heights = new Array<number>(targetLines).fill(evenBand)

  /*
   * The band heights are the layout's, always.
   *
   * A manual grid used to short-circuit this entirely — the rows were where the
   * user put them and the automatic sizing had no say. That is the half of a row
   * divider that has been taken away: it deforms the type now, and where the
   * lines sit is decided from the text and the outline as it is without one.
   */
  for (let pass = 0; pass < 2; pass++) {
    const nextHeights: number[] = []
    let cursor = top
    for (let i = 0; i < targetLines; i++) {
      const height = heights[i] ?? evenBand
      const centre = cursor + height / 2
      const halfInk = height / (2 * spacing)
      const span = spanAcrossBand(scanlines, centre - halfInk, centre + halfInk, reach)
      const width = span ? span.x1 - span.x0 : 0
      const naturalWidth = naturalWidths[i] ?? 1
      const inkHeight = inkHeights[i] ?? 1
      // The size that makes this line exactly fill its span, and the ink height
      // that follows from it.
      const size = width > 0 ? width / naturalWidth : 1
      nextHeights.push(Math.max(1, inkHeight * size * spacing))
      cursor += height
    }

    // Normalise so the stack fills the shape's height exactly.
    const sum = nextHeights.reduce((a, b) => a + b, 0)
    if (!(sum > 0)) return null
    const k = totalHeight / sum

    // Blend between EQUAL heights and each line's own aspect. Even lines are
    // the default; the variation is a control.
    //
    // The blend runs PAST the aspect heights rather than stopping at them. Lines
    // of similar length have similar aspects, so a blend capped at 1 could only
    // ever reach the small difference the text happened to contain — the slider
    // moved the whole way and barely anything happened. Extrapolating gives the
    // control a range you can actually see, and the floor below keeps a line
    // from being driven to nothing.
    heights = nextHeights.map((h) => {
      const aspectHeight = h * k
      const blend = heightVariation * HEIGHT_VARIATION_RANGE
      return Math.max(evenBand * MIN_BAND_FRACTION, evenBand + (aspectHeight - evenBand) * blend)
    })

    // Blending can drift off the total, so renormalise.
    const blended = heights.reduce((a, b) => a + b, 0)
    if (!(blended > 0)) return null
    const correction = totalHeight / blended
    heights = heights.map((h) => h * correction)
  }

  // Phase 3 — lay the final bands out and pack each line into its own.
  const lines: CandidateLine[] = []
  let cursor = top
  let inkHeightPx = 0

  // Space between adjacent rows, as a fraction of the container's height. This
  // is what line spacing now buys: separation between rows, rather than a margin
  // around the whole block.
  const rowGap = ((1 - 1 / spacing) * totalHeight) / (shapeHeight * targetLines)

  for (let i = 0; i < targetLines; i++) {
    const height = heights[i]
    if (height === undefined) return null

    const centre = cursor + height / 2
    const bandInk = height / spacing
    const rowSpan = spanAcrossBand(scanlines, centre - bandInk / 2, centre + bandInk / 2, reach)
    if (!rowSpan) return null

    // The row's slice of the container. The gap that keeps rows apart is taken
    // at the boundaries BETWEEN rows only: the first row's top and the last
    // row's bottom run all the way to the outline, which is what makes the type
    // bleed to the shape's edge instead of floating inside it.
    const halfGap = rowGap / 2
    const rowTopFraction = clamp(
      (cursor - shapeTop) / shapeHeight + (i === 0 ? 0 : halfGap),
      0,
      1,
    )
    const rowBottomFraction = clamp(
      (cursor + height - shapeTop) / shapeHeight - (i === targetLines - 1 ? 0 : halfGap),
      0,
      1,
    )

    const lineText = lineTexts[i]
    if (lineText === undefined) return null

    const span = rowSpan
    const naturalWidth = naturalWidths[i] ?? 1
    const inkHeight = inkHeights[i] ?? 1
    const available = span.x1 - span.x0
    const size = Math.max(1, bandInk / inkHeight)
    const naturalAtSize = naturalWidth * size
    const horizontalScale = clamp(
      naturalAtSize > 0 ? available / naturalAtSize : 1,
      HARD_SCALE_MIN,
      HARD_SCALE_MAX,
    )

    const ink = measureInkExtent(options.fontId, lineText)
    const inkCentreOffset = ((ink.top + ink.bottom) / 2) * size

    lines.push({
      text: lineText,
      y: centre - inkCentreOffset,
      size,
      horizontalScale,
      span,
      bandTop: centre - bandInk / 2,
      bandBottom: centre + bandInk / 2,
      rowTopFraction,
      rowBottomFraction,
      rowIndex: i,
    })

    inkHeightPx = Math.max(inkHeightPx, bandInk)
    cursor += height
  }

  return {
    lines,
    lineTexts,
    inkHeightPx,
    blockTop: top,
    blockBottom: top + totalHeight,
  }
}

/** Span widths per band, used to weight how many units each line receives. */
function bandWeights(
  scanlines: ReturnType<typeof calculateTextSpans>,
  top: number,
  bandHeight: number,
  count: number,
): number[] {
  const weights: number[] = []
  for (let i = 0; i < count; i++) {
    const centre = top + bandHeight * (i + 0.5)
    const span = spanAcrossBand(scanlines, centre - bandHeight / 2, centre + bandHeight / 2)
    weights.push(span ? span.x1 - span.x0 : 0)
  }
  return weights
}

/**
 * The horizontal run a line of type should occupy across a vertical band.
 *
 * `reach` chooses how greedy this is:
 *
 * - `fit` intersects every scanline in the band, giving a rectangle that fits
 *   entirely inside the shape. Safe, but in a tapering form — a diamond, say —
 *   the intersection collapses to the band's narrowest point and the line ends
 *   up far short of the edges.
 * - `edge` takes the span at the band's mid-line, so the line reaches the
 *   shape's full width where it is widest. The corners of a tall line can then
 *   sit slightly outside the outline, which is exactly what the reference
 *   posters do: the type is cut by the shape rather than tucked inside it.
 */
function spanAcrossBand(
  scanlines: ReturnType<typeof calculateTextSpans>,
  top: number,
  bottom: number,
  reach: 'fit' | 'edge' = 'fit',
): Span | null {
  if (reach === 'edge') {
    const centre = (top + bottom) / 2
    const rows = nearestScanline(scanlines, centre)
    const row = rows[0]
    if (!row) return null
    const widest = widestSpan(row)
    return widest ? { y: centre, x0: widest.x0, x1: widest.x1 } : null
  }
  return spanIntersection(scanlines, top, bottom)
}

function spanIntersection(
  scanlines: ReturnType<typeof calculateTextSpans>,
  top: number,
  bottom: number,
): Span | null {
  const inBand = scanlines.filter((line) => line.y >= top && line.y <= bottom)
  // A band thinner than the scanline spacing can contain none; fall back to the
  // nearest line so a dense layout still gets a usable span.
  const rows = inBand.length > 0 ? inBand : nearestScanline(scanlines, (top + bottom) / 2)
  if (rows.length === 0) return null

  let x0 = -Infinity
  let x1 = Infinity
  for (const row of rows) {
    const widest = widestSpan(row)
    if (!widest) return null
    x0 = Math.max(x0, widest.x0)
    x1 = Math.min(x1, widest.x1)
  }

  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 - x0 <= 0) return null
  return { y: (top + bottom) / 2, x0, x1 }
}

function nearestScanline(
  scanlines: ReturnType<typeof calculateTextSpans>,
  y: number,
): ReturnType<typeof calculateTextSpans> {
  let best: (typeof scanlines)[number] | null = null
  let bestDistance = Infinity
  for (const line of scanlines) {
    const distance = Math.abs(line.y - y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = line
    }
  }
  return best ? [best] : []
}

/**
 * Score a candidate layout. Higher is better.
 *
 * Per-line distortion dominates deliberately. Scoring on scale UNIFORMITY alone
 * is degenerate: a single-line layout has nothing to vary, so it scores
 * perfectly uniform even while squashing the text to a tenth of its natural
 * width. Measuring each line's departure from its natural proportions instead
 * ranks a genuinely well-fitted multi-line layout above that.
 *
 * Coverage has to be scored explicitly, or the least-distorted layout is always
 * the smallest one and the engine shrinks the text into a tidy island in the
 * middle of the shape instead of letting the typography become the shape. It is
 * measured from the area the text actually covers rather than from the
 * requested fill fraction: a layout that nominally spans the full height but
 * strands a squeezed line in a tapering end covers less than it claims.
 */
function scoreCandidate(candidate: Candidate, shapeArea: number): number {
  // Legibility is deliberately NOT optimised for — the text follows the shape,
  // and however distorted a character has to become is acceptable. But a weak
  // guard against the DEGENERATE extremes is still needed: with none at all the
  // search set a fourteen-word sentence as one line of paper-thin slivers,
  // because every layout tied on coverage and the tie-breaks favoured the
  // simplest. This is deliberately weak enough to lose to a real fill gain.
  let aspectPenalty = 0
  for (const line of candidate.lines) {
    const chars = Math.max(1, Array.from(line.text).length)
    const band = line.bandBottom - line.bandTop
    if (!(band > 0)) continue
    const aspect = (line.span.x1 - line.span.x0) / chars / band
    aspectPenalty += Math.abs(Math.log2(Math.max(aspect, 1e-6) / NATURAL_CHAR_ASPECT))
  }
  const sanity = 1 / (1 + aspectPenalty / Math.max(1, candidate.lines.length))

  return scoreShape(candidate, shapeArea) + sanity * 9
}

/** Roughly the width-to-height ratio of a character in a condensed display face. */
const NATURAL_CHAR_ASPECT = 0.55

function scoreShape(candidate: Candidate, shapeArea: number): number {
  const scales = candidate.lines.map((l) => l.horizontalScale)
  if (scales.length === 0) return -Infinity

  let min = Infinity
  let max = -Infinity
  let distortionSum = 0
  let worstDistortion = 0
  for (const s of scales) {
    const safe = Math.max(s, 1e-6)
    if (safe < min) min = safe
    if (safe > max) max = safe
    // Log space, so stretching 2x and squashing 2x are penalised equally.
    const distortion = Math.abs(Math.log2(safe))
    distortionSum += distortion
    if (distortion > worstDistortion) worstDistortion = distortion
  }

  // 1. Naturalness: how close each line stays to its designed proportions.
  //    The worst line is weighed alongside the average, because a mean alone
  //    lets one catastrophically stretched line hide behind several good ones —
  //    a layout with a 13x line scored almost as well as a clean one.
  const meanDistortion = distortionSum / scales.length
  const naturalness = 1 / (1 + meanDistortion + worstDistortion * 0.5)

  // 2. Uniformity: neighbouring lines should be scaled similarly.
  const spread = max / min
  const uniformity = 1 / (1 + Math.log2(Math.max(1, spread)))

  // 3. Avoid stranding an extremely short final line.
  const last = candidate.lines[candidate.lines.length - 1]
  let balance = 1
  if (last && candidate.lines.length > 1) {
    const avgLen =
      candidate.lines.reduce((acc, l) => acc + l.text.length, 0) / candidate.lines.length
    balance = clamp(last.text.length / Math.max(1, avgLen), 0.2, 1)
  }

  // 4. Coverage: the shape area the text's ink boxes actually occupy.
  let inkArea = 0
  for (const line of candidate.lines) {
    // Each line's own band, not one shared height: bands vary now, and using
    // the tallest for all of them made a single-line layout score as highly as
    // a well-fitted multi-line one.
    inkArea += (line.span.x1 - line.span.x0) * (line.bandBottom - line.bandTop)
  }
  const coverage = shapeArea > 0 ? clamp(inkArea / shapeArea, 0, 1) : 0

  // Coverage is weighted heavily on purpose. At a lower weight the
  // least-distorted layout kept winning by a hair, and the engine would settle
  // for a small tidy block of text floating in a mostly empty shape — the
  // opposite of the typography becoming the shape.
  return coverage * 10 + balance * 0.5 + uniformity * 0.2 + naturalness * 0.2
}

/** Approximate interior area, integrating span widths over the scanlines. */
function estimateShapeArea(scanlines: ReturnType<typeof calculateTextSpans>): number {
  if (scanlines.length < 2) return 0
  const first = scanlines[0]
  const last = scanlines[scanlines.length - 1]
  if (!first || !last) return 0
  const spacing = (last.y - first.y) / Math.max(1, scanlines.length - 1)

  let area = 0
  for (const line of scanlines) {
    for (const span of line.spans) area += (span.x1 - span.x0) * spacing
  }
  return area
}
