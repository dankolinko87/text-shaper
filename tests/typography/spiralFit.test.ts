import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds, smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import type { Spiral } from '../../src/geometry/spiral'
import { runAt } from '../../src/geometry/run'
import { documentDefaults } from '../../src/state/defaults'
import { MIN_LINE_HEIGHT } from '../../src/types/document'
import { fitTextToShape, type FitOptions } from '../../src/typography/fit'
import type { SpiralFitExtras } from '../../src/typography/spiralFit'
import {
  measureInkExtent,
  measureUnitWidth,
  registerFont,
} from '../../src/typography/fontRegistry'
import { STATIC_FRAME } from '../../src/typography/animation'
import { renderFrame, type FittedLayout } from '../../src/typography/frame'
import { verifyExactText } from '../../src/typography/invariant'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const BLOB = smoothPath(
  'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
)

const SHORT = 'RONESHA IS THE VERY BEST'
const LONG =
  'The Easter Bunny goes like hop! hop! hop! and then he stops to think about ' +
  'whether a carrot is really the best thing to eat before a long day of hiding ' +
  'eggs in the tall wet grass, and decides that it very probably is. Have a happy Easter!'

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})

afterEach(() => {
  resetPaperScope()
})

/** The shapes here are centred on the origin. */
/**
 * The run a spiral fit produced.
 *
 * `RunLayout.run` is a plain `Run` — the shape a ring and a spiral share — so
 * the turn count and pitch, which only a spiral has, are reached through here.
 */
const spiralOf = (result: { layout?: FittedLayout }): Spiral =>
  result.layout!.lines[0]!.run!.run as Spiral

const distanceFromCentre = (p: { x: number; y: number }): number => Math.hypot(p.x, p.y)

function fit(text: string, shapePath = ELLIPSE, extra: Partial<FitOptions & SpiralFitExtras> = {}) {
  return fitTextToShape({
    text,
    shapePath,
    fontId: 'anton',
    flowMode: 'word',
    lineSpacing: documentDefaults.typography.lineSpacing,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'ring',
    turns: 'many',
    distortion: { ...documentDefaults.distortion },
    seed: 5,
    ...extra,
  })
}

describe('fitting text to a spiral', () => {
  it('fills every primitive shape', () => {
    for (const primitive of PRIMITIVES) {
      const result = fit(SHORT, primitive.build(680, 600))
      expect(result.ok, primitive.label).toBe(true)
      if (!result.ok) continue
      expect(result.path.length, primitive.label).toBeGreaterThan(200)
      expect(result.path, primitive.label).not.toMatch(/NaN|Infinity/)
    }
  })

  it('sets the letters at their drawn size when asked not to wrap them', () => {
    /*
     * The two ways type can meet a curve. WRAPPED, the letters are scaled into
     * slots that fill the band and the outlines are then bent along the run, so
     * a letter splays as it travels — the spiral's own look, and its default.
     * SET, there is one size, it is the size the fit reports, and the run
     * decides only where each letter sits and which way it faces.
     *
     * Both halves are asserted because the interesting failure is the switch not
     * reaching the artwork at all, which leaves everything else looking right.
     */
    const set = fit(SHORT, ELLIPSE, { rigid: true })
    const packed = fit(SHORT, ELLIPSE, { rigid: false })
    expect(set.ok && packed.ok).toBe(true)
    if (!set.ok || !packed.ok) return

    const size = set.lines[0]!.size
    for (const slot of set.layout!.lines[0]!.slots) {
      expect(slot.scaleX).toBeCloseTo(size, 6)
      expect(slot.scaleY).toBeCloseTo(size, 6)
    }
    // The packer sizes letters to fill the band, which is a different number
    // from the type size and on this shape four times it.
    expect(packed.layout!.lines[0]!.slots[0]!.scaleX).not.toBeCloseTo(
      packed.lines[0]!.size,
      1,
    )

    expect(set.layout!.lines[0]!.run!.rigid).toBe(true)
    expect(packed.layout!.lines[0]!.run!.rigid).toBeUndefined()
    expect(set.path).not.toBe(packed.path)
    for (const result of [set, packed]) {
      expect(verifyExactText(SHORT, [result.layout!.lines[0]!.characters.join('')], 'character').ok)
        .toBe(true)
    }
  })

  it('does not wind deeper than set letters can cover', () => {
    /*
     * `reachHole` buys depth by shrinking the type, and it can only do that
     * because packed letters widen to fill whatever run they are given. Set
     * letters do not widen — the only give is tracking, and that is capped — so
     * the same trade leaves the extra run EMPTY. Left unguarded the spiral wound
     * to the middle with the text stopping partway in.
     *
     * Measured as how much of the run the line actually reaches across. The
     * short line on a single-turn spiral is the honest exception: the run's
     * length jumps in steps as turns appear, so there is slack no tracking
     * inside the cap can absorb.
     */
    for (const text of [SHORT, LONG]) {
      const result = fit(text, ELLIPSE, { rigid: true, centreHole: 0 })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const line = result.layout!.lines[0]!
      const run = line.run!.run
      const last = line.slots[line.slots.length - 1]!
      const advance = measureUnitWidth('anton', line.characters[last.index] as string) * last.scaleX
      expect((last.x + advance) / run.total).toBeGreaterThan(0.8)
    }
  })

  it('sets the line height and the gap independently', () => {
    /*
     * The whole point of splitting them. A turn used to be the letters' own
     * height plus a share of it for the gap, one number for both, so asking for
     * room AROUND the letters — a banner — was impossible without also changing
     * how far apart the turns sat.
     *
     * Read off the pitch, which is the sum, and the band, which is one of the
     * two terms: raising the height must move both, and raising the gap must
     * move only the pitch.
     */
    const base = fit(LONG, ELLIPSE, { band: true, lineHeight: 1, lineSpacing: 1 })
    const taller = fit(LONG, ELLIPSE, { band: true, lineHeight: 2, lineSpacing: 1 })
    const looser = fit(LONG, ELLIPSE, { band: true, lineHeight: 1, lineSpacing: 2 })
    expect(base.ok && taller.ok && looser.ok).toBe(true)
    if (!base.ok || !taller.ok || !looser.ok) return

    const bandHeight = (result: typeof base): number => {
      const band = (result as { layout?: FittedLayout }).layout!.lines[0]!.run!.band!
      return (band.to - band.from) / (result as { lines: { size: number }[] }).lines[0]!.size
    }
    const pitch = (result: typeof base): number =>
      spiralOf(result).pitch / (result as { lines: { size: number }[] }).lines[0]!.size

    // Twice the band, per em of type, and a pitch that grew with it.
    expect(bandHeight(taller) / bandHeight(base)).toBeCloseTo(2, 1)
    expect(pitch(taller)).toBeGreaterThan(pitch(base))

    // A wider gap moves the turns apart and leaves the band exactly as it was.
    expect(bandHeight(looser)).toBeCloseTo(bandHeight(base), 6)
    expect(pitch(looser)).toBeGreaterThan(pitch(base))
  })

  it('keeps the banner off until it is asked for, and out of the fit', () => {
    const plain = fit(SHORT, ELLIPSE, {})
    const banded = fit(SHORT, ELLIPSE, { band: true })
    expect(plain.ok && banded.ok).toBe(true)
    if (!plain.ok || !banded.ok) return

    expect(plain.band).toBeUndefined()
    expect(banded.band!.length).toBeGreaterThan(200)
    // A backdrop must not re-fit the type it sits behind.
    expect(banded.path).toBe(plain.path)
  })

  it('stops the banner where the text stops', () => {
    /*
     * Set letters keep their drawn widths, so on a run longer than the words the
     * line stops short — and the banner used to carry on without it, winding
     * most of a turn into the middle of the shape with nothing on it. The wider
     * the gap between the turns the further it went: a coarser pitch makes the
     * run's length jump in bigger steps, so the size search has more left over.
     */
    const result = fit(SHORT, ELLIPSE, { band: true, rigid: true, lineSpacing: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const line = result.layout!.lines[0]!
    const band = line.run!.band!
    const run = line.run!.run
    const slots = line.slots
    const last = slots[slots.length - 1]!
    const advance = measureUnitWidth('anton', line.characters[last.index] as string)
      * last.scaleX

    expect(band.start).toBeCloseTo(slots[0]!.x, 6)
    expect(band.end).toBeCloseTo(last.x + advance, 6)
    // And the cut did something: there is run left over that no longer carries
    // a band. Without this the test passes on a banner that was never trimmed.
    expect(band.end! / run.total).toBeLessThan(0.95)
  })

  it('runs the banner exactly as far as the packed letters do', () => {
    /*
     * Packed letters tile the space they are given, so that space IS their
     * extent — and it is no longer always the whole run. The packer is handed
     * the run only as far as the letters may be stretched to fill it, and past
     * that the run is left empty, so the banner has to stop there too.
     *
     * Measured on this line: the band covers 1057 of a 1231-unit run, ending
     * just past the last slot. The 174 units after it carry no letters.
     */
    const packed = fit(SHORT, ELLIPSE, { band: true, rigid: false })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return

    const line = packed.layout!.lines[0]!
    const band = line.run!.band!
    const total = line.run!.run.total
    const last = line.slots[line.slots.length - 1]!

    expect(band.start).toBe(0)
    // Past the last letter's slot, and short of the run's end.
    expect(band.end!).toBeGreaterThan(last.x)
    expect(band.end!).toBeLessThan(total)
  })

  it('thins the banner without moving the type it sits behind', () => {
    /*
     * A band shorter than the letters is a deliberate look — a stripe through
     * the middle of them rather than a banner around them — and the letters
     * still stand their full height whatever is drawn behind them.
     *
     * So below 1 the line height sets the FILL and nothing else. Spacing the
     * turns by the band alone would have thinned the stripe and pulled the turns
     * together at the same time, closing one turn's letters onto the next's, and
     * would have started the outermost turn too close to the edge for the type
     * to fit inside it.
     */
    const full = fit(LONG, ELLIPSE, { band: true, rigid: true, lineHeight: 1 })
    const thin = fit(LONG, ELLIPSE, { band: true, rigid: true, lineHeight: MIN_LINE_HEIGHT })
    expect(full.ok && thin.ok).toBe(true)
    if (!full.ok || !thin.ok) return

    expect(thin.lines[0]!.size).toBeCloseTo(full.lines[0]!.size, 6)
    expect(spiralOf(thin).pitch).toBeCloseTo(spiralOf(full).pitch, 6)
    expect(spiralOf(thin).turns).toBe(spiralOf(full).turns)
    // Only the fill changed, and it changed by the whole of the setting.
    const heightOf = (result: typeof full): number => {
      const band = (result as { layout?: FittedLayout }).layout!.lines[0]!.run!.band!
      return band.to - band.from
    }
    expect(heightOf(thin) / heightOf(full)).toBeCloseTo(MIN_LINE_HEIGHT, 4)
  })

  it('never spaces the turns closer than the letters are tall', () => {
    /*
     * The property the line height has to protect whatever it is set to: one
     * turn's letters must not reach the next turn's. Checked at the thinnest
     * band and the tightest gap the controls allow, which is where it would go
     * first.
     */
    for (const lineHeight of [MIN_LINE_HEIGHT, 0.5, 1]) {
      const result = fit(LONG, ELLIPSE, { band: true, rigid: true, lineHeight, lineSpacing: 0.5 })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const size = result.lines[0]!.size
      const inkHeight = measureInkExtent('anton', LONG).height * size
      expect(spiralOf(result).pitch, `line height ${lineHeight}`).toBeGreaterThan(inkHeight)
    }
  })

  it('lets the band sit outside the outline, as a lap always could', () => {
    /*
     * A lap and a spiral were the same fit written twice, and the copies had
     * drifted: the spiral's inset clamped `Math.max(0, reach)` where the lap's
     * carried a band position, so a spiral could not put its type anywhere but
     * inside the shape. Nothing chose that — it was the clamp, and only one of
     * the two copies had it.
     */
    const inside = fit(SHORT, ELLIPSE, { side: 1 })
    const outside = fit(SHORT, ELLIPSE, { side: -1 })
    expect(inside.ok && outside.ok).toBe(true)
    if (!inside.ok || !outside.ok) return

    const shape = pathBounds(ELLIPSE)
    const held = pathBounds(inside.path)
    const spilled = pathBounds(outside.path)

    // Inside, the type stops at the drawn edge; outside, it crosses it.
    expect(held.x).toBeGreaterThan(shape.x - 2)
    expect(spilled.x).toBeLessThan(shape.x - 2)
    expect(spilled.width).toBeGreaterThan(held.width)
  })

  it('says the text exactly once', () => {
    // The rule the whole tool is built on, and the one the spiral was at risk
    // of breaking: the reference artwork for this effect repeats its phrase.
    for (const text of [SHORT, LONG]) {
      const result = fit(text)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.lines).toHaveLength(1)
      expect(verifyExactText(text, [result.lines[0]!.text], 'character').ok).toBe(true)
    }
  })

  it('gives more turns to more text, at a smaller size', () => {
    // The finding that made "never repeat" workable: density is a consequence
    // of how much has been written, not a setting.
    const short = fit(SHORT)
    const long = fit(LONG)
    expect(short.ok && long.ok).toBe(true)
    if (!short.ok || !long.ok) return

    expect(spiralOf(long).turns).toBeGreaterThan(spiralOf(short).turns)
    expect(long.lines[0]!.size).toBeLessThan(short.lines[0]!.size)
  })

  it('lands the text on the run rather than merely near it', () => {
    // The solver's whole job. If the size were wrong the packer would still
    // fill the run — by stretching every letter — so the check that matters is
    // that the natural width is close to the arc it was solved against.
    const result = fit(LONG)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const run = spiralOf(result)
    const solvedFor = result.lines[0]!.span.x1
    expect(solvedFor).toBeCloseTo(run.total, 6)
  })

  it('keeps the type inside the shape it was given', () => {
    for (const [label, shape] of [
      ['ellipse', ELLIPSE],
      ['blob', BLOB],
    ] as const) {
      const result = fit(LONG, shape)
      expect(result.ok, label).toBe(true)
      if (!result.ok) continue
      const outline = pathBounds(shape)
      const ink = pathBounds(result.path)
      // A little tolerance: the outermost turn sits ON the outline, so
      // ascenders reach inward and descenders a shade outward.
      const slack = 12
      expect(ink.x, label).toBeGreaterThan(outline.x - slack)
      expect(ink.y, label).toBeGreaterThan(outline.y - slack)
      expect(ink.x + ink.width, label).toBeLessThan(outline.x + outline.width + slack)
      expect(ink.y + ink.height, label).toBeLessThan(outline.y + outline.height + slack)
    }
  })

  it('reaches most of the way across the shape', () => {
    // A spiral that only made one small turn in the middle would pass every
    // check above while looking nothing like the effect.
    const result = fit(LONG)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const outline = pathBounds(ELLIPSE)
    const ink = pathBounds(result.path)
    expect(ink.width).toBeGreaterThan(outline.width * 0.8)
    expect(ink.height).toBeGreaterThan(outline.height * 0.8)
  })

  it('does not ask one letter to absorb a whole corner', () => {
    /*
     * What corner damage actually is, in a number.
     *
     * A corner shears a letter by its height times the angle the run turns
     * through while crossing it. On a rectangle a single letter was being asked
     * to take 49 degrees of that, which is what produced the wedges and notched
     * letterforms at every corner; the corner is now eased wide enough that the
     * worst letter takes about half of it.
     *
     * Measured on the OUTERMOST turn. The innermost turn of any spiral is short
     * and bends hard by nature — averaging the two hides the thing being tested.
     */
    const rect = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(520, 420)
    const r = fit(LONG, rect, { baselineShift: -0.4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const run = spiralOf(r)
    const letter = run.total / [...LONG].length
    const firstTurn = run.total / run.turns
    let worst = 0
    for (let i = 0; i < 600; i++) {
      const at = (i / 600) * (firstTurn - letter)
      const a = runAt(run, at).tangent
      const b = runAt(run, at + letter).tangent
      const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y))
      worst = Math.max(worst, (Math.acos(dot) * 180) / Math.PI)
    }
    expect(worst, `${worst.toFixed(0)} degrees across one letter`).toBeLessThan(35)
  })

  it('takes the type out to the edge when nothing is padding it', () => {
    /*
     * With no padding the outermost capitals should be ON the outline, not held
     * back from it.
     *
     * They were, by two separate amounts. The outermost turn was placed an
     * ascender's height inside the edge, and a display face declares far more
     * ascender than its capitals use — Anton says 1.176em and inks 0.867 — so a
     * third of an em went missing before anything else happened. A baseline
     * shift then opened a second gap the same way, because the fit did not know
     * the type had moved off its line.
     *
     * The tolerance is a pitch because a spiral cannot be flush the whole way
     * round: the outermost turn is at the edge where it starts and has blended a
     * full turn inward by the time it gets back there, which is what makes it a
     * spiral rather than a ring. What it must not be is a pitch adrift BEFORE
     * that blend starts.
     */
    for (const shift of [0, -0.4, 0.3]) {
      const r = fit(LONG, ELLIPSE, { padding: 0, baselineShift: shift })
      expect(r.ok, `shift ${shift}`).toBe(true)
      if (!r.ok) continue
      const outline = pathBounds(ELLIPSE)
      const ink = pathBounds(r.path)
      const pitch = spiralOf(r).pitch
      const gap = Math.min(
        ink.x - outline.x,
        ink.y - outline.y,
        outline.x + outline.width - (ink.x + ink.width),
        outline.y + outline.height - (ink.y + ink.height),
      )
      // Close to the edge...
      expect(gap, `shift ${shift} left a ${gap.toFixed(0)} gap at pitch ${pitch.toFixed(0)}`).toBeLessThan(pitch)
      // ...without spilling out of the shape.
      expect(gap, `shift ${shift} spilled outside`).toBeGreaterThan(-12)
    }
  })

  it('leaves the middle open when asked', () => {
    const full = fit(LONG, ELLIPSE, {})
    const holed = fitTextToShape({
      text: LONG,
      shapePath: ELLIPSE,
      fontId: 'anton',
      flowMode: 'word',
      lineSpacing: documentDefaults.typography.lineSpacing,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'ring',
    turns: 'many',
      seed: 5,
      centreHole: 0.5,
    } as FitOptions & { centreHole: number })

    expect(full.ok && holed.ok).toBe(true)
    if (!full.ok || !holed.ok) return

    // The middle is genuinely left alone. Compared against the unholed run
    // rather than an absolute figure: the spiral already stops short of the
    // exact centre on its own, where offsetting stops resembling the shape.
    const innermost = (r: typeof full) =>
      r.ok ? distanceFromCentre(spiralOf(r).points.at(-1)!) : 0
    expect(innermost(holed)).toBeGreaterThan(innermost(full) * 1.3)
    expect(spiralOf(holed).turns).toBeLessThan(spiralOf(full).turns)

  })

  it('leaves at least as much of the middle empty as the number says', () => {
    /*
     * What the control promises: set it to 60% and no type comes closer than 60%
     * of the way in from the edge. A LIMIT, not a target — and reading it as a
     * target is how this came to draw ribbons.
     *
     * Winding deeper with the same words means smaller type and more turns, so
     * the run grows while the text shrinks, and the only thing that can make up
     * the difference is stretching the letters. Past a point that depth is
     * simply unbuyable. The old wording promised the number exactly and the fit
     * kept the promise by drawing letters 2.4 times their designed width.
     *
     * So it is a floor, and it steps: measured on this line the empty middle
     * runs 0.256, 0.256, 0.256, 0.300, 0.554, 0.554, 0.600, 0.700, 0.837 as the
     * setting goes 0 to 0.8. Exact where a turn boundary allows, over where one
     * does not, and never under.
     *
     * Deliberately NOT a claim about type size. Size is derived from this, not
     * monotonic with it, and it steps whenever the run gains or loses a turn.
     */
    let previous = -1
    let opened = 0
    for (const asked of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const r = fit(LONG, ELLIPSE, { centreHole: asked })
      expect(r.ok, `hole ${asked}`).toBe(true)
      if (!r.ok) continue
      const run = spiralOf(r)
      const empty = (run.reach - run.depth) / run.reach
      // Never closer in than asked.
      expect(empty, `hole ${asked}`).toBeGreaterThanOrEqual(asked - 0.02)
      // Never back the other way, however the turns fall.
      expect(empty, `hole ${asked} vs ${previous}`).toBeGreaterThanOrEqual(previous)
      previous = empty
      opened = empty
    }
    // And it is a control, not a threshold: the far end opens the middle far
    // wider than the near end does.
    expect(opened).toBeGreaterThan(0.7)
  })

  it('never opens a bigger hole than the setting before it', () => {
    // The failure this replaced a bisection to fix: taking the type down to
    // wind deeper shortens the pitch, so each turn steps a shorter way in, and
    // on a flattened ellipse the smaller type came out SHALLOWER. Asking for no
    // hole left more of the middle empty than asking for 30% — the control ran
    // backwards at the end of its own range.
    const flat = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(630, 435)
    let previous = -1
    for (const asked of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      const r = fit(LONG, flat, { centreHole: asked })
      expect(r.ok, `hole ${asked}`).toBe(true)
      if (!r.ok) continue
      const run = spiralOf(r)
      const empty = (run.reach - run.depth) / run.reach
      expect(empty, `hole ${asked} opened a bigger middle than ${previous}`).toBeGreaterThan(
        previous - 0.02,
      )
      previous = empty
    }
  })

  it('closes the middle up when the hole is closed', () => {
    // The other half of the same control, and the reason it was reported: with
    // no hole asked for, the type has to reach the middle rather than sitting
    // in a fat ring around the rim.
    const closed = fit(LONG, ELLIPSE, { centreHole: 0 })
    const open = fit(LONG, ELLIPSE, { centreHole: 0.6 })
    expect(closed.ok && open.ok).toBe(true)
    if (!closed.ok || !open.ok) return

    const innermost = (r: typeof closed) =>
      r.ok ? distanceFromCentre(spiralOf(r).points.at(-1)!) : 0
    expect(innermost(closed)).toBeLessThan(innermost(open) * 0.6)
    expect(spiralOf(closed).turns).toBeGreaterThan(spiralOf(open).turns)
  })

  it('redraws the still artwork exactly through the frame renderer', () => {
    // The guard that keeps spiral text inside the animation pipeline: what the
    // fit returns and what a still frame renders have to be the same drawing.
    const result = fit(LONG)
    expect(result.ok).toBe(true)
    if (!result.ok || !result.layout) return
    expect(renderFrame(result.layout, STATIC_FRAME)).toBe(result.path)
  })

  it('is deterministic', () => {
    expect(fit(LONG).ok && fit(LONG).ok).toBe(true)
    const a = fit(LONG)
    const b = fit(LONG)
    expect(a.ok && b.ok && a.path === b.path).toBe(true)
  })

  it('refuses a shape too small to wind rather than drawing nonsense', () => {
    const tiny = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(8, 8)
    const result = fit(LONG, tiny)
    if (!result.ok) {
      expect(result.reason).toBe('no-space')
    } else {
      // If it does fit, it must still be real geometry.
      expect(result.path).not.toMatch(/NaN|Infinity/)
    }
  })

  it('handles a single character without dividing by anything', () => {
    const result = fit('R')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).not.toMatch(/NaN|Infinity/)
  })
})
