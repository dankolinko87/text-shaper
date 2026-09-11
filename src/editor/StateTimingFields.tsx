import { EASING_LABELS, EASING_PRESETS, type Easing } from '../anim/easing'
import { MIN_TRANSITION_MS } from '../anim/timeline'
import { Slider } from '../components/controls'
import { useDocumentStore } from '../state/documentStore'
import type { Stated } from '../types/document'
import { kindOf } from './stated'

/**
 * How long a state rests and takes to leave, and on what curve — the three
 * things every state has whatever it is a state OF. One block, written
 * against the kind table, so a mosaic's timing and a frame's cannot come to
 * differ in range, step or wording.
 */
export function StateTimingFields({ object, at }: { object: Stated; at: number }) {
  const state = object.states[at]
  if (!state) return null
  const kind = kindOf(object)
  const commit = (label: string) => () => useDocumentStore.getState().commit(label)

  return (
    <>
      {/* Zero is a state that never rests, which is usually what you want. */}
      <Slider
        label="Hold"
        value={state.holdMs}
        min={0}
        max={4000}
        step={10}
        editable
        suffix="ms"
        onChange={(ms) => kind.setTiming(object.id, at, { holdMs: ms })}
        onCommit={commit('Change hold')}
      />
      {/* One frame is the floor: a transition of zero is a division by nothing. */}
      <Slider
        label="Transition"
        value={state.transitionMs}
        min={MIN_TRANSITION_MS}
        max={4000}
        step={10}
        editable
        suffix="ms"
        onChange={(ms) => kind.setTiming(object.id, at, { transitionMs: ms })}
        onCommit={commit('Change transition')}
      />
      <div className="field">
        <label className="field__label" htmlFor={`easing-${object.id}-${at}`}>
          Easing
        </label>
        <select
          id={`easing-${object.id}-${at}`}
          className="input"
          value={state.easing}
          onChange={(e) => {
            kind.setEasing(object.id, at, e.target.value as Easing)
            useDocumentStore.getState().commit('Change easing')
          }}
        >
          {EASING_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {EASING_LABELS[preset]}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}
