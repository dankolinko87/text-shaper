import { Rect, type Canvas as FabricCanvas } from 'fabric'
import { useEffect, useRef } from 'react'

import { pointObjectToArtboard } from '../geometry/objectSpace'
import { useUiStore } from '../state/uiStore'
import type { Stated } from '../types/document'
import { token } from './colours'
import { beginObjectDrag, type ObjectDrag } from './objectDrag'
import { plateBounds } from './stated'
import { liveTransform } from './renderer'

/**
 * The plate behind a thing with states that you have hold of: a frame, or a
 * mosaic.
 *
 * A grey strip under the selected object or the frame being worked inside —
 * so it reads as a place laid out on the page rather than a box drawn on it,
 * the way a Figma frame's name and edge set it apart from what is merely near
 * it. Spread, the plate takes the whole row in with padding round it, and its
 * top edge makes screen-sized room for the number chips; collapsed it is
 * exactly the object's box. Square: the rounded corners belong to the ground
 * an EMPTY object stands on when nothing holds it (`groundRadius`), and while
 * the plate is here it is that ground.
 *
 * Drawn once per canvas and RE-PLACED before every render from the live
 * transform, so it follows a drag, a turn or a resize as it happens rather
 * than catching up when the gesture ends. `before:render` and not
 * `after:render`, because placing asks nothing to be redrawn and so cannot
 * start a loop. It sits under everything; the renderer's stacking pass keeps
 * it there.
 *
 * It is also a HANDLE: a press on the plate drags the whole object — every
 * window of a spread row — since the plate is the one place that is plainly
 * the object and not one of its states. Not selectable, so Fabric never
 * treats the plate as a thing of its own; the press is turned into a drag of
 * the object by `beginObjectDrag`, and the marquee is kept from starting.
 * The handlers live as long as the canvas and read the object through a ref:
 * the drag writes the document as it goes, and an effect keyed on the object
 * would tear its own drag down on the first move.
 */
export function FramePlate({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: Stated | undefined
}) {
  const spread = useUiStore((s) => Boolean(object) && s.spread === object?.id)
  const objectRef = useRef<Stated | undefined>(object)
  const spreadRef = useRef(spread)

  /* What the plate stands for, as of the latest render; the handlers below read these. */
  useEffect(() => {
    objectRef.current = object
    spreadRef.current = spread
    canvas?.requestRenderAll()
  }, [canvas, object, spread])

  useEffect(() => {
    if (!canvas) return

    const plate = new Rect({
      originX: 'left',
      originY: 'top',
      width: 1,
      height: 1,
      fill: token('--spread-plate', 'rgba(127, 127, 127, 0.18)'),
      selectable: false,
      evented: true,
      hoverCursor: 'move',
      objectCaching: false,
      excludeFromExport: true,
      visible: false,
    })
    plate.set('gridRole', 'frame-plate')

    const place = (): void => {
      const held = objectRef.current
      if (!held) {
        if (plate.visible) plate.set({ visible: false })
        return
      }
      const bounds = plateBounds(held, spreadRef.current, canvas.getZoom() || 1)
      const transform = liveTransform(canvas, held.id, held.transform)
      const at = pointObjectToArtboard(transform, { x: bounds.x, y: bounds.y })
      const width = bounds.width * (transform.scaleX || 1)
      const height = bounds.height * (transform.scaleY || 1)
      plate.set({
        visible: true,
        left: at.x,
        top: at.y,
        angle: transform.rotation,
        width,
        height,
      })
      plate.setCoords()
    }

    /* A press on the plate is a drag of the object. */
    let drag: ObjectDrag | null = null
    let selectionWas: boolean | null = null
    const onDownBefore = (opt: { target?: unknown }): void => {
      if (opt.target !== plate) return
      // Fabric decides on the marquee before it says `mouse:down`; told here, it does not.
      selectionWas = canvas.selection
      canvas.selection = false
    }
    const onDown = (opt: { target?: unknown; e: Event }): void => {
      const held = objectRef.current
      if (opt.target !== plate || !held) return
      drag = beginObjectDrag(held.id, canvas.getScenePoint(opt.e as MouseEvent))
    }
    const onMove = (opt: { e: Event }): void => {
      const mouse = opt.e as MouseEvent
      drag?.move(canvas.getScenePoint(mouse), mouse.shiftKey)
    }
    const release = (): void => {
      if (selectionWas !== null) {
        canvas.selection = selectionWas
        selectionWas = null
      }
      drag?.end()
      drag = null
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !drag) return
      e.stopImmediatePropagation()
      drag.cancel()
      drag = null
    }

    place()
    canvas.add(plate)
    canvas.sendObjectToBack(plate)
    canvas.on('before:render', place)
    canvas.on('mouse:down:before', onDownBefore)
    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('keydown', onKey, { capture: true })
    canvas.requestRenderAll()
    return () => {
      canvas.off('before:render', place)
      canvas.off('mouse:down:before', onDownBefore)
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('keydown', onKey, { capture: true })
      release()
      canvas.remove(plate)
      canvas.requestRenderAll()
    }
  }, [canvas])

  return null
}
