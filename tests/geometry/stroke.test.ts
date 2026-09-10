import { describe, expect, it } from 'vitest'

import {
  blendStroke,
  dashArrayFor,
  sameStroke,
  strokeBand,
  strokePaint,
  strokeReach,
} from '../../src/geometry/stroke'
import { alphaOf } from '../../src/typography/colour'
import type { PositionedStroke, Stroke } from '../../src/types/document'

const solid = (over: Partial<PositionedStroke> = {}): PositionedStroke => ({
  colour: '#101014ff',
  width: 10,
  position: 'centre',
  dash: null,
  ...over,
})

describe('how far a border reaches outside its path', () => {
  /*
   * The whole point of this function is that two callers cannot disagree about
   * it — the group's bounds on the canvas, and the frame an export composes
   * into. Both crop the artwork if they get it wrong.
   */
  it('is nothing inside, half the width centred, and the whole width outside', () => {
    expect(strokeReach(solid({ position: 'inside' })), 'inside takes its width out of the shape').toBe(0)
    expect(strokeReach(solid({ position: 'centre' }))).toBe(5)
    expect(strokeReach(solid({ position: 'outside' }))).toBe(10)
  })

  it('is nothing at all without a border, or with one of no width', () => {
    expect(strokeReach(null)).toBe(0)
    expect(strokeReach(solid({ width: 0, position: 'outside' }))).toBe(0)
  })

  it('treats a border with no position of its own as centred', () => {
    const plain: Stroke = { colour: '#000000ff', width: 8, dash: null }
    expect(strokeReach(plain)).toBe(4)
  })
})

describe('turning a position into a stroke', () => {
  /*
   * Canvas only strokes down the centre, so inside and outside are one centred
   * stroke at DOUBLE width with half of it clipped away. If this ever stops
   * doubling, a border renders at half the width asked for.
   */
  it('doubles the width and asks for a clip, except in the middle', () => {
    expect(strokePaint(solid({ position: 'centre' }))).toEqual({ width: 10, clip: 'none' })
    expect(strokePaint(solid({ position: 'inside' }))).toEqual({ width: 20, clip: 'inside' })
    expect(strokePaint(solid({ position: 'outside' }))).toEqual({ width: 20, clip: 'outside' })
  })
})

describe('the dash pattern', () => {
  it('is null for a solid border, not an empty array', () => {
    // Fabric and canvas both read null as "solid"; an empty array is a pattern
    // with no segments, which some implementations draw as nothing at all.
    expect(dashArrayFor(solid())).toBeNull()
    expect(dashArrayFor(null)).toBeNull()
  })

  it('is the dash and the gap, in that order', () => {
    expect(dashArrayFor(solid({ dash: { length: 8, gap: 4 } }))).toEqual([8, 4])
  })

  it('refuses a dash of no length, which would draw nothing', () => {
    expect(dashArrayFor(solid({ dash: { length: 0, gap: 4 } }))).toBeNull()
  })
})

describe('one border on the way to another', () => {
  const red: Stroke = { colour: '#ff0000ff', width: 4, dash: null }
  const blue: Stroke = { colour: '#0000ffff', width: 12, dash: null }

  it('carries the colour and the width together', () => {
    const half = blendStroke(red, blue, 0.5)
    expect(half?.width).toBe(8)
    expect(half?.colour).not.toBe(red.colour)
    expect(half?.colour).not.toBe(blue.colour)
  })

  it('fades a border that is not there yet, rather than popping it in', () => {
    /*
     * The rule the backdrop already follows: a border that is not there is not
     * a border of zero width, it is a border of no colour. Appearing at full
     * weight on the first frame of a transition is what this prevents.
     */
    const arriving = blendStroke(null, blue, 0.25)
    expect(arriving?.width, 'at the width it will have').toBe(12)
    expect(alphaOf(arriving!.colour), 'a quarter of the way in').toBeCloseTo(0.25, 1)

    const leaving = blendStroke(red, null, 0.75)
    expect(leaving?.width).toBe(4)
    expect(alphaOf(leaving!.colour), 'three quarters gone').toBeCloseTo(0.25, 1)
  })

  it('reaches each end exactly', () => {
    /*
     * Compared through `alphaOf` and the width rather than by string equality:
     * `mixColours` normalises a fully opaque colour from `#ff0000ff` to
     * `#ff0000`, which is the same colour spelled shorter. Asserting the
     * spelling would be testing the colour helper, not this.
     */
    const start = blendStroke(red, blue, 0)
    expect(start?.width).toBe(red.width)
    expect(alphaOf(start!.colour)).toBe(1)
    expect(start!.colour.slice(0, 7)).toBe('#ff0000')

    const end = blendStroke(red, blue, 1)
    expect(end?.width).toBe(blue.width)
    expect(end!.colour.slice(0, 7)).toBe('#0000ff')
  })

  it('is nothing when neither end has one', () => {
    expect(blendStroke(null, null, 0.5)).toBeNull()
  })

  it('cuts the dash pattern rather than crawling it', () => {
    // Two rhythms are not two positions of one rhythm; interpolating them would
    // walk the dashes through lengths nobody chose.
    const dashed: Stroke = { ...red, dash: { length: 10, gap: 2 } }
    const other: Stroke = { ...blue, dash: { length: 2, gap: 10 } }
    expect(blendStroke(dashed, other, 0.4)?.dash).toEqual({ length: 10, gap: 2 })
    expect(blendStroke(dashed, other, 0.6)?.dash).toEqual({ length: 2, gap: 10 })
  })
})

describe('whether two borders are the same border', () => {
  /*
   * This is what stops a mosaic edit carrying forward over a state that has
   * been given an edge of its own — see `sameGeometry`.
   */
  it('counts every field that shows', () => {
    const base: Stroke = { colour: '#112233ff', width: 3, dash: { length: 6, gap: 2 } }
    expect(sameStroke(base, { ...base })).toBe(true)
    expect(sameStroke(base, { ...base, colour: '#112234ff' })).toBe(false)
    expect(sameStroke(base, { ...base, width: 4 })).toBe(false)
    expect(sameStroke(base, { ...base, dash: { length: 6, gap: 3 } })).toBe(false)
    expect(sameStroke(base, { ...base, dash: null })).toBe(false)
  })

  it('counts the position, which is a different band in the same place', () => {
    /*
     * Left out, this was wrong twice over: a store refusing a position change
     * as "no change", and two states called copies when one bordered inside and
     * the other outside — so an edit carrying forward would overwrite one
     * somebody had authored.
     */
    const inside = solid({ position: 'inside' })
    expect(sameStroke(inside, solid({ position: 'inside' }))).toBe(true)
    expect(sameStroke(inside, solid({ position: 'centre' }))).toBe(false)
    expect(sameStroke(inside, solid({ position: 'outside' }))).toBe(false)
    // A border with no position of its own is centred, and reads as centred.
    const plain: Stroke = { colour: solid().colour, width: solid().width, dash: null }
    expect(sameStroke(plain, solid({ position: 'centre' }))).toBe(true)
  })

  it('tells no border apart from any border', () => {
    expect(sameStroke(null, null)).toBe(true)
    expect(sameStroke(null, { colour: '#000000ff', width: 1, dash: null })).toBe(false)
  })
})

describe('the band a rounded rectangle borders', () => {
  /*
   * A rounded rect can be offset by arithmetic — inflate it by d and raise its
   * radius by d and you have the same curve moved outward — so the mosaic gets
   * its three positions without a clip at all. The radius moving WITH the box
   * is the part that matters: leave it alone and the corners stop being
   * concentric, which shows as a band that thickens at the corners.
   */
  const BOX = { x: -50, y: -50, width: 100, height: 100 }

  it('leaves a centred band exactly where the curve is', () => {
    const band = strokeBand(BOX, 20, solid({ width: 10, position: 'centre' }))
    expect(band.box).toEqual(BOX)
    expect(band.radius).toBe(20)
  })

  it('pulls an inside band in by half its width, radius and all', () => {
    const band = strokeBand(BOX, 20, solid({ width: 10, position: 'inside' }))
    expect(band.box).toEqual({ x: -45, y: -45, width: 90, height: 90 })
    expect(band.radius, 'concentric with the outline it follows').toBe(15)
  })

  it('pushes an outside band out by half its width, radius and all', () => {
    const band = strokeBand(BOX, 20, solid({ width: 10, position: 'outside' }))
    expect(band.box).toEqual({ x: -55, y: -55, width: 110, height: 110 })
    expect(band.radius).toBe(25)
  })

  it('never takes a radius or a box below nothing', () => {
    // A border wider than the corner it rounds, on a shape smaller than itself.
    const band = strokeBand(BOX, 2, solid({ width: 400, position: 'inside' }))
    expect(band.radius).toBe(0)
    expect(band.box.width).toBe(0)
    expect(band.box.height).toBe(0)
  })

  it('agrees with `strokeReach` about how far out it goes', () => {
    for (const position of ['inside', 'centre', 'outside'] as const) {
      const stroke = solid({ width: 12, position })
      const band = strokeBand(BOX, 20, stroke)
      // The band's own outer edge is its box plus half the stroke it is drawn
      // with — and that has to be the number the clip and the export frame use.
      const outerEdge = (band.box.width - BOX.width) / 2 + stroke.width / 2
      expect(outerEdge, position).toBeCloseTo(strokeReach(stroke), 9)
    }
  })
})
