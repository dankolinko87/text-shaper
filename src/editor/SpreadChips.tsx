import { useEffect, useState } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { placeOnStage } from './canvasAnchor'
import { showFrameState } from './frameStates'
import { windowOffset } from './renderer'
import './canvas.css'

/**
 * A number over each window of a spread frame.
 *
 * The row shows every state at once, and a row of identical windows is a row
 * of things you cannot tell apart — which state is which is the one thing the
 * spread exists to show. The chip on the state being shown is inverted, and
 * pressing a chip shows that state, so the row answers the question and takes
 * the answer too.
 *
 * HTML, placed by the same maths as the bar, so the chips keep one size at
 * every zoom; each hangs off its window's top-left corner through the frame's
 * transform, so a moved or turned frame carries them with it.
 */
export function SpreadChips({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: FrameObject | undefined
}) {
  const spread = useUiStore((s) => (object ? s.spreadFrame === object.id : false))
  const shown = useUiStore((s) => (object ? (s.mosaicStates[object.id] ?? 0) : 0))
  const [places, setPlaces] = useState<({ x: number; y: number } | null)[]>([])

  useEffect(() => {
    if (!canvas || !object || !spread) {
      setPlaces([])
      return
    }
    const place = (): void => {
      const box = object.localBounds
      const scale = object.transform.scaleX || 1
      const next = object.states.map((_, i) =>
        placeOnStage(canvas, object, { x: box.x + windowOffset(object, i) / scale, y: box.y }),
      )
      // Only when something has actually moved; this runs on every render.
      setPlaces((previous) =>
        previous.length === next.length &&
        previous.every((was, i) => {
          const is = next[i]
          return was && is && Math.abs(was.x - is.x) < 0.5 && Math.abs(was.y - is.y) < 0.5
        })
          ? previous
          : next,
      )
    }
    place()
    canvas.on('after:render', place)
    return () => {
      canvas.off('after:render', place)
    }
  }, [canvas, object, spread])

  if (!object || !spread) return null
  const index = Math.min(shown, object.states.length - 1)

  return (
    <>
      {places.map((at, i) =>
        at ? (
          <button
            key={object.states[i]?.id ?? i}
            type="button"
            className="spread-chip"
            data-shown={i === index}
            style={{ left: at.x, top: at.y }}
            aria-label={`Show state ${i + 1}`}
            aria-pressed={i === index}
            onClick={() => showFrameState(object, i)}
          >
            {i + 1}
          </button>
        ) : null,
      )}
    </>
  )
}
