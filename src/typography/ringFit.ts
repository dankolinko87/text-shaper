import { buildRing, outlineSharpness, startAtAngle } from '../geometry/ring'
import type { Run } from '../geometry/run'
import { clamp } from '../utils/math'
import type { FitOptions, FitOutcome } from './fit'
import { textSpan } from './packLine'
import {
  CORNER_EASE,
  CUSP_MARGIN,
  fitAlongRun,
  wordsCanTravel,
  type RunFitExtras,
  type RunMetrics,
  type RunSource,
} from './runFit'

/**
 * How short of a full lap the words may fall and still close the banner.
 *
 * Set letters leave a sliver over — the size search sizes them to the lap and
 * the leftover is spread as tracking up to a cap — so "all the way round" has to
 * mean all the way round give or take that sliver, not to the unit.
 */
const LAP_CLOSED_SLACK = 0.03

/**
 * One lap around a shape.
 *
 * The spiral winds inward until the shape runs out; this goes round once and
 * stops. Everything the two have in common — the ink measurements, the band
 * arithmetic, the size search, placing and drawing — is in `runFit.ts`. What is
 * left here is the four answers a lap gives differently.
 */

export interface RingFitExtras extends RunFitExtras {
  /** Travels the lap the other way, so the capitals point inward. */
  outward?: boolean
  /**
   * Begin and end the line at a chosen point on the shape.
   *
   * The line is the same either way — one continuous run of words the whole way
   * round, upside down along the bottom as type on a closed path is. This only
   * decides WHERE its two ends sit: left alone they land wherever the offsetter
   * happened to start the outline, which is a different angle on every shape.
   */
  split?: boolean
  /** Where the break sits, as a clock bearing. See `startAtAngle`. */
  splitAngle?: number
  /** Share of the lap left empty where the words begin and end. */
  gap?: number
}

export function fitRing(options: FitOptions & RingFitExtras): FitOutcome {
  const split = options.split === true
  /*
   * Empty lap, as a share of it.
   *
   * The text closes the loop, so without this its last letter lands against its
   * first and the two words run together — a lap ending in BELIEVE and starting
   * with NICE reads BELIEVENCE.
   */
  const gap = clamp(options.gap ?? 0, 0, 0.6)

  /*
   * A lap SETS its letters unless told otherwise, where a spiral packs them.
   *
   * The two modes' defaults differ because they are recording history, not a
   * preference: a lap around a shape has always been the type-on-path case, and
   * a spiral has always got its look from letters that splay as they travel.
   * Normalised here rather than in the shared fit, which has no business knowing
   * which kind of run it is being asked for.
   */
  return fitAlongRun({ ...options, rigid: options.rigid !== false }, (m) =>
    lapSource(options.shapePath, split, options.splitAngle ?? DEFAULT_SPLIT_ANGLE, gap, options.outward === true, m),
  )
}

/**
 * Nine o'clock, where the break was nailed down before it was a control.
 *
 * The lap winds clockwise from wherever it begins, so a break here sends the
 * words up over the top first — the half that reads the right way up.
 */
export const DEFAULT_SPLIT_ANGLE = 270

function lapSource(
  shapePath: string,
  split: boolean,
  splitAngle: number,
  gap: number,
  outward: boolean,
  m: RunMetrics,
): RunSource {
  // Measured once: it does not change with the type size, and the search asks
  // for a lap some thirty times.
  const cuspFloor = outlineSharpness(shapePath) - CUSP_MARGIN

  return {
    noSpace: 'Not enough space to run text around this shape.',

    build(size) {
      /*
       * Travelled backwards, the type stands on the other side of the lap — so
       * the lap has to sit where type reaching INWARD from it lands in the same
       * ring that type reaching outward would have. Mirrored about the band's
       * own middle, which is exactly that.
       */
      const reach = outward ? m.reach + 2 * m.bandMiddle : m.reach
      const lap = buildRing({
        shapePath,
        inset: m.insetFor(reach, size),
        cornerEase: CORNER_EASE * m.inkHeight * size,
        cuspFloor,
        ...(outward ? { reversed: true } : {}),
      })
      // Turned to begin where asked, if asked. The same loop either way — only
      // the point the words start and finish at moves.
      return lap && split ? startAtAngle(lap, splitAngle) : lap
    },

    /** A lap gets SHORTER as the type grows, because bigger type sits further in. */
    fits: (lap, size) => m.textWidth(size) < lap.total * (1 - gap),

    /*
     * The gap is spent at the SEAM, half before the words and half after. Split,
     * the seam has been turned to the side of the shape, so that is where the
     * opening sits.
     */
    place: (lap) => ({ from: (lap.total * gap) / 2, to: lap.total - (lap.total * gap) / 2 }),

    /*
     * The banner covers what the words cover — unless they go the whole way
     * round, in which case it closes.
     *
     * A lap whose words reach all the way to their own starting point should not
     * show an opening at an angle nobody chose, so a continuous one at full size
     * stays a closed ring and the gap is the text's alone. But the words do not
     * always go all the way round: split cuts a deliberate opening at the side,
     * and the size control can take the type down until it covers a third of the
     * lap. A banner that ran on regardless looked like a mistake in both cases,
     * so what decides it is how far the words actually reach, not which control
     * was used.
     *
     * Cut to the WORDS, not to the space they were given: set letters keep their
     * drawn widths, so a line shorter than its room leaves slack the banner
     * should not cover.
     */
    bandRange(lap, size, metrics, slots, where) {
      const words = metrics.rigid
        ? (textSpan(slots, metrics.characters, metrics.fontId, size, 0, true) as {
            start?: number
            end?: number
          })
        : { start: where.from, end: where.to }
      const start = words.start ?? where.from
      const end = words.end ?? where.to
      const closes = !split && (end - start) / lap.total >= 1 - gap - LAP_CLOSED_SLACK
      return closes ? {} : { start, end }
    },

    maxSegment: (_lap, size) => Math.max(2, m.inkHeight * size * 0.4),

    /*
     * A whole lap can carry travelling words; a split one cannot. It is still a
     * closed run, so they would go round quite happily — but its banner has a
     * deliberate opening that stays put, and the words would come out of it onto
     * bare shape.
     */
    travels: wordsCanTravel(true, split),
  } satisfies RunSource<Run>
}
