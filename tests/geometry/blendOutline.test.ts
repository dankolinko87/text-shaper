import { describe, expect, it } from 'vitest'

import { blendOutline, outlineToPath, sameOutline, sameTopology } from '../../src/geometry/outline'
import type { PathNode, PathOutline } from '../../src/types/document'

/**
 * One shape on the way to another.
 *
 * A morph is a handful of lerps and nothing else: anchors and both handles
 * travel in straight lines, which sweeps a Bézier smoothly from one curve to
 * the other with no resampling, no arc-length matching and no geometry engine.
 * That is what makes it cheap enough to run every frame.
 *
 * What it CANNOT do is pair up points that have nothing to do with each other,
 * and most of the care here is in refusing that rather than in the arithmetic.
 */

const node = (x: number, y: number, handle = 0): PathNode => ({
  point: { x, y },
  handleIn: { x: -handle, y: 0 },
  handleOut: { x: handle, y: 0 },
  smooth: handle !== 0,
})

const square = (size: number): PathOutline => ({
  subpaths: [
    {
      closed: true,
      nodes: [node(-size, -size), node(size, -size), node(size, size), node(-size, size)],
    },
  ],
})

describe('topology, which a morph is only meaningful within', () => {
  it('accepts two outlines built the same way', () => {
    expect(sameTopology(square(10), square(50))).toBe(true)
  })

  it('rejects a different number of nodes', () => {
    const triangle: PathOutline = {
      subpaths: [{ closed: true, nodes: [node(0, 0), node(10, 0), node(5, 10)] }],
    }
    expect(sameTopology(square(10), triangle)).toBe(false)
  })

  it('rejects a different number of subpaths, and an open against a closed', () => {
    const two: PathOutline = { subpaths: [...square(10).subpaths, ...square(5).subpaths] }
    expect(sameTopology(square(10), two)).toBe(false)

    const open: PathOutline = {
      subpaths: [{ closed: false, nodes: square(10).subpaths[0]!.nodes }],
    }
    expect(sameTopology(square(10), open)).toBe(false)
  })
})

describe('blending', () => {
  it('lands halfway between the two shapes', () => {
    const mid = blendOutline(square(10), square(50), 0.5)
    expect(mid).not.toBeNull()
    expect(mid!.subpaths[0]!.nodes[0]!.point).toEqual({ x: -30, y: -30 })
    expect(mid!.subpaths[0]!.nodes[2]!.point).toEqual({ x: 30, y: 30 })
  })

  it('carries the handles, not only the anchors', () => {
    /*
     * The handles ARE the curve. Blending anchors alone would slide the corners
     * of a rounded shape into place while every edge stayed the curvature of
     * whichever end was drawn first.
     */
    const from: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 0), node(10, 0, 0)] }] }
    const to: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 8), node(10, 0, 8)] }] }
    const mid = blendOutline(from, to, 0.5)
    expect(mid!.subpaths[0]!.nodes[0]!.handleOut.x).toBeCloseTo(4, 6)
    expect(mid!.subpaths[0]!.nodes[0]!.handleIn.x).toBeCloseTo(-4, 6)
  })

  it('gives back each end exactly, so a hold shows what was authored', () => {
    const a = square(10)
    const b = square(50)
    expect(blendOutline(a, b, 0)).toBe(a)
    expect(blendOutline(a, b, 1)).toBe(b)
  })

  it('refuses a pair it cannot pair up, rather than inventing a shape', () => {
    const triangle: PathOutline = {
      subpaths: [{ closed: true, nodes: [node(0, 0), node(10, 0), node(5, 10)] }],
    }
    expect(blendOutline(square(10), triangle, 0.5)).toBeNull()
  })

  it('cuts the smooth flag rather than interpolating a boolean', () => {
    const from: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 0), node(10, 0, 0)] }] }
    const to: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 8), node(10, 0, 8)] }] }
    expect(blendOutline(from, to, 0.25)!.subpaths[0]!.nodes[0]!.smooth).toBe(false)
    expect(blendOutline(from, to, 0.75)!.subpaths[0]!.nodes[0]!.smooth).toBe(true)
  })

  it('produces something drawable at every step', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const path = outlineToPath(blendOutline(square(10), square(50), t) as PathOutline)
      expect(path.length).toBeGreaterThan(0)
      expect(path).not.toContain('NaN')
    }
  })
})

describe('telling two outlines apart', () => {
  it('sees a moved point', () => {
    expect(sameOutline(square(10), square(10))).toBe(true)
    expect(sameOutline(square(10), square(10.5))).toBe(false)
  })

  it('sees a moved HANDLE, with every anchor where it was', () => {
    // A shape can be reshaped without a single anchor moving, and a frame that
    // could not see that would refuse to play a curvature morph.
    const from: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 0), node(10, 0, 0)] }] }
    const to: PathOutline = { subpaths: [{ closed: true, nodes: [node(0, 0, 8), node(10, 0, 8)] }] }
    expect(sameOutline(from, to)).toBe(false)
  })

  it('treats a missing outline as its own answer', () => {
    expect(sameOutline(undefined, undefined)).toBe(true)
    expect(sameOutline(square(10), undefined)).toBe(false)
  })
})
