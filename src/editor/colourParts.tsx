import type { ReactNode } from 'react'

import { AddRow, ColorField, Slider, StrokeField } from '../components/controls'
import { DEFAULT_STROKE } from '../geometry/stroke'
import { typographyById, useDocumentStore } from '../state/documentStore'
import { valuesFor } from '../frame/frame'
import { frameTargetFor } from './memberEdits'
import type { AnimationControl } from '../typography/animation'
import {
  COLOUR_EFFECTS,
  colourEffectById,
  defaultColourConfig,
  gradientStops,
  type StopsControl,
} from '../typography/colour'
import { GradientField } from './GradientField'
import type {
  ColourConfigValue,
  ColourEffect,
  ColourSettings,
  PositionedStroke,
  TypographyObject,
} from '../types/document'
import { ControlList, PresetSelect } from './presetControls'
import './panels.css'

/**
 * The colour of each part of a typography object, to sit WITH that part.
 *
 * These were a tab of their own, which put a banner's colour and a banner's
 * motion in two different places — so editing one thing meant visiting two
 * tabs. The tab is gone; each block below now sits inside the Design section
 * for the part it colours.
 *
 * What has not changed: a colour and what it does over the loop are one
 * decision, made in one place. Splitting them is what made the colour effects
 * look broken — you could pick "Flicker" and see nothing happen, because there
 * was nowhere to say what it should flicker TO.
 *
 * Nor has this: a fill starts as NOTHING. `containerFill` and `lineFill` default
 * to null, and null is not a transparent colour — it is no fill at all, and the
 * control for it is a button that adds one rather than a picker showing a colour
 * nobody chose.
 */


/** The appearance as it stands right now — the state's if there is one. */
function currentAppearance(id: string): TypographyObject['appearance'] | undefined {
  const target = frameTargetFor(id)
  if (!target) return typographyById(id)?.appearance
  const frame = useDocumentStore.getState().doc.objects[target.frameId]
  if (!frame || frame.kind !== 'frame') return undefined
  const member = frame.members.find((each) => each.id === target.memberId)
  return member ? valuesFor(member, frame.states[target.at]).appearance : undefined
}

/**
 * Merge onto what the store holds right now, not onto what this render saw.
 *
 * Reading before writing is what lets a control be dragged immediately after a
 * neighbouring one was set without undoing it — and the read has to come from
 * the same place the write goes, or the merge would be onto the wrong values.
 */
function setAppearance(id: string, patch: Partial<TypographyObject['appearance']>): void {
  const target = frameTargetFor(id)
  if (target) {
    /*
     * Only the field that changed. The store merges it onto what the state
     * already says, and only onto that — merging here onto the resolved
     * appearance wrote all five fields into the state on the first colour
     * change, after which the state could never follow the member's other
     * four again.
     */
    useDocumentStore
      .getState()
      .setMemberValues(target.frameId, target.at, target.memberId, { appearance: patch })
    return
  }
  const current = currentAppearance(id)
  if (!current) return
  useDocumentStore.getState().updateObject(id, { appearance: { ...current, ...patch } })
}

const store = () => useDocumentStore.getState()
const commitAs = (label: string) => (): void => {
  store().commit(`Change ${label.toLowerCase()}`)
}

/**
 * Merge onto the settings as the STORE has them.
 *
 * Spreading the prop would drop any change made since React last rendered, so
 * picking an effect and immediately dragging its slider would undo the pick.
 */
function setColour(
  id: string,
  object: TypographyObject,
  key: 'textColour' | 'shapeColour',
  patch: Partial<ColourSettings>,
): void {
  const animation = typographyById(id)?.animation ?? object.animation
  store().updateObject(id, {
    animation: { ...animation, [key]: { ...animation[key], ...patch } },
  })
}

/** One control of one effect, merged onto whatever the others currently are. */
function setConfig(
  id: string,
  object: TypographyObject,
  key: 'textColour' | 'shapeColour',
  control: string,
  value: ColourConfigValue,
): void {
  const animation = typographyById(id)?.animation ?? object.animation
  setColour(id, object, key, { config: { ...animation[key].config, [control]: value } })
}

/* ---------------------------------------------------------------- the type */

export function TypeColour({ id, object }: { id: string; object: TypographyObject }) {
  return (
    <>
      <EffectPicker
        settings={object.animation.textColour}
        base={object.appearance.textFill}
        colour={
          <ColorField
            label="Colour"
            value={object.appearance.textFill}
            onChange={(textFill) => setAppearance(id, { textFill })}
            onCommit={commitAs('text colour')}
          />
        }
        onEffect={(effect) => {
          setColour(id, object, 'textColour', {
            effect,
            config: defaultColourConfig(effect, object.appearance.textFill),
          })
          store().commit('Change type colour effect')
        }}
        onConfig={(key, value) => setConfig(id, object, 'textColour', key, value)}
        onCommit={commitAs}
      />
    </>
  )
}

/* -------------------------------------------------------------- the banner */

/**
 * A filled band following the run, with the type inside it.
 *
 * A plain colour, with no effect of its own: a banner is a backdrop, and a
 * backdrop that cycles behind type that is also cycling is two things competing
 * rather than one design.
 */
export function BannerColour({ id, object }: { id: string; object: TypographyObject }) {
  if (object.appearance.lineFill === null) {
    return (
      <AddRow
        label="Banner"
        add="Add banner"
        onAdd={() => {
          setAppearance(id, { lineFill: '#111318' })
          store().commit('Add banner')
        }}
      />
    )
  }

  return (
    <ColorField
      label="Banner colour"
      bare
      value={object.appearance.lineFill}
      onChange={(lineFill) => setAppearance(id, { lineFill })}
      onCommit={commitAs('banner colour')}
      removeLabel="Remove banner"
      onRemove={() => {
        setAppearance(id, { lineFill: null })
        store().commit('Remove banner')
      }}
    />
  )
}

/* --------------------------------------------------------------- the shape */

export function ShapeColour({ id, object }: { id: string; object: TypographyObject }) {
  if (object.appearance.containerFill === null) {
    return (
      <AddRow
        label="Colour"
        add="Add shape colour"
        onAdd={() => {
          setAppearance(id, { containerFill: '#dcdcd8' })
          store().commit('Show shape')
        }}
      />
    )
  }

  const typeOnly = (): void => {
    setAppearance(id, { containerFill: null })
    store().commit('Hide shape')
  }

  return (
    <>
      <EffectPicker
        settings={object.animation.shapeColour}
        base={object.appearance.containerFill}
        colour={
          <ColorField
            label="Shape colour"
            bare
            value={object.appearance.containerFill}
            onChange={(containerFill) => setAppearance(id, { containerFill })}
            onCommit={commitAs('shape colour')}
            removeLabel="Type only — no shape colour"
            onRemove={typeOnly}
          />
        }
        removeLabel="Type only — no shape colour"
        onRemove={typeOnly}
        onEffect={(effect) => {
          setColour(id, object, 'shapeColour', {
            effect,
            // The shape's own colour; the type's if the shape has none (the closure cannot see the guard above).
            config: defaultColourConfig(
              effect,
              object.appearance.containerFill ?? object.appearance.textFill,
            ),
          })
          store().commit('Change shape colour effect')
        }}
        onConfig={(key, value) => setConfig(id, object, 'shapeColour', key, value)}
        onCommit={commitAs}
      />
    </>
  )
}

/**
 * The container's edge, directly under the fill it belongs to.
 *
 * Its own export rather than part of `ShapeColour`, because a border is a peer
 * of the fill and not a detail of it — and because the next part to want one
 * (the banner, the type, a tile) calls `StrokeField` the same way, from its own
 * section, with nothing shared but this three-line adapter.
 */
export function ShapeBorder({ id, object }: { id: string; object: TypographyObject }) {
  return (
    <StrokeField
      value={object.appearance.containerStroke}
      defaults={DEFAULT_STROKE}
      onChange={(next) =>
        setAppearance(id, { containerStroke: next as PositionedStroke | null })
      }
      onCommit={(label) => store().commit(label)}
    />
  )
}

/* ------------------------------------------------------------- the whole of it */

/**
 * The object's own transparency, above the individual fills.
 *
 * Its own section rather than folded in with a colour, because every colour
 * field already carries its own alpha — this is the one that governs all of
 * them at once, which is a different question.
 */
export function OpacityControl({ id, object }: { id: string; object: TypographyObject }) {
  return (
    <Slider
      label="Opacity"
      value={object.appearance.opacity}
      min={0}
      max={1}
      step={0.01}
      format={(v) => `${Math.round(v * 100)}%`}
      onChange={(opacity) => setAppearance(id, { opacity })}
      onCommit={commitAs('opacity')}
    />
  )
}

/**
 * The effect first, then the colour, then the effect's own controls.
 *
 * The colour control keeps its place whatever the effect: a flat colour row
 * for none, cycle and flicker, and for a gradient the gradient itself — its
 * stops, where the row was. So choosing Gradient changes nothing on screen
 * but that one control, and adds nothing but the motion below it.
 *
 * The generic list draws the three plain kinds; a gradient's stops are the
 * one control that is colour's own, and this — the one file that knows the
 * colour effects — draws it.
 */
function EffectPicker({
  settings,
  base,
  colour,
  onEffect,
  onConfig,
  onCommit,
  onRemove,
  removeLabel,
}: {
  settings: ColourSettings
  /** The part's own colour: the gradient's stop 0 when a config predates stops. */
  base: string
  /** The flat colour row, shown for every effect but the gradient. */
  colour: ReactNode
  onEffect: (effect: ColourEffect) => void
  onConfig: (key: string, value: ColourConfigValue) => void
  onCommit: (label: string) => () => void
  onRemove?: () => void
  removeLabel?: string
}) {
  const effect = colourEffectById(settings?.effect ?? 'none')
  const stopsControl = effect.controls.find((control): control is StopsControl => control.kind === 'stops')
  const plain = effect.controls.filter((control): control is AnimationControl => control.kind !== 'stops')
  return (
    <>
      <PresetSelect
        label="Colour effect"
        options={COLOUR_EFFECTS.map((e) => ({ id: e.id, label: e.label }))}
        value={effect.id}
        onChange={(next) => onEffect(next as ColourEffect)}
      />
      {stopsControl ? (
        <GradientField
          control={stopsControl}
          stops={gradientStops(settings?.config ?? {}, base)}
          onChange={(stops) => onConfig('stops', stops)}
          onCommit={(label) => onCommit(label)()}
          {...(onRemove ? { onRemove, removeLabel } : {})}
        />
      ) : (
        colour
      )}
      <ControlList
        controls={plain}
        config={settings?.config ?? {}}
        onChange={onConfig}
        onCommit={onCommit}
      />
    </>
  )
}
