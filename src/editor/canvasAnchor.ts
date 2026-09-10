import { useEffect, useState } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { pointObjectToArtboard } from '../geometry/objectSpace'
import { token } from './colours'
import { liveTransform } from './renderer'
import type { DocumentObject, Rect } from '../types/document'

/**
 * Where to put an HTML control that has to follow an object on the canvas.
 *
 * Controls like the state selector are HTML rather than canvas artwork on
 * purpose: they must stay one size at every zoom, take a hover and focus, and
 * open real menus. What they give up by not being drawn into the scene is
 * knowing where they are, which is what this works out.
 *
 * Shared by every such control so they cannot come to disagree about where the
 * object's bottom edge is — and so a fix to the tracking is a fix for all of
 * them at once.
 */

export interface Placement {
  left: number
  top: number
}

/** How far from the object a control floats, in screen pixels. */
const GAP = 9

/**
 * A point in an object's own space, as a position on the stage in pixels.
 *
 * Through the object's transform and then the viewport's — so a control follows
 * an object that has been moved, scaled or turned, without turning with it.
 *
 * The LIVE transform, not the stored one. Fabric only writes a drag back to the
 * document when the gesture ends, so reading the document mid-drag left the
 * control behind and made it jump on release.
 */
export function placeOnStage(
  canvas: FabricCanvas,
  object: DocumentObject,
  point: { x: number; y: number },
): { x: number; y: number } | null {
  const element = canvas.getElement()
  const stage = element.closest('.canvas-stage')
  const view = canvas.viewportTransform
  if (!stage || !view) return null
  const at = pointObjectToArtboard(liveTransform(canvas, object.id, object.transform), point)
  const canvasBox = element.getBoundingClientRect()
  const stageBox = stage.getBoundingClientRect()
  return {
    x: at.x * view[0] + view[4] + canvasBox.left - stageBox.left,
    y: at.y * view[3] + view[5] + canvasBox.top - stageBox.top,
  }
}

/**
 * Below the object — unless that would run into the tool pill, and then above.
 *
 * A flip, the way every tooltip and menu already behaves, rather than a clamp:
 * clamping parks the control over the artwork with no object under it, and
 * hiding loses it on exactly the large object that sits low. `limit` is the
 * lowest the control's bottom edge may reach; `Infinity` when there is nothing
 * to keep clear of.
 */
export function placeControl(foot: number, head: number, height: number, limit: number): number {
  const below = foot + GAP
  return below + height <= limit ? below : head - GAP - height
}

/** The top of the tool pill in stage pixels, less the gap — the band no control enters. */
function pillLimit(stage: Element): number {
  const pill = stage.parentElement?.querySelector(':scope > .toolbar')
  if (!pill) return Number.POSITIVE_INFINITY
  return pill.getBoundingClientRect().top - stage.getBoundingClientRect().top - GAP
}

export function useCanvasAnchor(
  canvas: FabricCanvas | null,
  object: DocumentObject | undefined,
  /** The box to hang from, when it is not the object's own — a spread frame's whole row. */
  bounds?: Rect,
): Placement | null {
  const [at, setAt] = useState<Placement | null>(null)

  const id = object?.id
  const bx = bounds?.x
  const by = bounds?.y
  const bw = bounds?.width
  const bh = bounds?.height
  useEffect(() => {
    if (!canvas || !object) {
      setAt(null)
      return
    }

    const place = (): void => {
      const stage = canvas.getElement().closest('.canvas-stage')
      if (!stage) return
      const box =
        bx !== undefined && by !== undefined && bw !== undefined && bh !== undefined
          ? { x: bx, y: by, width: bw, height: bh }
          : object.localBounds
      const x = box.x + box.width / 2
      const foot = placeOnStage(canvas, object, { x, y: box.y + box.height })
      const head = placeOnStage(canvas, object, { x, y: box.y })
      if (!foot || !head) return

      // The control's own height, as the stylesheet has it — CSS owns the number.
      const height = parseFloat(token('--pill-height', '32px')) || 32
      const next = {
        left: foot.x,
        top: placeControl(foot.y, head.y, height, pillLimit(stage)),
      }

      // Only when it has actually moved. This runs on every canvas render, and
      // during playback that is sixty times a second.
      setAt((previous) =>
        previous &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5
          ? previous
          : next,
      )
    }

    place()
    canvas.on('after:render', place)
    return () => {
      canvas.off('after:render', place)
    }
  }, [canvas, object, id, bx, by, bw, bh])

  return at
}
