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

export function PresetGrid({
  options,
  value,
  onChange,
}: {
  options: readonly { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div className="field field--stack">
      <div className="preset-grid">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`preset-chip${option.id === value ? ' preset-chip--active' : ''}`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
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
  config: Record<string, number | string>
  onChange: (key: string, value: number | string) => void
  onCommit: (label: string) => () => void
}) {
  return (
    <>
      {controls.map((control) =>
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
