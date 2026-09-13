import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { useUiStore } from '../state/uiStore'
import { placeOnStage } from './canvasAnchor'
import { isStated } from '../types/document'
import { isExporting } from './liveCanvas'
import { beginObjectDrag, type ObjectDrag } from './objectDrag'
import { plateBounds } from './stated'
import { useSelectedObject } from './selection'
import './canvas.css'

/**
 * The selected object's name, floating just above its top-left corner.
 *
 * What Figma writes over a frame: the name of the thing you have hold of,
 * where your eye already is. In the selection green, because that is what it
 * says. HTML placed by the same maths as the bar and the chips, so it keeps
 * one size at every zoom; anything with states has its name above its PLATE
 * — which, spread, is the whole row and the room for the number chips, so
 * the name never sits on a chip — and everything else above its own box.
 *
 * And a handle: drag the name and the whole object comes with it, spread or
 * not — the way a frame is carried by its title in Figma. The pointer is
 * captured by the name, so the drag survives the pointer running ahead of it.
 */
export function ObjectLabel({ canvas }: { canvas: FabricCanvas | null }) {
  const { selected } = useSelectedObject()
  const spread = useUiStore((s) => (selected ? s.spread === selected.id : false))
  const zoom = useUiStore((s) => s.zoom)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<ObjectDrag | null>(null)

  const scene = (e: ReactPointerEvent<HTMLElement>) =>
    canvas ? canvas.getScenePoint(e.nativeEvent) : { x: e.clientX, y: e.clientY }
  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    if (!canvas || !selected || e.button !== 0) return
    const drag = beginObjectDrag(selected.id, scene(e))
    if (!drag) return
    dragRef.current = drag
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    dragRef.current?.move(scene(e), e.shiftKey)
  }
  const onPointerUp = (): void => {
    dragRef.current?.end()
    dragRef.current = null
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !dragRef.current) return
      e.stopImmediatePropagation()
      dragRef.current.cancel()
      dragRef.current = null
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  useEffect(() => {
    if (!canvas || !selected) {
      setAt(null)
      return
    }
    const place = (): void => {
      // A snapshot's render is not the screen's; see `isExporting`.
      if (isExporting()) return
      const box = isStated(selected)
        ? plateBounds(selected, spread, canvas.getZoom() || 1)
        : selected.localBounds
      const next = placeOnStage(canvas, selected, { x: box.x, y: box.y })
      setAt((previous) =>
        previous && next && Math.abs(previous.x - next.x) < 0.5 && Math.abs(previous.y - next.y) < 0.5
          ? previous
          : next,
      )
    }
    place()
    canvas.on('after:render', place)
    return () => {
      canvas.off('after:render', place)
    }
  }, [canvas, selected, spread, zoom])

  if (!selected || !at) return null
  return (
    <span
      className="object-label"
      style={{ left: at.x, top: at.y }}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {selected.name}
    </span>
  )
}
