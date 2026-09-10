import { Group, type Canvas as FabricCanvas, type FabricObject } from 'fabric'

import { pointObjectToArtboard } from '../geometry/objectSpace'
import type { FrameObject, Rect, Vec2 } from '../types/document'
import { liveTransform } from './renderer'

/**
 * Where each member of a frame actually is on the ARTBOARD.
 *
 * Read off what was drawn rather than worked out from `localBounds`, and that
 * part matters: a member group is built from its artwork and centred on that,
 * so a shape whose path does not fill its declared bounds is somewhere else and
 * a different size. Fabric knows where it put the artwork; the document only
 * knows what it asked for.
 *
 * `getCoords()` answers in the scene, applying the group's transform on the way
 * out — but only for a child whose own corner cache is current, and THAT is
 * what was wrong. Fabric caches `aCoords` and re-bases a child's `left`/`top`
 * when the group lays itself out to fit its content; a child whose coordinates
 * were computed before that re-basing keeps them, so `getCoords()` faithfully
 * transforms stale numbers and returns a position the member has not been in
 * since the group was built. Measured: a member reported 1050 where it was
 * drawn at 800, while the frame's own plate — which Fabric happened to refresh
 * — reported its 200 correctly. That is why the outlines sat away from the
 * shapes and no click ever landed on a member.
 *
 * So the corners are refreshed before they are read. `setCoords()` is Fabric's
 * own answer to exactly this and costs a matrix per member.
 *
 * Reading Fabric rather than recomputing from the document is deliberate: after
 * the refresh this is the drawn truth, including the frame's live position mid
 * drag — Fabric moves a group as the pointer moves and writes the result back
 * only when the gesture ends, so boxes derived from the stored transform would
 * trail the frame across the canvas.
 */
export function memberBoxes(group: FabricObject | undefined): Map<string, Rect> {
  const out = new Map<string, Rect>()
  // The GROUP, handed in — the registry knows it; scanning the canvas for the
  // frame's id is what stops working the moment a frame is drawn more than once.
  if (!(group instanceof Group)) return out

  for (const child of group.getObjects()) {
    const memberId = child.get('memberId') as string | undefined
    if (!memberId) continue

    child.setCoords()
    /*
     * All four corners, then their extent — never a corner pair.
     *
     * A rotated frame turns its members' boxes with it, so the top-left of the
     * box is not the top-left of anything Fabric reports. The extent of the
     * four points is the upright box that actually contains the member, which
     * is what an axis-aligned outline and a rectangular hit test need.
     */
    const corners = child.getCoords()
    const xs = corners.map((point) => point.x)
    const ys = corners.map((point) => point.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    out.set(memberId, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y })
  }

  return out
}

/** The frame's own box, on the artboard, as a run of four corners. */
export function frameCorners(canvas: FabricCanvas | null, frame: FrameObject): Vec2[] {
  const transform = liveTransform(canvas, frame.id, frame.transform)
  const b = frame.localBounds
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ].map((point) => pointObjectToArtboard(transform, point))
}
