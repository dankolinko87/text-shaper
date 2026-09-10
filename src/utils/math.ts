export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

/**
 * Guard against the invalid geometry the spec calls out: NaN, Infinity, and
 * values so large they break downstream integer conversion in the clipper.
 */
export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value)
}

export function safeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** Round to a fixed number of decimals, avoiding `-0`. */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  const r = Math.round(value * f) / f
  return r === 0 ? 0 : r
}

export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}
