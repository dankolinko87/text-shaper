import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { measureRun, runAt, type Run } from '../../src/geometry/run'
import { buildSpiral, type Spiral } from '../../src/geometry/spiral'
import { createRunWarp } from '../../src/typography/runWarp'
import type { Vec2 } from '../../src/types/document'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)

let spiral: Spiral

beforeAll(async () => {
  await initClipper()
  // Padded like the fit pads it: the run is the baseline and the capitals stand
  // outward from it, so the outermost turn has to start a letter height inside
  // the drawn edge or they would cross it.
  spiral = buildSpiral({ shapePath: ELLIPSE, pitch: 60, padding: 60 })!
})

afterEach(() => {
  resetPaperScope()
})

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
/** The shape is centred on the origin, so distance from it is distance out. */
const fromCentre = (p: Vec2): number => Math.hypot(p.x, p.y)

const warp = (extra: Partial<Parameters<typeof createRunWarp>[0]> = {}) =>
  createRunWarp({ run: spiral, x0: 0, baseline: 0, ...extra })
/** The run itself, for asking where it goes. */
const w0 = (s: number): Vec2 => warp()(s, 0)

describe('bending a strip onto the run', () => {
  it('puts the baseline on the run itself', () => {
    const w = warp()
    for (const s of [0, 200, 900, spiral.total * 0.8]) {
      const expected = runAt(spiral, s).point
      expect(distance(w(s, 0), expected)).toBeLessThan(0.01)
    }
  })

  it('stands the capitals AWAY from the middle, so the type reads upright on top', () => {
    // Which side the type stands on is not a free choice: it follows from the
    // direction the turns are wound, and this is the side that reads.
    const w = warp()
    for (const s of [0, 400, 1200]) {
      const onLine = w(s, 0)
      const ascender = w(s, -40)
      expect(fromCentre(ascender)).toBeGreaterThan(fromCentre(onLine))
    }
  })

  it('never mirrors the letters, anywhere along the run', () => {
    /*
     * The regression this file exists for.
     *
     * The warp used to offer a "which side does the type stand on" option that
     * negated the normal, and negating the normal alone is a REFLECTION: the
     * whole run came out as mirror-writing. Handedness is what catches it —
     * every other property (the baseline is on the run, glyphs keep their
     * height, the run advances at the right rate) held perfectly while the text
     * was unreadable.
     *
     * The Jacobian determinant of a warp that turns without reflecting is +1.
     */
    const w = warp()
    const h = 0.05
    // Strictly inside the run: `runAt` clamps at both ends, so a difference
    // taken across an end measures the clamp and not the warp.
    for (let i = 0; i <= 200; i++) {
      const s = (i / 200) * (spiral.total - h)
      const at = w(s, 0)
      const along = w(s + h, 0)
      const up = w(s, h)
      const determinant =
        ((along.x - at.x) / h) * ((up.y - at.y) / h) - ((up.x - at.x) / h) * ((along.y - at.y) / h)
      expect(determinant, `mirrored at s=${s.toFixed(0)}`).toBeGreaterThan(0)
    }
  })

  it('runs left to right across the top of the shape', () => {
    // The other half of reading the right way up. Travelling the other way puts
    // the text backwards even though every letter is drawn correctly.
    let topAt = 0
    let topY = Infinity
    for (let i = 0; i <= 2000; i++) {
      const s = (i / 2000) * spiral.total
      const p = w0(s)
      if (p.y < topY) {
        topY = p.y
        topAt = s
      }
    }
    expect(w0(topAt + 20).x).toBeGreaterThan(w0(topAt).x)
  })

  it('keeps a glyph its own height', () => {
    // The warp bends the strip; it must not stretch or shrink it. A letter
    // that grew as it travelled would ruin the fit the packer just solved.
    const w = warp()
    for (const s of [0, 500, 1500, spiral.total * 0.6]) {
      expect(distance(w(s, 0), w(s, -50))).toBeCloseTo(50, 3)
    }
  })

  it('advances along the run at the rate the strip says', () => {
    // What lets the packer treat the run as a plain horizontal span: 20 units
    // along the strip has to be 20 units along the spiral.
    const w = warp()
    for (const s of [100, 800, 2000]) {
      expect(distance(w(s, 0), w(s + 20, 0))).toBeGreaterThan(19)
      expect(distance(w(s, 0), w(s + 20, 0))).toBeLessThan(21)
    }
  })

  it('rotates the letters to follow the curve', () => {
    // The reason glyph rotation needs no code of its own. A vertical stroke in
    // the strip comes out pointing along the run's normal, which turns as the
    // run turns — so on opposite sides of the shape it points opposite ways.
    const w = warp()
    const direction = (s: number): Vec2 => {
      const a = w(s, 0)
      const b = w(s, -30)
      return { x: (b.x - a.x) / 30, y: (b.y - a.y) / 30 }
    }
    const first = direction(50)
    const halfway = direction(spiral.total / 12)
    const dot = first.x * halfway.x + first.y * halfway.y
    expect(dot).toBeLessThan(0.9)
  })

  it('keeps letters vertical when asked', () => {
    // Upright mode: the position follows the run but the letterforms do not
    // turn, so a vertical stroke stays vertical wherever it lands.
    const w = warp({ upright: true })
    for (const s of [0, 700, 1800]) {
      const a = w(s, 0)
      const b = w(s, -30)
      expect(b.x).toBeCloseTo(a.x, 6)
      expect(b.y).toBeCloseTo(a.y - 30, 6)
    }
  })

  it('shifts the type off its line when asked', () => {
    const plain = warp()
    const lifted = warp({ baselineShift: 12 })
    const onLine = plain(600, 0)
    // Lifting is in the same direction the capitals stand, which is away from
    // the middle of the shape.
    expect(fromCentre(lifted(600, 0))).toBeGreaterThan(fromCentre(onLine))
    expect(distance(lifted(600, 0), onLine)).toBeCloseTo(12, 3)
  })

  it('emits finite points everywhere, including past both ends', () => {
    // The run has two ends. A character pushed past one — which rounding at the
    // very start or end can do — must land somewhere real.
    const w = warp()
    for (const s of [-500, -1, 0, spiral.total, spiral.total + 500]) {
      for (const y of [-80, 0, 30]) {
        const p = w(s, y)
        expect(Number.isFinite(p.x), `${s},${y}`).toBe(true)
        expect(Number.isFinite(p.y), `${s},${y}`).toBe(true)
      }
    }
  })

  it('never places type outside the shape it came from', () => {
    // The capitals stand outward from the run, so what keeps them inside the
    // outline is the padding on the outermost turn rather than the normal.
    const w = warp()
    for (let i = 0; i <= 300; i++) {
      const s = (i / 300) * spiral.total
      const top = w(s, -40)
      expect(Math.abs(top.x)).toBeLessThan(345)
      expect(Math.abs(top.y)).toBeLessThan(305)
    }
  })
})

/** A line drawn as a squiggle: five crests in seven hundred units. */
function squiggle(amplitude = 60, waves = 2, length = 700): Run {
  const points: Vec2[] = []
  const steps = 700
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    points.push({ x: u * length, y: Math.sin(u * Math.PI * 2 * waves) * amplitude })
  }
  return measureRun(points) as Run
}

/** How the map turns a small square, at one point of the strip. */
function determinant(w: (x: number, y: number) => Vec2, s: number, y: number): number {
  const h = 0.05
  const at = w(s, y)
  const along = w(s + h, y)
  const up = w(s, y + h)
  return (
    ((along.x - at.x) / h) * ((up.y - at.y) / h) - ((up.x - at.x) / h) * ((along.y - at.y) / h)
  )
}

describe('bending a strip onto a run that turns tighter than the type is tall', () => {
  /*
   * A shape cannot do this and a drawn line can, which is why it went unnoticed
   * until there were lines to draw.
   *
   * Type on a lap or a spiral stands on the OUTSIDE of every turn — between the
   * run and the outline the run was inset from — and the outside of a turn has
   * no centre to fall into, however tight it is. A line the user drew turns both
   * ways beneath the same sentence, so half its letters lean inward, and where
   * it doubles back tighter than they are tall they pass through the centre of
   * the turn and come out as shards.
   */
  const RUN = squiggle()
  const REACH = 100
  const tight = createRunWarp({ run: RUN, x0: 0, baseline: 0, reach: REACH })

  it('is a run this really can happen on', () => {
    /*
     * Not an assertion about the code — about the fixture. The rest of this
     * block is worth nothing if the squiggle turns gently enough that no
     * reasonable map would fold on it, so the plain offset of it is measured
     * here and it does fold: pushing the outline out along the normal turns it
     * inside out somewhere.
     */
    /** The run pushed out along its own normal, with nothing held back. */
    const plain = (t: number, h: number): Vec2 => {
      const { point, tangent } = runAt(RUN, t)
      return { x: point.x + tangent.y * h, y: point.y - tangent.x * h }
    }

    let worst = Infinity
    for (let i = 0; i <= 400; i++) {
      const s = (i / 400) * RUN.total
      worst = Math.min(worst, determinant((x, y) => plain(x, -y), s, -REACH))
    }
    expect(worst).toBeLessThan(0)
  })

  it('never turns a letter inside out, anywhere across the strip', () => {
    for (let i = 0; i <= 400; i++) {
      const s = (i / 400) * (RUN.total - 0.1)
      for (let y = -REACH; y <= REACH; y += REACH / 8) {
        expect(determinant(tight, s, y), `folded at s=${s.toFixed(0)} y=${y.toFixed(0)}`)
          .toBeGreaterThan(0)
      }
    }
  })

  it('does it by holding the far side of the letter back, not by moving the line', () => {
    // The baseline is untouched wherever it runs — a point ON the run is not
    // leaning into anything — and the ink above it is pulled in only where the
    // run turns toward it.
    let held = 0
    for (let i = 0; i <= 400; i++) {
      const s = (i / 400) * RUN.total
      const on = runAt(RUN, s).point
      const base = tight(s, 0)
      expect(Math.hypot(base.x - on.x, base.y - on.y), `baseline moved at ${s.toFixed(0)}`)
        .toBeLessThan(0.01)

      const off = tight(s, -REACH)
      held = Math.max(held, 1 - Math.hypot(off.x - on.x, off.y - on.y) / REACH)
    }
    // Somewhere on the squiggle the ink is pulled in by a good part of its reach.
    expect(held).toBeGreaterThan(0.2)
  })

  it('leaves type standing on the outside of a turn exactly where it was', () => {
    /*
     * The other half of the guard, and the half that keeps every ring and spiral
     * in the tool drawing what it drew before: on the side that curves AWAY,
     * nothing is held at all, and the answer is the plain offset to the last
     * decimal rather than nearly it.
     */
    const w = warp()
    for (let i = 0; i <= 300; i++) {
      const s = (i / 300) * spiral.total
      for (const y of [-10, -40, -80]) {
        /*
         * Asked by DISTANCE, which is exactly the question and needs no
         * reference map to compare against. Holding a point back only ever
         * shortens how far off the run it stands; it never turns it. So the
         * distance from the run being the height that was asked for, to the last
         * decimal a float carries, is the statement that nothing was held.
         */
        const height = -y
        const reached = distance(w(s, y), runAt(spiral, s).point)
        expect(Math.abs(reached - height) / height, `held at s=${s.toFixed(0)} y=${y}`).toBeLessThan(
          1e-9,
        )
      }
    }
  })
})
