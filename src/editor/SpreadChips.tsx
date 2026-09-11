import { useEffect, useState } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { FRAME_MAX_STATES } from '../types/frame'
import { placeOnStage } from './canvasAnchor'
import { duplicateFrameStateAt, showFrameState } from './frameStates'
import { windowOffset } from './renderer'
import './canvas.css'

/**
 * The HTML that rides on a spread frame's row: a number over each window, and
 * a + in every gap and after the last window.
 *
 * The numbers: a row of identical windows is a row of things you cannot tell
 * apart, and which state is which is the one thing the spread exists to show.
 * The chip on the state being shown is inverted, and pressing a chip shows
 * that state.
 *
 * The pluses: laying every keyframe out is exactly when you can see that one
 * is missing, and where. A + in the gap after window N makes a copy of state N
 * right there, which is what "add one between these two" means; the one after
 * the last window grows the row at its end.
 *
 * HTML, placed by the same maths as the bar, so everything keeps one size at
 * every zoom; each hangs off a point of its window through the frame's
 * transform, so a moved or turned frame carries them with it.
 */

interface Point {
  x: number
  y: number
}

export function SpreadChips({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: FrameObject | undefined
}) {
  const spread = useUiStore((s) => (object ? s.spreadFrame === object.id : false))
  const shown = useUiStore((s) => (object ? (s.mosaicStates[object.id] ?? 0) : 0))
  const [chips, setChips] = useState<(Point | null)[]>([])
  const [inserts, setInserts] = useState<(Point | null)[]>([])
  /** The gap's size on screen — the area a hover over reveals the + in. */
  const [gapSize, setGapSize] = useState<Point>({ x: 0, y: 0 })

  useEffect(() => {
    if (!canvas || !object || !spread) {
      setChips([])
      setInserts([])
      return
    }
    const place = (): void => {
      const box = object.localBounds
      const scale = object.transform.scaleX || 1
      // One window's step and the gap between two, in the frame's own units.
      const step = windowOffset(object, 1) / scale
      const gap = step - box.width
      const nextChips = object.states.map((_, i) =>
        placeOnStage(canvas, object, { x: box.x + step * i, y: box.y }),
      )
      const nextInserts = object.states.map((_, i) =>
        placeOnStage(canvas, object, {
          x: box.x + box.width + gap / 2 + step * i,
          y: box.y + box.height / 2,
        }),
      )
      // Only when something has actually moved; this runs on every render.
      const same = (was: (Point | null)[], is: (Point | null)[]): boolean =>
        was.length === is.length &&
        was.every((a, i) => {
          const b = is[i]
          return a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
        })
      setChips((previous) => (same(previous, nextChips) ? previous : nextChips))
      setInserts((previous) => (same(previous, nextInserts) ? previous : nextInserts))
      const zoom = canvas.getZoom() || 1
      const nextGap = { x: gap * scale * zoom, y: box.height * (object.transform.scaleY || 1) * zoom }
      setGapSize((previous) =>
        Math.abs(previous.x - nextGap.x) < 0.5 && Math.abs(previous.y - nextGap.y) < 0.5
          ? previous
          : nextGap,
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
  const full = object.states.length >= FRAME_MAX_STATES

  return (
    <>
      {chips.map((at, i) =>
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
      {inserts.map((at, i) =>
        at ? (
          <div
            key={`insert-${object.states[i]?.id ?? i}`}
            className="spread-insert"
            style={{ left: at.x, top: at.y, width: gapSize.x, height: gapSize.y }}
          >
            <Tooltip
              label={full ? `A frame holds at most ${FRAME_MAX_STATES} states` : 'Add a state here'}
              side="top"
            >
              <button
                type="button"
                className="pill__button spread-insert__button"
                aria-label={`Add a state after state ${i + 1}`}
                disabled={full}
                onClick={() => duplicateFrameStateAt(object, i)}
              >
                <Icon name="plus" size={13} />
              </button>
            </Tooltip>
          </div>
        ) : null,
      )}
    </>
  )
}
