import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import {
  EDGE_NAMES,
  buildStack,
  curveHandles,
  curvePoints,
  insertDivider,
  movePoint,
  stackCurves,
  type BoundaryStack,
  type CurveRef,
} from '../../src/editor/gridModel'
import { documentDefaults } from '../../src/state/defaults'
import type { GridDivider, TypographyObject, Vec2 } from '../../src/types/document'

const SHAPE = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(600, 400)
const MIN_GAP = 0.02

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

function object(): TypographyObject {
  const b = pathBounds(SHAPE)
  return {
    kind: 'typography',
    id: 'o1',
    name: 'r',
    originalSourcePath: SHAPE,
    currentSourcePath: SHAPE,
    simplifiedRenderPath: SHAPE,
    insetPath: null,
    localBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    geometryRevision: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: 'HELLO THERE',
    textFlowMode: 'word',
    fittingMode: 'boundary-warp',
    dividers: [],
    font: { ...documentDefaults.font },
    typography: { ...documentDefaults.typography },
    run: { ...documentDefaults.run },
    outline: null,
    distortion: { ...documentDefaults.distortion },
    appearance: { ...documentDefaults.appearance },
    animation: { ...documentDefaults.animation },
    seed: 1,
    visible: true,
    locked: false,
  } as TypographyObject
}

const stack = (): BoundaryStack =>
  buildStack(object(), [
    { top: 0, bottom: 0.5 },
    { top: 0.5, bottom: 1 },
  ])!

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('the grid editor’s handles', () => {
  it('offers one handle per corner, not two stacked on each other', () => {
    /*
     * Every corner is the end of two edges, and both keep a control point for
     * it — the Coons map needs that. The editor drew a handle for each, exactly
     * on top of the other, and there was no way to tell which one a press had
     * grabbed. The vertical edges no longer offer theirs.
     */
    const s = stack()
    const handles: Vec2[] = []
    for (const ref of stackCurves(s)) {
      for (const handle of curveHandles(s, ref)) handles.push(handle.point)
    }

    for (let i = 0; i < handles.length; i++) {
      for (let j = i + 1; j < handles.length; j++) {
        const a = handles[i]
        const b = handles[j]
        if (!a || !b) continue
        // Dividers legitimately END on the outer edges, so only the four
        // corners are checked here — those are the ones that were duplicated.
        const corner =
          Math.abs(Math.abs(a.x) - 300) < 1 && Math.abs(Math.abs(a.y) - 200) < 1
        if (corner) expect(distance(a, b), `two handles at ${a.x},${a.y}`).toBeGreaterThan(1)
      }
    }
  })

  it('moves a corner in both axes, not just one', () => {
    /*
     * An edge endpoint used to be pinned to its edge's value axis: a top corner
     * could be dragged up and down but not along, and a left corner along but
     * not up. It reads as a handle that is stuck, and there is no reason for it
     * — an edge runs between its corners and its table is rebuilt from them.
     */
    for (const edge of EDGE_NAMES) {
      const s = stack()
      const ref = { kind: 'edge', edge } as const
      const points = curvePoints(s, ref)
      for (const index of [0, points.length - 1]) {
        const from = points[index]
        if (!from) continue
        const moved = movePoint(s, ref, index, { x: from.x + 30, y: from.y + 25 }, MIN_GAP)
        expect(moved, `${edge}[${index}]`).not.toBeNull()
        const after = curvePoints(moved!.stack, ref)[index]
        expect(Math.abs(after!.x - from.x), `${edge}[${index}] x`).toBeGreaterThan(1)
        expect(Math.abs(after!.y - from.y), `${edge}[${index}] y`).toBeGreaterThan(1)
      }
    }
  })

  it('keeps both edges attached to a corner that moves', () => {
    // The other half of drawing one handle: it has to move both edges. Moving
    // only the one that was grabbed tore the outline open at the corner.
    const s = stack()
    const from = curvePoints(s, { kind: 'edge', edge: 'top' })[0]!
    const to = { x: from.x - 30, y: from.y - 25 }
    const moved = movePoint(s, { kind: 'edge', edge: 'top' }, 0, to, MIN_GAP)
    expect(moved).not.toBeNull()

    const top = curvePoints(moved!.stack, { kind: 'edge', edge: 'top' })[0]!
    const left = curvePoints(moved!.stack, { kind: 'edge', edge: 'left' })[0]!
    expect(distance(top, left)).toBeLessThan(0.01)
    expect(distance(moved!.stack.patch.corners.p00, top)).toBeLessThan(0.01)
    expect(moved!.edit.path).toBeTruthy()
  })

  it('will not let a corner cross the point next to it', () => {
    // Free in both axes, but not free to fold the edge back on itself.
    const s = stack()
    const top = curvePoints(s, { kind: 'edge', edge: 'top' })
    const inner = top[1]!
    const moved = movePoint(s, { kind: 'edge', edge: 'top' }, 0, { x: inner.x + 200, y: 0 }, MIN_GAP)
    expect(moved).not.toBeNull()
    expect(curvePoints(moved!.stack, { kind: 'edge', edge: 'top' })[0]!.x).toBeLessThan(inner.x)
  })
})

/**
 * The outer boundary is not the grid editor's to move.
 *
 * It used to be: the patch's four edges ARE the container's outline, so dragging
 * one rewrote the shape — through `patchToPath`, which emits seventy-two straight
 * segments a side. One drag turned a four-node circle into a 288-point polyline:
 * past the node limit, so the app put up a warning saying the shape could no
 * longer be edited by hand; a few pixels off where it had been; and heavier for
 * every animation frame, since the warp insets and subdivides that path sixty
 * times a second.
 *
 * The outline is edited as an outline now, by its own nodes, and the grid editor
 * offers only what it is actually for — the dividers. `stackCurves` is where that
 * is decided, and it is the only thing standing between an edge ref and
 * `patchToPath`, so it is worth saying out loud.
 */
describe('what the grid editor offers to drag', () => {
  it('offers the dividers and nothing else', () => {
    const s = stack()
    const refs = stackCurves(s)

    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((ref) => ref.kind === 'divider')).toBe(true)
    /*
     * Widened on purpose. `stackCurves` returns `DividerRef[]`, so the compiler
     * already refuses an edge here — putting one back would not build. This
     * checks the runtime answer as well, because the type is a promise about the
     * signature and this is a promise about the value.
     */
    expect((refs as CurveRef[]).some((ref) => ref.kind === 'edge')).toBe(false)
  })

  it('never asks the document to change the container path', () => {
    /*
     * Every `patchToPath` call in the model sits behind an early return for
     * dividers, so it is reachable only from an edge ref. With none offered, a
     * whole gesture cannot produce one.
     */
    const s = stack()
    for (const ref of stackCurves(s)) {
      for (const handle of curveHandles(s, ref)) {
        const moved = movePoint(s, ref, handle.index, { x: handle.point.x + 5, y: handle.point.y + 5 }, MIN_GAP)
        if (moved) expect(moved.edit.path, `${JSON.stringify(ref)}`).toBeNull()
      }
    }
  })
})

/**
 * A deformer put down does nothing until it is moved.
 *
 * `warp.ts` maps the type from where a deformer RESTS to where it now is, so a
 * deformer only deforms when those differ. A divider that does not say where it
 * rests is assumed to rest at an even split, `(i + 1) / (count + 1)` — which is
 * only true of one dropped exactly in the middle.
 *
 * Columns have always recorded it. Rows never did, so the moment a row cut
 * appeared at the real boundary between two lines — 0.32, say — the warp read
 * that as "dragged from 0.25 to 0.32" and shoved the type across to meet it.
 * Opening the grid on a shape and adding a single line re-flowed the whole
 * block, before anything had been dragged at all.
 */
describe('where a row deformer rests', () => {
  const rowsOf = (dividers: readonly GridDivider[]) =>
    dividers.filter((d) => (d.axis ?? 'row') === 'row')

  it('is written down for the cuts the editor opens with', () => {
    /*
     * These are materialised from the rows the engine actually laid out, so by
     * construction they are exactly where the type already is. Saying so is what
     * makes them a no-op.
     */
    const s = stack()
    const rows = rowsOf(s.dividers)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.rest, 'a materialised cut says where it rests').toBeDefined()
      expect(row.rest).toBeCloseTo(row.points[0]!.y, 6)
    }
  })

  it('is where a new row was put down, so putting it down changes nothing', () => {
    const s = stack()
    const before = new Set(rowsOf(s.dividers).map((d) => d.id))
    // Object space, which the model inverts into the patch's own (u, v) — so the
    // invariant is that it rests where it LANDED, not at the number passed in.
    const result = insertDivider(s, { x: 0.5, y: 0.7 }, 'row')
    expect(result).not.toBeNull()

    const added = rowsOf(result!.dividers).find((d) => !before.has(d.id))
    expect(added, 'a row was added').toBeDefined()
    expect(added!.rest, 'and it says where it rests').toBeDefined()
    expect(added!.rest).toBeCloseTo(added!.points[0]!.y, 6)
  })

  it('writes down the resting places of the rows already there', () => {
    /*
     * The same reason the column branch does it. Left implicit, every existing
     * row's assumed rest is `(i + 1) / (count + 1)` — which CHANGES when the new
     * one arrives and the count goes up, so adding a row would re-space every
     * other one and drag type nowhere near the click.
     */
    const s = stack()
    const before = rowsOf(s.dividers).map((d) => d.points[0]!.y)
    const result = insertDivider(s, { x: 0.5, y: 0.9 }, 'row')

    for (const row of rowsOf(result!.dividers)) {
      expect(row.rest, 'every row says where it rests').toBeDefined()
    }
    // And none of the originals was moved by the arrival of the new one.
    const after = rowsOf(result!.dividers).map((d) => d.points[0]!.y)
    for (const y of before) {
      expect(after.some((v) => Math.abs(v - y) < 1e-6), `row at ${y} kept its place`).toBe(true)
    }
  })
})
