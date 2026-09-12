import { useMemo } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { useUiStore } from '../state/uiStore'
import type { Tiled } from '../types/document'
import { isStated } from '../types/document'
import { useCanvasAnchor } from './canvasAnchor'
import {
  addState,
  changeStateCount,
  kindOf,
  moves,
  plateBounds,
  playing,
  showState,
  togglePlay,
  toggleSpread,
} from './stated'
import { useSelectedObject } from './selection'
import './canvas.css'

/**
 * The bar under the selected object: play, its states, and how they are shown.
 *
 * One bar, whatever the object. A shape with a preset gets play alone; anything
 * with states gets play, the stepper, +, and the spread toggle.
 * It used to be three bars — states centred, play at the left, and a
 * measurement to keep the two from touching — which was three answers to
 * "where is the control for this object".
 *
 * HTML rather than canvas, deliberately. It is a control, not artwork: it must
 * stay one size whatever the zoom, take a hover, take focus, and open a real
 * menu. Drawn into the canvas it would need every one of those hand-rolled, and
 * would scale with the object — which is exactly what a control must not do.
 * It sits in the stage, positioned over the canvas at the object's bottom edge
 * (or above it, when below would run into the tools), and re-placed whenever
 * the canvas renders, so panning and zooming carry it along.
 */
export function ObjectBar({
  canvas,
  inside,
}: {
  canvas: FabricCanvas | null
  /** The mosaic being typed into, which is the object even while nothing is selected. */
  inside: Tiled | undefined
}) {
  const { selected } = useSelectedObject()
  const object = inside ?? selected
  const id = object?.id
  const shown = useUiStore((s) => (id ? (s.mosaicStates[id] ?? 0) : 0))
  const spread = useUiStore((s) => (id ? s.spread === id : false))
  const running = useUiStore((s) => (object ? playing(object, s) : false))
  const zoom = useUiStore((s) => s.zoom)
  // A stated object's bar hangs from its PLATE — a frame's whole row while
  // spread — so it clears the grey rather than sitting on its bottom strip.
  const bounds = useMemo(
    () => (object && isStated(object) ? plateBounds(object, spread, zoom) : undefined),
    [object, spread, zoom],
  )
  const at = useCanvasAnchor(canvas, object, bounds)

  if (!object || !at) return null

  const stated = isStated(object) ? object : undefined
  const kind = stated ? kindOf(stated) : undefined
  const count = stated ? stated.states.length : 0
  const index = Math.min(shown, Math.max(0, count - 1))
  const max = kind?.max ?? 0
  const full = count >= max
  const can = moves(object)
  // No play button under a thing that cannot play: a disabled transport under
  // a still shape promises a motion it does not have. It stays while running,
  // so a stop is always reachable.
  const showPlay = can || running
  if (!stated && !showPlay) return null
  const show = (next: number): void => {
    if (stated) showState(stated, next)
  }

  return (
    <div
      className="object-bar pill"
      style={{ left: at.left, top: at.top }}
      role="group"
      aria-label={`${object.name}: playback and states`}
    >
      {showPlay ? (
        <Tooltip label={running ? 'Stop' : 'Play'} side="top">
          <button
            type="button"
            className="pill__button"
            aria-label={running ? 'Stop' : 'Play'}
            onClick={() => togglePlay(object)}
          >
            <Icon name={running ? 'stop' : 'play'} size={16} />
          </button>
        </Tooltip>
      ) : null}

      {stated ? (
        <>
          {showPlay ? <span className="pill__divider" aria-hidden="true" /> : null}

          {/*
            Spread, there is no state to step to — every one is on screen — so
            the stepper goes and + stays: laying every keyframe out is exactly
            when you can see that one is missing.
          */}
          {spread ? null : (
            <>
              <Tooltip label="Previous state" side="top">
                <button
                  type="button"
                  className="pill__button"
                  aria-label="Previous state"
                  disabled={index === 0}
                  onClick={() => show(index - 1)}
                >
                  <Icon name="chevronLeft" size={16} />
                </button>
              </Tooltip>

              <span className="object-bar__count">
                <span aria-hidden="true">
                  {index + 1}/{count}
                </span>
                {/*
                  A count is a menu where the kind offers one — a mosaic is
                  BORN with states and changing how many is a normal thing to
                  do; it sits under an invisible native select, which brings
                  the keyboard, the platform's own list and its dismissal with
                  it. A frame's states are made by duplicating an arrangement
                  you built, so + is its honest verb and it offers no count.
                */}
                {kind?.setCount ? (
                  <select
                    className="object-bar__picker"
                    aria-label={`State ${index + 1} of ${count}. Change how many states`}
                    value={count}
                    onChange={(e) => changeStateCount(stated, Number(e.target.value))}
                  >
                    {(count < kind.min ? [count] : []).map((value) => (
                      <option key={value} value={value}>
                        {value} state{value === 1 ? '' : 's'}
                      </option>
                    ))}
                    {Array.from({ length: kind.max - kind.min + 1 }, (_, i) => {
                      const value = kind.min + i
                      return (
                        <option key={value} value={value}>
                          {value} states
                        </option>
                      )
                    })}
                  </select>
                ) : null}
              </span>

              <Tooltip label="Next state" side="top">
                <button
                  type="button"
                  className="pill__button"
                  aria-label="Next state"
                  disabled={index >= count - 1}
                  onClick={() => show(index + 1)}
                >
                  <Icon name="chevronRight" size={16} />
                </button>
              </Tooltip>
            </>
          )}

          <Tooltip label={full ? `Holds at most ${max} states` : 'Add a state'} side="top">
            <button
              type="button"
              className="pill__button"
              aria-label="Add a state"
              disabled={full}
              onClick={() => addState(stated, index)}
            >
              <Icon name="plus" size={16} />
            </button>
          </Tooltip>

          {/*
            Its own group, behind a divider: stepping through states and laying
            them all out are different questions, and the row of steppers should
            not read as though this were one more of them.
          */}
          <span className="pill__divider" aria-hidden="true" />
          <Tooltip label={spread ? 'Back to one' : 'Spread the states side by side'} side="top">
            <button
              type="button"
              className="pill__button"
              aria-label={spread ? 'Back to one' : 'Spread the states side by side'}
              onClick={() => toggleSpread(stated)}
            >
              <Icon name={spread ? 'collapse' : 'spread'} size={16} />
            </button>
          </Tooltip>
        </>
      ) : null}
    </div>
  )
}
