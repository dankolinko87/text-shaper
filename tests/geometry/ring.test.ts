import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { buildRing, startAtAngle } from '../../src/geometry/ring'
import { measureRun, ribbonPath, runAt } from '../../src/geometry/run'
import type { Vec2 } from '../../src/types/document'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const RECTANGLE = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600)
const BLOB = smoothPath(
  'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
)

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('a lap around a shape', () => {
  it('closes, so there is no seam to fall off', () => {
    /*
     * The difference between a lap and a spiral, and not a cosmetic one. On an
     * open run anything pushed past the end piles up at it, which collapses a
     * glyph to a spike; a lap comes round again instead.
     */
    const ring = buildRing({ shapePath: ELLIPSE, inset: 40 })!
    expect(ring.closed).toBe(true)

    const start = runAt(ring, 0)
    const round = runAt(ring, ring.total)
    expect(distance(start.point, round.point)).toBeLessThan(0.01)

    // Past the end is back at the beginning, not stuck against it.
    const past = runAt(ring, ring.total + 25)
    expect(distance(past.point, runAt(ring, 25).point)).toBeLessThan(0.01)
    // ...and the heading comes round with it, rather than freezing.
    expect(past.tangent.x).toBeCloseTo(runAt(ring, 25).tangent.x, 6)
  })

  it('shrinks going in and grows going out', () => {
    // The band control is a signed offset, and the clipper offsets both ways.
    const inside = buildRing({ shapePath: ELLIPSE, inset: 60 })!
    const on = buildRing({ shapePath: ELLIPSE, inset: 0 })!
    const outside = buildRing({ shapePath: ELLIPSE, inset: -60 })!
    expect(inside.total).toBeLessThan(on.total)
    expect(outside.total).toBeGreaterThan(on.total)
  })

  it('refuses a lap that has folded rather than handing one back', () => {
    // Offset far enough in and the outline self-intersects; the clipper leaves a
    // cusp where the crossing was, and type drawn through a cusp folds over
    // itself. The fit reads null as "back off to a smaller size".
    expect(buildRing({ shapePath: ELLIPSE, inset: 400 })).toBeNull()
  })

  it('begins the lap at the side of the shape, not at a corner', () => {
    /*
     * A lap has no beginning of its own — the one it arrives with is wherever
     * the offsetter happened to start the path, which is a different angle on
     * every shape. That does not matter until the line has to BREAK somewhere,
     * and then it matters entirely: the break is where a reader looks for the
     * start of the words.
     *
     * On anything with a flat side the whole edge shares the extreme x, so the
     * sample nearest the shape's own middle height is taken. Landing on a corner
     * would start the line on one.
     */
    for (const [label, shape] of [
      ['ellipse', ELLIPSE],
      ['rectangle', RECTANGLE],
      ['blob', BLOB],
    ] as const) {
      const ring = buildRing({ shapePath: shape, inset: 40 })!
      const turned = startAtAngle(ring, 270)
      expect(turned, label).not.toBeNull()
      if (!turned) continue

      // Still a loop: nothing was cut, only rotated.
      expect(turned.closed, label).toBe(true)
      expect(turned.total, label).toBeCloseTo(ring.total, 6)
      expect(turned.points.length, label).toBe(ring.points.length)

      const start = turned.points[0] as Vec2
      const xs = ring.points.map((p) => p.x)
      const ys = ring.points.map((p) => p.y)
      const width = Math.max(...xs) - Math.min(...xs)
      const middleY = (Math.max(...ys) + Math.min(...ys)) / 2
      // On the left edge...
      expect(start.x, `${label} x`).toBeLessThan(Math.min(...xs) + width * 0.03)
      // ...and half way down it, rather than at either corner.
      expect(Math.abs(start.y - middleY), `${label} y`).toBeLessThan(width * 0.05)
    }
  })

  /*
   * The whole point of the control: the break goes where it is asked for, on
   * every shape, including the ones whose flat sides used to need a special
   * case of their own.
   */
  it('starts the lap at whatever bearing it is given', () => {
    for (const [label, shape] of [
      ['ellipse', ELLIPSE],
      ['rectangle', RECTANGLE],
      ['blob', BLOB],
    ] as const) {
      const ring = buildRing({ shapePath: shape, inset: 40 })!
      const xs = ring.points.map((p) => p.x)
      const ys = ring.points.map((p) => p.y)
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2

      for (const want of [0, 45, 90, 180, 270, 315]) {
        const turned = startAtAngle(ring, want)
        expect(turned, `${label} ${want}`).not.toBeNull()
        if (!turned) continue

        const start = turned.points[0] as Vec2
        const got = ((Math.atan2(start.x - cx, -(start.y - cy)) * 180) / Math.PI + 360) % 360
        const off = Math.abs(((got - want + 540) % 360) - 180)
        /*
         * Within a couple of degrees. The lap is a polyline, so the break lands
         * on the nearest SAMPLE to the bearing rather than exactly on it — and
         * that is right: a break between samples would need the loop cut, and
         * nothing here cuts it.
         */
        expect(off, `${label} at ${want}° landed at ${got.toFixed(1)}°`).toBeLessThan(2)
      }
    }
  })

  it('turns the whole loop rather than cutting it, at any bearing', () => {
    const ring = buildRing({ shapePath: BLOB, inset: 40 })!
    for (const want of [0, 120, 200, 359]) {
      const turned = startAtAngle(ring, want)!
      expect(turned.closed, `${want}`).toBe(true)
      expect(turned.total, `${want}`).toBeCloseTo(ring.total, 6)
      expect(turned.points.length, `${want}`).toBe(ring.points.length)
    }
  })

  it('takes a bearing outside a full turn as the same place', () => {
    // A slider that wraps should not be a slider that breaks.
    const ring = buildRing({ shapePath: ELLIPSE, inset: 40 })!
    const plain = startAtAngle(ring, 90)!
    for (const same of [450, -270, 810]) {
      expect((startAtAngle(ring, same)!.points[0] as Vec2), `${same}`).toEqual(
        plain.points[0] as Vec2,
      )
    }
  })

  it('winds up over the top from there, which is the readable half', () => {
    // Clockwise on screen, so the first thing the words do is climb the left
    // side and cross the top the right way up.
    const ring = buildRing({ shapePath: ELLIPSE, inset: 40 })!
    const turned = startAtAngle(ring, 270)!
    const early = runAt(turned, turned.total * 0.15).point
    expect(early.y).toBeLessThan((turned.points[0] as Vec2).y)
  })

  it('leaves the middle of a lap open, and closes a cut one', () => {
    /*
     * The two shapes a band comes in, and the difference is what has to be
     * closed. A whole lap is an annulus — an outer loop with the inner one
     * reversed, so `nonzero` fill leaves the shape's middle open instead of
     * flooding it. Anything cut to its text is a strip with two square ends,
     * one loop, whatever run it came off.
     */
    const lap = buildRing({ shapePath: ELLIPSE, inset: 40 })
    expect(lap).toBeTruthy()
    if (!lap) return

    const whole = ribbonPath(lap, { from: -30, to: 10 })
    expect(whole.match(/M/g)).toHaveLength(2)

    const cut = ribbonPath(lap, { from: -30, to: 10, start: 0, end: lap.total / 2 })
    expect(cut.match(/M/g)).toHaveLength(1)
    // Half the lap, so roughly half the corners, plus the two interpolated ends.
    expect(cut.match(/L/g)!.length).toBeLessThan(whole.match(/L/g)!.length)
  })

  it('starts and ends a cut band exactly where it was asked to', () => {
    /*
     * Interpolated rather than snapped to the nearest sample. A band that ended
     * at whichever sample happened to be closest would step in and out by up to
     * half a sample as the text was edited.
     */
    const lap = buildRing({ shapePath: ELLIPSE, inset: 40 })
    if (!lap) return

    const start = lap.total * 0.137
    const end = lap.total * 0.611
    // Zero height, so both edges of the strip lie on the run itself and the
    // path's own corners are directly comparable with it.
    const path = ribbonPath(lap, { from: 0, to: 1e-9, start, end })
    const numbers = (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    const first = { x: numbers[0] as number, y: numbers[1] as number }

    const wanted = runAt(lap, start).point
    expect(Math.hypot(first.x - wanted.x, first.y - wanted.y)).toBeLessThan(0.05)
  })

  it('refuses a band with nothing to draw', () => {
    const run = measureRun([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ])!
    expect(ribbonPath(run, { from: 10, to: 10 })).toBe('')
    expect(ribbonPath(run, { from: -10, to: 10, start: 50, end: 50 })).toBe('')
  })
})

