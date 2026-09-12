import { dashArrayFor, strokePaint } from '../geometry/stroke'
import { styleOf } from './paintStyle'
import type { PositionedStroke, Rect, Stroke } from '../types/document'

/**
 * A border, drawn onto a canvas — the export's half of `editor/strokePaint.ts`.
 *
 * The same three cases and the same reasoning, expressed in the other API. Both
 * exist because the canvas and the exporters do not share a drawing layer; they
 * are kept beside one another in the plan and in review precisely so the three
 * cases cannot drift apart.
 *
 * The caller has already applied the object's transform to `ctx`, so widths are
 * in object units here exactly as they are on the canvas.
 */
export function strokeOnContext(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  stroke: PositionedStroke | Stroke,
  /** The area being drawn into, for the inverted clip. In the same units as the path. */
  frame: Rect,
): void {
  if (!(stroke.width > 0)) return
  const { width, clip } = strokePaint(stroke)

  ctx.save()

  if (clip !== 'none') {
    /*
     * Canvas has no inverted clip, so an outside border is the even-odd trick:
     * a region covering everything, with the shape punched out of it. Inside is
     * the plain case — clip to the shape itself.
     *
     * `nonzero` on the plain clip so a counter reads as outside the shape and
     * the border follows a hole correctly, matching the fill's own rule.
     */
    if (clip === 'inside') {
      ctx.clip(path, 'nonzero')
    } else {
      const outside = new Path2D()
      outside.rect(frame.x, frame.y, frame.width, frame.height)
      outside.addPath(path)
      ctx.clip(outside, 'evenodd')
    }
  }

  const dash = dashArrayFor(stroke)
  ctx.setLineDash(dash ?? [])
  ctx.lineWidth = width
  ctx.strokeStyle = styleOf(ctx, stroke.colour, frame)
  ctx.stroke(path)

  ctx.restore()
}
