import { AddRow, Slider, StrokeField } from '../components/controls'
import { DEFAULT_STROKE } from '../geometry/stroke'
import { typographyById, useDocumentStore } from '../state/documentStore'
import { valuesFor } from '../frame/frame'
import { frameTargetFor } from './memberEdits'
import { COLOUR_EFFECTS, colourEffectById, defaultColourConfig } from '../typography/colour'
import { isSolidPaint } from '../typography/paint'
import type {
  ColourConfigValue,
  ColourEffect,
  ColourSettings,
  PositionedStroke,
  TypographyObject,
} from '../types/document'
import type { Paint } from '../types/paint'
import { PaintField, strokePaintField } from './PaintField'
import { beginCrop, cropTargetFor } from './cropTargets'
import { ControlList, PresetSelect } from './presetControls'
import './panels.css'

/**
 * The fill of each part of a typography object, to sit WITH that part.
 *
 * These were a tab of their own, which put a banner's colour and a banner's
 * motion in two different places — so editing one thing meant visiting two
 * tabs. The tab is gone; each block below now sits inside the Design section
 * for the part it colours.
 *
 * A fill is a paint — a colour, a gradient or a picture — and the paint field
 * is the one control for all three. A colour EFFECT (cycle, flicker) acts on
 * a solid fill and is offered only then: a gradient carries its own motion,
 * and a picture has none.
 *
 * Nor has this changed: a fill starts as NOTHING. `containerFill` and
 * `lineFill` default to null, and null is not a transparent colour — it is no
 * fill at all, and the control for it is a button that adds one rather than a
 * picker showing a colour nobody chose.
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
      <PaintField
        label="Fill"
        value={object.appearance.textFill}
        motion
        onChange={(textFill) => setAppearance(id, { textFill })}
        onCommit={(label) => store().commit(label)}
        onCrop={() => beginCrop(cropTargetFor(id, 'text', 0))}
      />
      <EffectPicker
        settings={object.animation.textColour}
        paint={object.appearance.textFill}
        onEffect={(effect) => {
          setColour(id, object, 'textColour', {
            effect,
            config: defaultColourConfig(effect, solidBase(object.appearance.textFill)),
          })
          store().commit('Change type colour effect')
        }}
        onConfig={(key, value) => setConfig(id, object, 'textColour', key, value)}
        onCommit={commitAs}
      />
    </>
  )
}

/** The hex a colour effect starts from; an effect is only offered on a solid fill. */
const solidBase = (paint: Paint): string | undefined => (isSolidPaint(paint) ? paint : undefined)

/* -------------------------------------------------------------- the banner */

/**
 * A filled band following the run, with the type inside it.
 *
 * A paint like any other; it moves only by its own motion, since a banner is
 * a backdrop and a backdrop that cycles behind type that is also cycling is
 * two things competing rather than one design.
 */
export function BannerColour({ id, object }: { id: string; object: TypographyObject }) {
  if (object.appearance.lineFill === null) {
    return (
      <AddRow
        label="Fill"
        add="Add banner"
        onAdd={() => {
          setAppearance(id, { lineFill: '#111318' })
          store().commit('Add banner')
        }}
      />
    )
  }

  return (
    <PaintField
      label="Banner fill"
      bare
      motion
      value={object.appearance.lineFill}
      onChange={(lineFill) => setAppearance(id, { lineFill })}
      onCommit={(label) => store().commit(label)}
      onCrop={() => beginCrop(cropTargetFor(id, 'banner', 0))}
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
        label="Fill"
        add="Add shape fill"
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
      <PaintField
        label="Shape fill"
        bare
        motion
        value={object.appearance.containerFill}
        onChange={(containerFill) => setAppearance(id, { containerFill })}
        onCommit={(label) => store().commit(label)}
        onCrop={() => beginCrop(cropTargetFor(id, 'shape', 0))}
        removeLabel="Type only — no shape fill"
        onRemove={typeOnly}
      />
      <EffectPicker
        settings={object.animation.shapeColour}
        paint={object.appearance.containerFill}
        onEffect={(effect) => {
          setColour(id, object, 'shapeColour', {
            effect,
            config: defaultColourConfig(
              effect,
              solidBase(object.appearance.containerFill ?? object.appearance.textFill),
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
      paint={strokePaintField}
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
 * The colour effect, under a SOLID fill: what the one colour does over the
 * loop, and the effect's own controls. A gradient or a picture carries its own
 * motion, so for those there is nothing here to pick.
 */
function EffectPicker({
  settings,
  paint,
  onEffect,
  onConfig,
  onCommit,
}: {
  settings: ColourSettings
  paint: Paint
  onEffect: (effect: ColourEffect) => void
  onConfig: (key: string, value: ColourConfigValue) => void
  onCommit: (label: string) => () => void
}) {
  if (!isSolidPaint(paint)) return null
  const effect = colourEffectById(settings?.effect ?? 'none')
  return (
    <>
      <PresetSelect
        label="Colour effect"
        options={COLOUR_EFFECTS.map((e) => ({ id: e.id, label: e.label }))}
        value={effect.id}
        onChange={(next) => onEffect(next as ColourEffect)}
      />
      <ControlList
        controls={effect.controls.filter((control) => control.kind !== 'stops')}
        config={settings?.config ?? {}}
        onChange={onConfig}
        onCommit={onCommit}
      />
    </>
  )
}
