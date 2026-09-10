import { describe, expect, it } from 'vitest'

import { calculateTextSpans } from '../../src/geometry/spans'
import { pathArea, pathBounds, transformPathData, validatePath, pathContainsPoint} from '../../src/geometry/path'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { PRIMITIVES, type PrimitiveShape } from '../../src/geometry/primitives'
import { compose } from '../../src/geometry/transform'

describe('primitive presets', () => {
  it('produces a valid, closed, positive-area container for each', () => {
    for (const shape of PRIMITIVES) {
      const path = shape.build(520, 420)
      const check = validatePath(path)
      expect(check.valid, `${shape.label}: ${check.reason}`).toBe(true)
      expect(path.endsWith('Z'), `${shape.label} is not closed`).toBe(true)
    }
  })

  it('centres every outline on the origin', () => {
    // The object's local origin is where its transform places it, so a preset
    // whose outline sat off-centre would appear to jump away from the cursor.
    for (const shape of PRIMITIVES) {
      const b = pathBounds(shape.build(520, 420))
      expect(Math.abs(b.x + b.width / 2), `${shape.label} x`).toBeLessThan(1)
      expect(Math.abs(b.y + b.height / 2), `${shape.label} y`).toBeLessThan(1)
    }
  })

  it('fits inside the requested box', () => {
    for (const shape of PRIMITIVES) {
      const b = pathBounds(shape.build(520, 420))
      expect(b.width, `${shape.label} width`).toBeLessThanOrEqual(521)
      expect(b.height, `${shape.label} height`).toBeLessThanOrEqual(421)
    }
  })

  it('can be scanned for text like any drawn shape', () => {
    // The whole pipeline starts here: a preset the sampler cannot read would
    // accept text and then render nothing.
    for (const shape of PRIMITIVES) {
      const spans = calculateTextSpans(shape.build(520, 420), {
        sampleCount: 48,
        minSpanWidth: 4,
      })
      expect(spans.length, `${shape.label} produced no scanlines`).toBeGreaterThan(20)
    }
  })

  it('emits no arc commands', () => {
    // Everything downstream is written against the vocabulary the freehand
    // tracer emits; an arc would be a second dialect to support.
    for (const shape of PRIMITIVES) {
      expect(shape.build(520, 420)).not.toMatch(/[Aa]/)
    }
  })
})

describe('transformPathData', () => {
  it('scales area by the product of the scale factors', () => {
    const square = 'M-100 -100L100 -100L100 100L-100 100Z'
    const scaled = transformPathData(
      square,
      compose({ x: 0, y: 0, scaleX: 2, scaleY: 3, rotation: 0, flipX: false, flipY: false }),
    )
    expect(pathArea(scaled) / pathArea(square)).toBeCloseTo(6, 3)
  })

  it('keeps a shape centred on the origin when it was already centred', () => {
    // This is what lets a bake leave the shape where it looks like it is: the
    // matrix has no translation, so the local origin does not move.
    const path = PRIMITIVES[0]!.build(400, 300)
    const out = transformPathData(
      path,
      compose({ x: 0, y: 0, scaleX: 1.7, scaleY: 0.6, rotation: 25, flipX: false, flipY: false }),
    )
    const b = pathBounds(out)
    expect(Math.abs(b.x + b.width / 2)).toBeLessThan(1)
    expect(Math.abs(b.y + b.height / 2)).toBeLessThan(1)
  })

  it('leaves the path untouched under an identity matrix', () => {
    const path = PRIMITIVES[1]!.build(200, 100)
    const out = transformPathData(
      path,
      compose({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }),
    )
    expect(pathArea(out)).toBeCloseTo(pathArea(path), 3)
  })
})

describe('a preset as points you can take hold of', () => {
  /*
   * A preset is a starting point, not a finished thing — it is dropped on the
   * artboard so it can be pushed into the shape someone actually wants. So it
   * arrives node-editable, like everything else that can be drawn.
   *
   * These paths are built in the same vocabulary the freehand tracer emits —
   * cubics and lines, no arcs — which is what makes reading them back give the
   * corners and quadrants they were WRITTEN with, and not a point more.
   */
  it('gives every preset a node list that redraws it', () => {
    for (const shape of PRIMITIVES) {
      const data = shape.build(400, 300)
      const outline = pathToOutline(data)
      expect(outline, shape.id).not.toBeNull()
      expect(outline!.subpaths.length, `${shape.id} subpaths`).toBe(1)
      expect(outline!.subpaths[0]!.closed, `${shape.id} closed`).toBe(true)

      const drawn = pathBounds(outlineToPath(outline!))
      const built = pathBounds(data)
      expect(Math.abs(drawn.width - built.width), `${shape.id} width`).toBeLessThan(0.05)
      expect(Math.abs(drawn.height - built.height), `${shape.id} height`).toBeLessThan(0.05)
    }
  })

  it('leaves a preset with the handful of points it was drawn with', () => {
    // Not a wall of markers: the whole value of editing a preset is that there
    // are few enough points to aim at and each one means something.
    const counts: Record<string, number> = {}
    for (const shape of PRIMITIVES) {
      counts[shape.id] = pathToOutline(shape.build(400, 300))!.subpaths[0]!.nodes.length
    }
    expect(counts).toEqual({
      ellipse: 4,
      rectangle: 4,
      rounded: 8,
      arch: 5,
      triangle: 3,
      hexagon: 6,
    })
  })

  it('calls a rectangle\'s points corners and an ellipse\'s smooth', () => {
    const nodes = (id: string) =>
      pathToOutline(PRIMITIVES.find((p) => p.id === id)!.build(400, 300))!.subpaths[0]!.nodes
    expect(nodes('rectangle').every((n) => !n.smooth), 'a rectangle').toBe(true)
    expect(nodes('triangle').every((n) => !n.smooth), 'a triangle').toBe(true)
    expect(nodes('ellipse').every((n) => n.smooth), 'an ellipse').toBe(true)
  })
})

describe('a preset at its own proportions', () => {
  /*
   * Every preset is dropped as the REGULAR version of itself — a circle, a
   * square, an equilateral triangle — and each one knows the ratio at which that
   * is true. The trap being guarded against is assuming that ratio is always 1:
   * an equilateral triangle standing on a base of `w` is `w·√3/2` tall, and a
   * hexagon is regular at 1 even though the box it fills is not square.
   */
  const SIDE = 480
  const natural = (shape: PrimitiveShape): string => shape.build(SIDE, SIDE * shape.aspect)

  /** The side lengths of a path's straight-line vertices, in order. */
  function sides(data: string): number[] {
    const points = [...data.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }))
    return points.map((p, i) => {
      const q = points[(i + 1) % points.length] as { x: number; y: number }
      return Math.hypot(q.x - p.x, q.y - p.y)
    })
  }

  const equalWithin = (values: number[], tolerance: number): boolean => {
    const first = values[0] as number
    return values.every((v) => Math.abs(v - first) <= tolerance)
  }

  it('makes the ellipse a circle', () => {
    const b = pathBounds(natural(PRIMITIVES.find((p) => p.id === 'ellipse')!))
    expect(b.width).toBeCloseTo(b.height, 6)
    expect(b.width).toBeCloseTo(SIDE, 6)
  })

  it('makes the rectangles square', () => {
    for (const id of ['rectangle', 'rounded'] as const) {
      const b = pathBounds(natural(PRIMITIVES.find((p) => p.id === id)!))
      expect(b.width, id).toBeCloseTo(b.height, 6)
    }
  })

  it('makes the triangle equilateral', () => {
    // The one that a square box gets wrong: at 1:1 the base is longer than the
    // two sides and it sits visibly squat.
    const shape = PRIMITIVES.find((p) => p.id === 'triangle')!
    const lengths = sides(natural(shape))
    expect(lengths.length).toBe(3)
    expect(equalWithin(lengths, 0.05), `sides ${lengths.join(', ')}`).toBe(true)

    const square = sides(shape.build(SIDE, SIDE))
    expect(equalWithin(square, 0.05), 'a square box is NOT equilateral').toBe(false)
  })

  it('makes the hexagon regular, bounds notwithstanding', () => {
    const shape = PRIMITIVES.find((p) => p.id === 'hexagon')!
    const lengths = sides(natural(shape))
    expect(lengths.length).toBe(6)
    expect(equalWithin(lengths, 0.05), `sides ${lengths.join(', ')}`).toBe(true)

    // Its box is wider than it is tall, and that is what a regular hexagon's box
    // is — squaring it up would be the thing that broke it.
    const b = pathBounds(natural(shape))
    expect(b.height / b.width).toBeCloseTo(Math.sqrt(3) / 2, 3)
    expect(equalWithin(sides(shape.build(SIDE, (SIDE * Math.sqrt(3)) / 2)), 0.05)).toBe(false)
  })

  it('gives the arch a true semicircle rather than a squashed one', () => {
    // No regular polygon to appeal to, so what has to be right is the cap: its
    // radius is capped against the height, and a short box flattens it.
    const shape = PRIMITIVES.find((p) => p.id === 'arch')!
    const b = pathBounds(natural(shape))
    // Straight sides half the width tall, then a semicircle of the same radius.
    expect(b.width).toBeCloseTo(SIDE, 6)
    expect(b.height).toBeCloseTo(SIDE, 6)
  })
})

/**
 * Whether a point is inside a shape.
 *
 * Asked when a double-click has to decide what it means. On the outline it adds
 * or removes a point; INSIDE the shape it belongs to the grid, which is where a
 * deformer line gets added; and only OUTSIDE does it mean "let me out of here".
 * Before this existed, "away from the outline" was taken to mean outside — so
 * double-clicking in the middle of a shape to add a deformer closed the editor
 * instead.
 */
describe('a point inside a shape', () => {
  const square = 'M0 0 L100 0 L100 100 L0 100 Z'

  it('says yes well inside and no well outside', () => {
    expect(pathContainsPoint(square, { x: 50, y: 50 })).toBe(true)
    expect(pathContainsPoint(square, { x: -20, y: 50 })).toBe(false)
    expect(pathContainsPoint(square, { x: 50, y: 180 })).toBe(false)
  })

  it('treats a hole as outside, which is what pointing at one means', () => {
    // Outer square, inner square wound the other way: a donut under nonzero.
    const donut = 'M0 0 L100 0 L100 100 L0 100 Z M30 30 L30 70 L70 70 L70 30 Z'
    expect(pathContainsPoint(donut, { x: 50, y: 50 }), 'in the hole').toBe(false)
    expect(pathContainsPoint(donut, { x: 15, y: 50 }), 'in the ring').toBe(true)
  })

  it('is false for a point in the bounding box but outside the shape', () => {
    // The reason bounds are not good enough: the bay of a concave shape is
    // inside the box and outside the shape.
    const vee = 'M0 0 L40 0 L50 80 L60 0 L100 0 L100 100 L0 100 Z'
    expect(pathContainsPoint(vee, { x: 50, y: 20 }), 'in the notch').toBe(false)
    expect(pathContainsPoint(vee, { x: 50, y: 95 }), 'below it').toBe(true)
  })
})
