import { createPortal } from 'react-dom'
import type { RefObject } from 'react'

import { ColorPickerBody, usePopoverPlacement } from '../components/ColorPicker'
import { AddRow, Button, IconButton, Slider } from '../components/controls'
import { Icon, type IconName } from '../components/Icon'
import { STOPS_CONTROL, sortStops } from '../typography/colour'
import { isGradientPaint, isImagePaint, paintKindOf, paintOfKind } from '../typography/paint'
import type { GradientMotion, Paint, PaintKind } from '../types/paint'
import { GradientField } from './GradientField'
import './panels.css'

/**
 * The picker for any paint: three tabs — a colour, a gradient, a picture —
 * and under each the settings that kind has, the way Figma's fill picker
 * does it. Opened from a paint field's swatch and placed like the colour
 * picker, since for a solid colour it IS the colour picker.
 */

const ICONS: Record<PaintKind, IconName> = { solid: 'square', gradient: 'blend', image: 'image' }
const NAMES: Record<PaintKind, string> = { solid: 'Solid', gradient: 'Gradient', image: 'Image' }
/** The motions a gradient can be given; still is the absence of one. */
const MOTIONS: readonly { value: Exclude<GradientMotion, 'still'>; label: string }[] = [
  { value: 'sweep', label: 'Side to side' },
  { value: 'hover', label: 'Hover' },
  { value: 'pulse', label: 'Pulse' },
]

export function PaintPicker({
  label,
  value,
  anchor,
  popoverRef,
  allow,
  motion = false,
  src,
  onChange,
  onCommit,
  onPickImage,
  onCrop,
  onClose,
}: {
  label: string
  value: Paint | null
  anchor: RefObject<HTMLElement | null>
  popoverRef: RefObject<HTMLDivElement | null>
  allow: readonly PaintKind[]
  motion?: boolean
  /** The picture's source, when the paint is one. */
  src?: string | undefined
  onChange: (paint: Paint) => void
  onCommit: (label: string) => void
  /** Ask for a picture file; the image tab needs one before it can be chosen. */
  onPickImage: () => void
  onCrop?: (() => void) | undefined
  onClose: () => void
}) {
  usePopoverPlacement(anchor, popoverRef)
  const kind: PaintKind = value === null ? 'solid' : paintKindOf(value)
  const gradient = value !== null && isGradientPaint(value) ? value : null
  const image = value !== null && isImagePaint(value) ? value : null
  const lower = label.toLowerCase()

  const choose = (next: PaintKind): void => {
    if (next === kind && value !== null) return
    if (next === 'image') {
      onPickImage()
      return
    }
    const paint = paintOfKind(next, value)
    if (!paint) return
    onChange(paint)
    onCommit(next === 'solid' ? `Colour ${lower}` : `Blend ${lower}`)
  }

  return createPortal(
    <div
      className="color-picker paint-picker popover"
      role="dialog"
      aria-label={label}
      ref={popoverRef}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="paint-picker__tabs" role="tablist" aria-label={`${label} type`}>
        {allow.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            className="paint-picker__tab"
            aria-selected={kind === each && value !== null}
            aria-label={NAMES[each]}
            title={NAMES[each]}
            onClick={() => choose(each)}
          >
            <Icon name={ICONS[each]} size={16} />
          </button>
        ))}
      </div>

      {gradient ? (
        <>
          <div className="paint-picker__shape">
            <select
              className="input"
              aria-label="Gradient shape"
              value={gradient.shape}
              onChange={(e) => {
                onChange({ ...gradient, shape: e.target.value as 'linear' | 'radial' })
                onCommit('Change gradient shape')
              }}
            >
              <option value="linear">Linear</option>
              <option value="radial">Radial</option>
            </select>
            <IconButton
              icon="splitHorizontal"
              small
              label="Flip the gradient"
              tooltipSide="top"
              onClick={() => {
                onChange({ ...gradient, stops: sortStops(gradient.stops.map((stop) => ({ ...stop, at: 1 - stop.at }))) })
                onCommit('Flip gradient')
              }}
            />
            <IconButton
              icon="restart"
              small
              label="Turn the gradient a quarter"
              tooltipSide="top"
              onClick={() => {
                onChange({ ...gradient, angle: (gradient.angle + 90) % 360 })
                onCommit('Turn gradient')
              }}
            />
          </div>
          <GradientField
            control={STOPS_CONTROL}
            stops={gradient.stops}
            onChange={(stops) => onChange({ ...gradient, stops })}
            onCommit={onCommit}
          />
          <Slider
            label="Angle"
            value={gradient.angle}
            min={0}
            max={359}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(angle) => onChange({ ...gradient, angle })}
            onCommit={() => onCommit('Turn gradient')}
          />
          {motion ? <hr className="paint-picker__divider" /> : null}
          {motion && (gradient.motion ?? 'still') === 'still' ? (
            <AddRow
              label="Motion"
              add="Add motion"
              onAdd={() => {
                onChange({ ...gradient, motion: 'sweep', travel: gradient.travel ?? 0.5 })
                onCommit('Add gradient motion')
              }}
            />
          ) : null}
          {motion && (gradient.motion ?? 'still') !== 'still' ? (
            <div className="field">
              <span className="field__label">Motion</span>
              <div className="paint-picker__motion">
                <select
                  className="input"
                  aria-label="Gradient motion"
                  value={gradient.motion}
                  onChange={(e) => {
                    onChange({ ...gradient, motion: e.target.value as GradientMotion })
                    onCommit('Change gradient motion')
                  }}
                >
                  {MOTIONS.map((each) => (
                    <option key={each.value} value={each.value}>
                      {each.label}
                    </option>
                  ))}
                </select>
                <IconButton
                  icon="minus"
                  small
                  label="Remove the motion"
                  tooltipSide="top"
                  onClick={() => {
                    const { motion: _was, travel: _travel, ...rest } = gradient
                    onChange(rest)
                    onCommit('Remove gradient motion')
                  }}
                />
              </div>
            </div>
          ) : null}
          {motion && (gradient.motion ?? 'still') !== 'still' ? (
            <Slider
              label="Travel"
              value={gradient.travel ?? 0.5}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(travel) => onChange({ ...gradient, travel })}
              onCommit={() => onCommit('Change gradient travel')}
            />
          ) : null}
        </>
      ) : image ? (
        <>
          <div
            className="paint-picker__preview"
            style={src ? { backgroundImage: `url(${src})` } : undefined}
            aria-hidden="true"
          />
          <div className="paint-picker__actions">
            <Button variant="ghost" onClick={onPickImage}>
              Replace
            </Button>
            {onCrop ? (
              <Button variant="ghost" icon="crop" onClick={onCrop}>
                Crop
              </Button>
            ) : null}
          </div>
          <Slider
            label="Opacity"
            value={image.opacity ?? 1}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(opacity) => onChange(opacity >= 1 ? { ...image, opacity: undefined } : { ...image, opacity })}
            onCommit={() => onCommit(`Fade ${lower} picture`)}
          />
        </>
      ) : (
        <ColorPickerBody
          label={label}
          value={typeof value === 'string' ? value : '#ffffffff'}
          onChange={(colour) => onChange(colour)}
          onCommit={() => onCommit(`Colour ${lower}`)}
        />
      )}
    </div>,
    document.body,
  )
}
