import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { pathDeviation, pathToOutline, refitDensePath } from '../../src/geometry/outline'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { subdividePath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import type { PathOutline } from '../../src/types/document'

/**
 * Making a dense path editable again — when that can be done honestly.
 *
 * The grid rewrites an edge as a polyline of several hundred points, and a shape
 * in that state has no points anyone can take hold of. The same Bézier fit that
 * turns a captured stroke into a handful of anchors will reduce it — but paper's
 * fitter distorts a closed path near its seam, so the reduction has to be
 * measured and thrown away when it costs the drawing.
 */

const REFIT_TOLERANCE = 0.2
const REFIT_DRIFT = 1

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

const countNodes = (outline: PathOutline): number =>
  outline.subpaths.reduce((n, s) => n + s.nodes.length, 0)

const ellipse = (): string => PRIMITIVES.find((p) => p.id === 'ellipse')!.build(480, 480)

describe('measuring how far two paths are apart', () => {
  it('is zero for a path against itself', () => {
    expect(pathDeviation(ellipse(), ellipse())).toBeLessThan(0.01)
  })

  it('notices a corner cut off, which a bounding box would not', () => {
    /*
     * The reason this is symmetric and sampled rather than a comparison of
     * boxes: a path can sit entirely inside another's bounds and still be a
     * different shape.
     */
    const circle = ellipse()
    const square = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(480, 480)
    expect(pathDeviation(circle, square)).toBeGreaterThan(50)
  })
})

describe('refitting a flattened shape', () => {
  /** A shape in the state the grid leaves one in: hundreds of straight steps. */
  const dense = (): string => subdividePath(ellipse(), 4)

  it('refuses a reduction that would move the shape', () => {
    /*
     * The case that decides the design. paper's fitter pulls a closed path
     * around at its seam — measured at over two per cent of a circle's width,
     * at every tolerance — so this reduction is available and is turned down.
     */
    const before = pathToOutline(dense())!
    expect(countNodes(before), 'dense enough to be a problem').toBeGreaterThan(120)
    expect(refitDensePath(dense(), REFIT_TOLERANCE, REFIT_DRIFT), 'not at that price').toBeNull()
  })

  it('takes one that stays put', () => {
    // The same reduction with the drift allowance opened up: it exists, and it
    // really is a large reduction — what it is not is free.
    const taken = refitDensePath(dense(), REFIT_TOLERANCE, 50)
    expect(taken, 'available when affordable').not.toBeNull()
    expect(countNodes(taken!.outline)).toBeLessThan(countNodes(pathToOutline(dense())!) / 4)
    expect(pathDeviation(dense(), taken!.path)).toBeLessThan(50)
  })

  it('refuses when there is nothing to gain', () => {
    // An ellipse is four nodes already. Refitting one would be an edit with no
    // purpose, and null is how that is said.
    expect(refitDensePath(ellipse(), REFIT_TOLERANCE, REFIT_DRIFT)).toBeNull()
  })

  it('refuses what is not a path', () => {
    expect(refitDensePath('', REFIT_TOLERANCE, REFIT_DRIFT)).toBeNull()
    expect(refitDensePath('M10 10', REFIT_TOLERANCE, REFIT_DRIFT)).toBeNull()
  })
})
