import { buildSpiral, type Spiral } from '../geometry/spiral'
import type { FitOptions, FitOutcome } from './fit'
import { MAX_TRACKING, textSpan } from './packLine'
import {
  CORNER_EASE,
  MAX_STRETCH,
  fitAlongRun,
  wordsCanTravel,
  type RunFitExtras,
  type RunMetrics,
  type RunSource,
  type Solved,
} from './runFit'

/**
 * A spiral into a shape.
 *
 * A lap goes round once and stops; this winds inward until the shape runs out.
 * Everything the two have in common — the ink measurements, the band arithmetic,
 * the size search, placing and drawing — is in `runFit.ts`. What is left here is
 * the pitch, the depth search, and the answers a spiral gives differently.
 *
 * What follows from laying the text down once is worth stating because it
 * surprises people: the number of turns is decided by how much has been written.
 * Thirty characters make one big turn; six hundred make eight small ones. There
 * is no setting for it because there is nothing to set — it is arithmetic.
 */

/**
 * Gap between one turn and the next, as a share of the ink height, per unit of
 * line spacing. The default setting of 1.14 therefore leaves 0.55 of a letter.
 */
const TURN_GAP = 0.48



/** Enough halvings across the narrow stretch window to land within a percent. */
const REACH_STEPS = 12

/**
 * A depth gain smaller than this is not worth shrinking the type for.
 *
 * As a share of the shape's reach. Without it the search trades a visibly
 * smaller size for a fraction of a unit of extra depth.
 */
const DEPTH_TOLERANCE = 0.02

export interface SpiralFitExtras extends RunFitExtras {
  /** Share of the shape left empty in the middle. */
  centreHole?: number
  /** Winds outward from the middle instead of inward from the edge. */
  outward?: boolean
}

export function fitSpiral(options: FitOptions & SpiralFitExtras): FitOutcome {
  return fitAlongRun<Spiral>(options, (m) => windSource(options, m))
}

function windSource(
  options: FitOptions & SpiralFitExtras,
  m: RunMetrics,
): RunSource<Spiral> {
  /*
   * One turn is the line's own height PLUS a gap, never a multiple of it.
   *
   * Multiplying by the line-spacing setting looks equivalent and is not, because
   * it lets the product fall below the ink: at the old default of 1.14 a turn was
   * 1.14 ink heights, so 14% of a letter's height separated one line of type from
   * the next and the run read as a solid band. Anything under 1.0 — and the
   * slider goes to 0.5 — overlapped outright, which is what turns a spiral into
   * black rings.
   *
   * Written as carriage + gap the collision cannot happen at any setting, and the
   * slider does what its name says: it sets the space BETWEEN the turns.
   */
  const spacing = m.carriage + m.inkHeight * Math.max(0.1, options.lineSpacing) * TURN_GAP
  const hole = options.centreHole ?? 0

  /*
   * How much of a run the text at a given size can actually cover.
   *
   * Packed letters cover ALL of it — they are scaled into their slots, so a
   * longer run makes them wider rather than leaving it empty. That is what lets
   * the depth search buy depth by shrinking the type.
   *
   * Set letters cannot be bought with. They keep their drawn widths, so the only
   * give is tracking, and tracking is capped before the line stops reading as
   * words. Past that a longer run is simply an emptier one, and a depth search
   * that ignored this wound the spiral to the middle with the text stopping a
   * third of the way in.
   */
  const covers = (size: number, total: number): boolean => {
    if (m.textWidth(size) >= total) return false
    if (!m.rigid) return true
    const slack = size * MAX_TRACKING * Math.max(0, m.characters.length - 1)
    return m.textWidth(size) + slack >= total
  }

  const wind = (size: number): Spiral | null =>
    buildSpiral({
      shapePath: options.shapePath,
      pitch: size * spacing,
      padding: m.inset(size),
      centreHole: hole,
      cornerEase: CORNER_EASE * m.inkHeight * size,
      ...(options.outward ? { fromCentre: true } : {}),
    })

  return {
    noSpace: 'Not enough space for a spiral here.',

    build: (size) => wind(size),

    /** A spiral gets LONGER as the type shrinks, because that wins turns. */
    fits: (spiral, size) => m.textWidth(size) < spiral.total,

    refine: (natural) => reachHole(natural, wind, covers, m.textWidth),

    // A spiral has a beginning, so the type starts at it and any slack falls at
    // the inner end, where the run is running out anyway.
    place: (spiral) => ({ from: 0, to: spiral.total, align: 'start' }),

    /*
     * Packed letters tile the space they were given exactly, so that IS their
     * extent — no glyph needs measuring. Set letters have to be asked.
     */
    bandRange: (_spiral, size, metrics, slots, where) =>
      metrics.rigid
        ? textSpan(slots, metrics.characters, metrics.fontId, size, 0, true)
        : { start: where.from, end: where.to },

    // One pitch is about a letter's width.
    maxSegment: (spiral) => Math.max(2, spiral.pitch / 4),

    /*
     * A spiral has two ends, so only SET letters can travel it — and what they
     * do is worth knowing before choosing it: they wind inward, reach the middle
     * and appear again at the outside, the way a groove runs.
     */
    travels: wordsCanTravel(false),
  }
}

/**
 * Wind as deep as the centre hole allows, and no deeper than the type can fill.
 *
 * `buildSpiral` already refuses to go past the hole, so "as deep as it will go"
 * IS the setting: leave a big hole and the run stops at it, close the hole and
 * the run keeps going until the shape runs out. What the fit adds is the size to
 * do it at, because the largest type whose text fills one run — the solve above,
 * and the right starting point — always stops at the SHALLOWEST run that works.
 * Short text therefore gave a fat ring near the rim with the middle left empty,
 * and no setting of the hole could pull it in.
 *
 * Deepest wins, with the LARGER type winning ties, which is what keeps the
 * control continuous. It used to ask a yes/no question instead — does this run
 * reach the hole? — and take the natural size when the answer was yes and a much
 * smaller one when it was no. That is a cliff, and it was visible: on a 520x435
 * ellipse the type sat at 41 units for every setting from 0 to 19% and then
 * jumped 35% to 55 at 20%, for one step of the slider. Ranking runs by depth
 * instead means a setting that admits one more turn changes the size by the
 * width of that turn rather than by the whole difference between two solves.
 *
 * A SCAN rather than a bisection, because depth is not monotonic in size and
 * assuming it was produced the exact bug this control was meant to fix. Taking
 * the type down shortens the pitch, so each turn steps a shorter way inward,
 * while the guards in `buildSpiral` still cut the run off at much the same
 * place; on a flattened ellipse the smaller type therefore ended up SHALLOWER,
 * and asking for no hole left MORE of the middle empty than asking for 30%.
 */
function reachHole(
  natural: Solved<Spiral>,
  wind: (size: number) => Spiral | null,
  covers: (size: number, total: number) => boolean,
  textWidth: (size: number) => number,
): Solved<Spiral> {
  const tolerance = natural.run.reach * DEPTH_TOLERANCE
  // Largest first, so a run that is no deeper never costs type size.
  let best = natural
  for (let step = 1; step <= REACH_STEPS; step++) {
    const size = natural.size * (1 - (step / REACH_STEPS) * (1 - 1 / MAX_STRETCH))
    const spiral = wind(size)
    // A run the text cannot fill is not an improvement, whatever its depth.
    if (!spiral || !covers(size, spiral.total)) continue
    /*
     * Nor is one it can only fill by stretching past what still reads as type.
     *
     * This is what makes the hole a floor rather than a target. Depth bought
     * below here is depth the words cannot cover: the run grows as the type
     * shrinks and the text shrinks with it, so the two move apart, and the
     * packer would make up the difference by pulling the letters out of shape.
     */
    if (spiral.total > textWidth(size) * MAX_STRETCH) continue
    if (spiral.depth > best.run.depth + tolerance) best = { size, run: spiral }
  }
  return best
}
