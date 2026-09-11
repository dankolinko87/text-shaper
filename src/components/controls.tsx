import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { alphaOf, withAlpha } from '../typography/colour'
import type { PositionedStroke, Stroke, StrokePosition } from '../types/document'
import { Icon, type IconName } from './Icon'
import './controls.css'

/* --------------------------------------------------------------- Tooltip */

interface TooltipProps {
  label: string
  shortcut?: string
  side?: 'top' | 'right' | 'bottom'
  children: ReactNode
}

/**
 * How long the pointer must rest on a control before its tip appears — and for
 * how long after one tip hides the next appears at once.
 *
 * The delay is what keeps a sweep across the toolbar from flashing five tips;
 * the warm window is what keeps a deliberate hunt from waiting five times.
 * Shared across every tooltip, because "the user is reading tips" is a fact
 * about the user and not about any one control.
 */
const OPEN_DELAY_MS = 400
const WARM_MS = 300
let lastHidden = 0

/**
 * Tooltips appear on hover AND on keyboard focus, so the shortcut hints are
 * reachable without a mouse. Focus shows at once: a keyboard user has already
 * said which control they mean.
 */
export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timer = useRef<number | null>(null)
  const shown = useRef(false)

  const cancel = (): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }
  const show = (): void => {
    cancel()
    shown.current = true
    setVisible(true)
  }
  const hide = (): void => {
    cancel()
    if (shown.current) lastHidden = Date.now()
    shown.current = false
    setVisible(false)
  }
  const enter = (): void => {
    if (Date.now() - lastHidden < WARM_MS) {
      show()
      return
    }
    cancel()
    timer.current = window.setTimeout(show, OPEN_DELAY_MS)
  }
  useEffect(() => cancel, [])

  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={enter}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {/*
        Mounted only while shown. A hidden tip that stays in the layout still
        counts towards its scroll container's width — and a long tip beside a
        control at a panel's edge gave the states rail a horizontal scrollbar
        for a label nobody could see.
      */}
      {visible ? (
        <span className="tooltip" data-side={side} role="presentation">
          {label}
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      ) : null}
    </span>
  )
}

/* ------------------------------------------------------------ IconButton */

interface IconButtonProps {
  icon: IconName
  /** Always required — icon-only buttons must still name themselves for screen readers. */
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  danger?: boolean
  small?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom'
  onClick: () => void
}

export function IconButton({
  icon,
  label,
  shortcut,
  active = false,
  disabled = false,
  danger = false,
  small = false,
  tooltipSide = 'bottom',
  onClick,
}: IconButtonProps) {
  const classes = ['icon-button']
  if (danger) classes.push('icon-button--danger')
  if (small) classes.push('icon-button--sm')

  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type="button"
        className={classes.join(' ')}
        data-active={active}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
      >
        {/*
          Twenty in a thirty-pixel control. Sixteen left the glyph adrift in the
          middle of its button and made the toolbar read as smaller than it is;
          the dense variant takes sixteen, where the button is 22px.
        */}
        <Icon name={icon} size={small ? 16 : 20} />
      </button>
    </Tooltip>
  )
}

/* ---------------------------------------------------------------- Button */

interface ButtonProps {
  children: ReactNode
  icon?: IconName
  variant?: 'default' | 'primary' | 'ghost'
  disabled?: boolean
  onClick: () => void
}

export function Button({
  children,
  icon,
  variant = 'default',
  disabled = false,
  onClick,
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`button${variant === 'default' ? '' : ` button--${variant}`}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  )
}

/* ---------------------------------------------------------------- Slider */

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Formats the readout; defaults to a rounded number. Ignored when editable. */
  format?: (value: number) => string
  onChange: (value: number) => void
  /** Called once when the drag ends, so one drag makes one history entry. */
  onCommit?: () => void
  /**
   * Makes the readout a number field, for a value worth typing exactly.
   *
   * Off by default: most sliders here set a proportion nobody wants to name to
   * two decimal places, and a spin box beside every one of them would be noise.
   */
  editable?: boolean
  /** Marks the field as having just refused a value, for a brief accent. */
  limited?: boolean
  /**
   * Greys the control out and stops it accepting anything.
   *
   * For a value that is real and kept but has nothing to act on — the last
   * state's transition while looping is off, say. Disabled rather than hidden,
   * because the number is still the authored one and will matter again.
   */
  disabled?: boolean
  /** A unit shown beside an editable readout, where the number alone is ambiguous. */
  suffix?: string
  /**
   * The one thing about this control that cannot be seen — a modifier key, a
   * gesture — as a tooltip on its label. Never a description of what the
   * control does: the label says that, and a paragraph under a slider is a
   * paragraph you scroll past every time.
   */
  tip?: string
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  onCommit,
  editable = false,
  limited = false,
  disabled = false,
  suffix,
  tip,
}: SliderProps) {
  const id = useId()
  const caption = (
    <label className="field__label" htmlFor={id}>
      {label}
    </label>
  )
  return (
    <div className="field" data-limited={limited || undefined} data-disabled={disabled || undefined}>
      {tip ? (
        <Tooltip label={tip} side="top">
          {caption}
        </Tooltip>
      ) : (
        caption
      )}
      <div className="slider">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          // A slider cannot ask for more than its range allows, so the value it
          // shows is the stored one — clamped here only for a document that
          // arrived holding something outside it.
          value={Math.min(Math.max(value, min), max)}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
        {editable ? (
          <span className="slider__entry">
            <DraftNumber
              label={label}
              value={value}
              disabled={disabled}
              onPreview={onChange}
              onCommit={onCommit}
            />
            {suffix ? <span className="slider__suffix">{suffix}</span> : null}
          </span>
        ) : (
          <span className="slider__value">{format ? format(value) : Math.round(value)}</span>
        )}
      </div>
    </div>
  )
}

/**
 * A number field that lets you finish typing.
 *
 * The obvious version — bind the input to the stored value, write on every
 * keystroke — cannot be typed in at all once the stored value is clamped.
 * Typing `12` writes `1`, the limits recompute around `1`, the field re-renders
 * as `1`, and the `2` lands on a value that has already moved. The user is left
 * fighting their own control.
 *
 * So while the field has focus it renders EXACTLY what was typed and nothing
 * writes over it. The store still hears every intelligible draft, which is what
 * keeps the canvas moving as you type, but the field is not listening back.
 *
 * One editing session is one history entry: drafts preview without committing
 * and the commit fires once, on Enter or on the way out.
 */
function DraftNumber({
  label,
  value,
  onPreview,
  onCommit,
  disabled = false,
}: {
  label: string
  value: number
  onPreview: (value: number) => void
  onCommit?: () => void
  disabled?: boolean
}) {
  /** Null means "not being edited": show the stored value. */
  const [draft, setDraft] = useState<string | null>(null)
  /** What it was before this session, so Escape has something to go back to. */
  const openedAt = useRef(value)

  const shown = draft ?? String(Math.round(value * 100) / 100)

  const finish = (element: HTMLInputElement): void => {
    setDraft(null)
    onCommit?.()
    element.blur()
  }

  return (
    <input
      className="input input--number slider__input"
      type="text"
      inputMode="decimal"
      aria-label={label}
      disabled={disabled}
      value={shown}
      onFocus={(e) => {
        openedAt.current = value
        setDraft(String(Math.round(value * 100) / 100))
        e.currentTarget.select()
      }}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        /*
         * `Number('')` is 0, and `Number(' ')` is too — so an empty field would
         * write a zero the user never asked for and then fight them as they
         * typed the rest. Emptiness is checked before finiteness, not after.
         * `-` and `.` fail the finite test on their own, as they should: they
         * are halfway to a number, not a number.
         */
        const trimmed = raw.trim()
        if (trimmed !== '' && Number.isFinite(Number(trimmed))) onPreview(Number(trimmed))
      }}
      onKeyDown={(e) => {
        // The canvas listens for keys too, and a mosaic being typed into would
        // otherwise take these digits into a tile.
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget)
        if (e.key === 'Escape') {
          // Put back what was there when the field was opened. Uncommitted, so
          // an abandoned edit leaves no entry in the history at all.
          onPreview(openedAt.current)
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => finish(e.currentTarget)}
    />
  )
}

/* ------------------------------------------------------- SegmentedControl */

interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="field">
      <span className="field__label" id={`${label}-label`}>
        {label}
      </span>
      <div className="segmented" role="group" aria-labelledby={`${label}-label`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ ColorField */

interface ColorFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
  /**
   * The things being edited do not agree on a colour.
   *
   * The field says so rather than showing one of them as if it spoke for the
   * rest — but it still accepts a colour, and that colour goes to all of them.
   */
  mixed?: boolean
  /**
   * What the field says when it has no colour to show.
   *
   * "Mixed" is right for a set of things that disagree, and wrong for a single
   * value that is simply absent — a backdrop nobody has chosen is not a
   * disagreement. The default keeps every existing field reading as it did.
   */
  emptyLabel?: string
  disabled?: boolean
  /**
   * No visible label: the section names the thing. The label is still spoken,
   * because a swatch with no name is a swatch with no name to a screen reader.
   */
  bare?: boolean
  /** Take the colour away — a fill that can be absent, a border, a banner. */
  onRemove?: () => void
  removeLabel?: string
}

export function ColorField({
  label,
  value,
  onChange,
  onCommit,
  mixed = false,
  emptyLabel = 'Mixed',
  disabled = false,
  bare = false,
  onRemove,
  removeLabel = 'Remove',
}: ColorFieldProps) {
  const id = useId()
  const alpha = alphaOf(value)
  /*
   * The native picker cannot carry transparency — it hands back six digits
   * whatever it was given — so the shade it returns is put back on top of the
   * opacity already chosen rather than replacing the colour outright. Picking a
   * new shade on a half-visible fill leaves it half visible.
   */
  const shade = withAlpha(value, 1)
  /*
   * One row, the shape Figma's is: swatch and hex in one well, the opacity as
   * a percentage in a second, and the remove control at the end. The `#` is
   * not shown — every hex here is a colour, so the sign says nothing.
   */
  const hex = mixed ? '' : value.replace(/^#/, '')

  return (
    <div className="field" data-disabled={disabled || undefined}>
      {bare ? null : (
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="color-field" data-mixed={mixed || undefined}>
        <span className="color-field__well">
          <span className="color-field__swatch">
            {/* Checks behind, so transparency reads as transparency and not as a
                lighter colour. */}
            <span className="color-field__fill" style={{ background: value }} />
            <input
              id={id}
              type="color"
              value={shade}
              disabled={disabled}
              aria-label={mixed ? `${label}, ${emptyLabel.toLowerCase()}` : label}
              onChange={(e) => onChange(withAlpha(e.target.value, alpha))}
              onBlur={onCommit}
            />
          </span>
          <input
            className="color-field__hex"
            /*
             * With a mixed selection the field says so rather than showing the
             * first tile's value as if it spoke for the rest. Typing a colour
             * still applies it to everything selected — the emptiness is a
             * readout, not a refusal.
             */
            value={hex}
            placeholder={mixed ? emptyLabel : undefined}
            disabled={disabled}
            spellCheck={false}
            aria-label={`${label} hex value${mixed ? `, ${emptyLabel.toLowerCase()}` : ''}`}
            onChange={(e) => {
              const next = e.target.value.replace(/^#/, '')
              if (/^[0-9a-fA-F]{0,8}$/.test(next)) onChange(`#${next}`)
            }}
            onBlur={onCommit}
          />
        </span>
        <span className="color-field__alpha">
          <DraftNumber
            label={`${label} opacity`}
            value={Math.round(alpha * 100)}
            disabled={disabled}
            onPreview={(percent) =>
              onChange(withAlpha(value, Math.min(1, Math.max(0, percent / 100))))
            }
            onCommit={onCommit}
          />
          <span className="color-field__unit" aria-hidden="true">
            %
          </span>
        </span>
        {onRemove ? (
          <IconButton
            icon="minus"
            label={removeLabel}
            small
            tooltipSide="top"
            disabled={disabled}
            onClick={onRemove}
          />
        ) : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- AddRow */

/**
 * A part that is not there yet: its name, and a + to add it.
 *
 * The row is the shape the part will have once added — a name at the left, a
 * control at the right — so adding does not shift the section; and it is the
 * row Figma uses for a fill, a stroke or an effect, which is where everyone's
 * hand already knows it.
 */
export function AddRow({
  label,
  add,
  onAdd,
  disabled = false,
}: {
  label: string
  /** What the + does, for the tooltip and the screen reader. */
  add: string
  onAdd: () => void
  disabled?: boolean
}) {
  return (
    <div className="add-row">
      <span className="add-row__label">{label}</span>
      <IconButton icon="plus" label={add} small tooltipSide="top" disabled={disabled} onClick={onAdd} />
    </div>
  )
}

/* ----------------------------------------------------------- NumberField */

interface NumberFieldProps {
  label: string
  value: number
  step?: number
  onChange: (value: number) => void
  onCommit?: () => void
}

export function NumberField({ label, value, step = 1, onChange, onCommit }: NumberFieldProps) {
  const id = useId()
  return (
    <div className="field__row">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input input--number"
        type="number"
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
        onBlur={onCommit}
      />
    </div>
  )
}

/* ------------------------------------------------------------ StrokeField */

/**
 * A border, wherever one can be added.
 *
 * One control, used by the shape and by the mosaic today and by the banner, the
 * type, a tile or a drawn line whenever they want one. It renders rows into
 * whatever section it is dropped into — no heading, no box — because a border
 * is a property of a part, not a part of its own.
 *
 * ## Nothing exists until it is added
 *
 * `null` is the resting value and it means no border, exactly as it does for
 * `containerFill` and `lineFill`. While it is null this is a single Add row and
 * nothing else: no width, no position, no style, not disabled, not hidden —
 * absent. A shape with no border has a panel that never mentions one, and
 * removing a border returns the section to precisely the height it had.
 *
 * The Add row is deliberately the same shape as the fill row above it — same
 * label column, same ghost button — because a border is a paint like a fill and
 * is added the way a fill is.
 */
export function StrokeField({
  value,
  onChange,
  onCommit,
  positions = true,
  label = 'Border',
  addLabel = 'Add border',
  defaults,
  disabled = false,
}: {
  /** What the part is called on its add row and its remove control. */
  label?: string
  value: Stroke | PositionedStroke | null
  onChange: (next: Stroke | PositionedStroke | null) => void
  onCommit?: (label: string) => void
  /**
   * Whether a position can be honoured here.
   *
   * False for a part whose border can only ever sit inside — the mosaic's
   * silhouette, which is clipped to itself. The row is absent rather than
   * disabled, because a disabled control invites you to wonder what would
   * happen, and nothing would.
   */
  positions?: boolean
  addLabel?: string
  /** What Add gives you. A visible edge, not an invisible one. */
  defaults: Stroke | PositionedStroke
  disabled?: boolean
}) {
  /*
   * No label column on the Add row, and no heading above it.
   *
   * This lives in a section of its own now — one called Border — so a "Border"
   * label inside it would be the word twice on one screen. The section names
   * the thing; these rows are its settings.
   */
  if (value === null) {
    return (
      <AddRow
        label={label}
        add={addLabel}
        disabled={disabled}
        onAdd={() => {
          onChange(defaults)
          onCommit?.('Add border')
        }}
      />
    )
  }

  const patch = (next: Partial<Stroke & { position: StrokePosition }>, label: string): void => {
    onChange({ ...value, ...next } as Stroke | PositionedStroke)
    onCommit?.(label)
  }
  const dashed = value.dash !== null
  const position = 'position' in value ? value.position : 'centre'

  return (
    <>
      <ColorField
        label={`${label} colour`}
        bare
        value={value.colour}
        disabled={disabled}
        onChange={(colour) => onChange({ ...value, colour })}
        onCommit={() => onCommit?.('Change border colour')}
        removeLabel={`Remove ${label.toLowerCase()}`}
        onRemove={() => {
          onChange(null)
          onCommit?.('Remove border')
        }}
      />

      <Slider
        label="Width"
        value={value.width}
        min={0.5}
        max={40}
        step={0.5}
        editable
        disabled={disabled}
        onChange={(width) => onChange({ ...value, width })}
        onCommit={() => onCommit?.('Change border width')}
      />

      {positions ? (
        <SegmentedControl<StrokePosition>
          label="Position"
          value={position}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'centre', label: 'Centre' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={(next) => patch({ position: next }, 'Change border position')}
        />
      ) : null}

      <SegmentedControl<'solid' | 'dashed'>
        label="Style"
        value={dashed ? 'dashed' : 'solid'}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'dashed', label: 'Dashed' },
        ]}
        /*
          The dash it had, not a fresh one: switching to Solid and back should
          return the rhythm that was set rather than a default, so the switch is
          a preview rather than a decision you have to redo.
        */
        onChange={(next) =>
          patch(
            { dash: next === 'dashed' ? (value.dash ?? { length: 8, gap: 4 }) : null },
            'Change border style',
          )
        }
      />

      {/* Only once there are dashes to apply them to. */}
      {dashed && value.dash ? (
        <>
          <Slider
            label="Dash"
            value={value.dash.length}
            min={1}
            max={60}
            step={1}
            editable
            disabled={disabled}
            onChange={(length) => onChange({ ...value, dash: { ...value.dash!, length } })}
            onCommit={() => onCommit?.('Change dash')}
          />
          <Slider
            label="Gap"
            value={value.dash.gap}
            min={0}
            max={60}
            step={1}
            editable
            disabled={disabled}
            onChange={(gap) => onChange({ ...value, dash: { ...value.dash!, gap } })}
            onCommit={() => onCommit?.('Change dash gap')}
          />
        </>
      ) : null}
    </>
  )
}
