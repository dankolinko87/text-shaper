import { gradientStops, type FillPaint } from '../../src/typography/colour'
import type { ColourConfigValue } from '../../src/types/document'

/**
 * The gradient colour EFFECT as it was before v32, kept word for word.
 *
 * The effect became a paint, and the migration promises the picture is the
 * same at rest and in motion. That promise can only be checked against what
 * the effect actually drew — and the production copy is gone, which is the
 * point. So the old resolver lives here, for the tests and nothing else.
 */

type ColourConfig = Readonly<Record<string, ColourConfigValue>>

const RADIAL_REACH = 0.75
const HOVER_LEAN = 45
const PULSE_DEPTH = 2
const TAU = Math.PI * 2

const clamp = (v: number, low: number, high: number): number => Math.min(high, Math.max(low, v))
const steady = (value: number): number => Math.round(value * 1e6) / 1e6
const wrapDegrees = (angle: number): number => ((angle % 360) + 360) % 360

function read(config: ColourConfig, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readChoice(config: ColourConfig, key: string, fallback: string): string {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function legacyGradientPaint(config: ColourConfig, phase: number, base: string): FillPaint {
  const stops = gradientStops(config, base)
  const angle = read(config, 'angle', 0)
  const motion = readChoice(config, 'motion', 'still')
  const travel = clamp(read(config, 'travel', 0.5), 0, 1)

  const swing = steady(Math.sin(phase * TAU))
  const away = steady((1 - Math.cos(phase * TAU)) / 2)
  const tighten = motion === 'pulse' ? 1 + travel * PULSE_DEPTH * away : 1

  if (readChoice(config, 'shape', 'linear') === 'radial') {
    const radians = (angle * Math.PI) / 180
    const along = motion === 'sweep' ? travel * 0.35 * swing : 0
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
    angle: steady(wrapDegrees(angle + (motion === 'hover' ? travel * HOVER_LEAN * swing : 0))),
    offset: steady(
      motion === 'sweep'
        ? travel * 0.6 * swing
        : motion === 'hover'
          ? travel * 0.3 * ((Math.cos(phase * TAU) - 1) / 2)
          : 0,
    ),
    spread: steady(1 / tighten),
  }
}
