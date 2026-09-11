import { useEffect, useRef, useState } from 'react'

import { EASING_LABELS } from '../anim/easing'
import { filmPosition, formatDuration } from '../anim/timeline'
import { IconButton } from '../components/controls'
import { usePlayhead } from '../state/playhead'
import { useUiStore } from '../state/uiStore'
import type { Stated } from '../types/document'
import { duplicateStateAt, kindOf, moveStateTo, showState } from './stated'
import { uiOf } from './statedUi'
import './panels.css'

/**
 * The states of an object, one card each, in the order they play — for every
 * kind of object that has them.
 *
 * States are the one thing in this editor that is a LIST you work down, and
 * this is the list: a header with how long a lap takes to watch and a + to
 * add one; cards you press to show a state, drag to reorder, and open a ⋯ on;
 * a film that runs down the cards while the object plays. It used to exist
 * twice, once per kind, byte for byte apart from the thumbnail and two menu
 * items — which is exactly the kind of copy that drifts. What differs per
 * kind comes from `statedUi`; what the list DOES comes from `stated`.
 */

/**
 * How far a press on a state's row must travel before it is a reorder.
 *
 * The row is both the thing you press to open a state and the thing you grab
 * to move one, so the press cannot decide on its own — the same rule the
 * canvas uses for a press that might be a click or might be a resize.
 */
const DRAG_SLOP_PIXELS = 4
/**
 * The preview, in pixels. Big enough that the letters read: below about fifty
 * a glyph is five pixels of mush and the thumbnail says only "an object".
 */
const THUMB = 64

export function StatesList({ object }: { object: Stated }) {
  const kind = kindOf(object)
  const { Settings } = uiOf(object)

  /*
   * The film: while this object plays, the card of the state on screen is lit
   * and its bar fills through the state's turn, then the next card's. Read
   * from the playhead the canvas loop writes, so the strip and the artwork
   * cannot disagree about where the clock is.
   */
  const playheadMs = usePlayhead((s) => s.at[object.id])
  const film = playheadMs === undefined ? null : filmPosition(object.states, playheadMs)

  const shown = useUiStore((s) => s.mosaicStates[object.id] ?? 0)
  const count = object.states.length
  const at = Math.min(Math.max(0, shown), count - 1)

  /*
   * A drag in flight: which card was picked up, and where it would land.
   *
   * Owned by the LIST rather than by a card, because a drag is a relationship
   * between two of them — the card being dragged cannot know what it is over,
   * and the card underneath cannot know what is coming.
   *
   * `into` is an insertion POINT, not a card index: it runs 0…count, so the
   * gap after the last card is expressible. The destination index is one
   * lower when a card moves down, because removing it first shifts everything
   * after it up one.
   */
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ from: number; startY: number; moved: boolean } | null>(null)
  const [into, setInto] = useState<number | null>(null)
  /*
   * A drag that has actually moved must not also count as a click: `click`
   * fires after `pointerup`, so letting go of a card you just dragged would
   * open it as well.
   */
  const draggedRef = useRef(false)

  /** Which gap the pointer is in: 0 is above the first card, `count` past the last. */
  const gapAt = (y: number): number => {
    const cards = [...(listRef.current?.children ?? [])] as HTMLElement[]
    for (let i = 0; i < cards.length; i++) {
      // The ROW's midpoint, not the card's: an open card is several hundred
      // pixels tall, and its middle is somewhere down inside its own controls.
      const card = cards[i]
      if (!card) continue
      const box = (card.firstElementChild ?? card).getBoundingClientRect()
      if (y < box.top + box.height / 2) return i
    }
    return cards.length
  }

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent): void => {
      if (!drag.moved) {
        if (Math.abs(e.clientY - drag.startY) < DRAG_SLOP_PIXELS) return
        setDrag((was) => (was ? { ...was, moved: true } : was))
        draggedRef.current = true
      }
      setInto(gapAt(e.clientY))
    }

    const abandon = (): void => {
      setDrag(null)
      setInto(null)
    }

    const finish = (): void => {
      if (drag.moved && into !== null) {
        moveStateTo(object, drag.from, into > drag.from ? into - 1 : into)
      }
      abandon()
    }

    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      /*
       * Escape means "call off the thing in flight", and the thing in flight
       * is this drag. Left to carry on it reaches the editor's own Escape —
       * which puts a member down, folds a row or clears the selection — so
       * calling off a reorder would throw away the object being worked on.
       * Capture phase, because that handler was bound first.
       */
      e.stopPropagation()
      abandon()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    /*
     * A cancelled pointer ABANDONS rather than commits: the browser took the
     * pointer away, and it carries no position anybody chose.
     */
    window.addEventListener('pointercancel', abandon)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', abandon)
      window.removeEventListener('keydown', key, true)
    }
  }, [drag, into, object])

  return (
    <>
      {/*
        What every state shares, folded above the list. Shut by default — the
        states are what the rail is for; these are the things you set once.
      */}
      <Settings object={object} />

      <div className="states">
        <header className="states__header">
          <h3 className="panel__section-title">States</h3>
          {/*
            How long a lap takes to WATCH, which is what the play button and an
            export both produce — the speed's answer, not the sum of the states'
            own timings.
          */}
          <span className="states__length">{formatDuration(kind.playbackDuration(object))}</span>
          <IconButton
            icon="plus"
            label={
              count >= kind.max ? `A ${kind.noun} holds at most ${kind.max} states` : 'Add a state'
            }
            tooltipSide="top"
            small
            disabled={count >= kind.max}
            // A copy of the one on show, so nothing moves until you move it —
            // and the copy is what you are then looking at.
            onClick={() => duplicateStateAt(object, at)}
          />
        </header>

        <ul className="states__list" ref={listRef}>
          {object.states.map((state, index) => (
            <StateCard
              key={state.id}
              object={object}
              at={index}
              shown={index === at}
              playing={film?.index === index}
              within={film?.index === index ? film.within : 0}
              dragging={drag?.moved === true && drag.from === index}
              /*
               * Which edge of THIS card the line is drawn on. An insertion
               * point of `index` is the gap above it; `index + 1` is the gap
               * below, and only the last card draws that one — otherwise every
               * gap would be claimed by two neighbours and drawn twice.
               */
              dropEdge={
                drag?.moved !== true || into === null
                  ? null
                  : into === index
                    ? 'above'
                    : into === index + 1 && index === object.states.length - 1
                      ? 'below'
                      : null
              }
              onPickUp={(startY) => {
                draggedRef.current = false
                setDrag({ from: index, startY, moved: false })
                setInto(index)
              }}
              wasDragged={() => draggedRef.current}
              onNudge={(by) => moveStateTo(object, index, index + by)}
            />
          ))}
        </ul>
      </div>
    </>
  )
}

function StateCard({
  object,
  at,
  shown,
  playing,
  within,
  dragging,
  dropEdge,
  onPickUp,
  wasDragged,
  onNudge,
}: {
  object: Stated
  at: number
  /** On the canvas right now. Pressing the row makes it so; its controls are on the right. */
  shown: boolean
  /** The state the film is on right now, and how far through its turn. */
  playing: boolean
  within: number
  /** This card is the one being carried. */
  dragging: boolean
  /** Which edge the insertion line belongs on, if any. */
  dropEdge: 'above' | 'below' | null
  onPickUp: (startY: number) => void
  /** Whether the press that is ending turned into a drag, so a click is not one. */
  wasDragged: () => boolean
  onNudge: (by: number) => void
}) {
  const { Thumbnail, Actions } = uiOf(object)
  const state = object.states[at]
  if (!state) return null

  return (
    <li
      className="state-card"
      data-shown={shown}
      data-playing={playing}
      data-dragging={dragging}
      data-drop={dropEdge ?? undefined}
    >
      {/*
        The whole row is the handle. Pointer events rather than HTML5
        drag-and-drop, as everywhere else in the editor, and a press only
        becomes a drag once it has travelled — so the row still opens on a
        plain click. The actions at the right opt out.
      */}
      <div
        className="state-card__row"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          onPickUp(e.clientY)
        }}
      >
        <button
          type="button"
          className="state-card__open"
          aria-pressed={shown}
          onClick={() => {
            // The click that ends a real drag is not a click on the row.
            if (wasDragged()) return
            showState(object, at)
          }}
          // Reorderable without a mouse: Alt with an arrow moves the state
          // one place, so the row that opens a state also moves it.
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            if (!e.altKey) return
            e.preventDefault()
            onNudge(e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <Thumbnail object={object} at={at} size={THUMB} />
          <span className="state-card__meta">
            <span className="state-card__name">State {at + 1}</span>
            <span className="state-card__timing">
              {Math.round(state.holdMs)} · {Math.round(state.transitionMs)} ms
            </span>
            <span className="state-card__easing">{EASING_LABELS[state.easing]}</span>
          </span>
        </button>

        <div className="state-card__actions" onPointerDown={(e) => e.stopPropagation()}>
          <Actions object={object} at={at} />
        </div>
      </div>
      {playing ? (
        <span className="state-card__film" style={{ width: `${within * 100}%` }} aria-hidden="true" />
      ) : null}
    </li>
  )
}
