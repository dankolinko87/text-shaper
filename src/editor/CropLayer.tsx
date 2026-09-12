import { FabricImage, Polygon, Rect, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useRef } from 'react'

import { cropFromDelta, cropZoomed, placementOf } from '../geometry/imagePlacement'
import { objectToArtboard } from '../geometry/objectSpace'
import { applyToPoint, applyToVector, decompose, invert, multiply } from '../geometry/transform'
import type { Mat2D } from '../types/geometry'
import { cropBoxFor, cropPaintFor, type CropTarget } from '../state/cropModel'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { DocumentObject, Rect as Box, Transform2D, Vec2 } from '../types/document'
import { selectionColour } from './colours'
import { imageFor, sizeOf } from './imageCache'
import { isExporting } from './liveCanvas'
import { isStated } from '../types/document'
import { liveTransform } from './renderer'
import { shownTransform } from './stated'
import { isTextEntry } from './useShortcuts'

/** A corner handle's half size, and how near a press must land, in screen pixels. */
const HANDLE = 4
const HANDLE_HIT = 8
/** An arrow key moves the picture this share of its box; ten times that with Shift. */
const NUDGE = 0.01

/**
 * Cropping a picture where it is painted, on the canvas.
 *
 * The fill on the canvas shows the picture as cropped. This layer shows the
 * REST of it — the whole picture, dimmed, everywhere outside the box the
 * fill covers — with a frame round it and a handle at each corner. Drag the
 * picture to pan the crop; drag a corner to zoom it about the box's middle;
 * the arrows nudge it; Enter or Escape leave, as does a press outside it.
 * Every move writes the crop to the document as it goes, so the fill on the
 * canvas follows the hand, and the history hears about it once on release.
 *
 * The same overlay technique as the point editor: Fabric objects drawn onto
 * the canvas, never into the document; handlers registered once and reading
 * their live values through a ref.
 */
export function CropLayer({
  canvas,
  target,
  object,
  host,
  textPath,
  bandPath,
}: {
  canvas: FabricCanvas | null
  target: CropTarget | null
  /** The object the target names, on the artboard or inside a frame. */
  object: DocumentObject | undefined
  /** The frame's transform, for a member drawn inside one. */
  host?: Transform2D | undefined
  textPath?: string | undefined
  bandPath?: string | undefined
}) {
  const doc = useDocumentStore((s) => s.doc)
  const shapesRef = useRef<FabricObject[]>([])

  const paint = target ? cropPaintFor(doc, target) : null
  const box = target ? cropBoxFor(doc, target, { textPath, bandPath }) : null
  const source = paint ? imageFor(paint.asset) : null
  const active = Boolean(target && object && paint && box && source)

  /* Keep the live values the handlers read, without re-registering them. */
  const liveRef = useRef({ target, active, paint, box, source, object, host })
  liveRef.current = { target, active, paint, box, source, object, host }

  /* A target that has lost its picture or its box is put down. */
  useEffect(() => {
    if (target && !active) useUiStore.getState().setCroppingPaint(null)
  }, [target, active])

  /*
   * Object space to the artboard, as of NOW: read through the live ref, since
   * the handlers below are registered once and would otherwise keep the object
   * this component first rendered with — which was nothing.
   */
  const toArtboardMat = (): Mat2D => {
    const { object: own, host: within } = liveRef.current
    if (!own || !canvas) return [1, 0, 0, 1, 0, 0]
    const transform = isStated(own)
      ? shownTransform(canvas, own)
      : liveTransform(canvas, own.id, own.transform)
    return within ? multiply(objectToArtboard(within), objectToArtboard(transform)) : objectToArtboard(transform)
  }

  /* Draw the picture, its frame and its handles. */
  useEffect(() => {
    if (!canvas) return
    const clear = (): void => {
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }
    clear()
    if (!active || !paint || !box || !source) {
      canvas.requestRenderAll()
      return
    }
    const zoom = canvas.getZoom() || 1
    const add = (shape: FabricObject): void => {
      shape.set('gridRole', 'crop')
      canvas.add(shape)
      shapesRef.current.push(shape)
    }
    const shared = { selectable: false, evented: false, objectCaching: false, excludeFromExport: true } as const

    const mat = toArtboardMat()
    const t = decompose(mat)
    const size = sizeOf(source)
    const place = placementOf(box, size, paint.crop)
    const picture: Box = { x: box.x + place.x, y: box.y + place.y, width: place.width, height: place.height }
    const corners = [
      { x: picture.x, y: picture.y },
      { x: picture.x + picture.width, y: picture.y },
      { x: picture.x + picture.width, y: picture.y + picture.height },
      { x: picture.x, y: picture.y + picture.height },
    ].map((p) => applyToPoint(mat, p))

    /*
     * The whole picture, dimmed, with the fill's own box cut OUT of it: inside
     * the box the canvas already draws the crop, and drawing it again on top
     * would only muddy it. The clip is in the picture's own pixels, about its
     * centre, which is where Fabric measures a clip from.
     */
    const image = new FabricImage(source as unknown as HTMLImageElement, {
      ...shared,
      left: corners[0]!.x,
      top: corners[0]!.y,
      originX: 'left',
      originY: 'top',
      scaleX: place.scale * t.scaleX,
      scaleY: place.scale * t.scaleY,
      angle: t.rotation,
      opacity: 0.4,
    })
    const clip = new Rect({
      left: -size.width / 2 - place.x / place.scale,
      top: -size.height / 2 - place.y / place.scale,
      width: box.width / place.scale,
      height: box.height / place.scale,
      originX: 'left',
      originY: 'top',
      objectCaching: false,
    })
    clip.inverted = true
    image.clipPath = clip
    add(image)

    add(
      new Polygon(corners, {
        ...shared,
        fill: 'transparent',
        stroke: selectionColour(),
        strokeWidth: 1 / zoom,
        strokeUniform: true,
        strokeDashArray: [4 / zoom, 3 / zoom],
      }),
    )
    corners.forEach((corner, index) => {
      const handle = new Rect({
        ...shared,
        left: corner.x,
        top: corner.y,
        width: (HANDLE * 2) / zoom,
        height: (HANDLE * 2) / zoom,
        originX: 'center',
        originY: 'center',
        fill: '#ffffff',
        stroke: selectionColour(),
        strokeWidth: 1 / zoom,
      })
      handle.set('cropCorner', index)
      add(handle)
    })
    canvas.requestRenderAll()
    return clear
    // The transform is read live from the canvas; the deps say when the picture or its crop changed.
  }, [canvas, active, paint, box, source, object, host])

  useEffect(() => {
    if (!canvas) return
    let grab: { kind: 'pan' | 'corner'; last: Vec2; changed: boolean } | null = null

    const leave = (): void => useUiStore.getState().setCroppingPaint(null)

    const onDown = (opt: { e: Event }): void => {
      const { target: held, active: on, box: theBox, paint: thePaint, source: theSource } = liveRef.current
      if (!on || !held || !theBox || !thePaint || !theSource) return
      if (isExporting()) return
      const scene = canvas.getScenePoint(opt.e as MouseEvent)
      const zoom = canvas.getZoom() || 1
      const mat = toArtboardMat()
      const reach = HANDLE_HIT / zoom
      for (const shape of shapesRef.current) {
        if (shape.get('cropCorner') === undefined) continue
        if (Math.hypot(shape.left - scene.x, shape.top - scene.y) <= reach) {
          grab = { kind: 'corner', last: scene, changed: false }
          useUiStore.getState().setInteracting(held.objectId)
          return
        }
      }
      const local = applyToPoint(invert(mat), scene)
      const place = placementOf(theBox, sizeOf(theSource), thePaint.crop)
      const inside =
        local.x >= theBox.x + place.x &&
        local.x <= theBox.x + place.x + place.width &&
        local.y >= theBox.y + place.y &&
        local.y <= theBox.y + place.y + place.height
      if (!inside) {
        leave()
        return
      }
      grab = { kind: 'pan', last: scene, changed: false }
      useUiStore.getState().setInteracting(held.objectId)
    }

    const onMove = (opt: { e: Event }): void => {
      const { target: held, box: theBox } = liveRef.current
      if (!grab || !held || !theBox) return
      const scene = canvas.getScenePoint(opt.e as MouseEvent)
      const mat = toArtboardMat()
      const store = useDocumentStore.getState()
      if (grab.kind === 'pan') {
        const delta = applyToVector(invert(mat), { x: scene.x - grab.last.x, y: scene.y - grab.last.y })
        store.editPaintCrop(held, (crop) => cropFromDelta(crop, theBox, delta.x, delta.y))
      } else {
        const centre = applyToPoint(mat, { x: theBox.x + theBox.width / 2, y: theBox.y + theBox.height / 2 })
        const was = Math.hypot(grab.last.x - centre.x, grab.last.y - centre.y)
        const now = Math.hypot(scene.x - centre.x, scene.y - centre.y)
        if (was > 1e-6) store.editPaintCrop(held, (crop) => cropZoomed(crop, now / was))
      }
      grab.last = scene
      grab.changed = true
    }

    const release = (): void => {
      if (!grab) return
      const changed = grab.changed
      grab = null
      useUiStore.getState().setInteracting(null)
      if (changed) useDocumentStore.getState().commit('Crop picture')
    }

    const onKey = (e: KeyboardEvent): void => {
      const { target: held, active: on, box: theBox } = liveRef.current
      if (!on || !held || !theBox || isTextEntry(e.target)) return
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        leave()
        return
      }
      const step = (e.shiftKey ? NUDGE * 10 : NUDGE)
      const nudge =
        e.key === 'ArrowLeft'
          ? { x: -step, y: 0 }
          : e.key === 'ArrowRight'
            ? { x: step, y: 0 }
            : e.key === 'ArrowUp'
              ? { x: 0, y: -step }
              : e.key === 'ArrowDown'
                ? { x: 0, y: step }
                : null
      if (!nudge) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const store = useDocumentStore.getState()
      store.editPaintCrop(held, (crop) => ({ ...crop, x: crop.x + nudge.x, y: crop.y + nudge.y }))
      store.commit('Nudge picture')
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('keydown', onKey, { capture: true })
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas])

  return null
}
