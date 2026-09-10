import { measureRun, samplePath, type Run } from '../geometry/run'
import type { FitOptions, FitOutcome } from './fit'
import { textSpan } from './packLine'
import {
  fitAlongRun,
  wordsCanTravel,
  type RunFitExtras,
  type RunMetrics,
  type RunSource,
} from './runFit'

/**
 * Text along a line the user drew.
 *
 * The third kind of run, and the one that needs least. A lap and a spiral are
 * both OFFSETS of a closed outline — they have to be built at the type's own
 * size, because how far off the edge they sit is the type's reach and how far
 * apart the turns sit is its line height. A drawn line is not offset from
 * anything. It is the run, exactly as drawn, and it is the same run whatever
 * size the type is set at.
 *
 * That makes the size search trivial by comparison: the run's length is fixed,
 * so there is one size at which the words fill it and nothing to search for
 * twice. Longer words simply come out smaller, which is what the whole tool
 * does everywhere else — the text is laid down once and the type is sized to it.
 */

/** Distance between samples, in object units. */
const SPACING = 2

export interface PathFitExtras extends RunFitExtras {}

export function fitPath(options: FitOptions & PathFitExtras): FitOutcome {
  return fitAlongRun(options, (m) => lineSource(options.shapePath, m))
}

function lineSource(pathData: string, m: RunMetrics): RunSource {
  /*
   * Built ONCE, not per size.
   *
   * The other two sources are asked for a run some thirty times while the size
   * search runs, because for them the run depends on the size. This one does
   * not, and sampling a path means going through paper.js — so doing it once and
   * handing the same run back is the difference between one parse and thirty.
   */
  const points = samplePath(pathData, SPACING)
  const line = points ? measureRun(points) : null

  return {
    noSpace: 'Draw a longer line, or write less.',

    build: () => line,

    /*
     * The words must fit the line as drawn.
     *
     * Nothing here pushes back the way a lap does — a lap shortens as the type
     * grows, so the two meet somewhere. A line is a fixed length, so this is the
     * simple version: the largest size whose words are shorter than it.
     */
    fits: (run, size) => m.textWidth(size) < run.total,

    // A line has a beginning, so the type starts at it and any slack falls at
    // the far end, exactly as a spiral's does.
    place: (run) => ({ from: 0, to: run.total, align: 'start' }),

    bandRange: (_run, size, metrics, slots, where) =>
      metrics.rigid
        ? textSpan(slots, metrics.characters, metrics.fontId, size, 0, true)
        : { start: where.from, end: where.to },

    // A letter bends as it travels, so its straight strokes have to be split
    // finely enough to bend with it.
    maxSegment: (_run, size) => Math.max(2, m.inkHeight * size * 0.4),

    /*
     * A line has two ends, so only SET letters can travel it: they march along,
     * leave at one end and arrive at the other. Packed letters would be smeared
     * across the gap between the two ends instead.
     */
    travels: wordsCanTravel(false),
  } satisfies RunSource<Run>
}
