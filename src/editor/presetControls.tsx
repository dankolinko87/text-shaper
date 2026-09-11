import { useId } from 'react'

import { ColorField, SegmentedControl, Slider } from '../components/controls'
import type { AnimationControl } from '../typography/animation'
import './panels.css'

/**
 * The pieces every preset menu is made of.
 *
 * Shared by the Animate and Colour tabs so that a preset is only ever described
 * once, in its own descriptor, and never again in interface code. Adding an
 * effect anywhere means adding it to a list — no panel changes at all.
 */

/**
 * Which preset is on: a labelled dropdown, the same control the font uses.
 *
 * A grid of chips read as a set of unrelated buttons and never said what it
 * was a choice OF; a select under a label does, and it is the one way of
 * choosing from a list this panel has, wherever the list appears.
 */
export function PresetSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Whatever controls a preset declared: sliders for numbers, a swatch for colours.
 *
 * The colour effects need a real second colour to cross to. Rotating the hue of
 * a near-black or a grey moves it by almost nothing, which is exactly why they
 * looked broken before there was anything here to pick one.
 */
export function ControlList({
  controls,
  config,
  onChange,
  onCommit,
}: {
  controls: readonly AnimationControl[]
  config: Readonly<Record<string, unknown>>
  onChange: (key: string, value: number | string) => void
  onCommit: (label: string) => () => void
}) {
  // A control hidden by its own `when` is absent, not disabled.
  const shown = controls.filter((control) => !control.when || control.when(config))
  return (
    <>
      {shown.map((control) =>
        control.kind === 'choice' ? (
          <SegmentedControl
            key={control.key}
            label={control.label}
            value={String(config[control.key] ?? control.value)}
            options={control.options}
            onChange={(value) => {
              onChange(control.key, value)
              onCommit(control.label)()
            }}
          />
        ) : control.kind === 'colour' ? (
          <ColorField
            key={control.key}
            label={control.label}
            value={String(config[control.key] ?? control.value)}
            onChange={(value) => onChange(control.key, value)}
            onCommit={onCommit(control.label)}
          />
        ) : (
          <Slider
            key={control.key}
            label={control.label}
            value={Number(config[control.key] ?? control.value)}
            min={control.min}
            max={control.max}
            step={control.step}
            {...(control.format ? { format: control.format } : {})}
            onChange={(value) => onChange(control.key, value)}
            onCommit={onCommit(control.label)}
          />
        ),
      )}
    </>
  )
}
