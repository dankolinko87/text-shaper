import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds, smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { runAt } from '../../src/geometry/run'
import { documentDefaults } from '../../src/state/defaults'
import { fitTextToShape, type FitOptions } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import type { Vec2 } from '../../src/types/document'
import { measureRun, type Run } from '../../src/geometry/run'
import { renderRunLine } from '../../src/typography/glyphs'
import { measureInkExtent, measureUnitWidth } from '../../src/typography/fontRegistry'
import type { GlyphSlot } from '../../src/typography/packLine'
import type { LayoutLine } from '../../src/typography/frame'
import type { RingFitExtras } from '../../src/typography/ringFit'
import { verifyExactText } from '../../src/typography/invariant'

const FONT_ID = 'anton'
const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const RECTANGLE = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600)
const BLOB = smoothPath(
  'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
)
const TEXT = 'NICE BUT ALSO SORRY TO BE NOT BELIEVE'

beforeAll(async () => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

function fit(shapePath = ELLIPSE, extra: Partial<FitOptions & RingFitExtras> = {}) {
  return fitTextToShape({
    text: TEXT,
    shapePath,
    fontId: FONT_ID,
    flowMode: 'word',
    lineSpacing: documentDefaults.typography.lineSpacing,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'ring',
    seed: 3,
    ...extra,
  } as FitOptions)
}

/** A letter's leading or trailing top corner, as `renderRunLine` places it. */
function corner(
  run: Run,
  line: LayoutLine,
  slot: GlyphSlot,
  size: number,
  capHeight: number,
  leading: boolean,
): Vec2 {
  const character = line.characters[slot.index] as string
  const advance = measureUnitWidth(FONT_ID, character) * size
  const at = slot.x + advance / 2 - line.span.x0
  // The same chord the renderer faces the letter along.
  const half = (advance / 2) * TURN_SPAN
  const from = runAt(run, at - half).point
  const to = runAt(run, at + half).point
  const middle = runAt(run, at).point
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const t = { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  const along = leading ? -advance / 2 : advance / 2
  return {
    x: middle.x + t.x * along + t.y * capHeight,
    y: middle.y + t.y * along - t.x * capHeight,
  }
}

/** Mirrors `TURN_SPAN` in `frame.ts`, which is what the renderer uses. */
const TURN_SPAN = 4

describe('text around a shape', () => {
  it('sets the text once around, and loses none of it', () => {
    for (const [label, split] of [
      ['around', false],
      ['split', true],
    ] as const) {
      const result = fit(ELLIPSE, { split, gap: 0.06 })
      expect(result.ok, label).toBe(true)
      if (!result.ok) continue
      // One line either way. Split moves where that line's ends sit; it does
      // not make a second line.
      expect(result.lineCount, label).toBe(1)
      const check = verifyExactText(
        TEXT,
        result.lines.map((line) => line.text),
        'character',
      )
      expect(check.ok, `${label}: ${check.ok ? '' : check.detail}`).toBe(true)
    }
  })

  it('sets the letters rigidly, at one size, without reshaping them', () => {
    /*
     * The difference between this mode and the spiral, and the reason it exists.
     *
     * A spiral bends the whole strip: every point of every outline is mapped
     * through the curve, which is where its character comes from and also where
     * a curve tighter than the type is tall turns letters inside out. On a drawn
     * blob that ate a whole word, and no easing fixed it, because the geometry
     * really was folded.
     *
     * Type on a path is SET, not stretched. Each glyph is moved and turned as a
     * rigid shape, so it cannot shear and it cannot fold. Checked on a straight
     * run, where a rigid placement has to reproduce the flat line exactly: the
     * ink is the font's own, at one size, however far along it sits.
     */
    const straight: Vec2[] = []
    for (let i = 0; i <= 400; i++) straight.push({ x: i * 4, y: 0 })
    const run = measureRun(straight)!
    const size = 60
    const characters = [...'HANDY']
    const slots = characters.map((_, index) => ({
      index,
      x: index * 100,
      baselineY: 0,
      scaleX: size,
      scaleY: size,
      blank: false,
    }))

    const drawn = renderRunLine({ fontId: FONT_ID, slots, characters, run, x0: 0 })
    const ink = measureInkExtent(FONT_ID, 'HANDY')
    const box = pathBounds(drawn.path)
    // Exactly the font's own ink height at this size — a stretched letter would
    // not be, and neither would a warped one.
    expect(box.height).toBeCloseTo(ink.height * size, 1)
  })

  it('never lets two letters cross where the run bends', () => {
    /*
     * The defect this mode was reported for twice, and it has one cause with two
     * faces: adjacent letters are rigid and face slightly different ways, so
     * where the run bends they lean apart at the top and lean together at the
     * bottom. At the baseline nothing is wrong — the gaps there were a uniform
     * 3.84 units on the shape it was reported from. Fifty-five units up, at cap
     * height, the same gaps ran from -29 to +63: a hole after one pair, two
     * letters crossing at the next.
     *
     * So the gap is measured where it goes wrong, at the top of the letters, not
     * where it always looks right.
     */
    for (const shape of [ELLIPSE, RECTANGLE, BLOB]) {
      const result = fit(shape, {})
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const line = result.layout!.lines[0]!
      const run = line.run!.run
      const size = result.lines[0]!.size
      const capHeight = -measureInkExtent(FONT_ID, 'H').top * size

      let worst = Infinity
      for (let i = 0; i + 1 < line.slots.length; i++) {
        const a = line.slots[i]
        const b = line.slots[i + 1]
        if (!a || !b || a.blank || b.blank) continue
        const trailing = corner(run, line, a, size, capHeight, false)
        const leading = corner(run, line, b, size, capHeight, true)
        const along = { x: leading.x - trailing.x, y: leading.y - trailing.y }
        const heading = runAt(run, b.x - line.span.x0).tangent
        worst = Math.min(worst, along.x * heading.x + along.y * heading.y)
      }
      expect(worst, `letters cross by ${(-worst).toFixed(0)} units`).toBeGreaterThan(-2)
    }
  })

  it('packs the letters into the lap when asked to wrap them', () => {
    /*
     * The lap defaults the other way from the spiral — set, not packed, because
     * type on a path is what the mode is for — but both are offered in both
     * modes, and the choice has to actually reach the artwork.
     */
    const set = fit(ELLIPSE, {})
    const packed = fit(ELLIPSE, { rigid: false })
    expect(set.ok && packed.ok).toBe(true)
    if (!set.ok || !packed.ok) return

    const size = set.lines[0]!.size
    for (const slot of set.layout!.lines[0]!.slots) {
      expect(slot.scaleX).toBeCloseTo(size, 6)
    }
    expect(set.layout!.lines[0]!.run!.rigid).toBe(true)
    expect(packed.layout!.lines[0]!.run!.rigid).toBeUndefined()
    expect(set.path).not.toBe(packed.path)
  })

  it('keeps the letters inside their banner', () => {
    /*
     * The banner and the letters are two separate paths with two separate
     * fills, and the only thing keeping them together is that both are placed
     * from the same description: `renderRunLine` puts a glyph point at
     * `point - n * off`, and `ribbonPath` puts a band edge at the same. Drift
     * between them is the failure this mode would show first, and it would show
     * as type hanging out of its own background.
     *
     * Measured against a LAP rather than a spiral: every point on a lap has one
     * nearest place on the run, where a spiral's turns pass close enough that
     * the nearest sample to a letter can belong to the turn next door.
     *
     * The half a percent of overshoot at line height 1 is the chord: a rigid
     * letter spans its run in a straight line while the band follows the curve,
     * so its outer corners sit a hair proud of a band drawn exactly ink-tall.
     */
    for (const lineHeight of [1, 1.8]) {
      const result = fit(ELLIPSE, { band: true, lineHeight })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const line = result.layout!.lines[0]!
      const run = line.run!.run
      const band = line.run!.band
      expect(band, 'a banner was asked for').toBeTruthy()
      if (!band) return

      let lowest = Infinity
      let highest = -Infinity
      for (const point of pathPoints(result.path)) {
        const off = offsetFromRun(run, point)
        lowest = Math.min(lowest, off)
        highest = Math.max(highest, off)
      }

      const height = band.to - band.from
      const overshoot = Math.max(band.from - lowest, highest - band.to) / height
      expect(overshoot, `line height ${lineHeight}`).toBeLessThan(0.02)

      // And sitting in the MIDDLE of it, not pressed against one edge.
      const drift = ((lowest + highest) / 2 - (band.from + band.to) / 2) / height
      expect(Math.abs(drift), `line height ${lineHeight}`).toBeLessThan(0.02)
    }
  })

  it('draws no banner until one is asked for, and never moves the type', () => {
    const plain = fit(ELLIPSE, {})
    const banded = fit(ELLIPSE, { band: true })
    expect(plain.ok && banded.ok).toBe(true)
    if (!plain.ok || !banded.ok) return

    expect(plain.band).toBeUndefined()
    expect(banded.band!.length).toBeGreaterThan(200)
    // A backdrop is a backdrop: turning it on must not re-fit anything.
    expect(banded.path).toBe(plain.path)
  })

  it('leaves the lap alone at a line height of one', () => {
    /*
     * The band's height and the gap after it are new terms in an old sum, and 1
     * is where the new sum has to equal the old one — otherwise every document
     * anyone has already made shifts the day they update.
     */
    const one = fit(ELLIPSE, { lineHeight: 1 })
    const taller = fit(ELLIPSE, { lineHeight: 2 })
    expect(one.ok && taller.ok).toBe(true)
    if (!one.ok || !taller.ok) return

    // Taller band, so the lap sits further in and takes smaller type with it.
    expect(taller.lines[0]!.size).toBeLessThan(one.lines[0]!.size)
    expect(taller.layout!.lines[0]!.run!.run.total).toBeLessThan(
      one.layout!.lines[0]!.run!.run.total,
    )
  })


  it('begins and ends the line at the side when asked to split', () => {
    /*
     * The line is the same one either way — a single continuous run of words the
     * whole way round, upside down along the bottom as type on a closed path is.
     * Split only decides WHERE its two ends sit.
     *
     * Left alone they land wherever the offsetter happened to start the outline,
     * which is a different angle on every shape; split puts them at 9 o'clock,
     * so the opening straddles the point the words begin and end at.
     */
    const result = fit(ELLIPSE, { split: true, gap: 0.13 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const line = result.layout!.lines[0]!
    const run = line.run!.run
    const bounds = pathBounds(ELLIPSE)
    const middleY = bounds.y + bounds.height / 2

    // The opening straddles the run's seam, so the words start just past it and
    // finish just short of it — both within a letter or two of the left side.
    for (const [label, at] of [
      ['start', line.span.x0],
      ['end', line.span.x1],
    ] as const) {
      const point = runAt(run, at).point
      expect(point.x, `${label} x`).toBeLessThan(bounds.x + bounds.width * 0.25)
      expect(Math.abs(point.y - middleY), `${label} y`).toBeLessThan(bounds.height * 0.35)
    }

    // Left alone, the ends fall somewhere else entirely.
    const loose = fit(ELLIPSE, { split: false, gap: 0.13 })
    if (!loose.ok) return
    const looseLine = loose.layout!.lines[0]!
    const looseStart = runAt(looseLine.run!.run, looseLine.span.x0).point
    const splitStart = runAt(run, line.span.x0).point
    expect(Math.hypot(looseStart.x - splitStart.x, looseStart.y - splitStart.y)).toBeGreaterThan(
      bounds.width * 0.1,
    )
  })




  it('breaks the banner where the line breaks', () => {
    /*
     * A banner that ran on through the opening while the words stopped looked
     * like a mistake. It only breaks where the break is DELIBERATE, though: left
     * to fall anywhere the line's ends are wherever the offsetter started the
     * outline, and an opening at that arbitrary angle would read as a fault in
     * the ring rather than as a design.
     */
    const closed = fit(ELLIPSE, { split: false, gap: 0.13, band: true })
    const broken = fit(ELLIPSE, { split: true, gap: 0.13, band: true })
    expect(closed.ok && broken.ok).toBe(true)
    if (!closed.ok || !broken.ok) return

    // A whole lap's band is an annulus: an outer loop and the inner one
    // reversed, so `nonzero` leaves the shape's middle open.
    expect(closed.band!.match(/M/g)).toHaveLength(2)
    // Broken, it is a single strip with two ends.
    expect(broken.band!.match(/M/g)).toHaveLength(1)

    /*
     * And it opens exactly where the words do, which is the part that went
     * wrong: the banner's ends are given as arc lengths along the run, and the
     * words were being placed half a gap round from there — bare band after the
     * last letter, and the first letter hanging out past the band's edge.
     */
    const line = broken.layout!.lines[0]!
    const band = line.run!.band!
    const words = textExtent(line)
    expect(band.start).toBeCloseTo(words.start, 3)
    expect(band.end).toBeCloseTo(words.end, 3)
  })

  it('travels the lap the other way, which is the badge look', () => {
    /*
     * The other half of the same drift: a spiral had Winds inward/outward from
     * the day it was written and a lap could not be reversed at all, because the
     * option had only ever been added to one of the two copies of the fit.
     *
     * Reversing which way a run is travelled flips which side of it the type
     * stands on, so the capitals point inward — a stamp rather than a sign. It
     * stays readable because handedness is preserved when the direction and the
     * normal turn together; flipping only the normal is mirror-writing, which is
     * a bug this project has had and fixed.
     */
    const outward = fit(ELLIPSE, { side: 1 })
    const inward = fit(ELLIPSE, { side: 1, outward: true })
    expect(outward.ok && inward.ok).toBe(true)
    if (!outward.ok || !inward.ok) return

    /*
     * The type stays in the SAME RING either way, which is the part that needed
     * arranging. A lap is placed so that type reaching outward from it lands
     * against the outline; travelled backwards the type reaches inward instead,
     * and left alone it floated an ink height inside the shape with a bare
     * margin around it. Mirroring the reach about the band's own middle puts it
     * back where it belongs, so the lap itself moves and the ink does not.
     */
    const shape = pathBounds(ELLIPSE)
    const out = pathBounds(outward.path)
    const inn = pathBounds(inward.path)
    expect(inn.width / out.width).toBeCloseTo(1, 1)
    expect(inn.height / out.height).toBeCloseTo(1, 1)
    expect(inn.width).toBeGreaterThan(shape.width * 0.9)

    // The lap moved to make that happen: outward-standing type sits an ink
    // height further in than inward-standing type does.
    const a = outward.layout!.lines[0]!.run!.run
    const b = inward.layout!.lines[0]!.run!.run
    expect(b.total).toBeGreaterThan(a.total * 1.1)
  })

  it('puts the band where the control says', () => {
    const outline = pathBounds(ELLIPSE)
    const widthOf = (side: number): number => {
      const result = fit(ELLIPSE, { side, padding: 0 })
      expect(result.ok, `side ${side}`).toBe(true)
      return result.ok ? pathBounds(result.path).width : 0
    }

    // Inside stays within the outline; outside reaches past it; centred sits
    // between the two.
    expect(widthOf(1)).toBeLessThanOrEqual(outline.width + 1)
    expect(widthOf(0)).toBeGreaterThan(widthOf(1))
    expect(widthOf(-1)).toBeGreaterThan(outline.width)
  })

  it('takes the type out to the edge, with the band inside', () => {
    // The lap is placed so the capitals arrive at the outline and stop. A ring
    // has no blend inward the way a spiral's first turn does, so this one should
    // be tight rather than within a pitch.
    const result = fit(ELLIPSE, { side: 1, padding: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const outline = pathBounds(ELLIPSE)
    const ink = pathBounds(result.path)
    expect(outline.width - ink.width).toBeLessThan(outline.width * 0.06)
    expect(outline.height - ink.height).toBeLessThan(outline.height * 0.06)
  })

  it('leaves room at the seam, so the last word does not touch the first', () => {
    /*
     * Going round once, the text closes the loop: BELIEVE lands against NICE and
     * reads BELIEVENCE. The gap is spent at the seam.
     *
     * Measured from the SLOTS rather than from the line's span. The span is the
     * whole lap — the words sit where they sit inside it — and reading the gap
     * off the span was how the banner came to open half a gap away from them.
     */
    const spaced = fit(ELLIPSE, { gap: 0.2 })
    expect(spaced.ok).toBe(true)
    if (!spaced.ok) return

    const line = spaced.layout!.lines[0]!
    const run = line.run!.run
    const words = textExtent(line)
    expect(words.start).toBeGreaterThan(0)
    expect(words.end).toBeLessThan(run.total)
    // The empty arc is the gap that was asked for, and it straddles the seam.
    expect((run.total - (words.end - words.start)) / run.total).toBeCloseTo(0.2, 2)
    expect(words.start).toBeCloseTo(run.total - words.end, 0)
  })
})

/** Every coordinate pair in a path, which for glyph outlines is every corner. */
function pathPoints(path: string): Vec2[] {
  const numbers = (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
  const points: Vec2[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i] as number, y: numbers[i + 1] as number })
  }
  return points
}

/**
 * How far off the run a point sits, in the space the glyphs are placed in.
 *
 * The inverse of what `renderRunLine` and `ribbonPath` both do, so a number from
 * here is directly comparable with a band's `from` and `to`.
 */
function offsetFromRun(run: Run, point: Vec2): number {
  let nearest = 0
  let best = Infinity
  for (let i = 0; i < run.points.length; i++) {
    const q = run.points[i] as Vec2
    const d = (q.x - point.x) ** 2 + (q.y - point.y) ** 2
    if (d < best) {
      best = d
      nearest = i
    }
  }
  const n = run.points.length
  const a = run.points[(nearest - 1 + n) % n] as Vec2
  const b = run.points[(nearest + 1) % n] as Vec2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const c = run.points[nearest] as Vec2
  return -((point.x - c.x) * (dy / length) + (point.y - c.y) * (-dx / length))
}

/** Where a line's words actually begin and end along its run, in arc length. */
function textExtent(line: LayoutLine): { start: number; end: number } {
  const slots = line.slots
  const first = slots[0] as GlyphSlot
  const last = slots[slots.length - 1] as GlyphSlot
  const advance = measureUnitWidth(FONT_ID, line.characters[last.index] as string) * last.scaleX
  return { start: first.x - line.span.x0, end: last.x + advance - line.span.x0 }
}
