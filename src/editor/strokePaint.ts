import { fillOf } from './paintFill'
import { Path, Rect as FabricRect, type FabricObject } from 'fabric'

import { dashArrayFor, strokeBand, strokePaint, strokeReach } from '../geometry/stroke'
import type { PositionedStroke, Rect, Stroke } from '../types/document'

/**
 * A border, as a Fabric object.
 *
 * The one place on the canvas side that knows how a position is achieved. Every
 * caller hands it a path and a stroke and gets back something to put in a
 * group; none of them knows there is a clip involved, which is what lets the
 * mechanism change without touching a single caller.
 *
 * ## Why it is its own object and not a stroke on the shape
 *
 * The shape's own Path carries the FILL. An outside border is drawn by clipping
 * away everything inside the outline — and a clip applies to the whole object,
 * so putting the stroke on the shape would clip its fill away with it. The
 * border is therefore always a separate, fill-less twin of the path it follows.
 *
 * ## How a position is achieved
 *
 * Canvas and Fabric only stroke down the CENTRE of a path. So:
 *
 * - centre: stroke at the asked width, no clip.
 * - inside: stroke at DOUBLE the width, clipped to the shape — the outer half
 *   falls outside the clip and the inner half is exactly the width asked for.
 * - outside: the same, with the clip inverted.
 *
 * Exact on curves, and O(1) per frame, which is what makes animating a border
 * affordable. The alternative — offsetting the path by half the width with the
 * clipper and stroking THAT centred — is exact too but flattens Béziers to
 * polygons and costs a WASM round trip per change. If the clip below ever
 * proves unreliable, that is the swap, and it happens here.
 */
export function strokeChild(pathData: string, stroke: PositionedStroke): FabricObject {
  const { width, clip } = strokePaint(stroke)

  const border = new Path(pathData, {
    fill: 'transparent',
    stroke: fillOf(stroke.colour),
    strokeWidth: width,
    strokeDashArray: dashArrayFor(stroke),
    /*
     * Scales with the object, unlike the placeholder hairline.
     *
     * The width is in object units like padding and the corner radii, so a
     * shape scaled to twice the size has a border twice as thick — which is
     * also what makes the export match, since it draws in object units under
     * one `ctx.scale`.
     */
    strokeUniform: false,
    /*
     * Cached, unlike everything else in this group — and it has to be.
     *
     * Fabric applies a clipPath by building a mask layer against the object's
     * CACHE context (`_drawClipPath` -> `createClipPathLayer`, which reads
     * `cacheTranslationX` and `zoomX` from it). With caching off the clip is
     * silently ignored: measured, an inside border grew the shape by its full
     * width on both sides, exactly as an outside one did, because both were
     * drawing the same doubled centred stroke with nothing cutting it.
     *
     * Only turned on where it is needed. A centred border needs no clip, so it
     * stays uncached like its neighbours and keeps updating live.
     */
    objectCaching: clip !== 'none',
    evented: false,
  })
  border.fillRule = 'nonzero'
  border.set('role', 'border')

  if (clip !== 'none') {
    /*
     * Built from the SAME path data, so the two share a bounding box and
     * therefore a centre — which is what lets the clip sit at the origin and
     * still line up. A clip on a Fabric child is positioned relative to that
     * child's own centre unless `absolutePositioned` is set.
     *
     * `nonzero` on the clip too, so a counter reads as outside the shape and a
     * border follows the hole correctly rather than filling it in.
     */
    const mask = new Path(pathData, {
      originX: 'center',
      originY: 'center',
      left: 0,
      top: 0,
      objectCaching: false,
    })
    mask.fillRule = 'nonzero'
    mask.inverted = clip === 'outside'
    border.clipPath = mask
  }

  return border
}

/**
 * The same, for a border that follows a rounded rectangle rather than a path.
 *
 * No clip at all here, and that is the difference. A rounded rect can be
 * OFFSET exactly by arithmetic — inflate it by d and raise its radius by d and
 * you have the original curve moved outward by d — so each position is simply a
 * different rectangle stroked down its centre. `strokeBand` does that sum.
 *
 * What the mosaic does need is room: its group is clipped to its own
 * silhouette, so a centred or outside band would be cut off at the curve. The
 * clip is grown by `strokeReach` to make exactly that room — see `mosaicClip`.
 *
 * Takes a null stroke and returns a rectangle of zero width. The mosaic keeps
 * this child attached whether or not there is a border, because playback
 * adjusts it per frame and a child appearing mid-transition would tear the
 * group's cache down exactly as a border faded in.
 */
export function strokeRect(
  box: Rect,
  radius: number,
  stroke: PositionedStroke | null,
): FabricObject {
  const band = stroke ? strokeBand(box, radius, stroke) : { box, radius }
  const border = new FabricRect({
    left: band.box.x + band.box.width / 2,
    top: band.box.y + band.box.height / 2,
    width: Math.max(0, band.box.width),
    height: Math.max(0, band.box.height),
    rx: Math.max(0, band.radius),
    ry: Math.max(0, band.radius),
    originX: 'center',
    originY: 'center',
    fill: 'transparent',
    stroke: fillOf(stroke?.colour),
    strokeWidth: stroke ? stroke.width : 0,
    strokeDashArray: dashArrayFor(stroke),
    strokeUniform: false,
    objectCaching: false,
    evented: false,
  })
  border.set('role', 'outline')
  return border
}

/**
 * The mosaic group's clip, with room for whatever the border needs.
 *
 * Grown by the border's outward reach and its radius raised to match, which is
 * the same curve offset outward — so the silhouette keeps its shape and only
 * makes room for the band. Everything the mosaic draws still stops at that
 * curve; nothing but the border ever reaches into the margin, and the border
 * covers it.
 */
export function mosaicClip(
  box: Rect,
  radius: number,
  stroke: PositionedStroke | null,
): { width: number; height: number; radius: number } {
  const reach = strokeReach(stroke)
  return {
    width: box.width + reach * 2,
    height: box.height + reach * 2,
    radius: Math.max(0, radius + reach),
  }
}

/**
 * Update one in place, for playback — the same fields, without rebuilding it.
 *
 * Typed structurally rather than as a `FabricObject` so that `mosaicPlayback`
 * can call it without importing Fabric's types, which it deliberately avoids:
 * it describes the handful of members it touches and nothing else, which is
 * what keeps a frame's hot path honest about what it is allowed to do.
 */
export function applyStroke(
  border: { set(values: Record<string, unknown>): void },
  stroke: Stroke | null,
): void {
  if (!stroke) {
    border.set({ stroke: 'transparent', strokeWidth: 0 })
    return
  }
  border.set({
    stroke: fillOf(stroke.colour),
    strokeWidth: stroke.width * 2,
    strokeDashArray: dashArrayFor(stroke),
  })
}
