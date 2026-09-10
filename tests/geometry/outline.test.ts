import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import {
  copyOutline,
  cornerAt,
  isSmoothAt,
  outlineToPath,
  pathToOutline,
  transformOutline,
} from '../../src/geometry/outline'
import { artboardToObject, objectToArtboard } from '../../src/geometry/objectSpace'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds, smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { strokeToLinePath, strokeToShapePath } from '../../src/geometry/strokeToPath'
import { compose } from '../../src/geometry/transform'
import type { PathData, PathNode, PathOutline } from '../../src/types/document'
import { blobStroke, drawnLineStroke, figureEightStroke } from '../fixtures/strokes'

/**
 * The two representations of a path, and the promise that they mean the same
 * thing.
 *
 * `currentSourcePath` is what everything downstream reads; the node list is what
 * the editor lets you take hold of. They are stored separately, so every test
 * here is ultimately the same question asked of different geometry: does the
 * round trip come back?
 */

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(400, 300)
const RECTANGLE = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(400, 300)

/** How far apart two paths' outlines sit, as a share of the larger one. */
function apart(a: PathData, b: PathData): number {
  const x = pathBounds(a)
  const y = pathBounds(b)
  const size = Math.max(x.width, x.height, y.width, y.height, 1)
  return (
    Math.max(
      Math.abs(x.x - y.x),
      Math.abs(x.y - y.y),
      Math.abs(x.width - y.width),
      Math.abs(x.height - y.height),
    ) / size
  )
}

const nodesOf = (outline: PathOutline): PathNode[] =>
  outline.subpaths.flatMap((subpath) => subpath.nodes)

describe('a path and its nodes', () => {
  it('comes back from a round trip, curves and all', () => {
    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    expect(drawn.ok).toBe(true)
    const blob = strokeToShapePath(blobStroke())
    expect(blob.ok).toBe(true)

    for (const [name, data] of [
      ['ellipse', ELLIPSE],
      ['rectangle', RECTANGLE],
      ['drawn line', drawn.ok ? drawn.pathData : ''],
      ['freehand blob', blob.ok ? blob.pathData : ''],
      ['smoothed polygon', smoothPath('M0 0L100 0L100 80L0 80Z')],
    ] as const) {
      const outline = pathToOutline(data)
      expect(outline, name).not.toBeNull()
      if (!outline) continue

      // Not the same STRING — paper emits relative commands and rounds
      // differently — but the same curve, which is the promise that matters.
      expect(apart(outlineToPath(outline), data), `${name} redrawn`).toBeLessThan(0.001)

      // And the nodes themselves survive a second trip unchanged, which is what
      // stops an edit drifting the shape a little further every time.
      const again = pathToOutline(outlineToPath(outline))
      expect(again, `${name} twice`).not.toBeNull()
      expect(again?.subpaths.map((s) => s.nodes.length)).toEqual(
        outline.subpaths.map((s) => s.nodes.length),
      )
      expect(apart(outlineToPath(again!), data), `${name} twice redrawn`).toBeLessThan(0.001)
    }
  })

  it('keeps a plain polyline exactly, to the character', () => {
    /*
     * A segment with no handles is emitted as `L` rather than as a cubic with
     * its control points sitting on the anchors. That is what makes this exact
     * rather than merely close — and an exact case is worth having, because
     * every other assertion here is a tolerance.
     */
    const data = 'M0 0L100 0L100 80L0 80Z'
    const outline = pathToOutline(data)
    expect(outline).not.toBeNull()
    expect(outlineToPath(outline!)).toBe(data)
  })

  it('keeps the subpaths of a shape drawn as two lobes', () => {
    // `strokeToShapePath` keeps every significant region on purpose, so a figure
    // eight really is two loops. A flat node list would lose one of them.
    const eight = strokeToShapePath(figureEightStroke())
    expect(eight.ok).toBe(true)
    if (!eight.ok) return

    const outline = pathToOutline(eight.pathData)
    expect(outline).not.toBeNull()
    expect(outline!.subpaths.length, 'both lobes').toBeGreaterThan(1)
    expect(outline!.subpaths.every((s) => s.closed), 'a lobe is closed').toBe(true)
    expect(apart(outlineToPath(outline!), eight.pathData)).toBeLessThan(0.001)
  })

  it('does not leave two nodes stacked at a closed path\'s seam', () => {
    /*
     * A closed path is serialised as a curve back to the start point AND a `Z`,
     * so reading it back gives a final anchor sitting on the first one — a few
     * parts in 100000 away, from the rounding of a chain of relative commands,
     * which is too far for paper's own zero-tolerance join.
     *
     * That was invisible while a path was only a string. It is not invisible now:
     * it would put two markers in the same place on every freehand shape, and
     * dragging one would leave the other behind at the seam.
     */
    const blob = strokeToShapePath(blobStroke())
    expect(blob.ok).toBe(true)
    if (!blob.ok) return

    for (const subpath of pathToOutline(blob.pathData)!.subpaths) {
      const first = subpath.nodes[0]!
      const last = subpath.nodes[subpath.nodes.length - 1]!
      expect(Math.hypot(last.point.x - first.point.x, last.point.y - first.point.y)).toBeGreaterThan(
        0.01,
      )
      // And the seam is still a curve: the closing handle went onto the first
      // node rather than being dropped with the duplicate.
      expect(Math.hypot(first.handleIn.x, first.handleIn.y)).toBeGreaterThan(0)
    }
  })

  it('knows an open path from a closed one', () => {
    const drawn = strokeToLinePath(drawnLineStroke('arc'))
    expect(drawn.ok).toBe(true)
    if (!drawn.ok) return

    expect(pathToOutline(drawn.pathData)!.subpaths[0]!.closed, 'a line').toBe(false)
    expect(pathToOutline(ELLIPSE)!.subpaths[0]!.closed, 'an ellipse').toBe(true)
  })

  it('refuses what there is no curve in', () => {
    expect(pathToOutline('')).toBeNull()
    expect(pathToOutline('   ')).toBeNull()
    expect(pathToOutline('M10 10')).toBeNull()
    expect(pathToOutline('M0 0LNaN 4')).toBeNull()
  })

  it('takes an arc rather than refusing it', () => {
    /*
     * `mapPathPoints` refuses arcs and returns null, which makes the shape
     * animation fall back to the outline it already had. paper turns them into
     * cubics on the way in, so an outline read through here comes out arc-free
     * and the next thing to touch the path has an easier time than the last.
     */
    const outline = pathToOutline('M0 0A50 50 0 0 1 100 0')
    expect(outline).not.toBeNull()
    expect(outlineToPath(outline!)).not.toMatch(/[Aa]/)
  })
})

describe('telling a smooth point from a corner', () => {
  it('reads a rectangle as corners and an ellipse as smooth', () => {
    // The two ends of the question, on geometry whose answer is not in doubt.
    for (const node of nodesOf(pathToOutline(RECTANGLE)!)) {
      expect(node.smooth, 'a rectangle corner').toBe(false)
    }
    for (const node of nodesOf(pathToOutline(ELLIPSE)!)) {
      expect(node.smooth, 'an ellipse quadrant').toBe(true)
    }
  })

  it('does not need the two handles to be the same length', () => {
    /*
     * The invariant is COLLINEAR, not mirrored, and this is the case that
     * decides it: a Bézier fit produces collinear handles of unequal length all
     * the time. A mirrored test would call every fitted point a corner.
     */
    const lopsided: PathNode = {
      point: { x: 0, y: 0 },
      handleIn: { x: -10, y: 0 },
      handleOut: { x: 90, y: 0 },
      smooth: false,
    }
    expect(isSmoothAt(lopsided)).toBe(true)

    const drawn = strokeToLinePath(drawnLineStroke('wave'))
    expect(drawn.ok).toBe(true)
    if (!drawn.ok) return
    const fitted = nodesOf(pathToOutline(drawn.pathData)!)
    const uneven = fitted.filter(
      (n) =>
        n.smooth &&
        Math.abs(Math.hypot(n.handleIn.x, n.handleIn.y) - Math.hypot(n.handleOut.x, n.handleOut.y)) >
          0.5,
    )
    expect(uneven.length, 'a fit produces uneven smooth handles').toBeGreaterThan(0)
  })

  it('refuses a cusp, and a point with a handle missing', () => {
    // Both handles on the same side is a cusp, not a smooth point.
    expect(
      isSmoothAt({
        point: { x: 0, y: 0 },
        handleIn: { x: 10, y: 0 },
        handleOut: { x: 20, y: 0 },
        smooth: false,
      }),
    ).toBe(false)

    // An open path's endpoints have one handle each.
    expect(
      isSmoothAt({
        point: { x: 0, y: 0 },
        handleIn: { x: 0, y: 0 },
        handleOut: { x: 20, y: 0 },
        smooth: false,
      }),
    ).toBe(false)

    expect(isSmoothAt(cornerAt({ x: 5, y: 5 }))).toBe(false)
  })

  it('allows a degree of slack, and no more', () => {
    const at = (degrees: number): PathNode => {
      const a = (degrees * Math.PI) / 180
      return {
        point: { x: 0, y: 0 },
        handleIn: { x: -30, y: 0 },
        handleOut: { x: 30 * Math.cos(a), y: 30 * Math.sin(a) },
        smooth: false,
      }
    }
    expect(isSmoothAt(at(0)), 'straight through').toBe(true)
    expect(isSmoothAt(at(0.5)), 'half a degree').toBe(true)
    expect(isSmoothAt(at(5)), 'five degrees').toBe(false)
  })
})

describe('carrying an outline through a matrix', () => {
  it('scales the anchors and the handles, and moves only the anchors', () => {
    /*
     * Handles are measured from their anchor, so a translation must not reach
     * them. Translating them as well would fling every handle across the
     * artboard while the anchors stayed put — which is what `applyToVector`
     * exists to prevent, and why relative handles are the right storage.
     */
    const outline = pathToOutline(ELLIPSE)!
    const before = nodesOf(outline)[0]!

    const moved = transformOutline(
      outline,
      compose({ x: 300, y: 0, scaleX: 2, scaleY: 2, rotation: 0, flipX: false, flipY: false }),
    )
    const after = nodesOf(moved)[0]!

    expect(after.point.x).toBeCloseTo(before.point.x * 2 + 300, 6)
    expect(after.point.y).toBeCloseTo(before.point.y * 2, 6)
    expect(after.handleIn.x).toBeCloseTo(before.handleIn.x * 2, 6)
    expect(after.handleIn.y).toBeCloseTo(before.handleIn.y * 2, 6)
    expect(after.smooth).toBe(before.smooth)
  })

  it('still describes the path the same matrix produces', () => {
    // The property the bake depends on: outline and path stay two accounts of
    // one shape, whatever is done to them.
    const outline = pathToOutline(ELLIPSE)!
    const m = compose({
      x: 40,
      y: -25,
      scaleX: 1.7,
      scaleY: 0.6,
      rotation: 30,
      flipX: false,
      flipY: false,
    })
    expect(apart(outlineToPath(transformOutline(outline, m)), ELLIPSE)).toBeGreaterThan(0)
    const direct = outlineToPath(transformOutline(pathToOutline(outlineToPath(outline))!, m))
    expect(apart(outlineToPath(transformOutline(outline, m)), direct)).toBeLessThan(0.001)
  })
})

describe('carrying an outline back out of an object', () => {
  it('undoes the whole matrix, not just the position', () => {
    /*
     * What the pen relies on when it continues an existing path: the run is
     * drawn in artboard space over an object that may be turned and resized, and
     * it has to land in that object's own space. Undoing only the translation
     * would leave every new node rotated away from the path it is joining.
     */
    const t = {
      x: 220,
      y: -60,
      scaleX: 1.6,
      scaleY: 0.75,
      rotation: 42,
      flipX: false,
      flipY: false,
    }
    const outline = pathToOutline(ELLIPSE)!
    const there = transformOutline(outline, objectToArtboard(t))
    const back = transformOutline(there, artboardToObject(t))

    expect(apart(outlineToPath(there), ELLIPSE), 'it really did move').toBeGreaterThan(0.1)
    for (const [i, node] of nodesOf(back).entries()) {
      const was = nodesOf(outline)[i]!
      expect(node.point.x, `node ${i} x`).toBeCloseTo(was.point.x, 6)
      expect(node.point.y, `node ${i} y`).toBeCloseTo(was.point.y, 6)
      expect(node.handleOut.x, `node ${i} handle x`).toBeCloseTo(was.handleOut.x, 6)
      expect(node.handleOut.y, `node ${i} handle y`).toBeCloseTo(was.handleOut.y, 6)
    }
  })
})

describe('copying an outline', () => {
  it('shares nothing with the original', () => {
    // `duplicateObjects` spreads objects shallowly, so an outline held for the
    // length of a drag has to be a copy all the way down or two objects are
    // edited at once.
    const outline = pathToOutline(ELLIPSE)!
    const copy = copyOutline(outline)
    copy.subpaths[0]!.nodes[0]!.point.x = 9999
    copy.subpaths[0]!.nodes[0]!.handleIn.y = 9999
    expect(outline.subpaths[0]!.nodes[0]!.point.x).not.toBe(9999)
    expect(outline.subpaths[0]!.nodes[0]!.handleIn.y).not.toBe(9999)
  })
})
