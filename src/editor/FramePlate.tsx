import { Rect, type Canvas as FabricCanvas } from 'fabric'
import { useEffect } from 'react'

import { pointObjectToArtboard } from '../geometry/objectSpace'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { token } from './colours'
import { plateBounds } from './objectBarActions'
import { liveTransform } from './renderer'

/**
 * The plate behind a frame you have hold of.
 *
 * A rounded grey strip with a little padding, under the selected frame or the
 * one being worked inside — so the frame reads as a place laid out on the
 * page rather than a box drawn on it, the way a Figma frame's name and edge
 * set it apart from what is merely near it. Spread, the plate takes the whole
 * row in, and its top edge makes screen-sized room for the number chips;
 * collapsed there are no chips, so there is no extra room.
 *
 * Drawn once per frame and RE-PLACED before every render from the live
 * transform, so it follows a drag, a turn or a resize as it happens rather
 * than catching up when the gesture ends. `before:render` and not
 * `after:render`, because placing asks nothing to be redrawn and so cannot
 * start a loop. It sits under everything; the renderer's stacking pass keeps
 * it there.
 */
export function FramePlate({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: FrameObject | undefined
}) {
  const spread = useUiStore((s) => Boolean(object) && s.spreadFrame === object?.id)

  useEffect(() => {
    if (!canvas || !object) return

    const plate = new Rect({
      originX: 'left',
      originY: 'top',
      width: 1,
      height: 1,
      fill: token('--spread-plate', 'rgba(127, 127, 127, 0.18)'),
      selectable: false,
      evented: false,
      objectCaching: false,
      excludeFromExport: true,
    })
    plate.set('gridRole', 'frame-plate')

    const place = (): void => {
      const bounds = plateBounds(object, spread, canvas.getZoom() || 1)
      const transform = liveTransform(canvas, object.id, object.transform)
      const at = pointObjectToArtboard(transform, { x: bounds.x, y: bounds.y })
      const width = bounds.width * (transform.scaleX || 1)
      const height = bounds.height * (transform.scaleY || 1)
      const radius = Math.min(width, height) * 0.06
      plate.set({
        left: at.x,
        top: at.y,
        angle: transform.rotation,
        width,
        height,
        rx: radius,
        ry: radius,
      })
      plate.setCoords()
    }

    place()
    canvas.add(plate)
    canvas.sendObjectToBack(plate)
    canvas.on('before:render', place)
    canvas.requestRenderAll()
    return () => {
      canvas.off('before:render', place)
      canvas.remove(plate)
      canvas.requestRenderAll()
    }
  }, [canvas, object, spread])

  return null
}
