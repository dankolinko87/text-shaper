import { afterEach, describe, expect, it } from 'vitest'

import { activeLayerItemCount, resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { outlineToPath } from '../../src/geometry/outline'
import { pathBounds, validatePath } from '../../src/geometry/path'
import { resamplePolyline } from '../../src/geometry/resample'
import {
  DEFAULT_STROKE_OPTIONS,
  strokeToLinePath,
  strokeToShapePath,
} from '../../src/geometry/strokeToPath'
import { samplePath } from '../../src/geometry/run'
import type { Vec2 } from '../../src/types/document'
import {
  blobStroke,
  circleStroke,
  dotStroke,
  drawnLineStroke,
  fastFlickStroke,
  figureEightStroke,
  idealLine,
  tinySquareStroke,
} from '../fixtures/strokes'

afterEach(() => {
  resetPaperScope()
})

describe('resamplePolyline', () => {
  it('produces near-uniform spacing regardless of input density', () => {
    const out = resamplePolyline(fastFlickStroke(), 5)
    const gaps: number[] = []
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]
      const b = out[i]
      if (!a || !b) continue
      gaps.push(Math.hypot(b.x - a.x, b.y - a.y))
    }
    // Relative tolerance: float accumulation over a long polyline drifts by a
    // fraction of a percent, which is far below the sub-pixel level that matters.
    for (const gap of gaps) expect(Math.abs(gap - 5) / 5).toBeLessThan(0.01)
  })

  it('preserves the first and last points exactly', () => {
    const input = circleStroke()
    const out = resamplePolyline(input, 7)
    expect(out[0]).toEqual(input[0])
    expect(out[out.length - 1]).toEqual(input[input.length - 1])
  })

  it('handles degenerate inputs without throwing', () => {
    expect(resamplePolyline([], 5)).toEqual([])
    expect(resamplePolyline([{ x: 1, y: 1 }], 5)).toEqual([{ x: 1, y: 1 }])
    // Consecutive duplicates collapse.
    expect(
      resamplePolyline(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        5,
      ),
    ).toEqual([{ x: 0, y: 0 }])
  })
})

describe('strokeToShapePath', () => {
  it('converts a freehand circle into a closed, centred shape', () => {
    const result = strokeToShapePath(circleStroke())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Area within 10% of the drawn circle (r = 120).
    const expectedArea = Math.PI * 120 * 120
    expect(result.area).toBeGreaterThan(expectedArea * 0.9)
    expect(result.area).toBeLessThan(expectedArea * 1.1)

    // The path is recentred on the local origin.
    const b = result.localBounds
    expect(b.x + b.width / 2).toBeCloseTo(0, 3)
    expect(b.y + b.height / 2).toBeCloseTo(0, 3)

    // ...and the artboard position it was drawn at is reported separately.
    // The fixture has deliberate jitter, so the centre lands near but not
    // exactly on (300, 300).
    expect(result.artboardCenter.x).toBeGreaterThan(295)
    expect(result.artboardCenter.x).toBeLessThan(305)
    expect(result.artboardCenter.y).toBeGreaterThan(295)
    expect(result.artboardCenter.y).toBeLessThan(305)

    expect(validatePath(result.pathData).valid).toBe(true)
  })

  it('simplifies: far fewer segments than raw input points', () => {
    const input = circleStroke()
    const result = strokeToShapePath(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const segmentCount = (result.pathData.match(/[cslq]/gi) ?? []).length
    expect(segmentCount).toBeLessThan(input.length / 2)
  })

  it('resolves a self-intersecting figure eight into a valid shape', () => {
    const result = strokeToShapePath(figureEightStroke())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(validatePath(result.pathData).valid).toBe(true)

    /*
     * No self-crossings remain after the repair step — anywhere except the waist.
     *
     * `getCrossings` rather than `getIntersections`, because uniting a figure
     * eight leaves its two lobes meeting at a point, and that is a legitimate
     * intersection. Whether paper then calls that single point a CROSSING is
     * knife-edge: it flips between zero, one and two with sub-unit changes to
     * the smoothing, and the original settings simply happened to land on zero.
     *
     * So the waist is excluded and everywhere else is held strictly. That is the
     * guarantee worth having — an outline that crosses itself somewhere it
     * should not breaks the fill — while not asserting a coin-flip about one
     * point that the shape's validity does not depend on.
     */
    const away = withPaper((scope) => {
      const item = new scope.CompoundPath(result.pathData)
      const centre = item.bounds.center
      const strays = item
        .getCrossings(item)
        .filter((c) => Math.hypot(c.point.x - centre.x, c.point.y - centre.y) > 2)
        .map((c) => ({ x: c.point.x, y: c.point.y }))
      item.remove()
      return strays
    })
    expect(away, 'no crossing away from the waist').toEqual([])
  })

  it('keeps both lobes of a figure eight rather than deleting half the drawing', () => {
    const result = strokeToShapePath(figureEightStroke())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const regionCount = withPaper((scope) => {
      const item = new scope.CompoundPath(result.pathData)
      const children = item.children as unknown[] | undefined
      const count = children ? children.length : 1
      item.remove()
      return count
    })
    expect(regionCount).toBe(2)
  })

  it('preserves concavity in a blob', () => {
    const result = strokeToShapePath(blobStroke())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A concave blob encloses noticeably less than its bounding box.
    const boxArea = result.localBounds.width * result.localBounds.height
    expect(result.area).toBeLessThan(boxArea * 0.85)
  })

  it('rejects a stray click as too few points', () => {
    const result = strokeToShapePath(dotStroke)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-few-points')
  })

  it('rejects a shape too small to be intentional', () => {
    // 9x9 = 81 square units, below the 120 minimum but large enough to survive
    // simplification, so we exercise the area gate rather than the empty gate.
    const result = strokeToShapePath(tinySquareStroke(9), {
      ...DEFAULT_STROKE_OPTIONS,
      resampleSpacing: 0.5,
      simplifyTolerance: 0.1,
      smooth: false,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-small')
  })

  it('rejects a shape that simplification collapses entirely', () => {
    const result = strokeToShapePath(tinySquareStroke(3), {
      ...DEFAULT_STROKE_OPTIONS,
      resampleSpacing: 0.5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('degenerate')
  })

  it('produces path data that re-parses to the same bounds', () => {
    const result = strokeToShapePath(circleStroke())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = pathBounds(result.pathData)
    expect(reparsed.width).toBeCloseTo(result.localBounds.width, 3)
    expect(reparsed.height).toBeCloseTo(result.localBounds.height, 3)
  })
})

describe('strokeToLinePath', () => {
  /** Farthest any point of `poly` sits from the polyline `against`. */
  const strayFrom = (poly: readonly Vec2[], against: readonly Vec2[]): number => {
    let worst = 0
    for (const q of poly) {
      let best = Infinity
      for (let i = 1; i < against.length; i++) {
        const a = against[i - 1] as Vec2
        const b = against[i] as Vec2
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len2 = dx * dx + dy * dy || 1
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2))
        best = Math.min(best, Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)))
      }
      worst = Math.max(worst, best)
    }
    return worst
  }

  /*
   * Both halves of "simplify it, but do not lose the drawing" in one test,
   * because either alone is trivially satisfiable — a straight line has two
   * anchors, and a verbatim copy of the stroke has no error.
   *
   * The counts are what the drawn stroke actually produces, with room either
   * side; the point of the assertion is the ORDER, not the number. Before the
   * line pipeline had its own settings it inherited the shape's and left 20 of
   * them on the same stroke, which is what the handles looked like.
   */
  it('leaves a handful of anchors on a hand-drawn line, and still follows it', () => {
    for (const kind of ['wave', 'arc'] as const) {
      const result = strokeToLinePath(drawnLineStroke(kind))
      expect(result.ok, kind).toBe(true)
      if (!result.ok) continue

      expect(result.anchors.length, `${kind} anchors`).toBeGreaterThanOrEqual(3)
      expect(result.anchors.length, `${kind} anchors`).toBeLessThanOrEqual(9)

      // Against the curve the hand MEANT to draw, not the record of the hand:
      // the wobble filtered out here is ±12 units, so landing within 2% of the
      // ideal is the fit following the drawing rather than the shake.
      const drawn = samplePath(result.pathData, 4)
      expect(drawn, kind).not.toBeNull()
      const want = idealLine(kind).map((p) => ({
        x: p.x - result.artboardCenter.x,
        y: p.y - result.artboardCenter.y,
      }))
      const span = Math.hypot(result.localBounds.width, result.localBounds.height)
      expect(strayFrom(drawn!, want) / span, `${kind} stray`).toBeLessThan(0.02)
    }
  })

  /*
   * The same gesture drawn at a fifth of the size comes out as the same line.
   *
   * This is the property the absolute settings did not have, and it is not
   * cosmetic. A stroke is captured in SCENE units, so the same movement of the
   * hand is five times as long on an artboard zoomed out five times, while the
   * shake in it stays the same share of it. A filter measured in artboard units
   * is therefore a different filter at every zoom level. Measured on this wave
   * at full, half and a fifth size, the old settings left 25, 16 and 10 anchors;
   * these leave 6, 6 and 6.
   *
   * Within one anchor rather than exactly equal, because the fit is greedy and a
   * split that lands on the knife edge can go either way once the inputs differ
   * in their last bits — which they do, since a fifth is not a number a float
   * can hold.
   */
  it('makes the same line of the same gesture at any size', () => {
    for (const kind of ['wave', 'arc'] as const) {
      const big = strokeToLinePath(drawnLineStroke(kind, 1))
      const small = strokeToLinePath(drawnLineStroke(kind, 0.2))
      expect(big.ok && small.ok, kind).toBe(true)
      if (!big.ok || !small.ok) continue

      expect(
        Math.abs(small.anchors.length - big.anchors.length),
        `${kind} anchors: ${small.anchors.length} vs ${big.anchors.length}`,
      ).toBeLessThanOrEqual(1)

      // And the same curve, which is the half that matters — an anchor more or
      // less on the same line is invisible, a different line is not.
      const scaled = samplePath(small.pathData, 4)!.map((p) => ({ x: p.x * 5, y: p.y * 5 }))
      const drawn = samplePath(big.pathData, 4)!
      const span = Math.hypot(big.localBounds.width, big.localBounds.height)
      expect(strayFrom(scaled, drawn) / span, `${kind} shape`).toBeLessThan(0.02)
    }
  })

  it('keeps the line open, and keeps the ends where the hand left them', () => {
    const raw = drawnLineStroke('wave')
    const result = strokeToLinePath(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.pathData.toUpperCase()).not.toContain('Z')

    const first = result.anchors[0] as Vec2
    const last = result.anchors[result.anchors.length - 1] as Vec2
    const rawFirst = raw[0] as Vec2
    const rawLast = raw[raw.length - 1] as Vec2
    const c = result.artboardCenter
    // Within a couple of units: the ends are clamped by the smoother, so they
    // move only by the jitter on the last sample itself.
    expect(Math.hypot(first.x + c.x - rawFirst.x, first.y + c.y - rawFirst.y)).toBeLessThan(3)
    expect(Math.hypot(last.x + c.x - rawLast.x, last.y + c.y - rawLast.y)).toBeLessThan(3)
  })

  /*
   * What the point editor draws its guide from, and what it draws its handles
   * from, are the same line.
   *
   * `PathLayer` samples the path for the curve and uses the anchors for the
   * handles. That was self-evidently consistent while a line came out with sixty
   * anchors — a chord between points a few units apart IS the curve — and it is
   * worth pinning now that there are six, because a handle sitting off the line
   * it is supposed to control would be a confusing thing to ship.
   */
  it('puts every handle on the curve the guide is drawn from', () => {
    for (const kind of ['wave', 'arc'] as const) {
      const result = strokeToLinePath(drawnLineStroke(kind))
      expect(result.ok, kind).toBe(true)
      if (!result.ok) continue

      const curve = samplePath(result.pathData, 3)
      expect(curve, kind).not.toBeNull()
      expect(strayFrom(result.anchors, curve!), `${kind} handles off the line`).toBeLessThan(0.5)
    }
  })

  it('rejects a stroke that went nowhere', () => {
    const result = strokeToLinePath(dotStroke)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-few-points')
  })
})

describe('paperContext', () => {
  it('does not leak items across many operations', () => {
    for (let i = 0; i < 50; i++) {
      strokeToShapePath(circleStroke(300, 300, 100 + i))
    }
    expect(activeLayerItemCount()).toBe(0)
  })

  it('cleans up even when the callback throws', () => {
    expect(() =>
      withPaper((scope) => {
        new scope.Path.Circle({ center: [0, 0], radius: 10 })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(activeLayerItemCount()).toBe(0)
  })
})

describe('which of the two a stroke became', () => {
  /*
   * The whole difference between the drawing tools, carried on the RESULT rather
   * than restated by whoever consumes it.
   *
   * It used to be the caller's job, and the caller stopped doing it: every line
   * the line tool drew came out a filled shape, silently, because the field was
   * optional and its default was the other answer. A pipeline that reports what
   * it produced cannot be misquoted.
   */
  it('says so itself', () => {
    const line = strokeToLinePath(drawnLineStroke('wave'))
    expect(line.ok).toBe(true)
    if (line.ok) expect(line.open, 'a line is open').toBe(true)

    const shape = strokeToShapePath(blobStroke())
    expect(shape.ok).toBe(true)
    if (shape.ok) expect(shape.open, 'a shape is closed').toBe(false)
  })

  it('agrees with the geometry it produced', () => {
    // Not independent facts: the flag has to describe the path, or it is worse
    // than no flag at all.
    for (const result of [strokeToLinePath(drawnLineStroke('arc')), strokeToShapePath(blobStroke())]) {
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      for (const subpath of result.outline.subpaths) {
        expect(subpath.closed, `open=${result.open}`).toBe(!result.open)
      }
    }
  })
})

describe('the nodes a stroke is left with', () => {
  /*
   * The fit already computes Bézier handles — that is what makes a hand-drawn
   * curve a curve rather than a polyline. Until now creation read the anchors
   * off the fitted path and dropped the handles on the floor, so the editor had
   * to re-invent the tangents from the anchors alone every time one moved, and
   * moving one point reshaped the whole line.
   *
   * Keeping the fit's own handles is what makes point editing local.
   */
  it('keeps the handles the fit worked out, on a line', () => {
    for (const kind of ['wave', 'arc'] as const) {
      const result = strokeToLinePath(drawnLineStroke(kind))
      expect(result.ok, kind).toBe(true)
      if (!result.ok) continue

      const nodes = result.outline.subpaths[0]!.nodes
      expect(result.outline.subpaths.length, `${kind} subpaths`).toBe(1)
      expect(nodes.length, `${kind} nodes`).toBe(result.anchors.length)
      expect(result.outline.subpaths[0]!.closed, `${kind} open`).toBe(false)

      const curved = nodes.filter(
        (n) => Math.hypot(n.handleIn.x, n.handleIn.y) + Math.hypot(n.handleOut.x, n.handleOut.y) > 0,
      )
      expect(curved.length, `${kind} curved nodes`).toBe(nodes.length)

      // And the nodes describe the same curve the fit serialised, so the two
      // halves of the object's geometry agree from the moment it is created.
      const drawn = pathBounds(outlineToPath(result.outline))
      const fitted = pathBounds(result.pathData)
      expect(Math.abs(drawn.width - fitted.width), `${kind} width`).toBeLessThan(0.05)
      expect(Math.abs(drawn.height - fitted.height), `${kind} height`).toBeLessThan(0.05)
      expect(Math.abs(drawn.x - fitted.x), `${kind} x`).toBeLessThan(0.05)
      expect(Math.abs(drawn.y - fitted.y), `${kind} y`).toBeLessThan(0.05)
    }
  })

  it('keeps every lobe of a freehand shape, closed', () => {
    // A freehand shape legitimately is a donut or a figure eight — the pipeline
    // keeps every significant region on purpose — so the outline has to carry
    // subpaths or the first edit would drop one.
    const eight = strokeToShapePath(figureEightStroke())
    expect(eight.ok).toBe(true)
    if (!eight.ok) return

    expect(eight.outline.subpaths.length).toBeGreaterThan(1)
    for (const subpath of eight.outline.subpaths) {
      expect(subpath.closed).toBe(true)
      expect(subpath.nodes.length).toBeGreaterThanOrEqual(2)
    }

    const blob = strokeToShapePath(blobStroke())
    expect(blob.ok).toBe(true)
    if (!blob.ok) return
    const drawn = pathBounds(outlineToPath(blob.outline))
    const fitted = pathBounds(blob.pathData)
    expect(Math.abs(drawn.width - fitted.width)).toBeLessThan(0.05)
    expect(Math.abs(drawn.height - fitted.height)).toBeLessThan(0.05)
  })
})
