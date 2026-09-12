import type { ColourConfigValue, ColourEffect, ColourSettings, GradientStop } from '../types/document'
import type { ImageCrop, Paint } from '../types/paint'
import { clamp } from '../utils/math'
import type { AnimationControl, ControlBase } from './animation'
import { resolvePaint } from './paint'

/**
 * Colour, and what it does over the loop.
 *
 * Kept apart from motion for two reasons. A sticker should be able to shimmer
 * AND bounce — while colour was one of the motion presets, choosing it meant
 * giving up movement. And the resting colour and its animation are one decision
 * made in one place: picking a shade and then hunting through another tab for
 * the effect that acts on it is how the colour presets ended up looking broken.
 *
 * The same four effects apply to the type and to the container, chosen
 * separately, so a still shape can hold shifting type or the reverse.
 */

/**
 * A fill, which is not always one colour.
 *
 * Everything that draws — the editor's canvas and the GIF encoder — turns this
 * into its own kind of paint. Describing the fill rather than resolving it here
 * is what keeps one gradient identical in the preview and in the export.
 */
export type FillPaint =
  | { kind: 'solid'; colour: string }
  | {
      kind: 'gradient'
      shape: 'linear'
      /** The colours along the blend, in order. Beyond the outermost, the outer colour holds. */
      stops: readonly GradientStop[]
      /** Degrees, clockwise from pointing right. */
      angle: number
      /** How far the band is pushed along its own axis, as a share of the box. */
      offset: number
      /** How much of the box the blend spans. 1 is corner to corner. */
      spread: number
    }
  | {
      kind: 'gradient'
      shape: 'radial'
      /** The colours along the blend, in order. Beyond the outermost, the outer colour holds. */
      stops: readonly GradientStop[]
      /** Where the middle sits, as a fraction of the box. (0.5, 0.5) is centred. */
      centre: { x: number; y: number }
      /** How far the blend reaches, as a share of the box's half-diagonal. */
      radius: number
    }
  | {
      kind: 'image'
      /** Which picture, by asset id; the renderer looks it up. */
      asset: string
      crop: ImageCrop
      opacity: number
    }

/** A gradient's colours: a list of stops, the one control the generic list cannot draw. */
export interface StopsControl extends ControlBase {
  kind: 'stops'
  key: 'stops'
  value: GradientStop[]
  min: number
  max: number
}
export type ColourControl = AnimationControl | StopsControl
export const MIN_STOPS = 2
export const MAX_STOPS = 8

type ColourConfig = Readonly<Record<string, ColourConfigValue>>

export interface ColourEffectDef {
  id: ColourEffect
  label: string
  hint: string
  controls: ColourControl[]
  /** The fill at this moment, given the artwork's own resting colour. */
  paint(config: ColourConfig, phase: number, base: string): FillPaint
}

const whole = (v: number): string => `${Math.round(v)}`

/** The second colour every effect crosses to. Warm, and visible on most things. */
const SECOND_COLOUR = '#e0552f'
/*
 * A fresh gradient's first stop. The document's own default text fill — but
 * every real use goes through `defaultColourConfig(id, base)`, which puts the
 * part's actual colour there; this is only what a config seeded with no base
 * in hand starts from.
 */
const FIRST_COLOUR = '#101014'

function read(
  config: ColourConfig,
  key: string,
  fallback: number,
): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readColour(
  config: ColourConfig,
  key: string,
  fallback: string,
): string {
  const value = config[key]
  // Eight digits as well as six: an effect colour carries its opacity.
  return typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim())
    ? value.trim()
    : fallback
}

/** Stops in order of `at`, as a copy; the stop objects themselves are kept. */
export function sortStops(stops: readonly GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.at - b.at)
}

const isStop = (value: unknown): value is GradientStop =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as GradientStop).at === 'number' &&
  Number.isFinite((value as GradientStop).at) &&
  typeof (value as GradientStop).colour === 'string' &&
  parseHex((value as GradientStop).colour) !== null

/**
 * A gradient's stops, sorted and clamped — or, for a config that predates
 * stops, the picture it painted: the part's own colour to the one it blended
 * to. So nothing is wrong between a document being loaded and migrated.
 */
export function gradientStops(config: ColourConfig, base: string): GradientStop[] {
  const value = config['stops']
  if (Array.isArray(value)) {
    const stops = value.filter(isStop).map((stop) => ({ at: clamp(stop.at, 0, 1), colour: stop.colour }))
    if (stops.length >= MIN_STOPS) return sortStops(stops)
  }
  return [
    { at: 0, colour: base },
    { at: 1, colour: readColour(config, 'to', SECOND_COLOUR) },
  ]
}

/** The colour a gradient shows at `t`, blending between the stops either side. */
export function stopColourAt(stops: readonly GradientStop[], t: number): string {
  const sorted = sortStops(stops)
  const first = sorted[0]
  if (!first) return '#000000'
  if (t <= first.at) return first.colour
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as GradientStop
    const b = sorted[i] as GradientStop
    if (t <= b.at) {
      return b.at === a.at ? b.colour : mixColours(a.colour, b.colour, (t - a.at) / (b.at - a.at))
    }
  }
  return (sorted[sorted.length - 1] as GradientStop).colour
}

function sameStops(a: readonly GradientStop[], b: readonly GradientStop[]): boolean {
  return a.length === b.length && a.every((stop, i) => stop.at === b[i]?.at && stop.colour === b[i]?.colour)
}

const solid = (colour: string): FillPaint => ({ kind: 'solid', colour })

const TAU = Math.PI * 2

/** The stops control the gradient editor draws, now that no effect declares one. */
export const STOPS_CONTROL: StopsControl = {
  kind: 'stops',
  key: 'stops',
  label: 'Stops',
  value: [
    { at: 0, colour: FIRST_COLOUR },
    { at: 1, colour: SECOND_COLOUR },
  ],
  min: MIN_STOPS,
  max: MAX_STOPS,
}

export const COLOUR_EFFECTS: readonly ColourEffectDef[] = [
  {
    id: 'none',
    label: 'None',
    hint: 'One flat colour.',
    controls: [],
    paint: (_config, _phase, base) => solid(base),
  },
  {
    id: 'cycle',
    label: 'Cycle',
    hint: 'Crosses to a second colour and back.',
    controls: [{ kind: 'colour', key: 'to', label: 'Shifts to', value: SECOND_COLOUR }],
    paint: (config, phase, base) =>
      // Starts ON the artwork's own colour, reaches the chosen one halfway, and
      // returns. A sine would start between the two, so merely choosing the
      // effect would change the resting artwork.
      solid(
        mixColours(base, readColour(config, 'to', SECOND_COLOUR), (1 - Math.cos(phase * TAU)) / 2),
      ),
  },
  {
    id: 'flicker',
    label: 'Flicker',
    hint: 'Blinks between two shades on a beat.',
    controls: [
      { kind: 'colour', key: 'to', label: 'Blinks to', value: SECOND_COLOUR },
      { kind: 'number', key: 'beats', label: 'Beats', min: 1, max: 8, step: 1, value: 3, format: whole },
    ],
    paint: (config, phase, base) => {
      // A WHOLE number of beats is what lands the loop back on the first shade.
      const beats = Math.max(1, Math.round(read(config, 'beats', 3)))
      const on = Math.floor(phase * beats * 2) % 2 === 1
      return solid(on ? readColour(config, 'to', SECOND_COLOUR) : base)
    },
  },
]

export function colourEffectById(id: ColourEffect): ColourEffectDef {
  return COLOUR_EFFECTS.find((effect) => effect.id === id) ?? (COLOUR_EFFECTS[0] as ColourEffectDef)
}

/**
 * The values an effect starts with, ready to store on an object.
 *
 * Given the part's own colour, a gradient's first stop is that colour, so
 * choosing the effect does not repaint the still artwork. The stop list is a
 * fresh copy per object — never the descriptor's own array.
 */
export function defaultColourConfig(id: ColourEffect, base?: string): Record<string, ColourConfigValue> {
  const out: Record<string, ColourConfigValue> = {}
  for (const control of colourEffectById(id).controls) {
    if (control.kind === 'stops') {
      out[control.key] = control.value.map((stop, i) => ({
        ...stop,
        colour: i === 0 && base ? base : stop.colour,
      }))
    } else {
      out[control.key] = control.value
    }
  }
  return out
}

/**
 * What to fill with at this moment.
 *
 * A colour effect acts on a SOLID base: cycle and flicker take one colour
 * somewhere and back. A gradient or a picture is a paint with its own idea
 * of the loop, so the effect stands aside and the paint answers for itself.
 */
export function paintAt(
  settings: ColourSettings | undefined,
  phase: number,
  base: Paint,
): FillPaint {
  if (typeof base !== 'string') return resolvePaint(base, phase) as FillPaint
  if (!settings) return solid(base)
  return colourEffectById(settings.effect).paint(settings.config ?? {}, phase, base)
}

/** Whether two resolved paints would draw the same, for skipping work. */
export function sameFillPaint(a: FillPaint, b: FillPaint): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'solid' && b.kind === 'solid') return a.colour === b.colour
  if (a.kind === 'image' && b.kind === 'image') {
    return (
      a.asset === b.asset &&
      a.crop.scale === b.crop.scale &&
      a.crop.x === b.crop.x &&
      a.crop.y === b.crop.y &&
      a.opacity === b.opacity
    )
  }
  if (a.kind === 'gradient' && b.kind === 'gradient') {
    if (a.shape !== b.shape || !sameStops(a.stops, b.stops)) return false
    if (a.shape === 'radial' && b.shape === 'radial') {
      return a.centre.x === b.centre.x && a.centre.y === b.centre.y && a.radius === b.radius
    }
    if (a.shape === 'linear' && b.shape === 'linear') {
      return a.angle === b.angle && a.offset === b.offset && a.spread === b.spread
    }
  }
  return false
}

/**
 * The two ends of a gradient across a box, as fractions of it.
 *
 * Shared by everything that draws so the preview and the export agree. The line
 * runs through the middle at the given angle and is stretched to cover the box's
 * corners, which is what stops a diagonal gradient running out of colour before
 * it reaches them.
 */
export function gradientEnds(
  angle: number,
  /** Slide along the axis, as a share of the box. Zero is centred. */
  offset = 0,
  /** How much of the box the blend spans. 1 is corner to corner. */
  spread = 1,
): { x1: number; y1: number; x2: number; y2: number } {
  const radians = (angle * Math.PI) / 180
  const dx = Math.cos(radians)
  const dy = Math.sin(radians)
  // Half the box's extent along the gradient's own direction.
  const reach = ((Math.abs(dx) + Math.abs(dy)) / 2) * spread
  return {
    x1: 0.5 + dx * (offset - reach),
    y1: 0.5 + dy * (offset - reach),
    x2: 0.5 + dx * (offset + reach),
    y2: 0.5 + dy * (offset + reach),
  }
}

/**
 * A radial gradient's circles, in the same fractions-of-the-box units.
 *
 * The radius is given against the box's HALF-DIAGONAL, so a value of 1 reaches
 * the corners of a square box and keeps meaning the same thing on a wide one.
 */
export function radialEnds(
  centre: { x: number; y: number },
  radius: number,
): { x1: number; y1: number; r1: number; x2: number; y2: number; r2: number } {
  const reach = Math.max(0.001, radius) * Math.SQRT1_2
  return { x1: centre.x, y1: centre.y, r1: 0, x2: centre.x, y2: centre.y, r2: reach }
}

/**
 * Blend two hex colours, transparency included.
 *
 * Works on greys, unlike the hue rotation this replaced: rotating a hue keeps
 * saturation, and the stock near-black text has almost none — a 150-degree turn
 * moved it four parts in 255, which is to say the effect appeared dead.
 *
 * Alpha is a channel like the others here, which is the whole of what makes the
 * colour effects work on a translucent fill. Parsing six digits only, this
 * returned the colour it started from for anything with transparency on it, so
 * choosing Cycle on a half-visible shape did nothing at all — a dead control
 * rather than a visible fault, which is the worse kind.
 */
export function mixColours(from: string, to: string, amount: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return from
  const t = clamp(amount, 0, 1)
  const channel = (i: number): number =>
    Math.round(clamp((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t, 0, 255))
  return formatHex(channel(0), channel(1), channel(2), channel(3))
}

/**
 * Two colours blended, where either may be NOTHING.
 *
 * The whole of the care here is in what null means. A fill nobody has added is
 * not a transparent black one: blend towards black and a fade picks up a dark
 * edge on its way out, which is visible, wrong, and very hard to name once you
 * are looking at it. So something appearing fades up from a transparent version
 * of the colour it is BECOMING, and something disappearing fades down through a
 * transparent version of the colour it WAS. Only the alpha ever moves.
 *
 * Both endpoints come back exactly as authored, null included, so a hold shows
 * what was chosen rather than a value that merely rounds to it.
 *
 * Lifted out of the mosaic's timeline, where it was written, because null means
 * the same thing to a frame's fills as it does to a tile's background — and two
 * copies of this rule would be two chances to get the dark edge back.
 */
export function blendColour(a: string | null, b: string | null, t: number): string | null {
  if (t <= 0) return a
  if (t >= 1) return b
  if (a === null && b === null) return null
  // Fading in from nothing, or out to nothing: the colour that DOES exist at
  // zero alpha, so the fade is of that colour and not through some other one.
  if (a === null) return mixColours(withAlpha(b as string, 0), b as string, t)
  if (b === null) return mixColours(a, withAlpha(a, 0), t)
  return mixColours(a, b, t)
}

/** `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, as four channels of 0..255. */
export function parseHex(hex: string): [number, number, number, number] | null {
  const text = hex.trim().replace(/^#/, '')
  const short = /^([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(text)
  if (short) {
    const pair = (c: string | undefined, fallback: number): number =>
      c === undefined ? fallback : Number.parseInt(c + c, 16)
    return [
      pair(short[1], 0),
      pair(short[2], 0),
      pair(short[3], 0),
      pair(short[4], 255),
    ]
  }
  const full = /^([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text)
  if (!full || !full[1]) return null
  const value = Number.parseInt(full[1], 16)
  const alpha = full[2] === undefined ? 255 : Number.parseInt(full[2], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha]
}

/**
 * Back to hex, dropping a fully opaque alpha.
 *
 * Six digits where six will do, so a colour that was never made transparent
 * comes back out of this exactly as it went in — which keeps documents, render
 * cache keys and the parity fixtures unchanged by the arrival of transparency.
 */
export function formatHex(r: number, g: number, b: number, a = 255): string {
  const pair = (v: number): string =>
    Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  const rgb = `#${pair(r)}${pair(g)}${pair(b)}`
  return a >= 255 ? rgb : `${rgb}${pair(a)}`
}

/** How opaque a colour is, 0 to 1. Anything unparseable reads as solid. */
export function alphaOf(hex: string): number {
  const parsed = parseHex(hex)
  return parsed ? (parsed[3] ?? 255) / 255 : 1
}

/** The same colour at a different opacity. */
export function withAlpha(hex: string, alpha: number): string {
  const parsed = parseHex(hex)
  if (!parsed) return hex
  return formatHex(parsed[0], parsed[1], parsed[2], Math.round(clamp(alpha, 0, 1) * 255))
}
