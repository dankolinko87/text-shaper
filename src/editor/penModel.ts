import type { PathNode, PathOutline, Vec2 } from '../types/document'

/**
 * The pen's state machine, with no canvas in it.
 *
 * Split out for the same reason `gridModel` is: a pen is a multi-click gesture
 * spanning many press-release cycles, and that is exactly the kind of thing that
 * is impossible to be sure of by clicking around and easy to be sure of in a
 * test. `PenLayer` owns the pixels and the events; everything about what a click
 * MEANS lives here.
 *
 * Points are in ARTBOARD space throughout. The object does not exist yet, so
 * there is no object space to be in — `finishPen` is where the drawing is
 * recentred and becomes geometry.
 */

/** Screen pixels the pointer must travel before a press is a handle drag. */
export const PEN_DRAG_THRESHOLD = 3

export interface PenState {
  nodes: PathNode[]
  /**
   * The object being extended, when the pen was armed on an existing open path.
   *
   * The pen may continue a path and close it onto itself; it may not join two
   * different paths. That is what keeps endpoint hit-testing confined to one
   * object, and it is the difference between a hit test over two points and a
   * hit test over every path in the document.
   */
  extending: string | null
  /** True once the run has been brought back round to its own start. */
  closed: boolean
}

export function startPen(extending: string | null = null, nodes: PathNode[] = []): PenState {
  return { nodes: nodes.map(copy), extending, closed: false }
}

const copy = (node: PathNode): PathNode => ({
  point: { ...node.point },
  handleIn: { ...node.handleIn },
  handleOut: { ...node.handleOut },
  smooth: node.smooth,
})

const corner = (at: Vec2): PathNode => ({
  point: { ...at },
  handleIn: { x: 0, y: 0 },
  handleOut: { x: 0, y: 0 },
  smooth: false,
})

/** Put a corner down. A drag afterwards is what turns it into a smooth point. */
export function penDown(state: PenState, at: Vec2): PenState {
  if (state.closed) return state
  return { ...state, nodes: [...state.nodes, corner(at)] }
}

/**
 * Pull a handle out of the node just placed.
 *
 * The pointer drags `handleOut`, and `handleIn` MIRRORS it — the one place in
 * this codebase where the two sides are forced equal, and rightly: a node being
 * born under the pointer has no existing shape on its far side to preserve, so
 * symmetry is the only sensible guess and it is what every pen does.
 *
 * `breaking` (Alt) pulls out only the forward handle, which leaves the segment
 * behind the node straight and is how a curve is started out of a corner.
 */
export function penDrag(state: PenState, at: Vec2, breaking = false): PenState {
  const index = shapingIndex(state)
  const node = state.nodes[index]
  if (!node) return state

  const out = { x: at.x - node.point.x, y: at.y - node.point.y }
  const next = [...state.nodes]
  next[index] = {
    ...copy(node),
    handleOut: out,
    // `0 - v` rather than `-v`: negating a zero gives -0, which is harmless
    // arithmetically and an odd thing to find in a saved document.
    handleIn: breaking ? { ...node.handleIn } : { x: 0 - out.x, y: 0 - out.y },
    smooth: !breaking,
  }
  return { ...state, nodes: next }
}

/**
 * Which node the press currently down is shaping.
 *
 * The last one, normally — you place a node and drag its handle out of it. But
 * the press that CLOSES a run lands on the first node, and that node is what the
 * closing drag shapes: its `handleIn` is the curve arriving from the last node,
 * which is the segment being drawn at that moment.
 *
 * Closing used to commit on the press, so this question never came up and the
 * final segment was always a straight snap — the one part of a path that could
 * not be curved as it was drawn.
 */
export function shapingIndex(state: PenState): number {
  return state.closed ? 0 : state.nodes.length - 1
}

/** Whether a press at `at` lands on the run's first node, closing it. */
export function penClosesAt(state: PenState, at: Vec2, reach: number): boolean {
  const first = state.nodes[0]
  if (!first || state.nodes.length < 3) return false
  return Math.hypot(at.x - first.point.x, at.y - first.point.y) <= reach
}

/**
 * Bring the run round to its own start.
 *
 * Closing is not the end of the gesture: the press that closes may still be
 * dragged, and while it is, `shapingIndex` points at the first node so the
 * closing segment can be curved like any other. The run is finished when that
 * press is released.
 */
export function closePen(state: PenState): PenState {
  return { ...state, closed: true }
}

/**
 * Drop the node a double-click's second press left behind.
 *
 * A double-click is two full press-release cycles and THEN a `dblclick`, so by
 * the time "finish here" arrives the pen has already put a stray node down on
 * top of the last one. Nothing about the event order can be changed, so it is
 * taken back instead.
 */
export function dropStray(state: PenState): PenState {
  if (state.nodes.length < 2) return state
  return { ...state, nodes: state.nodes.slice(0, -1) }
}

/**
 * Take back the last node, the way Backspace does while drawing.
 *
 * Unlike `dropStray` this is allowed to empty the run: taking back the only node
 * left is how you abandon a path you have just started, and refusing would leave
 * a single anchor on screen that no key can remove.
 *
 * A run that had been closed is opened again — the node being removed is the one
 * that closed it, so leaving the flag set would describe a shape whose last side
 * is missing.
 */
export function retractPen(state: PenState): PenState {
  if (state.nodes.length === 0) return state
  return { ...state, nodes: state.nodes.slice(0, -1), closed: false }
}

/**
 * The nearest point to `to` that lies on a 45° ray out of `from`.
 *
 * What Shift means everywhere a direction is being chosen: placing the next
 * anchor square to the last one, and pulling a handle out along an axis or a
 * diagonal. The DISTANCE is kept and only the angle is snapped, so the pointer
 * still says how far — projecting onto the ray instead would make the shape
 * shrink as the pointer wandered off the axis, which reads as the tool fighting
 * back.
 */
export function constrain(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1e-9) return { x: to.x, y: to.y }
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: from.x + Math.cos(angle) * distance, y: from.y + Math.sin(angle) * distance }
}

/** The run as an outline, or null when there is not enough of it to be a path. */
export function penOutline(state: PenState): PathOutline | null {
  if (state.nodes.length < 2) return null
  return { subpaths: [{ nodes: state.nodes.map(copy), closed: state.closed }] }
}

/**
 * Turn a path round, so the pen can extend it from its other end.
 *
 * Both the ORDER and the two handles on every node: `handleIn` describes the
 * curve arriving at a node and `handleOut` the curve leaving it, and reversing
 * the direction of travel swaps which is which. Reversing the order alone would
 * turn every curve inside out.
 */
export function reverseNodes(nodes: readonly PathNode[]): PathNode[] {
  return [...nodes].reverse().map((node) => ({
    point: { ...node.point },
    handleIn: { ...node.handleOut },
    handleOut: { ...node.handleIn },
    smooth: node.smooth,
  }))
}
