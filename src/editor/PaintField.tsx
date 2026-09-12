import { useCallback, useId, useRef, useState } from 'react'

import { DraftNumber, HexInput, IconButton, type StrokePaintProps } from '../components/controls'
import { useDismiss } from '../components/useDismiss'
import { useDocumentStore } from '../state/documentStore'
import { alphaOf, withAlpha } from '../typography/colour'
import { isImagePaint, paintKindOf, paintOfKind } from '../typography/paint'
import type { Paint, PaintKind, StrokePaint } from '../types/paint'
import { paintCss } from './gradientCss'
import { importImageFile, pickImageFile } from './imageImport'
import { PaintPicker } from './PaintPicker'
import './panels.css'

/**
 * One control for any fill: a colour, a gradient, or a picture.
 *
 * Every colour input in the app is this, so every part — a shape's type and
 * body, a banner, a border, a tile, a letter, an object's background — offers
 * the same three and edits them the same way. The row itself is small: the
 * swatch, what the paint is (a hex, "Linear", "Image"), its opacity, and the
 * minus that takes it away. The swatch opens the picker, which carries the
 * three kinds as tabs and everything each kind can be set to.
 *
 * Choosing a kind keeps what it can of the old value — a colour becomes a
 * gradient starting from itself, a gradient becomes its first colour — so
 * switching is never a reset.
 */

const KIND_LABELS: Record<PaintKind, string> = { solid: 'Solid', gradient: 'Gradient', image: 'Image' }
const ALL: readonly PaintKind[] = ['solid', 'gradient', 'image']

export function PaintField({
  label,
  value,
  onChange,
  onCommit,
  mixed = false,
  emptyLabel = 'Mixed',
  onRemove,
  removeLabel,
  disabled = false,
  allow = ALL,
  motion = false,
  bare = false,
  onCrop,
}: {
  label: string
  value: Paint | null
  onChange: (paint: Paint) => void
  /** Every finished change, with what it was. */
  onCommit: (label: string) => void
  /** The things being edited do not agree; the field says so and takes a value for all of them. */
  mixed?: boolean
  emptyLabel?: string
  onRemove?: () => void
  removeLabel?: string
  disabled?: boolean
  /** Which kinds this part can take. A line takes no picture. */
  allow?: readonly PaintKind[]
  /** Whether a gradient here may move over the loop: a shape's own fills. */
  motion?: boolean
  /** No visible label: the section names the thing. */
  bare?: boolean
  /** Enter the crop mode for this picture on the canvas. */
  onCrop?: () => void
}) {
  const id = useId()
  const swatchRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
    swatchRef.current?.focus()
  }, [])
  useDismiss(open, close, swatchRef, popoverRef)

  const shown = mixed ? null : value
  const kind: PaintKind | null = shown === null ? null : paintKindOf(shown)
  const image = shown !== null && isImagePaint(shown) ? shown : null
  const src = useDocumentStore((s) => (image ? s.doc.assets[image.asset]?.src : undefined))
  const lower = label.toLowerCase()

  /*
   * A picture is chosen from disk, and the paint is written only once a file
   * has been read: there is no half-made picture paint to show meanwhile.
   * The asset goes into the document first, so the paint has something to
   * name; the same picture twice is one asset.
   */
  const pickImage = async (): Promise<void> => {
    const input = fileRef.current
    if (!input) return
    const file = await pickImageFile(input)
    if (!file) return
    try {
      const asset = await importImageFile(file)
      const assetId = useDocumentStore.getState().addAsset(asset)
      const paint = paintOfKind('image', shown, assetId)
      if (!paint) return
      onChange(paint)
      onCommit(image ? `Replace ${lower} picture` : `Picture ${lower}`)
    } catch {
      // Not a picture the browser can read; nothing changes.
    }
  }

  const swatchStyle = src
    ? { backgroundImage: `url(${src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: paintCss(shown) }

  return (
    <div className="paint-field" data-disabled={disabled}>
      {bare ? null : (
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="color-field" data-mixed={mixed || shown === null || undefined}>
        <span className="color-field__well">
          <button
            type="button"
            id={id}
            ref={swatchRef}
            className="color-field__swatch"
            aria-label={mixed ? `${label}, ${emptyLabel.toLowerCase()}` : label}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen((was) => !was)}
          >
            <span className="color-field__fill" style={swatchStyle} />
          </button>
          {typeof shown === 'string' ? (
            <HexInput
              label={label}
              value={shown}
              disabled={disabled}
              onChange={(colour) => onChange(colour)}
              onCommit={() => onCommit(`Colour ${lower}`)}
            />
          ) : (
            <span className="paint-field__kind">
              {shown === null ? emptyLabel : kind === 'gradient' ? (shown.kind === 'gradient' && shown.shape === 'radial' ? 'Radial' : 'Linear') : KIND_LABELS[kind ?? 'solid']}
            </span>
          )}
        </span>
        {typeof shown === 'string' || image ? (
          <span className="color-field__alpha">
            <DraftNumber
              label={`${label} opacity`}
              value={Math.round((image ? (image.opacity ?? 1) : alphaOf(shown as string)) * 100)}
              disabled={disabled}
              onPreview={(percent) => {
                const alpha = Math.min(1, Math.max(0, percent / 100))
                if (image) onChange(alpha >= 1 ? { ...image, opacity: undefined } : { ...image, opacity: alpha })
                else onChange(withAlpha(shown as string, alpha))
              }}
              onCommit={() => onCommit(`Fade ${lower}`)}
            />
            <span className="color-field__unit" aria-hidden="true">
              %
            </span>
          </span>
        ) : null}
        {onRemove ? (
          <IconButton
            icon="minus"
            label={removeLabel ?? `Remove ${lower}`}
            small
            tooltipSide="top"
            disabled={disabled}
            onClick={onRemove}
          />
        ) : null}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="paint-field__file"
        tabIndex={-1}
        aria-hidden="true"
      />

      {open ? (
        <PaintPicker
          label={label}
          value={shown}
          anchor={swatchRef}
          popoverRef={popoverRef}
          allow={allow}
          motion={motion}
          src={src}
          onChange={onChange}
          onCommit={onCommit}
          onPickImage={() => void pickImage()}
          onCrop={onCrop}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

/** The paint field as a line's paint control: no picture on an edge. */
export function strokePaintField(props: StrokePaintProps) {
  return (
    <PaintField
      label={props.label}
      bare
      value={props.value}
      disabled={props.disabled}
      allow={['solid', 'gradient']}
      onChange={(paint) => props.onChange(paint as StrokePaint)}
      onCommit={props.onCommit}
      onRemove={props.onRemove}
      removeLabel={props.removeLabel}
    />
  )
}
