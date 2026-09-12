import { describe, expect, it } from 'vitest'

import { gradientEnds, sameFillPaint, stopColourAt, type FillPaint } from '../../src/typography/colour'
import {
  blendPaint,
  collectAssetIds,
  fadedPaint,
  gradientAt,
  paintKey,
  paintMoves,
  paintOfKind,
  resolvePaint,
  samePaint,
  solidOf,
  unifyStops,
} from '../../src/typography/paint'
import type { DocumentObject } from '../../src/types/document'
import type { GradientPaint, ImagePaint, Paint } from '../../src/types/paint'

/**
 * One paint for every fill: told apart, compared, blended between states and
 * resolved for a moment of the loop, the same way wherever it is used.
 */

const NEAR_BLACK = '#101014'
const WARM = '#e0552f'

const gradient = (patch: Partial<GradientPaint> = {}): GradientPaint => ({
  kind: 'gradient',
  shape: 'linear',
  stops: [
    { at: 0, colour: NEAR_BLACK },
    { at: 1, colour: WARM },
  ],
  angle: 0,
  ...patch,
})
const picture = (patch: Partial<ImagePaint> = {}): ImagePaint => ({
  kind: 'image',
  asset: 'img_a',
  crop: { scale: 1, x: 0, y: 0 },
  ...patch,
})

/** The blend fraction at a point of the box, as the painters compute it. */
function blendAt(paint: FillPaint, x: number, y: number): number {
  if (paint.kind !== 'gradient') return 0
  if (paint.shape === 'radial') {
    const away = Math.hypot(x - paint.centre.x, y - paint.centre.y)
    return Math.min(1, away / Math.max(1e-6, paint.radius * Math.SQRT1_2))
  }
  const e = gradientEnds(paint.angle, paint.offset, paint.spread)
  const dx = e.x2 - e.x1
  const dy = e.y2 - e.y1
  const length = dx * dx + dy * dy || 1
  return Math.min(1, Math.max(0, ((x - e.x1) * dx + (y - e.y1) * dy) / length))
}

describe('telling paints apart', () => {
  it('compares by what would draw, whatever the kind', () => {
    expect(samePaint('#ff0000', '#ff0000')).toBe(true)
    expect(samePaint('#ff0000', '#ff0001')).toBe(false)
    expect(samePaint(null, null)).toBe(true)
    expect(samePaint(null, '#ff0000')).toBe(false)
    expect(samePaint(gradient(), gradient())).toBe(true)
    expect(samePaint(gradient(), gradient({ angle: 1 }))).toBe(false)
    expect(samePaint(gradient(), gradient({ motion: 'sweep' }))).toBe(false)
    expect(samePaint(gradient(), '#101014')).toBe(false)
    expect(samePaint(picture(), picture())).toBe(true)
    expect(samePaint(picture(), picture({ crop: { scale: 2, x: 0, y: 0 } }))).toBe(false)
    expect(samePaint(picture(), picture({ opacity: 0.5 }))).toBe(false)
  })

  it('has a key that differs exactly when the paint does', () => {
    expect(paintKey('#ff0000')).toBe('#ff0000')
    expect(paintKey(null)).toBe('none')
    expect(paintKey(gradient())).toBe(paintKey(gradient()))
    expect(paintKey(gradient())).not.toBe(paintKey(gradient({ shape: 'radial' })))
    expect(paintKey(picture())).not.toBe(paintKey(picture({ asset: 'img_b' })))
  })

  it('moves only as a gradient with a motion', () => {
    expect(paintMoves('#ff0000')).toBe(false)
    expect(paintMoves(gradient())).toBe(false)
    expect(paintMoves(gradient({ motion: 'still' }))).toBe(false)
    expect(paintMoves(gradient({ motion: 'hover' }))).toBe(true)
    expect(paintMoves(picture())).toBe(false)
  })

  it('answers as one colour for a swatch', () => {
    expect(solidOf('#123456')).toBe('#123456')
    expect(solidOf(gradient())).toBe(NEAR_BLACK)
    expect(solidOf(gradient({ stops: [{ at: 1, colour: WARM }, { at: 0, colour: '#000000' }] }))).toBe('#000000')
    expect(solidOf(null)).toBe('#101014')
  })
})

describe('changing kind', () => {
  it('keeps what it can: a colour becomes a gradient from itself, and back', () => {
    const asGradient = paintOfKind('gradient', '#336699')
    expect(asGradient).toEqual(gradient({ stops: [{ at: 0, colour: '#336699' }, { at: 1, colour: WARM }] }))
    expect(paintOfKind('solid', asGradient)).toBe('#336699')
    expect(paintOfKind('gradient', gradient({ angle: 30 })), 'a gradient stays itself').toEqual(gradient({ angle: 30 }))
    expect(paintOfKind('solid', null)).toBeNull()
  })

  it('needs a picture to become one', () => {
    expect(paintOfKind('image', '#336699')).toBeNull()
    expect(paintOfKind('image', '#336699', 'img_a')).toEqual(picture())
    expect(paintOfKind('image', picture({ opacity: 0.5 }), 'img_b')).toEqual(picture({ asset: 'img_b', opacity: 0.5 }))
  })

  it('fades to nothing of itself', () => {
    expect(fadedPaint('#ff0000')).toBe('#ff000000')
    const faded = fadedPaint(gradient()) as GradientPaint
    expect(faded.stops.every((stop) => stop.colour.endsWith('00'))).toBe(true)
    expect((fadedPaint(picture()) as ImagePaint).opacity).toBe(0)
  })
})

describe('blending paints', () => {
  it('returns each end as it is', () => {
    const a = gradient()
    const b = picture()
    expect(blendPaint(a, b, 0)).toBe(a)
    expect(blendPaint(a, b, 1)).toBe(b)
    expect(blendPaint(null, null, 0.5)).toBeNull()
  })

  it('fades a fill in from, and out to, itself at zero alpha', () => {
    const arriving = blendPaint(null, '#ff0000', 0.5) as string
    expect(arriving.slice(0, 7)).toBe('#ff0000')
    expect(arriving.length).toBe(9)
    const leaving = blendPaint(gradient(), null, 0.5) as GradientPaint
    expect(leaving.kind).toBe('gradient')
    expect(leaving.stops[0]!.colour.slice(0, 7)).toBe(NEAR_BLACK)
    const going = blendPaint(picture(), null, 0.25) as ImagePaint
    expect(going.opacity).toBeCloseTo(0.75, 9)
  })

  it('blends two colours as colours', () => {
    expect(blendPaint('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('blends a colour into a gradient by making the colour a gradient first', () => {
    const half = blendPaint('#000000', gradient({ stops: [{ at: 0, colour: '#000000' }, { at: 1, colour: '#ffffff' }] }), 0.5)
    expect(typeof half).toBe('object')
    const g = half as GradientPaint
    expect(g.stops.map((s) => s.colour)).toEqual(['#000000', '#808080'])
    // The other way round, too.
    const back = blendPaint(gradient({ stops: [{ at: 0, colour: '#000000' }, { at: 1, colour: '#ffffff' }] }), '#000000', 0.5) as GradientPaint
    expect(back.stops.map((s) => s.colour)).toEqual(['#000000', '#808080'])
  })

  it('blends two gradients stop by stop, adding stops that change nothing', () => {
    const a = gradient({ stops: [{ at: 0, colour: '#000000' }, { at: 1, colour: '#ffffff' }], angle: 350 })
    const b = gradient({
      stops: [
        { at: 0, colour: '#000000' },
        { at: 0.5, colour: '#ff0000' },
        { at: 1, colour: '#ffffff' },
      ],
      angle: 10,
    })
    const [ua, ub] = unifyStops(a.stops, b.stops)
    expect(ua.map((s) => s.at)).toEqual([0, 0.5, 1])
    expect(ub.map((s) => s.at)).toEqual([0, 0.5, 1])
    // A's picture is unchanged by its new stop.
    expect(stopColourAt(ua, 0.25)).toBe(stopColourAt(a.stops, 0.25))
    expect(stopColourAt(ua, 0.5)).toBe(stopColourAt(a.stops, 0.5))

    const half = blendPaint(a, b, 0.5) as GradientPaint
    expect(half.stops.map((s) => s.at)).toEqual([0, 0.5, 1])
    expect(half.stops[1]!.colour).toBe('#c04040')
    expect(half.angle, 'the short way round through zero').toBe(0)
  })

  it('blends two crops of the same picture, and cuts between different ones', () => {
    const a = picture({ crop: { scale: 1, x: 0, y: 0 } })
    const b = picture({ crop: { scale: 3, x: 0.2, y: -0.4 }, opacity: 0.5 })
    const half = blendPaint(a, b, 0.5) as ImagePaint
    expect(half.crop).toEqual({ scale: 2, x: 0.1, y: -0.2 })
    expect(half.opacity).toBeCloseTo(0.75, 9)
    const other = picture({ asset: 'img_b' })
    expect(blendPaint(a, other, 0.4)).toBe(a)
    expect(blendPaint(a, other, 0.6)).toBe(other)
  })

  it('cuts at the midpoint between kinds that have nothing in between', () => {
    const linear = gradient()
    const radial = gradient({ shape: 'radial' })
    expect(blendPaint(linear, radial, 0.49)).toBe(linear)
    expect(blendPaint(linear, radial, 0.51)).toBe(radial)
    expect(blendPaint(picture(), '#ff0000', 0.3)).toEqual(picture())
    expect(blendPaint(picture(), '#ff0000', 0.7)).toBe('#ff0000')
  })
})

describe('resolving a paint for a moment', () => {
  it('is nothing for nothing, a solid for a colour, itself for a picture', () => {
    expect(resolvePaint(null, 0.3)).toBeNull()
    expect(resolvePaint('#ff0000', 0.3)).toEqual({ kind: 'solid', colour: '#ff0000' })
    expect(resolvePaint(picture({ opacity: 0.5 }), 0.3)).toEqual({
      kind: 'image',
      asset: 'img_a',
      crop: { scale: 1, x: 0, y: 0 },
      opacity: 0.5,
    })
    expect((resolvePaint(picture(), 0) as { opacity: number }).opacity, 'absent is one').toBe(1)
  })

  it('paints unsorted stops in order, and clamps a stray position', () => {
    const paint = gradientAt(gradient({ stops: [{ at: 1.4, colour: '#ffffff' }, { at: 0, colour: '#000000' }] }), 0)
    expect(paint.kind === 'gradient' && paint.stops.map((stop) => stop.at)).toEqual([0, 1])
  })

  it('blends through every stop in order, along the axis', () => {
    const stops = [
      { at: 0, colour: '#000000' },
      { at: 0.5, colour: '#ff0000' },
      { at: 1, colour: '#ffffff' },
    ]
    const paint = gradientAt(gradient({ stops }), 0)
    if (paint.kind !== 'gradient') throw new Error('expected a gradient')
    const at = (x: number) => stopColourAt(paint.stops, blendAt(paint, x, 0.5))
    expect(at(0)).toBe('#000000')
    expect(at(0.25)).toBe('#800000')
    expect(at(0.75)).toBe('#ff8080')
    expect(at(1)).toBe('#ffffff')
  })

  it('is still unless a motion is asked for', () => {
    for (const shape of ['linear', 'radial'] as const) {
      const paint = gradient({ shape, angle: 45 })
      for (const phase of [0.25, 0.5, 0.75, 1]) {
        expect(sameFillPaint(gradientAt(paint, 0), gradientAt(paint, phase)), `${shape} at ${phase}`).toBe(true)
      }
    }
  })

  it('holds the angle it was given, at every angle', () => {
    for (const angle of [0, 45, 120, 300]) {
      const paint = gradientAt(gradient({ angle }), 0)
      if (paint.kind !== 'gradient' || paint.shape !== 'linear') throw new Error('expected linear')
      expect(paint.angle).toBeCloseTo(angle, 9)
    }
  })

  it('moves when a motion is asked for, and comes back', () => {
    for (const shape of ['linear', 'radial'] as const) {
      for (const motion of ['sweep', 'hover', 'pulse'] as const) {
        const paint = gradient({ shape, motion, travel: 1 })
        const start = gradientAt(paint, 0)
        const moved = [0.25, 0.5, 0.75].some((phase) => !sameFillPaint(start, gradientAt(paint, phase)))
        expect(moved, `${shape}/${motion} never moves`).toBe(true)
        expect(sameFillPaint(start, gradientAt(paint, 1)), `${shape}/${motion} does not close`).toBe(true)
      }
    }
  })

  it('starts every motion at rest, so switching one on changes nothing yet', () => {
    for (const shape of ['linear', 'radial'] as const) {
      const still = gradientAt(gradient({ shape }), 0)
      for (const motion of ['sweep', 'hover', 'pulse'] as const) {
        expect(sameFillPaint(still, gradientAt(gradient({ shape, motion, travel: 1 }), 0)), `${shape}/${motion}`).toBe(true)
      }
    }
  })

  it('moves the picture enough to see, whichever motion is chosen', () => {
    const grid: [number, number][] = []
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) grid.push([i / 6, j / 6])
    for (const shape of ['linear', 'radial'] as const) {
      for (const motion of ['sweep', 'hover', 'pulse'] as const) {
        const paint = gradient({ shape, motion, travel: 0.5 })
        const at = (phase: number) => gradientAt(paint, phase)
        const base = grid.map(([x, y]) => blendAt(at(0), x, y))
        let strongest = 0
        for (const phase of [0.2, 0.4, 0.6, 0.8]) {
          const now = at(phase)
          const mean =
            grid.reduce((sum, [x, y], i) => sum + Math.abs(blendAt(now, x, y) - (base[i] ?? 0)), 0) / grid.length
          strongest = Math.max(strongest, mean)
        }
        expect(strongest, `${shape}/${motion} shifts only ${(strongest * 100).toFixed(0)}%`).toBeGreaterThan(0.08)
      }
    }
  })

  it('offers a radial shape, centred and reaching out', () => {
    const paint = gradientAt(gradient({ shape: 'radial' }), 0)
    if (paint.kind !== 'gradient' || paint.shape !== 'radial') throw new Error('expected radial')
    expect(paint.centre).toEqual({ x: 0.5, y: 0.5 })
    expect(paint.radius).toBeGreaterThan(0)
  })
})

describe('the pictures a document refers to', () => {
  it('are gathered from every paint an object carries', () => {
    const tiled = {
      kind: 'mosaic',
      states: [
        {
          glyphColour: { a: picture({ asset: 'one' }) },
          tileColour: { a: '#ffffff', b: picture({ asset: 'two' }) },
          background: null,
          stroke: null,
        },
      ],
    } as unknown as DocumentObject
    const shape = {
      kind: 'typography',
      appearance: { textFill: picture({ asset: 'three' }), containerFill: null, lineFill: '#000000', containerStroke: null },
    } as unknown as DocumentObject
    const frame = {
      kind: 'frame',
      members: [{ id: 'm', object: shape }],
      states: [{ background: picture({ asset: 'four' }), values: { m: { appearance: { textFill: picture({ asset: 'five' }) } } } }],
    } as unknown as DocumentObject
    expect([...collectAssetIds([tiled, frame])].sort()).toEqual(['five', 'four', 'one', 'three', 'two'])
    const none: Paint = '#123456'
    expect(collectAssetIds([{ kind: 'typography', appearance: { textFill: none, containerFill: null, lineFill: null, containerStroke: null } } as unknown as DocumentObject]).size).toBe(0)
  })
})
