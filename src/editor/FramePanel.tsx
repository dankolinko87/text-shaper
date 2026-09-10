import { useEffect, useRef, useState } from 'react'

import { AddRow, ColorField, IconButton, SegmentedControl, Slider } from '../components/controls'
import { Menu } from '../components/Menu'
import { Icon } from '../components/Icon'
import { EASING_LABELS, EASING_PRESETS } from '../anim/easing'
import { formatDuration } from '../anim/timeline'
import { framePlaybackDuration } from '../frame/frame'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import type { Easing } from '../anim/easing'
import type { FrameState } from '../types/frame'
import { FRAME_MAX_STATES, FRAME_MIN_STATES } from '../types/frame'
import { FrameThumbnail } from './FrameThumbnail'
import {
  deleteFrameStateAt,
  duplicateFrameStateAt,
  moveFrameStateTo,
  showFrameState,
} from './frameStates'
import { Section } from './Section'
import './panels.css'

/** How far a press travels before it is a drag rather than a click, in pixels. */
const DRAG_SLOP_PIXELS = 4
const THUMB = 64

/**
 * A frame's panel: what every state shares, then the states.
 *
 * The same two-part shape a mosaic's has, for the same reason — one thing is
 * structural and the rest is per state — and it deliberately looks the same,
 * because they are the same idea and a user who has met one has met both.
 */
export function FramePanel({ object }: { object: FrameObject }) {
  const [openFrame, setOpenFrame] = useState(false)
  const store = () => useDocumentStore.getState()

  return (
    <>
      {/* What every state shares. A mosaic puts its grid here; a frame its members. */}
      <div className="panel__grid-section">
        <Section
          title="Frame"
          summary={
            object.members.length === 0
              ? 'Empty'
              : `${object.members.length} ${object.members.length === 1 ? 'object' : 'objects'}`
          }
          open={openFrame}
          onToggle={() => setOpenFrame((was) => !was)}
        >
          {/*
            Off by default, so the bounds are a drop target and a place rather
            than a cage. On, the frame is a window and a member crossing the edge
            wipes on — which is a masked reveal, and most of what a motion
            container is for.
          */}
          <SegmentedControl<'off' | 'on'>
            label="Clip"
            value={object.clip ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            onChange={(choice) => {
              store().setFrameClip(object.id, choice === 'on')
              store().commit(choice === 'on' ? 'Clip frame' : 'Unclip frame')
            }}
          />

          <Slider
            label="Speed"
            value={object.speed}
            min={0.1}
            max={4}
            step={0.1}
            editable
            suffix="×"
            onChange={(speed) => store().setFrameSpeed(object.id, speed)}
            onCommit={() => store().commit('Change speed')}
          />
        </Section>
      </div>
    </>
  )
}

/**
 * The frame's states: one card each, in the order they play.
 *
 * Its own component because it is wanted in two places — under the frame's
 * settings when the frame is selected, and above a member's controls when one
 * is picked inside it. The list used to vanish the moment a member was picked,
 * so you could not see which state you were editing while editing it.
 */
export function FrameStateList({ object }: { object: FrameObject }) {
  const shown = useUiStore((s) => s.mosaicStates[object.id] ?? 0)
  const count = object.states.length
  const at = Math.min(Math.max(0, shown), count - 1)

  /*
   * What is unfolded, kept apart from what is SHOWN — the mosaic's rule. Opening
   * a card shows its state; closing one leaves the canvas where it is; every
   * card can be shut at once. Held by state ID, not index, so duplicating or
   * deleting a state does not hand "open" to whichever state slid into the slot.
   */
  const [openStates, setOpenStates] = useState<ReadonlySet<string>>(
    () => new Set(object.states[at] ? [object.states[at].id] : []),
  )

  const toggleState = (id: string, index: number): void => {
    const opening = !openStates.has(id)
    setOpenStates((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // Opening one is asking to work on it, so the canvas follows. Closing says
    // nothing about which state you want to look at.
    if (opening) showFrameState(object, index)
  }

  /*
   * Navigating on the canvas carries the open card with it.
   *
   * Stepping through states with the bar under the frame is how you compare
   * arrangements, and arriving at one whose card is shut means opening it by
   * hand every time. Only when something is already open, though: with the
   * list collapsed, stepping through is LOOKING. The state being left is the
   * one that closes, so cards opened deliberately beside it stay open.
   */
  const previous = useRef(at)
  useEffect(() => {
    const from = previous.current
    if (from === at) return
    previous.current = at
    const left = object.states[from]?.id
    const arrived = object.states[at]?.id
    if (!arrived) return
    setOpenStates((was) => {
      if (was.size === 0) return was
      const next = new Set(was)
      if (left) next.delete(left)
      next.add(arrived)
      return next
    })
  }, [at, object.states])

  /*
   * A drag in flight: which card was picked up, and where it would land.
   *
   * Owned by the LIST rather than by a card, because a drag is a relationship
   * between two of them. `into` is an insertion POINT, 0…count, so the gap
   * after the last card is expressible; the destination index is one lower
   * when a card moves down, because taking it out first shifts the rest up.
   */
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ from: number; startY: number; moved: boolean } | null>(null)
  const [into, setInto] = useState<number | null>(null)
  // A drag that has actually moved must not also count as a click: `click`
  // fires after `pointerup`, and letting go of a dragged card would open it.
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
        moveFrameStateTo(object, drag.from, into > drag.from ? into - 1 : into)
      }
      abandon()
    }

    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // Escape means "call off the drag", and it stops HERE — left to carry on
      // it reaches the editor's own Escape, which would put the member down or
      // leave the frame. Capture phase, because that handler was bound first.
      e.stopPropagation()
      abandon()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    // A cancelled pointer abandons rather than commits: the browser took the
    // pointer away, and it carries no position anybody chose.
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
    <div className="states">
      <header className="states__header">
        <h3 className="panel__section-title">States</h3>
        <span className="states__length">{formatDuration(framePlaybackDuration(object))}</span>
        {openStates.size > 0 ? (
          <IconButton
            icon="chevronUp"
            label="Collapse every state"
            tooltipSide="top"
            small
            onClick={() => setOpenStates(new Set())}
          />
        ) : null}
        <IconButton
          icon="plus"
          label={
            count >= FRAME_MAX_STATES
              ? `A frame holds at most ${FRAME_MAX_STATES} states`
              : 'Add a state'
          }
          tooltipSide="top"
          small
          disabled={count >= FRAME_MAX_STATES}
          // A copy of the one on show, so nothing moves until you move it —
          // and the copy is what you are then looking at.
          onClick={() => duplicateFrameStateAt(object, at)}
        />
      </header>

      <ul className="states__list" ref={listRef}>
        {object.states.map((state, index) => (
          <StateCard
            key={state.id}
            object={object}
            at={index}
            state={state}
            open={openStates.has(state.id)}
            shown={index === at}
            onToggle={() => toggleState(state.id, index)}
            dragging={drag?.moved === true && drag.from === index}
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
            onNudge={(by) => moveFrameStateTo(object, index, index + by)}
          />
        ))}
      </ul>
    </div>
  )
}

function StateCard({
  object,
  at,
  state,
  open,
  shown,
  onToggle,
  dragging,
  dropEdge,
  onPickUp,
  wasDragged,
  onNudge,
}: {
  object: FrameObject
  at: number
  state: FrameState
  open: boolean
  /** On the canvas right now — which is not the same as being unfolded. */
  shown: boolean
  onToggle: () => void
  /** This card is the one being carried. */
  dragging: boolean
  /** Which edge the insertion line belongs on, if any. */
  dropEdge: 'above' | 'below' | null
  onPickUp: (startY: number) => void
  /** Whether the press that is ending turned into a drag, so a click is not one. */
  wasDragged: () => boolean
  onNudge: (by: number) => void
}) {
  const store = () => useDocumentStore.getState()
  const count = object.states.length
  /*
   * Who the escape hatches act on: the member picked inside this frame, or
   * every member when none is. Read here rather than passed down, because the
   * pick is a fact about the editor and not about the list.
   */
  const picked = useUiStore((s) =>
    s.insideFrame === object.id && s.frameSelection.length === 1 ? s.frameSelection[0] : undefined,
  )
  const pickedName = picked
    ? (object.members.find((each) => each.id === picked)?.object.name ?? 'the object')
    : undefined
  const authored = picked
    ? Boolean(state.values[picked])
    : Object.keys(state.values).length > 0

  return (
    <li
      className="state-card"
      data-open={open}
      data-shown={shown}
      data-dragging={dragging}
      data-drop={dropEdge ?? undefined}
    >
      {/*
        The whole row is the handle; the grip is there to SAY that. Pointer
        events rather than HTML5 drag-and-drop, as everywhere else in the
        editor, and a press only becomes a drag once it has travelled — so the
        row still opens on a plain click. The buttons at the right opt out.
      */}
      <div
        className="state-card__row"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          onPickUp(e.clientY)
        }}
      >
        <span className="state-card__grip" aria-hidden="true">
          <Icon name="grip" size={13} />
        </span>
        <button
          type="button"
          className="state-card__open"
          aria-expanded={open}
          onClick={() => {
            if (wasDragged()) return
            onToggle()
          }}
          // Reorderable without a mouse: Alt with an arrow moves the state one
          // place, as the mosaic's list does.
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            if (!e.altKey) return
            e.preventDefault()
            onNudge(e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <span className="lid-chevron" data-open={open}>
            <Icon name="chevronRight" size={13} />
          </span>
          <FrameThumbnail object={object} at={at} size={THUMB} />
          <span className="state-card__meta">
            <span className="state-card__name">State {at + 1}</span>
            <span className="state-card__timing">
              {Math.round(state.holdMs)} · {Math.round(state.transitionMs)} ms
            </span>
            <span className="state-card__easing">{EASING_LABELS[state.easing]}</span>
          </span>
        </button>

        <div className="state-card__actions" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton
            icon="duplicate"
            label={
              count >= FRAME_MAX_STATES
                ? `A frame holds at most ${FRAME_MAX_STATES} states`
                : 'Duplicate this state'
            }
            tooltipSide="top"
            small
            disabled={count >= FRAME_MAX_STATES}
            onClick={() => duplicateFrameStateAt(object, at)}
          />
          <IconButton
            icon="trash"
            label={
              count <= FRAME_MIN_STATES
                ? `An animation needs at least ${FRAME_MIN_STATES} states`
                : 'Delete this state'
            }
            tooltipSide="top"
            small
            disabled={count <= FRAME_MIN_STATES}
            onClick={() => deleteFrameStateAt(object, at)}
          />
          {/*
            The two ways out of "an edit lands on one state". Apply pushes
            what this state says — about the picked object, or about all of
            them — into every other state, laid over what they say. Reset
            forgets it, so the state follows the object's own values again,
            which is also how a state frozen by an older build is put right.
          */}
          <Menu
            label="More"
            heading={pickedName ? `${pickedName} in this state` : 'This state'}
            items={[
              {
                label: 'Apply to every state',
                disabled: !authored,
                onSelect: () => {
                  if (store().applyFrameStateToAll(object.id, at, picked)) {
                    store().commit('Apply state to all')
                  }
                },
              },
              {
                label: 'Reset to follow the shape',
                disabled: !authored,
                onSelect: () => {
                  if (store().resetFrameStateToMember(object.id, at, picked)) {
                    store().commit('Reset state')
                  }
                },
              },
            ]}
          />
        </div>
      </div>

      {open ? (
        <div className="state-card__body">
          <div className="section__body">
            {/*
              The one thing in a frame that belongs to no member, and it belongs
              to THIS state — so it lives on the state's own card, where a colour
              set here plainly means "in this state". It used to sit with the
              frame's settings and silently edit whichever state was on show.
            */}
            {(state.background ?? null) === null ? (
              <AddRow
                label="Background"
                add="Add background"
                onAdd={() => {
                  store().setFrameStateBackground(object.id, at, '#dcdcd8')
                  store().commit('Add frame background')
                }}
              />
            ) : (
              <ColorField
                label="Background"
                value={state.background ?? '#dcdcd8'}
                onChange={(colour) => store().setFrameStateBackground(object.id, at, colour)}
                onCommit={() => store().commit('Change frame background')}
                removeLabel="Remove background"
                onRemove={() => {
                  store().setFrameStateBackground(object.id, at, null)
                  store().commit('Remove frame background')
                }}
              />
            )}

            <Slider
              label="Hold"
              value={state.holdMs}
              min={0}
              max={4000}
              step={10}
              editable
              suffix="ms"
              onChange={(ms) => store().setFrameStateTiming(object.id, at, { holdMs: ms })}
              onCommit={() => store().commit('Change hold')}
            />
            <Slider
              label="Transition"
              value={state.transitionMs}
              min={16}
              max={4000}
              step={10}
              editable
              suffix="ms"
              onChange={(ms) => store().setFrameStateTiming(object.id, at, { transitionMs: ms })}
              onCommit={() => store().commit('Change transition')}
            />
            <div className="field">
              <label className="field__label" htmlFor={`frame-easing-${object.id}-${at}`}>
                Easing
              </label>
              <select
                id={`frame-easing-${object.id}-${at}`}
                className="input"
                value={state.easing}
                onChange={(e) => {
                  store().setFrameStateEasing(object.id, at, e.target.value as Easing)
                  store().commit('Change easing')
                }}
              >
                {EASING_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {EASING_LABELS[preset]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}
