import { describe, expect, it } from 'vitest'

import {
  closePen,
  constrain,
  dropStray,
  penClosesAt,
  penDown,
  penDrag,
  penOutline,
  retractPen,
  reverseNodes,
  shapingIndex,
  startPen,
  type PenState,
} from '../../src/editor/penModel'
import type { PathNode } from '../../src/types/document'

/**
 * What a click means, asked without a canvas.
 *
 * A pen is a gesture spanning many press-release cycles, which is the kind of
 * thing that is impossible to be sure of by clicking around and straightforward
 * to be sure of here.
 */

describe('drawing with the pen', () => {
  it('leaves corners where it was clicked', () => {
    let state = startPen()
    state = penDown(state, { x: 0, y: 0 })
    state = penDown(state, { x: 100, y: 0 })
    state = penDown(state, { x: 100, y: 80 })

    expect(state.nodes.map((n) => n.point)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ])
    expect(state.nodes.every((n) => !n.smooth), 'a click alone is a corner').toBe(true)
    expect(penOutline(state)!.subpaths[0]!.closed).toBe(false)
  })

  it('turns the node into a smooth one when the press is dragged', () => {
    /*
     * Mirrored, and this is the one place in the codebase where the two sides
     * are forced equal. A node being born under the pointer has no shape on its
     * far side to preserve, so symmetry is the only sensible guess — and it is
     * what every pen does.
     */
    let state = penDown(startPen(), { x: 50, y: 50 })
    state = penDrag(state, { x: 80, y: 50 })

    const node = state.nodes[0]!
    expect(node.handleOut).toEqual({ x: 30, y: 0 })
    expect(node.handleIn).toEqual({ x: -30, y: 0 })
    expect(node.smooth).toBe(true)
  })

  it('pulls one handle only when the drag is broken', () => {
    // How a curve is started out of a corner: the segment behind stays straight.
    let state = penDown(startPen(), { x: 50, y: 50 })
    state = penDrag(state, { x: 80, y: 50 }, true)

    const node = state.nodes[0]!
    expect(node.handleOut).toEqual({ x: 30, y: 0 })
    expect(node.handleIn).toEqual({ x: 0, y: 0 })
    expect(node.smooth).toBe(false)
  })

  it('follows the pointer while the press is still down', () => {
    // Every move during one press rewrites the same handle rather than adding.
    let state = penDown(startPen(), { x: 0, y: 0 })
    state = penDrag(state, { x: 10, y: 0 })
    state = penDrag(state, { x: 40, y: 10 })
    expect(state.nodes.length).toBe(1)
    expect(state.nodes[0]!.handleOut).toEqual({ x: 40, y: 10 })
  })
})

describe('closing the run', () => {
  it('closes on the first node once there is an area to close', () => {
    let state = startPen()
    for (const at of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]) {
      state = penDown(state, at)
    }
    expect(penClosesAt(state, { x: 3, y: 2 }, 6), 'on the first node').toBe(true)
    expect(penClosesAt(state, { x: 40, y: 40 }, 6), 'nowhere near it').toBe(false)
  })

  it('will not close two nodes into a shape', () => {
    // Two nodes and a closing segment is a line drawn twice, not a shape.
    let state = penDown(startPen(), { x: 0, y: 0 })
    state = penDown(state, { x: 100, y: 0 })
    expect(penClosesAt(state, { x: 0, y: 0 }, 6)).toBe(false)
  })

  it('stops taking nodes once it is closed', () => {
    let state = startPen()
    for (const at of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]) {
      state = penDown(state, at)
    }
    state = closePen(state)
    expect(penDown(state, { x: 50, y: 50 }).nodes.length).toBe(3)
    expect(penOutline(state)!.subpaths[0]!.closed).toBe(true)
  })
})

describe('finishing on a double-click', () => {
  it('takes back the node the second press left behind', () => {
    /*
     * A double-click is two full press-release cycles and THEN a `dblclick`, so
     * by the time "finish here" arrives the pen has already put a stray node
     * down on top of the last one. Nothing about that order can be changed, so
     * it is taken back instead.
     */
    let state = startPen()
    for (const at of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]) {
      state = penDown(state, at)
    }
    const stray = penDown(state, { x: 100, y: 80 })
    expect(dropStray(stray).nodes).toEqual(state.nodes)
  })

  it('will not strip a run down to nothing', () => {
    const state = penDown(startPen(), { x: 0, y: 0 })
    expect(dropStray(state).nodes.length).toBe(1)
  })
})

describe('a run that is not a path yet', () => {
  it('has no outline until there are two nodes', () => {
    expect(penOutline(startPen())).toBeNull()
    expect(penOutline(penDown(startPen(), { x: 0, y: 0 }))).toBeNull()
    expect(penOutline(penDown(penDown(startPen(), { x: 0, y: 0 }), { x: 9, y: 9 }))).not.toBeNull()
  })

  it('hands out a copy, so the state cannot be edited through it', () => {
    let state = penDown(startPen(), { x: 0, y: 0 })
    state = penDown(state, { x: 10, y: 10 })
    const outline = penOutline(state)!
    outline.subpaths[0]!.nodes[0]!.point.x = 999
    expect(state.nodes[0]!.point.x).toBe(0)
  })
})

describe('extending a path from its other end', () => {
  it('swaps the handles as well as the order', () => {
    /*
     * `handleIn` describes the curve arriving at a node and `handleOut` the
     * curve leaving it, so reversing the direction of travel swaps which is
     * which. Reversing the order alone turns every curve inside out.
     */
    const nodes: PathNode[] = [
      { point: { x: 0, y: 0 }, handleIn: { x: -1, y: -1 }, handleOut: { x: 5, y: 0 }, smooth: true },
      { point: { x: 50, y: 0 }, handleIn: { x: -8, y: 0 }, handleOut: { x: 8, y: 3 }, smooth: true },
      { point: { x: 90, y: 20 }, handleIn: { x: -4, y: -4 }, handleOut: { x: 0, y: 0 }, smooth: false },
    ]
    const back = reverseNodes(nodes)

    expect(back.map((n) => n.point)).toEqual([
      { x: 90, y: 20 },
      { x: 50, y: 0 },
      { x: 0, y: 0 },
    ])
    expect(back[0]!.handleIn).toEqual({ x: 0, y: 0 })
    expect(back[0]!.handleOut).toEqual({ x: -4, y: -4 })
    expect(back[1]!.handleIn).toEqual({ x: 8, y: 3 })
    expect(back[1]!.handleOut).toEqual({ x: -8, y: 0 })
    expect(back.map((n) => n.smooth)).toEqual([false, true, true])
  })

  it('is its own inverse', () => {
    const nodes: PathNode[] = [
      { point: { x: 0, y: 0 }, handleIn: { x: -1, y: -2 }, handleOut: { x: 5, y: 1 }, smooth: true },
      { point: { x: 40, y: 9 }, handleIn: { x: -6, y: 0 }, handleOut: { x: 2, y: 2 }, smooth: false },
    ]
    expect(reverseNodes(reverseNodes(nodes))).toEqual(nodes)
  })

  it('remembers which object it is continuing', () => {
    const state = startPen('obj-7', [
      { point: { x: 0, y: 0 }, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 }, smooth: false },
    ])
    expect(state.extending).toBe('obj-7')
    expect(penDown(state, { x: 10, y: 0 }).extending).toBe('obj-7')
  })
})

/**
 * Taking back an anchor, which Backspace does while drawing.
 *
 * Without it a misplaced point could only be escaped by throwing the whole run
 * away and starting again.
 */
describe('retracting the pen', () => {
  it('takes back the last node', () => {
    const state = penDown(penDown(startPen(), { x: 0, y: 0 }), { x: 10, y: 0 })

    expect(retractPen(state).nodes.map((n) => n.point)).toEqual([{ x: 0, y: 0 }])
  })

  it('will empty the run, unlike dropping a stray', () => {
    // Taking back the only node left is how a path begun by accident is
    // abandoned; refusing would leave an anchor no key could remove.
    const one = penDown(startPen(), { x: 0, y: 0 })

    expect(retractPen(one).nodes).toHaveLength(0)
    expect(dropStray(one).nodes).toHaveLength(1)
  })

  it('opens a run that had been closed', () => {
    // The node being removed is the one that closed it, so leaving the flag set
    // would describe a shape whose last side is missing.
    let state = startPen()
    for (const point of [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]) {
      state = penDown(state, point)
    }
    state = closePen(state)

    expect(retractPen(state).closed).toBe(false)
  })

  it('does nothing to an empty run', () => {
    expect(retractPen(startPen()).nodes).toHaveLength(0)
  })
})

/**
 * Shift, which snaps a direction without arguing about distance.
 */
describe('the 45° constraint', () => {
  const from = { x: 100, y: 100 }

  it('snaps a nearly-horizontal aim flat', () => {
    const at = constrain(from, { x: 200, y: 108 })

    expect(at.y).toBeCloseTo(100, 6)
    expect(at.x).toBeGreaterThan(from.x)
  })

  it('snaps a nearly-diagonal aim to the diagonal', () => {
    const at = constrain(from, { x: 180, y: 172 })

    expect(at.x - from.x).toBeCloseTo(at.y - from.y, 6)
  })

  it('keeps the distance rather than projecting onto the ray', () => {
    /*
     * Projecting would make the shape shrink as the pointer wandered off the
     * axis, which reads as the tool fighting back. Only the angle is snapped.
     */
    const target = { x: 200, y: 108 }
    const at = constrain(from, target)
    const asked = Math.hypot(target.x - from.x, target.y - from.y)

    expect(Math.hypot(at.x - from.x, at.y - from.y)).toBeCloseTo(asked, 6)
  })

  it('leaves a pointer sitting on the anchor alone', () => {
    // No direction to snap, and atan2 of nothing is not an angle.
    expect(constrain(from, from)).toEqual(from)
  })

  it('reaches every eighth of the circle', () => {
    const angles = new Set<number>()
    for (let degrees = 0; degrees < 360; degrees += 7) {
      const radians = (degrees * Math.PI) / 180
      const at = constrain(from, {
        x: from.x + Math.cos(radians) * 50,
        y: from.y + Math.sin(radians) * 50,
      })
      const snapped = Math.atan2(at.y - from.y, at.x - from.x)
      angles.add(Math.round((snapped * 180) / Math.PI))
    }

    // Eight rays, and nothing between them.
    expect(angles.size).toBe(8)
    for (const angle of angles) expect(Math.abs(angle) % 45).toBe(0)
  })
})

/**
 * The press that closes a run is still a drag.
 *
 * Closing used to commit the moment the button went down, which made the final
 * segment the one piece of a path that could not be curved while it was drawn.
 * Held open until release, the same drag that shapes every other node shapes the
 * closing one — and the node it shapes is the FIRST, whose `handleIn` is the
 * curve arriving from the last node.
 */
describe('shaping the closing segment', () => {
  const triangle = (): PenState => {
    let state = startPen()
    for (const point of [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]) {
      state = penDown(state, point)
    }
    return state
  }

  it('shapes the last node while the run is open', () => {
    const state = triangle()

    expect(shapingIndex(state)).toBe(state.nodes.length - 1)
  })

  it('shapes the FIRST node once the run is closed', () => {
    expect(shapingIndex(closePen(triangle()))).toBe(0)
  })

  it('pulls the first node’s handles, leaving the last node alone', () => {
    const closed = closePen(triangle())
    const dragged = penDrag(closed, { x: 40, y: -30 })

    expect(dragged.nodes[0]?.handleOut).toEqual({ x: 40, y: -30 })
    // Mirrored, so the closing segment arrives along the same line it leaves on.
    expect(dragged.nodes[0]?.handleIn).toEqual({ x: -40, y: 30 })
    expect(dragged.nodes[0]?.smooth).toBe(true)
    expect(dragged.nodes[2]?.handleOut).toEqual({ x: 0, y: 0 })
  })

  it('stays closed through the drag', () => {
    // The run ends when the press is released, not when it moves.
    expect(penDrag(closePen(triangle()), { x: 40, y: -30 }).closed).toBe(true)
  })

  it('still refuses to take new nodes while closed', () => {
    const closed = closePen(triangle())

    expect(penDown(closed, { x: 5, y: 5 }).nodes).toHaveLength(3)
  })
})
