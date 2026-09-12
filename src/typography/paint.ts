import type { DocumentObject, GradientStop } from '../types/document'
import type {
  GradientMotion,
  GradientPaint,
  ImagePaint,
  Paint,
  PaintKind,
} from '../types/paint'
import { clamp } from '../utils/math'
import {
  blendColour,
  mixColours,
  sortStops,
  stopColourAt,
  withAlpha,
  MIN_STOPS,
  type FillPaint,
} from './colour'

/**
 * The paint model: one kind of value for every fill in the app.
 *
 * A paint is a hex string, a gradient, or a picture (`types/paint.ts`). This
 * is the one place that tells them apart, compares them, blends them between
 * states and resolves them for a moment of a loop — so a tile, a letter, a
 * shape and a background all behave alike, and nobody else writes `typeof`.
 */

export const isSolidPaint = (paint: Paint): paint is string => typeof paint === 'string'
export const isGradientPaint = (paint: Paint): paint is GradientPaint =>
  typeof paint === 'object' && paint.kind === 'gradient'
export const isImagePaint = (paint: Paint): paint is ImagePaint =>
  typeof paint === 'object' && paint.kind === 'image'

export const paintKindOf = (paint: Paint): PaintKind => (typeof paint === 'string' ? 'solid' : paint.kind)

/** Whether two paints are the same paint — the equality every state comparison uses. */
export function samePaint(a: Paint | null | undefined, b: Paint | null | undefined): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left === 'string' || typeof right === 'string') return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === 'gradient' && right.kind === 'gradient') {
    return (
      left.shape === right.shape &&
      left.angle === right.angle &&
      (left.motion ?? 'still') === (right.motion ?? 'still') &&
      (left.travel ?? 0.5) === (right.travel ?? 0.5) &&
      sameStops(left.stops, right.stops)
    )
  }
  if (left.kind === 'image' && right.kind === 'image') {
    return (
      left.asset === right.asset &&
      left.crop.scale === right.crop.scale &&
      left.crop.x === right.crop.x &&
      left.crop.y === right.crop.y &&
      (left.opacity ?? 1) === (right.opacity ?? 1)
    )
  }
  return false
}

function sameStops(a: readonly GradientStop[], b: readonly GradientStop[]): boolean {
  return a.length === b.length && a.every((stop, i) => stop.at === b[i]?.at && stop.colour === b[i]?.colour)
}

/** A paint's identity as one string, for content keys. */
export function paintKey(paint: Paint | null | undefined): string {
  if (paint === null || paint === undefined) return 'none'
  if (typeof paint === 'string') return paint
  if (paint.kind === 'gradient') {
    const stops = paint.stops.map((stop) => `${stop.at}:${stop.colour}`).join('>')
    return `gradient:${paint.shape}:${stops}@${paint.angle}/${paint.motion ?? 'still'}/${paint.travel ?? 0.5}`
  }
  return `image:${paint.asset}@${paint.crop.scale},${paint.crop.x},${paint.crop.y}/${paint.opacity ?? 1}`
}

/** Whether a paint changes over a shape's loop by itself: a gradient with a motion. */
export function paintMoves(paint: Paint | null | undefined): boolean {
  return Boolean(paint) && typeof paint === 'object' && paint!.kind === 'gradient' && (paint!.motion ?? 'still') !== 'still'
}

/** A paint as one colour, for a swatch or a guard: a gradient's first stop, a picture's grey. */
export function solidOf(paint: Paint | null | undefined): string {
  if (!paint) return '#101014'
  if (typeof paint === 'string') return paint
  if (paint.kind === 'gradient') return sortStops(paint.stops)[0]?.colour ?? '#101014'
  return '#888888'
}

/** The warm second colour a fresh gradient blends to. */
export const SECOND_COLOUR = '#e0552f'

/**
 * The paint of another kind that keeps as much of this one as it can: a
 * solid becomes a gradient from itself; a gradient becomes its first colour.
 * A picture needs an asset, which the caller supplies; without one there is
 * no picture to become.
 */
export function paintOfKind(kind: PaintKind, from: Paint | null, asset?: string): Paint | null {
  if (kind === 'solid') return from === null ? null : solidOf(from)
  if (kind === 'gradient') {
    if (from && typeof from === 'object' && from.kind === 'gradient') return from
    const base = solidOf(from)
    return {
      kind: 'gradient',
      shape: 'linear',
      stops: [
        { at: 0, colour: base },
        { at: 1, colour: SECOND_COLOUR },
      ],
      angle: 0,
    }
  }
  if (!asset) return from && typeof from === 'object' && from.kind === 'image' ? from : null
  if (from && typeof from === 'object' && from.kind === 'image') return { ...from, asset }
  return { kind: 'image', asset, crop: { scale: 1, x: 0, y: 0 } }
}

/** The same paint at zero alpha — what a fill fades from when it arrives, and to when it goes. */
export function fadedPaint(paint: Paint): Paint {
  if (typeof paint === 'string') return withAlpha(paint, 0)
  if (paint.kind === 'gradient') {
    return { ...paint, stops: paint.stops.map((stop) => ({ ...stop, colour: withAlpha(stop.colour, 0) })) }
  }
  return { ...paint, opacity: 0 }
}

/* ------------------------------------------------------------ blending */

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Angles blended the short way round, so 350° to 10° turns through 0°. */
function mixAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180
  return wrapDegrees(a + delta * t)
}

/**
 * Two stop lists that draw the same two pictures with the SAME positions, so
 * they can be blended stop by stop. Each side gains the other's positions,
 * coloured as it already was there — adding a stop on a blend changes no
 * picture, which is the rule the gradient editor's add button rests on.
 */
export function unifyStops(
  a: readonly GradientStop[],
  b: readonly GradientStop[],
): [GradientStop[], GradientStop[]] {
  const ats = [...new Set([...a, ...b].map((stop) => clamp(stop.at, 0, 1)))].sort((x, y) => x - y)
  const fill = (stops: readonly GradientStop[]): GradientStop[] =>
    ats.map((at) => ({ at, colour: stopColourAt(stops, at) }))
  return [fill(a), fill(b)]
}

/** A solid as a gradient of the other's shape, one colour throughout. */
function promote(colour: string, like: GradientPaint): GradientPaint {
  return {
    ...like,
    stops: like.stops.map((stop) => ({ at: stop.at, colour })),
  }
}

/**
 * A paint on the way to another.
 *
 * Tween what can be, cut what cannot, at the midpoint — the rule a border's
 * dash and a member's flip already follow. Endpoints are returned as they
 * are, so a hold shows exactly what was chosen. A fill that is nothing at one
 * end fades from, or to, itself at zero alpha, as `blendColour` does.
 */
export function blendPaint(a: Paint | null, b: Paint | null, t: number): Paint | null {
  if (t <= 0) return a
  if (t >= 1) return b
  if (a === null && b === null) return null
  if (a === null) return blendPaint(fadedPaint(b as Paint), b, t)
  if (b === null) return blendPaint(a, fadedPaint(a), t)

  if (typeof a === 'string' && typeof b === 'string') return blendColour(a, b, t)

  const left = typeof a === 'string' ? null : a
  const right = typeof b === 'string' ? null : b

  // A solid meets a gradient: the solid is a gradient of that colour.
  if (typeof a === 'string' && right?.kind === 'gradient') return blendPaint(promote(a, right), right, t)
  if (typeof b === 'string' && left?.kind === 'gradient') return blendPaint(left, promote(b, left), t)

  if (left?.kind === 'gradient' && right?.kind === 'gradient' && left.shape === right.shape) {
    const [from, to] = unifyStops(left.stops, right.stops)
    const stops = from.map((stop, i) => ({
      at: stop.at,
      colour: mixColours(stop.colour, to[i]!.colour, t),
    }))
    const motion: GradientMotion | undefined = t < 0.5 ? left.motion : right.motion
    const travel =
      left.travel === undefined && right.travel === undefined
        ? undefined
        : mix(left.travel ?? 0.5, right.travel ?? 0.5, t)
    const out: GradientPaint = {
      kind: 'gradient',
      shape: left.shape,
      stops,
      angle: mixAngle(left.angle, right.angle, t),
    }
    if (motion !== undefined) out.motion = motion
    if (travel !== undefined) out.travel = travel
    return out
  }

  if (left?.kind === 'image' && right?.kind === 'image' && left.asset === right.asset) {
    const out: ImagePaint = {
      kind: 'image',
      asset: left.asset,
      crop: {
        scale: mix(left.crop.scale, right.crop.scale, t),
        x: mix(left.crop.x, right.crop.x, t),
        y: mix(left.crop.y, right.crop.y, t),
      },
    }
    const opacity = mix(left.opacity ?? 1, right.opacity ?? 1, t)
    if (opacity !== 1) out.opacity = opacity
    return out
  }

  // Nothing between them: the nearer end.
  return t < 0.5 ? a : b
}

/* ------------------------------------------------------------ resolving */

/** How far a radial gradient reaches at rest, in half-diagonals. */
const RADIAL_REACH = 0.75

/*
 * How hard hover and pulse pull, at full travel.
 *
 * Sized so that all three motions move the picture by comparable amounts at the
 * same Travel setting, which they did not to begin with: measured as the average
 * shift in the blend across the box, side to side moved it 23% at half travel
 * while hover and pulse managed 6% — a quarter as much, weak enough to read as a
 * control that does nothing at all.
 */
const HOVER_LEAN = 45
const PULSE_DEPTH = 2

/**
 * Round off the last few bits, so the loop closes on the same NUMBERS.
 *
 * `Math.sin(2 * Math.PI)` is not zero, it is -2.4e-16, and a closing frame that
 * differs from the opening one by that much looks identical and compares as
 * different — which is enough to make everything downstream redraw a frame it
 * did not need to, and enough to fail the seam test that exists to catch real
 * drift. Far finer than anything that draws can resolve.
 */
function steady(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

const TAU = Math.PI * 2

/** Into 0..360, so a full turn reports the angle it started from. */
export function wrapDegrees(angle: number): number {
  return ((angle % 360) + 360) % 360
}

/**
 * A gradient at a moment of the loop.
 *
 * A gradient is an APPEARANCE that may also move. Pick the shape and the
 * angle for a still gradient; pick a motion on top if it should move. Every
 * motion is at rest at phase 0, so choosing one never changes the artwork you
 * already had — it only decides where it goes from there.
 */
export function gradientAt(paint: GradientPaint, phase: number): FillPaint {
  const stops = sortStops(paint.stops).map((stop) => ({ at: clamp(stop.at, 0, 1), colour: stop.colour }))
  const angle = paint.angle
  const motion = paint.motion ?? 'still'
  const travel = clamp(paint.travel ?? 0.5, 0, 1)

  /*
   * Both of these are ZERO at phase 0 and again at phase 1.
   *
   * That is the whole trick to a motion that can be switched on without
   * disturbing the artwork, and to a loop that closes without a seam: `away`
   * goes out and comes back, `swing` goes one way, back through the middle,
   * the other way, and home.
   */
  const swing = steady(Math.sin(phase * TAU))
  const away = steady((1 - Math.cos(phase * TAU)) / 2)
  // Pulse draws the blend in and lets it back out, for both shapes.
  const tighten = motion === 'pulse' ? 1 + travel * PULSE_DEPTH * away : 1

  if (paint.shape === 'radial') {
    // The angle points the way the middle travels, so the one control means
    // the same thing to both shapes.
    const radians = (angle * Math.PI) / 180
    const along = motion === 'sweep' ? travel * 0.35 * swing : 0
    // A circle for the drift, so it comes home rather than doubling back.
    const driftX = motion === 'hover' ? travel * 0.16 * (Math.cos(phase * TAU) - 1) : 0
    const driftY = motion === 'hover' ? travel * 0.16 * Math.sin(phase * TAU) : 0
    return {
      kind: 'gradient',
      shape: 'radial',
      stops,
      centre: {
        x: steady(0.5 + Math.cos(radians) * along + driftX),
        y: steady(0.5 + Math.sin(radians) * along + driftY),
      },
      radius: steady(RADIAL_REACH / tighten),
    }
  }

  return {
    kind: 'gradient',
    shape: 'linear',
    stops,
    // Hover leans the axis and drifts it at the same time, a quarter turn
    // apart, so the blend floats around rather than wiping across. A lean on
    // its own barely reads: a linear gradient looks much the same rotated a
    // few degrees, which is why this needed both.
    angle: steady(wrapDegrees(angle + (motion === 'hover' ? travel * HOVER_LEAN * swing : 0))),
    offset: steady(
      motion === 'sweep'
        ? travel * 0.6 * swing
        : motion === 'hover'
          ? travel * 0.3 * ((Math.cos(phase * TAU) - 1) / 2)
          : 0,
    ),
    // Pulse draws the blend in to a tight band and lets it back out.
    //
    // In rather than out, and DIVIDING rather than subtracting. Loosening a
    // linear blend past the box barely shows — it is already covering
    // everything, and stretching it only flattens the contrast — so a pulse
    // that breathed both ways spent half its loop doing nothing visible.
    // Dividing keeps a hard pull at full travel from ever reaching zero,
    // which subtracting would.
    spread: steady(1 / tighten),
  }
}

/** What a paint draws as, at a moment of the loop. */
export function resolvePaint(paint: Paint | null | undefined, phase: number): FillPaint | null {
  if (paint === null || paint === undefined) return null
  if (typeof paint === 'string') return { kind: 'solid', colour: paint }
  if (paint.kind === 'gradient') return gradientAt(paint, phase)
  return { kind: 'image', asset: paint.asset, crop: paint.crop, opacity: paint.opacity ?? 1 }
}

/* ------------------------------------------------------------- walking */

/** Every paint an object carries, member patches and states included. */
export function paintsOf(object: DocumentObject): Paint[] {
  const out: Paint[] = []
  const take = (paint: Paint | null | undefined): void => {
    if (paint !== null && paint !== undefined) out.push(paint)
  }
  if (object.kind === 'typography') {
    take(object.appearance.textFill)
    take(object.appearance.containerFill)
    take(object.appearance.lineFill)
    take(object.appearance.containerStroke?.colour)
    return out
  }
  if (object.kind === 'frame') {
    for (const member of object.members) out.push(...paintsOf(member.object))
    for (const state of object.states) {
      take(state.background)
      for (const patch of Object.values(state.values)) {
        take(patch.appearance?.textFill)
        take(patch.appearance?.containerFill)
        take(patch.appearance?.lineFill)
        take(patch.appearance?.containerStroke?.colour)
      }
    }
    return out
  }
  for (const state of object.states) {
    take(state.background)
    take(state.stroke?.colour)
    if ('lines' in state) take(state.lines?.colour)
    for (const paint of Object.values(state.glyphColour)) take(paint)
    for (const paint of Object.values(state.tileColour)) take(paint)
  }
  return out
}

/** The pictures these objects refer to. */
export function collectAssetIds(objects: readonly DocumentObject[]): Set<string> {
  const ids = new Set<string>()
  for (const object of objects) {
    for (const paint of paintsOf(object)) {
      if (typeof paint === 'object' && paint.kind === 'image') ids.add(paint.asset)
    }
  }
  return ids
}

/** Stops sorted and at least two of them, else null: what a gradient needs to draw. */
export function usableStops(stops: readonly GradientStop[]): GradientStop[] | null {
  const sorted = sortStops(stops)
  return sorted.length >= MIN_STOPS ? sorted : null
}
