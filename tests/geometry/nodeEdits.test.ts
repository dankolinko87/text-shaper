import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import {
  insertNodeOn,
  isSmoothAt,
  moveHandle,
  moveNode,
  moveNodes,
  nodesInPolygon,
  nodesWithin,
  pointInPolygon,
  outlineToPath,
  removeNode,
  removeNodes,
  toggleSmooth,
} from '../../src/geometry/outline'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { smoothPath } from '../../src/geometry/path'
import { samplePath } from '../../src/geometry/run'
import { strokeToLinePath, strokeToShapePath } from '../../src/geometry/strokeToPath'
import type { PathOutline, Vec2 } from '../../src/types/document'
import { blobStroke, drawnLineStroke, figureEightStroke } from '../fixtures/strokes'

/**
 * Editing a path by its nodes.
 *
 * The behaviour these are all circling: an edit should change the part of the
 * curve it is about and nothing else. That is the whole reason a path carries
 * handles rather than bare anchors — with anchors alone the curve has to be
 * re-guessed through them on every edit, and every point moves a little.
 */

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

function line(): PathOutline {
  const result = strokeToLinePath(drawnLineStroke('wave'))
  if (!result.ok) throw new Error('fixture line failed to convert')
  return result.outline
}

/**
 * Points along an outline's own cubics, evaluated here rather than through a
 * path string.
 *
 * Densely enough that a curve which moved anywhere would show it, and at full
 * precision, which is the point: the emitted path rounds to two places, so a
 * comparison made through it cannot tell an exact split from a nearly exact one.
 */
function walk(outline: PathOutline, per = 64): Vec2[] {
  const points: Vec2[] = []
  for (const subpath of outline.subpaths) {
    const nodes = subpath.nodes
    const steps = subpath.closed ? nodes.length : nodes.length - 1
    for (let i = 0; i < steps; i++) {
      const a = nodes[i]!
      const b = nodes[(i + 1) % nodes.length]!
      const p0 = a.point
      const p1 = { x: p0.x + a.handleOut.x, y: p0.y + a.handleOut.y }
      const p3 = b.point
      const p2 = { x: p3.x + b.handleIn.x, y: p3.y + b.handleIn.y }
      for (let k = 0; k <= per; k++) {
        const t = k / per
        const u = 1 - t
        points.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        })
      }
    }
  }
  return points
}

const len = (v: Vec2): number => Math.hypot(v.x, v.y)

/** How far off parallel two vectors are, as a share of their lengths. */
function parallel(a: Vec2, b: Vec2): number {
  const scale = len(a) * len(b)
  if (scale === 0) return len(a) === len(b) ? 0 : 1
  return Math.abs(a.x * b.y - a.y * b.x) / scale
}

function length(points: Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  }
  return total
}

/** The `M`/`L`/`C` commands of a path, one per element. */
function commands(data: string): string[] {
  return data.match(/[MLCZ][^MLCZ]*/g) ?? []
}

describe('moving a node', () => {
  it('leaves every segment it is not part of exactly as it was', () => {
    /*
     * The failure this replaces: the editor kept anchors only and rebuilt the
     * curve through them with `smoothPath` on every edit, so a tangent was
     * re-guessed at every point and dragging one reshaped the whole line.
     */
    const outline = line()
    const nodes = outline.subpaths[0]!.nodes
    expect(nodes.length, 'enough nodes to have a middle').toBeGreaterThan(3)

    const at = 2
    const before = commands(outlineToPath(outline))
    const after = commands(
      outlineToPath(
        moveNode(outline, { subpath: 0, node: at }, {
          x: nodes[at]!.point.x + 40,
          y: nodes[at]!.point.y - 25,
        }),
      ),
    )

    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      // Command `i` runs from node i-1 to node i, so only the two touching the
      // moved node may differ.
      const touches = i === at || i === at + 1
      if (touches) expect(after[i], `segment ${i} moved`).not.toBe(before[i])
      else expect(after[i], `segment ${i} left alone`).toBe(before[i])
    }
  })

  it('is a real improvement on rebuilding the curve from the anchors', () => {
    // The same edit the old way, to show the difference is not hypothetical:
    // re-smoothing a polyline through the anchors changes segments at the far
    // end of the line from the one that was touched.
    const outline = line()
    const nodes = outline.subpaths[0]!.nodes
    const polyline = (points: Vec2[]): string =>
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('')

    const anchors = nodes.map((n) => ({ ...n.point }))
    const before = commands(smoothPath(polyline(anchors)))
    anchors[2] = { x: anchors[2]!.x + 40, y: anchors[2]!.y - 25 }
    const after = commands(smoothPath(polyline(anchors)))

    const last = before.length - 1
    expect(after[last], 'the old way moves the far end too').not.toBe(before[last])
  })

  it('carries the handles with the anchor', () => {
    // They are measured FROM the anchor, so moving it must not reshape the
    // curve either side — the bend travels with the point.
    const outline = line()
    const node = outline.subpaths[0]!.nodes[1]!
    const moved = moveNode(outline, { subpath: 0, node: 1 }, { x: 500, y: 500 })
      .subpaths[0]!.nodes[1]!
    expect(moved.handleIn).toEqual(node.handleIn)
    expect(moved.handleOut).toEqual(node.handleOut)
  })
})

describe('dragging a handle', () => {
  it('turns the far side to match but does not restretch it', () => {
    /*
     * G1, not mirrored. The two sides of a fitted curve are rarely the same
     * length, and forcing them equal would reshape the neighbouring segment
     * every time the user touched this one.
     */
    const outline = line()
    const ref = { subpath: 0, node: 2 }
    const node = outline.subpaths[0]!.nodes[2]!
    expect(node.smooth, 'a fitted interior node is smooth').toBe(true)
    const wasOut = Math.hypot(node.handleOut.x, node.handleOut.y)

    const edited = moveHandle(outline, ref, 'in', { x: -60, y: 60 }).subpaths[0]!.nodes[2]!
    expect(edited.handleIn).toEqual({ x: -60, y: 60 })
    expect(Math.hypot(edited.handleOut.x, edited.handleOut.y), 'kept its length').toBeCloseTo(
      wasOut,
      6,
    )
    expect(isSmoothAt(edited), 'still runs through smoothly').toBe(true)
    expect(edited.smooth).toBe(true)
  })

  it('leaves a corner\'s other side alone', () => {
    const outline = line()
    const ref = { subpath: 0, node: 2 }
    const corner = toggleSmooth(outline, ref)
    const was = corner.subpaths[0]!.nodes[2]!.handleOut

    const edited = moveHandle(corner, ref, 'in', { x: -60, y: 60 }).subpaths[0]!.nodes[2]!
    expect(edited.handleOut).toEqual(was)
    expect(edited.smooth).toBe(false)
  })

  it('breaks the point when asked, and says so in the flag', () => {
    const outline = line()
    const ref = { subpath: 0, node: 2 }
    const was = outline.subpaths[0]!.nodes[2]!.handleOut

    const edited = moveHandle(outline, ref, 'in', { x: -60, y: 60 }, true).subpaths[0]!.nodes[2]!
    expect(edited.handleOut, 'the far side stays put').toEqual(was)
    expect(edited.smooth, 'and the node is no longer smooth').toBe(false)
  })

  it('does not collapse the far side when a handle is dragged onto its anchor', () => {
    const outline = line()
    const ref = { subpath: 0, node: 2 }
    const was = outline.subpaths[0]!.nodes[2]!.handleOut
    const edited = moveHandle(outline, ref, 'in', { x: 0, y: 0 }).subpaths[0]!.nodes[2]!
    expect(edited.handleOut).toEqual(was)
  })
})

describe('changing what a point is', () => {
  it('makes a smooth point a corner without straightening anything', () => {
    /*
     * Zeroing the handles would straighten both neighbouring segments, which is
     * a much bigger change than the one asked for: the point becomes free to
     * kink, it does not become a kink.
     */
    const outline = line()
    const before = outlineToPath(outline)
    const cornered = toggleSmooth(outline, { subpath: 0, node: 2 })
    expect(cornered.subpaths[0]!.nodes[2]!.smooth).toBe(false)
    expect(outlineToPath(cornered), 'the curve is untouched').toBe(before)
  })

  it('gives a corner handles along the chord between its neighbours', () => {
    const outline = line()
    const ref = { subpath: 0, node: 2 }
    const cornered = toggleSmooth(outline, ref)
    const smoothed = toggleSmooth(cornered, ref)
    const node = smoothed.subpaths[0]!.nodes[2]!

    expect(node.smooth).toBe(true)
    expect(isSmoothAt(node), 'the flag is not a lie').toBe(true)

    const nodes = smoothed.subpaths[0]!.nodes
    const chord = {
      x: nodes[3]!.point.x - nodes[1]!.point.x,
      y: nodes[3]!.point.y - nodes[1]!.point.y,
    }
    const cross = node.handleOut.x * chord.y - node.handleOut.y * chord.x
    expect(Math.abs(cross) / (Math.hypot(chord.x, chord.y) * Math.hypot(node.handleOut.x, node.handleOut.y))).toBeLessThan(1e-9)
  })

  it('does nothing at an open path\'s end, where there is no kink to take out', () => {
    const outline = line()
    const last = outline.subpaths[0]!.nodes.length - 1
    expect(toggleSmooth(outline, { subpath: 0, node: 0 })).toBe(outline)
    expect(toggleSmooth(outline, { subpath: 0, node: last })).toBe(outline)
  })
})

describe('inserting a node', () => {
  it('does not move the curve', () => {
    /*
     * The exact property, and the reason this goes through `divideAtTime`
     * rather than splicing an anchor in: de Casteljau splits one cubic into two
     * that trace the same path, and it fixes up the NEIGHBOURS' handles — the
     * part a hand-rolled insert forgets, and why adding a point used to shift
     * the whole line.
     *
     * Asked of the NODES, because that is where the claim can actually be
     * settled. A comparison through the emitted path could only ever prove the
     * curve moved by less than the two decimal places it is written at, and a
     * comparison between sampled points cannot resolve below its own spacing.
     * What a split promises is precise and checkable directly: nothing but the
     * two segments either side of it changes at all, and those two keep their
     * anchors and their tangent DIRECTIONS, losing only handle length.
     */
    const outline = line()
    const nodes = outline.subpaths[0]!.nodes
    const at = walk(outline)[Math.floor(walk(outline).length / 2)]!

    const result = insertNodeOn(outline, at, 5)
    expect(result, 'found the curve').not.toBeNull()
    const after = result!.outline.subpaths[0]!.nodes
    const put = result!.ref.node
    expect(after.length).toBe(nodes.length + 1)

    for (let i = 0; i < nodes.length; i++) {
      const moved = after[i < put ? i : i + 1]!
      const was = nodes[i]!
      expect(moved.point, `node ${i} stayed put`).toEqual(was.point)

      const touching = i === put - 1 || i === put
      if (!touching) {
        expect(moved.handleIn, `node ${i} handleIn untouched`).toEqual(was.handleIn)
        expect(moved.handleOut, `node ${i} handleOut untouched`).toEqual(was.handleOut)
        continue
      }
      // The split shortens the handle facing it and leaves the other side
      // alone, which is what keeps the curve identical either way from here.
      const facing = i === put - 1 ? 'handleOut' : 'handleIn'
      const away = i === put - 1 ? 'handleIn' : 'handleOut'
      expect(moved[away], `node ${i} far side untouched`).toEqual(was[away])
      expect(parallel(moved[facing], was[facing]), `node ${i} tangent turned`).toBeLessThan(1e-12)
      expect(len(moved[facing]), `node ${i} handle grew`).toBeLessThan(len(was[facing]) + 1e-9)
    }

    // And the new node sits ON the curve, smoothly: a split point is never a
    // corner.
    expect(isSmoothAt(after[put]!)).toBe(true)

    // A global check that no arithmetic went astray anywhere: an exact split
    // leaves the arc length alone, and a splice does not.
    expect(Math.abs(length(walk(result!.outline, 512)) / length(walk(outline, 512)) - 1)).toBeLessThan(
      1e-6,
    )
  })

  it('puts the new node between the two it was clicked between', () => {
    const outline = line()
    const nodes = outline.subpaths[0]!.nodes
    const before = nodes.map((n) => ({ ...n.point }))

    const samples = samplePath(outlineToPath(outline), 1)!
    const result = insertNodeOn(outline, samples[Math.floor(samples.length * 0.25)]!, 5)!
    const after = result.outline.subpaths[0]!.nodes

    expect(result.ref.node).toBeGreaterThan(0)
    expect(result.ref.node).toBeLessThan(after.length - 1)
    // Every original anchor is still there, in order, with the new one spliced
    // in — so the node the user grabs next is the one they think it is.
    const withoutNew = after.filter((_, i) => i !== result.ref.node).map((n) => n.point)
    expect(withoutNew).toEqual(before)
  })

  it('keeps a corner a corner on the other side of the insert', () => {
    // The flags are AUTHORED. A node someone made a corner must not quietly
    // become smooth again because the curve through it looks straight enough.
    const outline = toggleSmooth(line(), { subpath: 0, node: 3 })
    expect(outline.subpaths[0]!.nodes[3]!.smooth).toBe(false)

    const samples = samplePath(outlineToPath(outline), 1)!
    const result = insertNodeOn(outline, samples[2]!, 5)!
    expect(result.ref.node, 'inserted before the corner').toBeLessThan(3)
    expect(result.outline.subpaths[0]!.nodes[4]!.smooth, 'the corner moved along').toBe(false)
  })

  it('refuses a point that is nowhere near the curve', () => {
    expect(insertNodeOn(line(), { x: 9000, y: 9000 }, 5)).toBeNull()
  })

  it('finds the right lobe of a shape with more than one', () => {
    const eight = strokeToShapePath(figureEightStroke())
    if (!eight.ok) throw new Error('fixture shape failed to convert')
    const counts = eight.outline.subpaths.map((s) => s.nodes.length)

    // Between two of the second lobe's nodes, not on one: there is already a
    // node where a node is, and `insertNodeOn` rightly refuses to stack another.
    const nodes = eight.outline.subpaths[1]!.nodes
    const second = {
      x: (nodes[0]!.point.x + nodes[1]!.point.x) / 2,
      y: (nodes[0]!.point.y + nodes[1]!.point.y) / 2,
    }
    const result = insertNodeOn(eight.outline, second, 40)
    expect(result, 'found it').not.toBeNull()
    expect(result!.ref.subpath).toBe(1)
    expect(result!.outline.subpaths.map((s) => s.nodes.length)).toEqual(
      counts.map((n, i) => (i === 1 ? n + 1 : n)),
    )
  })
})

describe('removing a node', () => {
  it('takes one away and leaves the rest alone', () => {
    const outline = line()
    const nodes = outline.subpaths[0]!.nodes
    const kept = removeNode(outline, { subpath: 0, node: 1 })!
    expect(kept.subpaths[0]!.nodes.map((n) => n.point)).toEqual(
      nodes.filter((_, i) => i !== 1).map((n) => n.point),
    )
  })

  it('refuses the last two, so a curve still runs between two points', () => {
    const outline: PathOutline = {
      subpaths: [
        {
          closed: false,
          nodes: [
            { point: { x: 0, y: 0 }, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 }, smooth: false },
            { point: { x: 10, y: 0 }, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 }, smooth: false },
          ],
        },
      ],
    }
    expect(removeNode(outline, { subpath: 0, node: 0 })).toBeNull()
  })

  it('drops a whole lobe that runs out, but never the last one', () => {
    // A shape with two contours can lose one and still be a shape. A shape with
    // one cannot — there would be nothing left to select.
    const blob = strokeToShapePath(blobStroke())
    if (!blob.ok) throw new Error('fixture shape failed to convert')
    const two: PathOutline = {
      subpaths: [
        blob.outline.subpaths[0]!,
        {
          closed: true,
          nodes: blob.outline.subpaths[0]!.nodes.slice(0, 2).map((n) => ({ ...n })),
        },
      ],
    }
    const kept = removeNode(two, { subpath: 1, node: 0 })
    expect(kept!.subpaths.length).toBe(1)
    expect(removeNode(kept!, { subpath: 0, node: 0 })!.subpaths[0]!.nodes.length).toBe(
      blob.outline.subpaths[0]!.nodes.length - 1,
    )
  })

  it('refuses a node that is not there', () => {
    expect(removeNode(line(), { subpath: 4, node: 0 })).toBeNull()
    expect(removeNode(line(), { subpath: 0, node: 99 })).toBeNull()
  })
})

/**
 * Several nodes at once: a picked set dragged, nudged or deleted as a body.
 */
describe('moving several nodes', () => {
  it('carries each picked anchor and its handles by the same offset, and nothing else', () => {
    const before = line()
    const refs = [
      { subpath: 0, node: 1 },
      { subpath: 0, node: 2 },
    ]
    const after = moveNodes(before, refs, { x: 7, y: -3 })
    before.subpaths[0]!.nodes.forEach((node, i) => {
      const moved = after.subpaths[0]!.nodes[i]!
      const picked = refs.some((ref) => ref.node === i)
      expect(moved.point.x).toBeCloseTo(node.point.x + (picked ? 7 : 0), 9)
      expect(moved.point.y).toBeCloseTo(node.point.y + (picked ? -3 : 0), 9)
      expect(moved.handleIn).toEqual(node.handleIn)
      expect(moved.handleOut).toEqual(node.handleOut)
    })
  })

  it('is the outline itself for no refs or no offset', () => {
    const before = line()
    expect(moveNodes(before, [], { x: 1, y: 1 })).toBe(before)
    expect(moveNodes(before, [{ subpath: 0, node: 0 }], { x: 0, y: 0 })).toBe(before)
  })
})

describe('removing several nodes', () => {
  it('takes them all away whatever order they were picked in', () => {
    const before = line()
    const count = before.subpaths[0]!.nodes.length
    const kept = removeNodes(before, [
      { subpath: 0, node: 1 },
      { subpath: 0, node: count - 1 },
      { subpath: 0, node: 3 },
    ])!
    expect(kept.subpaths[0]!.nodes).toHaveLength(count - 3)
    // The survivors are the ones not named, in their old order.
    const survivors = before.subpaths[0]!.nodes.filter((_, i) => ![1, 3, count - 1].includes(i))
    expect(kept.subpaths[0]!.nodes.map((n) => n.point)).toEqual(survivors.map((n) => n.point))
  })

  it('stops at the floor and says so when nothing could go', () => {
    const before = line()
    const all = before.subpaths[0]!.nodes.map((_, i) => ({ subpath: 0, node: i }))
    const kept = removeNodes(before, all)!
    expect(kept.subpaths[0]!.nodes).toHaveLength(2)
    expect(removeNodes(kept, [{ subpath: 0, node: 0 }])).toBeNull()
    expect(removeNodes(before, [])).toBeNull()
  })
})

describe('the nodes inside a box', () => {
  it('names every anchor inside, corners in any order, edges included', () => {
    const outline: PathOutline = {
      subpaths: [
        {
          closed: false,
          nodes: [10, 20, 30, 40].map((x) => ({
            point: { x, y: x },
            handleIn: { x: 0, y: 0 },
            handleOut: { x: 0, y: 0 },
            smooth: false,
          })),
        },
      ],
    }
    expect(nodesWithin(outline, { x: 35, y: 35 }, { x: 20, y: 20 })).toEqual([
      { subpath: 0, node: 1 },
      { subpath: 0, node: 2 },
    ])
    expect(nodesWithin(outline, { x: 0, y: 0 }, { x: 5, y: 5 })).toEqual([])
  })
})

describe('the nodes inside a lasso', () => {
  const loop = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 20, y: 20 },
    { x: 20, y: 40 },
    { x: 0, y: 40 },
  ]
  it('is inside an L-shaped loop where the loop actually is', () => {
    expect(pointInPolygon({ x: 10, y: 10 }, loop)).toBe(true)
    expect(pointInPolygon({ x: 10, y: 30 }, loop)).toBe(true)
    expect(pointInPolygon({ x: 30, y: 30 }, loop), 'the notch is outside').toBe(false)
    expect(pointInPolygon({ x: 50, y: 10 }, loop)).toBe(false)
  })
  it('names the anchors the loop takes in, and none for a loop too short to close', () => {
    const outline: PathOutline = {
      subpaths: [
        {
          closed: false,
          nodes: [
            { x: 10, y: 10 },
            { x: 30, y: 30 },
            { x: 10, y: 30 },
          ].map((point) => ({ point, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 }, smooth: false })),
        },
      ],
    }
    expect(nodesInPolygon(outline, loop)).toEqual([
      { subpath: 0, node: 0 },
      { subpath: 0, node: 2 },
    ])
    expect(nodesInPolygon(outline, loop.slice(0, 2))).toEqual([])
  })
})
