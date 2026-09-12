import { useState } from 'react'

import { AddRow, SegmentedControl, Slider } from '../components/controls'
import { PaintField } from './PaintField'
import { beginCrop, cropTargetFor } from './cropTargets'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { Section } from './Section'
import { StatedBackgroundField } from './StatedBackgroundField'
import { StateMenu } from './StateMenu'
import { StateTimingFields } from './StateTimingFields'
import './panels.css'

/**
 * A frame's panel: what every state shares, then the states.
 *
 * The same two-part shape a mosaic's has, for the same reason — one thing is
 * structural and the rest is per state — and it deliberately looks the same,
 * because they are the same idea and a user who has met one has met both.
 */
export function FramePanel({ object }: { object: FrameObject }) {
  const shown = useUiStore((s) => s.mosaicStates[object.id] ?? 0)
  const at = Math.min(Math.max(0, shown), object.states.length - 1)
  return <FrameStatePanel object={object} at={at} />
}

/**
 * What every state shares — whether the frame clips, and the clock the states
 * play to — folded above the list in the rail. Shut by default: these are set
 * once, and the states are what the rail is for.
 */
export function FrameSettings({ object }: { object: FrameObject }) {
  const [openFrame, setOpenFrame] = useState(false)
  const store = () => useDocumentStore.getState()

  return (
    <>
      <div className="panel__grid-section">
        <Section
          title="Frame settings"
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
          <StatedBackgroundField object={object} />
        </Section>
      </div>
    </>
  )
}

/**
 * The state on show, as the properties panel describes it: its backdrop and
 * its timing. This used to unfold inside the state's card; the card now names
 * the state, and this is where the state is worked on.
 */
export function FrameStatePanel({ object, at }: { object: FrameObject; at: number }) {
  const store = () => useDocumentStore.getState()
  const state = object.states[at]
  if (!state) return null
  return (
    <div className="panel__section">
      {/*
        The one thing in a frame that belongs to no member, and it belongs to
        THIS state — so a colour set here plainly means "in this state". It
        used to sit with the frame's settings and silently edit whichever
        state was on show.
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
        <PaintField
          label="Background"
          value={state.background ?? null}
          onChange={(paint) => store().setFrameStateBackground(object.id, at, paint)}
          onCommit={(label) => store().commit(label)}
          onCrop={() => beginCrop(cropTargetFor(object.id, 'background', at))}
          removeLabel="Remove background"
          onRemove={() => {
            store().setFrameStateBackground(object.id, at, null)
            store().commit('Remove frame background')
          }}
        />
      )}

      <StateTimingFields object={object} at={at} />
    </div>
  )
}

/**
 * The ⋯ on a frame state's card: the shared copy and delete, then the two
 * ways out of "an edit lands on one state". Apply pushes what this state
 * says (about the picked object, or all of them) into every other state,
 * laid over what they say; Reset forgets it, so the state follows the
 * object's own values again — which is also how a state frozen by an older
 * build is put right. Who they act on is the member picked inside the frame,
 * or every member when none is: a fact about the editor, read here.
 */
export function FrameStateActions({ object, at }: { object: FrameObject; at: number }) {
  const store = () => useDocumentStore.getState()
  const picked = useUiStore((s) =>
    s.insideFrame === object.id && s.frameSelection.length === 1 ? s.frameSelection[0] : undefined,
  )
  const state = object.states[at]
  if (!state) return null
  const pickedName = picked
    ? (object.members.find((each) => each.id === picked)?.object.name ?? 'the object')
    : undefined
  const authored = picked
    ? Boolean(state.values[picked])
    : Object.keys(state.values).length > 0

  return (
    <StateMenu
      object={object}
      at={at}
      heading={pickedName ? `${pickedName} in this state` : 'This state'}
      extras={[
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
  )
}
