import type { Vec2 } from '../../src/types/document'

/** A hand-drawn-ish circle with mild jitter. */
export function circleStroke(
  cx = 300,
  cy = 300,
  r = 120,
  count = 180,
  jitter = 2.5,
): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    // Deterministic pseudo-jitter so tests are reproducible.
    const j = Math.sin(i * 12.9898) * jitter
    pts.push({ x: cx + (r + j) * Math.cos(a), y: cy + (r + j) * Math.sin(a) })
  }
  return pts
}

/** A concave blob. */
export function blobStroke(): Vec2[] {
  const pts: Vec2[] = []
  const count = 200
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    const r = 140 + 55 * Math.sin(a * 3)
    pts.push({ x: 400 + r * Math.cos(a), y: 400 + r * Math.sin(a) })
  }
  return pts
}

/** A self-intersecting figure eight. */
export function figureEightStroke(): Vec2[] {
  const pts: Vec2[] = []
  const count = 220
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2
    pts.push({ x: 300 + 130 * Math.sin(t), y: 300 + 110 * Math.sin(t) * Math.cos(t) })
  }
  return pts
}

/** Too few points to form a shape. */
export const dotStroke: Vec2[] = [
  { x: 100, y: 100 },
  { x: 101, y: 100 },
  { x: 101, y: 101 },
]

/** A closed square of the given side length — small enough to be rejected. */
export function tinySquareStroke(side = 3): Vec2[] {
  const pts: Vec2[] = []
  const perSide = 6
  const corners: Vec2[] = [
    { x: 10, y: 10 },
    { x: 10 + side, y: 10 },
    { x: 10 + side, y: 10 + side },
    { x: 10, y: 10 + side },
  ]
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c]
    const b = corners[(c + 1) % corners.length]
    if (!a || !b) continue
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return pts
}

/** Wildly uneven spacing, as produced by a fast flick. */
export function fastFlickStroke(): Vec2[] {
  const pts: Vec2[] = []
  const count = 60
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    // Bunch samples at the start, spread them at the end.
    const speed = 1 + 6 * (i / count)
    pts.push({ x: 300 + 120 * Math.cos(a * speed * 0.2), y: 300 + 120 * Math.sin(a * speed * 0.2) })
  }
  return pts
}

/**
 * An OPEN stroke, drawn by a hand rather than a plotter.
 *
 * Two kinds of error on top of the intended curve, because they behave
 * differently and only one of them is what people mean by tremor: fast jitter,
 * which any low-pass removes, and slow WOBBLE at a few dozen units of
 * wavelength, which survives a narrow window and is what puts an anchor every
 * time the hand drifts. `idealLine` returns the same curve with neither, so a
 * test can ask how close the fit landed to what was meant.
 */
export function drawnLineStroke(kind: 'wave' | 'arc', scale = 1, seed = 1): Vec2[] {
  let s = seed
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  return idealLine(kind, scale).map((p, i, all) => {
    const u = i / (all.length - 1)
    const drift = (a: number, b: number, c: number): number =>
      (Math.sin(u * 41 + a) * 3 + Math.sin(u * 23 + b) * 4 + Math.sin(u * 9 + c) * 5) * scale
    return {
      x: p.x + drift(0.7, 2.1, 1.3) + (rnd() - 0.5) * 2.5 * scale,
      y: p.y + drift(3.5, 1.9, 2.9) + (rnd() - 0.5) * 2.5 * scale,
    }
  })
}

/** The curve `drawnLineStroke` is a shaky record of. */
export function idealLine(kind: 'wave' | 'arc', scale = 1): Vec2[] {
  const pts: Vec2[] = []
  const count = 420
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1)
    if (kind === 'wave') {
      pts.push({ x: (60 + u * 620) * scale, y: (300 + Math.sin(u * Math.PI * 2.2) * 130) * scale })
    } else {
      const a = Math.PI * 1.15 * u + Math.PI * 0.4
      pts.push({
        x: (360 + Math.cos(a) * 280) * scale,
        y: (360 + Math.sin(a) * 240) * scale,
      })
    }
  }
  return pts
}
