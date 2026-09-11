import { useEffect, useRef, useState, type TransitionEvent } from 'react'

import type { Stated } from '../types/document'
import { useSelectedObject } from './selection'
import { StatesList } from './StatesList'
import './panels.css'

/**
 * The states of the selected object, on the left — and nothing when it has none.
 *
 * States are the one thing in this editor that is a LIST you work down, and a
 * list of arrangements wants its own column rather than a slot under the
 * object's properties, where picking a member inside a frame used to swap it
 * out of sight. So: properties on the right, states on the left, the same
 * split Figma makes between the design panel and the layers.
 *
 * The rail is zero wide with nothing in it until a mosaic or a frame is
 * selected, and slides open when one is. Switching between two objects that
 * both have states swaps the content and does not slide again: the panel is
 * already open, and the eye should stay on the canvas.
 */
export function StatesRail() {
  const { stated } = useSelectedObject()
  const ref = useRef<HTMLDivElement>(null)

  /*
   * What the rail shows while it is closing.
   *
   * The content has to outlive the selection by the length of the slide, or the
   * panel would empty first and then shut — a blink, then a wipe. So the last
   * object is held until the width transition ends; `inert` on the closed rail
   * keeps that held copy from taking a press. Under reduced motion there is no
   * transition to wait for, so the content goes at once.
   */
  const [held, setHeld] = useState<Stated | undefined>(undefined)
  const open = Boolean(stated)
  const shown = stated ?? held

  useEffect(() => {
    if (stated) {
      const id = requestAnimationFrame(() => setHeld(stated))
      return () => cancelAnimationFrame(id)
    }
    const rail = ref.current
    if (!rail || parseFloat(getComputedStyle(rail).transitionDuration) > 0) return
    const id = requestAnimationFrame(() => setHeld(undefined))
    return () => cancelAnimationFrame(id)
  }, [stated])

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>): void => {
    if (e.target === ref.current && e.propertyName === 'width' && !stated) setHeld(undefined)
  }

  return (
    <div
      className="app__rail"
      data-open={open}
      inert={!open}
      ref={ref}
      onTransitionEnd={onTransitionEnd}
    >
      {shown ? (
        <aside className="panel panel--states" aria-label="States">
          <header className="panel__header">
            <h2 className="panel__title">{shown.name}</h2>
            <span className="panel__count">{shown.states.length}</span>
          </header>
          <div className="panel__scroll">
            <StatesList object={shown} />
          </div>
        </aside>
      ) : null}
    </div>
  )
}
