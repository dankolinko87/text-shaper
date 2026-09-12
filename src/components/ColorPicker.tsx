import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import { alphaOf, formatHex, parseHex, withAlpha } from '../typography/colour'
import { clamp01, hexToHsv, hslToHex, hsvToHex, hsvToHsl, type Hsv } from '../typography/hsv'
import { DraftNumber, HexInput, IconButton } from './controls'
import './controls.css'

/**
 * The colour picker: a field of saturation and value under a hue, an opacity
 * slider, the eyedropper, and the hex.
 *
 * Rendered through a portal to the body. Every panel clips what is positioned
 * inside it, so a picker that stood beside its swatch would be cut off at the
 * panel's edge; out here it floats above the panel it opened from and is
 * placed by hand from the swatch's own rectangle — below it, or above when
 * below would leave the window.
 *
 * Two things it keeps for itself. The HUE, while the colour cannot say it: a
 * grey or a black has no hue, and a picker that re-read it from the hex would
 * snap the hue slider to red the moment saturation touched zero. And a DRAFT
 * of the colour while a drag is under way: the document holds eight bits per
 * channel, and a ring re-derived from those each move would creep. The draft
 * stands while it and the document agree, and goes the moment they do not.
 *
 * One history entry per gesture: every move is `onChange`, the release is the
 * one `onCommit` — the rule every other control here follows.
 */

const WIDTH = 272
const GAP = 4
const MARGIN = 8

/** How the numbers are shown. Remembered for the session, as Figma remembers it. */
type Format = 'hex' | 'rgb' | 'hsl'
let lastFormat: Format = 'hex'
const FORMATS: readonly { id: Format; label: string }[] = [
  { id: 'hex', label: 'Hex' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
]

interface EyeDropperWindow {
  EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> }
}

/**
 * Where a popover hung from an anchor goes.
 *
 * BESIDE the swatch, to its left, its top level with the swatch's — the
 * panel the swatch sits in is at the right edge of the window, and a popover
 * under the swatch covered the very controls it was opened from. Below it
 * only when there is no room on the left, and above when below would leave
 * the window; never off any edge. Re-placed on resize, on any scroll
 * (capture, so the panel's own scroll counts), and whenever the popover
 * itself changes size — a tab that opens a taller body would otherwise leave
 * its bottom below the window. One taller than the window scrolls inside.
 */
export function usePopoverPlacement(
  anchor: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLDivElement | null>,
  width = WIDTH,
): void {
  useLayoutEffect(() => {
    const place = (): void => {
      const box = anchor.current?.getBoundingClientRect()
      const element = popoverRef.current
      if (!box || !element) return
      const height = element.offsetHeight
      let left = box.left - GAP - width
      let top = box.top
      if (left < MARGIN) {
        left = Math.min(Math.max(MARGIN, box.left), window.innerWidth - width - MARGIN)
        top = box.bottom + GAP
        if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, box.top - GAP - height)
      } else {
        top = Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - height))
      }
      element.style.top = `${top}px`
      element.style.left = `${left}px`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const grown = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (popoverRef.current && grown) grown.observe(popoverRef.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      grown?.disconnect()
    }
  }, [anchor, popoverRef, width])
}

export function ColorPicker({
  label,
  value,
  anchor,
  popoverRef,
  onChange,
  onCommit,
  onClose,
}: {
  label: string
  value: string
  /** The swatch the picker hangs from. */
  anchor: RefObject<HTMLElement | null>
  /** The picker's own element, for the dismissal that lives outside it. */
  popoverRef: RefObject<HTMLDivElement | null>
  onChange: (value: string) => void
  onCommit?: () => void
  onClose: () => void
}) {
  usePopoverPlacement(anchor, popoverRef)
  return createPortal(
    <div
      className="color-picker popover"
      role="dialog"
      aria-label={label}
      ref={popoverRef}
      /*
       * Escape closes the picker and goes no further: the editor's own Escape
       * would drop the selection and take the panel — and the picker — with it.
       */
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <ColorPickerBody label={label} value={value} onChange={onChange} onCommit={onCommit} />
    </div>,
    document.body,
  )
}

/** The picker's controls, for any popover that wants a colour in it. */
export function ColorPickerBody({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
}) {
  const parsed = hexToHsv(value) ?? { h: 0, s: 0, v: 0, a: 1 }
  const [hue, setHue] = useState(parsed.h)
  const [draft, setDraft] = useState<Hsv | null>(null)
  const [format, setFormat] = useState<Format>(lastFormat)
  const fieldRef = useRef<HTMLDivElement>(null)

  // The draft while it still describes the document; the document otherwise —
  // with the picker's own hue wherever the colour has none.
  const hsv: Hsv =
    draft && hsvToHex(draft) === value
      ? draft
      : { ...parsed, h: parsed.s > 0 && parsed.v > 0 ? parsed.h : hue }

  const apply = (next: Hsv): void => {
    setDraft(next)
    onChange(hsvToHex(next))
  }

  /* --------------------------------------------------------- the field */
  const pickAt = (e: PointerEvent<HTMLDivElement>): void => {
    const box = fieldRef.current?.getBoundingClientRect()
    if (!box) return
    apply({
      h: hsv.h,
      s: clamp01((e.clientX - box.left) / box.width),
      v: 1 - clamp01((e.clientY - box.top) / box.height),
      a: hsv.a,
    })
  }
  const onFieldDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    setHue(hsv.h)
    pickAt(e)
  }
  const onFieldMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) pickAt(e)
  }
  const onFieldUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit?.()
  }
  const onFieldKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.1 : 0.01
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const move = moves[e.key]
    if (!move) return
    const [ds, dv] = move
    e.preventDefault()
    setHue(hsv.h)
    apply({ ...hsv, s: clamp01(hsv.s + ds), v: clamp01(hsv.v + dv) })
  }

  // Opened by a press on the swatch; the field takes focus so the keys work at once.
  useEffect(() => {
    fieldRef.current?.focus()
  }, [])

  /* ------------------------------------------------------ eyedropper */
  const EyeDropper = (window as unknown as EyeDropperWindow).EyeDropper
  const pickFromScreen = (): void => {
    if (!EyeDropper) return
    new EyeDropper()
      .open()
      .then(({ sRGBHex }) => {
        onChange(withAlpha(sRGBHex, alphaOf(value)))
        onCommit?.()
      })
      .catch(() => {
        /* the pick was called off; nothing changes */
      })
  }

  const shade = hsvToHex({ h: hsv.h, s: hsv.s, v: hsv.v, a: 1 })
  const rgb = parseHex(value) ?? [0, 0, 0, 255]
  const hsl = hsvToHsl(hsv)

  /** One channel of the colour as a number, written back through the format it was read in. */
  const channel = (kind: 'r' | 'g' | 'b' | 'h' | 's' | 'l', next: number): void => {
    if (kind === 'r' || kind === 'g' || kind === 'b') {
      const [r, g, b, a] = rgb
      const at = { r, g, b }
      at[kind] = Math.round(Math.min(255, Math.max(0, next)))
      onChange(formatHex(at.r, at.g, at.b, a))
      return
    }
    const target = { ...hsl }
    if (kind === 'h') target.h = ((next % 360) + 360) % 360
    else target[kind] = clamp01(next / 100)
    setHue(target.h)
    apply(hexToHsv(hslToHex(target)) ?? hsv)
  }
  const number = (label: string, value: number, onPreview: (n: number) => void) => (
    <span className="color-picker__value">
      <DraftNumber label={label} value={value} onPreview={onPreview} onCommit={onCommit} />
    </span>
  )

  return (
    <>
      <div
        className="color-picker__field"
        ref={fieldRef}
        tabIndex={0}
        aria-label={`${label}: saturation and brightness`}
        aria-roledescription="colour field"
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        style={{ ['--picker-hue' as string]: `hsl(${Math.round(hsv.h)} 100% 50%)` }}
        onPointerDown={onFieldDown}
        onPointerMove={onFieldMove}
        onPointerUp={onFieldUp}
        onPointerCancel={onFieldUp}
        onKeyDown={onFieldKey}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow')) onCommit?.()
        }}
      >
        <span
          className="color-picker__ring"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: shade }}
        />
      </div>

      <input
        className="color-picker__hue"
        type="range"
        min={0}
        max={360}
        step={1}
        value={Math.round(hsv.h)}
        aria-label={`${label} hue`}
        style={{ ['--picker-hue' as string]: `hsl(${Math.round(hsv.h)} 100% 50%)` }}
        onChange={(e) => {
          const h = Number(e.target.value)
          setHue(h)
          apply({ ...hsv, h })
        }}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <input
        className="color-picker__alpha"
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(hsv.a * 100)}
        aria-label={`${label} opacity`}
        style={{ ['--picker-colour' as string]: shade }}
        onChange={(e) => apply({ ...hsv, a: Number(e.target.value) / 100 })}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />

      <div className="color-picker__row">
        {EyeDropper ? (
          <IconButton
            icon="pipette"
            label="Pick a colour from the screen"
            small
            tooltipSide="top"
            onClick={pickFromScreen}
          />
        ) : null}
        <select
          className="input color-picker__format"
          aria-label="Colour format"
          value={format}
          onChange={(e) => {
            const next = e.target.value as Format
            lastFormat = next
            setFormat(next)
          }}
        >
          {FORMATS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {format === 'hex' ? (
          <span className="color-picker__hex">
            <HexInput label={label} value={value} onChange={onChange} onCommit={onCommit} />
          </span>
        ) : format === 'rgb' ? (
          <>
            {number(`${label} red`, rgb[0], (n) => channel('r', n))}
            {number(`${label} green`, rgb[1], (n) => channel('g', n))}
            {number(`${label} blue`, rgb[2], (n) => channel('b', n))}
          </>
        ) : (
          <>
            {number(`${label} hue`, Math.round(hsl.h), (n) => channel('h', n))}
            {number(`${label} saturation`, Math.round(hsl.s * 100), (n) => channel('s', n))}
            {number(`${label} lightness`, Math.round(hsl.l * 100), (n) => channel('l', n))}
          </>
        )}
        <span className="color-field__alpha color-picker__opacity">
          <DraftNumber
            label={`${label} opacity`}
            value={Math.round(hsv.a * 100)}
            onPreview={(percent) => apply({ ...hsv, a: clamp01(percent / 100) })}
            onCommit={onCommit}
          />
          <span className="color-field__unit" aria-hidden="true">
            %
          </span>
        </span>
      </div>
    </>
  )
}
