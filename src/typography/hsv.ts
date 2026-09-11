import { clamp } from '../utils/math'
import { formatHex, parseHex } from './colour'

/**
 * Hue, saturation and value — the picker's way of seeing a colour.
 *
 * The document never holds these: it holds hex, and every reader of a colour
 * parses hex. HSV exists for one surface, the picker's field and its hue
 * slider, where a person moves through colours rather than typing them. So
 * this converts, both ways, through `parseHex`/`formatHex` — the same
 * rounding every other colour takes — so an opaque colour that goes out and
 * comes back is byte-identical, and a render cache keyed on hex is not upset
 * by a picker that merely opened.
 */
export interface Hsv {
  /** Degrees, 0..360. */
  h: number
  /** 0..1. */
  s: number
  /** 0..1. */
  v: number
  /** 0..1. */
  a: number
}

export const clamp01 = (n: number): number => clamp(n, 0, 1)

/** A grey has no hue of its own; it answers 0 and leaves the picker to keep its last. */
export function hexToHsv(hex: string): Hsv | null {
  const parsed = parseHex(hex)
  if (!parsed) return null
  const [r8, g8, b8, a8] = parsed
  const r = r8 / 255
  const g = g8 / 255
  const b = b8 / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a: a8 / 255 }
}

export function hsvToHex({ h, s, v, a }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp01(s)
  const val = clamp01(v)
  const c = val * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = val - c
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return formatHex((r + m) * 255, (g + m) * 255, (b + m) * 255, clamp01(a) * 255)
}

/** Hue, saturation and lightness — the other way a person reads a colour. */
export interface Hsl {
  h: number
  s: number
  l: number
  a: number
}

export function hsvToHsl({ h, s, v, a }: Hsv): Hsl {
  const l = v * (1 - s / 2)
  const denominator = Math.min(l, 1 - l)
  return { h, s: denominator === 0 ? 0 : (v - l) / denominator, l, a }
}

export function hslToHsv({ h, s, l, a }: Hsl): Hsv {
  const v = l + s * Math.min(l, 1 - l)
  return { h, s: v === 0 ? 0 : 2 * (1 - l / v), v, a }
}

export function hexToHsl(hex: string): Hsl | null {
  const hsv = hexToHsv(hex)
  return hsv ? hsvToHsl(hsv) : null
}

export const hslToHex = (hsl: Hsl): string => hsvToHex(hslToHsv(hsl))
