import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { ColorField, DraftNumber, IconButton } from '../components/controls'
import { sortStops, stopColourAt, type StopsControl } from '../typography/colour'
import { clamp01 } from '../typography/hsv'
import type { GradientStop } from '../types/document'
import { gradientCss } from './gradientCss'
import './panels.css'

/**
 * A gradient's stops: the bar they make, and a row for each.
 *
 * The bar is the picture. Its handles drag along it; a press on an empty run
 * adds a stop there, coloured as the blend already is at that point, so adding
 * changes nothing until the new stop is moved or recoloured. The rows are the
 * numbers: where a stop sits, what colour, how opaque — a colour row with a
 * position well in front — and the way to take one away.
 *
 * Stops carry no ids. While a handle is dragged its INDEX stays put, so it may
 * cross a neighbour without the row under it changing hands; the list is
 * sorted when the drag lets go, and the selection follows the stop by its
 * object, which sorting copies the list around rather than replaces. One
 * history entry per gesture: every move is a change, the release is the one
 * commit.
 */
export function GradientField({
  control,
  stops,
  onChange,
  onCommit,
  onRemove,
  removeLabel = 'Remove',
}: {
  control: StopsControl
  stops: readonly GradientStop[]
  onChange: (stops: GradientStop[]) => void
  onCommit: (label: string) => void
  /** Take the whole gradient's part away — the shape's "type only". */
  onRemove?: () => void
  removeLabel?: string
}) {
  const [selected, setSelected] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)
  /** The stop under the pointer, and the last list written for it. */
  const drag = useRef<{ index: number; moved: boolean; written: GradientStop | null } | null>(null)

  const full = stops.length >= control.max
  const fewest = stops.length <= control.min

  const atFromPointer = (clientX: number): number => {
    const box = barRef.current?.getBoundingClientRect()
    return box ? clamp01((clientX - box.left) / box.width) : 0
  }
  const replace = (index: number, patch: Partial<GradientStop>): GradientStop[] =>
    stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop))

  const settle = (label: string, follow: GradientStop | null): void => {
    const sorted = sortStops(stops)
    onChange(sorted)
    if (follow) setSelected(Math.max(0, sorted.indexOf(follow)))
    onCommit(label)
  }

  const add = (at: number): void => {
    if (full) return
    const stop = { at, colour: stopColourAt(stops, at) }
    const next = sortStops([...stops, stop])
    onChange(next)
    setSelected(next.indexOf(stop))
    onCommit('Add gradient stop')
  }
  /** Midway across the widest gap, where a new stop has the most room to mean something. */
  const addInWidestGap = (): void => {
    const sorted = sortStops(stops)
    let best = { at: 0.5, width: -1 }
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1] as GradientStop
      const b = sorted[i] as GradientStop
      if (b.at - a.at > best.width) best = { at: (a.at + b.at) / 2, width: b.at - a.at }
    }
    add(best.at)
  }
  const remove = (index: number): void => {
    if (fewest) return
    onChange(stops.filter((_, i) => i !== index))
    setSelected(Math.max(0, index - 1))
    onCommit('Remove gradient stop')
  }

  /* ------------------------------------------------------- the handles */
  const onHandleDown = (e: PointerEvent<HTMLButtonElement>, index: number): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    drag.current = { index, moved: false, written: null }
    setSelected(index)
  }
  const onHandleMove = (e: PointerEvent<HTMLButtonElement>): void => {
    const state = drag.current
    if (!state || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    const next = replace(state.index, { at: atFromPointer(e.clientX) })
    state.moved = true
    state.written = next[state.index] ?? null
    onChange(next)
  }
  const onHandleUp = (e: PointerEvent<HTMLButtonElement>): void => {
    const state = drag.current
    drag.current = null
    if (!state) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (state.moved) settle('Move gradient stop', state.written)
  }
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const stop = stops[index]
    if (!stop) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(index)
      return
    }
    const step = e.shiftKey ? 0.1 : 0.01
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    if (!delta) return
    e.preventDefault()
    onChange(replace(index, { at: clamp01(stop.at + delta) }))
  }

  return (
    <div className="gradient-field">
      <div className="gradient-field__header">
        <span className="field__label">{control.label}</span>
        {onRemove ? (
          <IconButton icon="minus" label={removeLabel} small tooltipSide="top" onClick={onRemove} />
        ) : null}
        <IconButton
          icon="plus"
          label={full ? `A gradient holds at most ${control.max} stops` : 'Add a stop'}
          small
          tooltipSide="top"
          disabled={full}
          onClick={addInWidestGap}
        />
      </div>

      <div
        className="gradient-field__bar"
        ref={barRef}
        style={{ ['--gradient' as string]: gradientCss(stops) }}
        aria-hidden="true"
        onClick={(e) => add(atFromPointer(e.clientX))}
      >
        {stops.map((stop, i) => (
          <button
            key={i}
            type="button"
            className="gradient-field__stop"
            role="slider"
            aria-label={`Stop ${i + 1}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(stop.at * 100)}
            data-selected={i === selected}
            style={{ left: `${stop.at * 100}%`, ['--stop-colour' as string]: stop.colour }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => onHandleDown(e, i)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={(e) => onHandleKey(e, i)}
            onKeyUp={(e) => {
              if (e.key.startsWith('Arrow')) settle('Move gradient stop', stops[i] ?? null)
            }}
          />
        ))}
      </div>

      <div className="gradient-field__rows">
        {stops.map((stop, i) => (
          <div key={i} className="gradient-field__row" data-selected={i === selected}>
            <span className="gradient-field__at">
              <DraftNumber
                label={`Stop ${i + 1} position`}
                value={Math.round(stop.at * 100)}
                onPreview={(percent) => {
                  setSelected(i)
                  onChange(replace(i, { at: clamp01(percent / 100) }))
                }}
                onCommit={() => settle('Move gradient stop', stops[i] ?? null)}
              />
              <span className="color-field__unit" aria-hidden="true">
                %
              </span>
            </span>
            <ColorField
              label={`Stop ${i + 1} colour`}
              bare
              value={stop.colour}
              onChange={(colour) => {
                setSelected(i)
                onChange(replace(i, { colour }))
              }}
              onCommit={() => onCommit('Change gradient stop colour')}
              removeLabel="Remove stop"
              removeDisabled={fewest}
              onRemove={() => remove(i)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
