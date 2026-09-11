import { useEffect, useState } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { useUiStore } from '../state/uiStore'
import { placeOnStage } from './canvasAnchor'
import { plateBounds } from './stated'
import { useSelectedObject } from './selection'
import './canvas.css'

/**
 * The selected object's name, floating just above its top-left corner.
 *
 * What Figma writes over a frame: the name of the thing you have hold of,
 * where your eye already is. In the selection green, because that is what it
 * says. HTML placed by the same maths as the bar and the chips, so it keeps
 * one size at every zoom; a frame's name sits above its plate (and so above
 * the spread's number chips), everything else's above its own box.
 */
export function ObjectLabel({ canvas }: { canvas: FabricCanvas | null }) {
  const { selected } = useSelectedObject()
  const spread = useUiStore((s) => (selected ? s.spread === selected.id : false))
  const zoom = useUiStore((s) => s.zoom)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!canvas || !selected) {
      setAt(null)
      return
    }
    const place = (): void => {
      const box =
        selected.kind === 'frame'
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
    <span className="object-label" style={{ left: at.x, top: at.y }} aria-hidden="true">
      {selected.name}
    </span>
  )
}
