import {
  evaluatePatch,
  rowArcTable,

  type OutlinePatch,
} from '../geometry/patch'
import { evaluateDivider } from '../geometry/grid'
import type { DistortionSettings, GridDivider, Vec2 } from '../types/document'
import { clamp, lerp } from '../utils/math'
import { seededValue } from '../utils/rng'

/**
 * The deformation field: a pure function from a point to a displaced point.
 *
 * This is what turns text set INSIDE a shape into text that BECOMES the shape.
 *
 * The field is a change of coordinates. A line of type is laid out flat, in a
 * plain rectangle; this maps that rectangle onto the row's slice of the
 * container. Because the container is a parametric patch, the map is the same in
 * both directions and has no preferred axis — which is what removed the whole
 * family of defects the previous version had wherever the outline turned
 * vertical.
 *
 * Everything is deterministic: expressive terms draw from a seeded generator
 * rather than `Math.random`, so a document renders identically on every load and
 * every exported frame, and animation can be evaluated at any time value.
 */

export type WarpFn = (x: number, y: number) => Vec2

export interface WarpContext {
  /** The container, as a map from the unit square. */
  patch: OutlinePatch
  /** The line's flat band, before warping. */
  bandTop: number
  bandBottom: number
  /** Where the line's flat band starts and ends horizontally. */
  bandLeft: number
  bandRight: number
  /**
   * The row's slice of the container, 0 at the top edge and 1 at the bottom.
   *
   * Defaults to the whole square, so a single row of type fills the shape.
   */
  rowTop?: number
  rowBottom?: number
  /**
   * Vertical deformers, as curves `u = g(v)` in patch space.
   *
   * These do NOT decide which words go where — that is what rows are for. Each
   * one grips the type at its resting position and drags it sideways, squeezing
   * whatever is on one side and stretching what is on the other. Dragging a
   * deformer is a change of proportion, not of content: the same words stay in
   * the same order in the same rows, and only their widths change.
   *
   * Because each is a curve rather than a straight line, the squeeze varies down
   * the shape: a deformer bowed to the left pinches the middle of a row while
   * leaving its ends alone.
   */
  columnDeformers?: readonly GridDivider[]
  /**
   * Horizontal deformers: they change how TALL the type is down the shape.
   *
   * The other axis of the same idea, and deliberately the same idea. A row
   * divider used to decide how many lines there were and which words went on
   * them, as well as bending the band it bounded — so drawing one repaginated
   * the text, and shortening the text repaginated it again. It is a deformer,
   * like its vertical counterpart: it changes proportion, never content.
   */
  rowDeformers?: readonly GridDivider[]
    /**
   * Where we are in an animation loop, 0 to 1. Still artwork leaves it at 0.
   *
   * The wave advances by exactly one cycle over the loop and the noise is
   * sampled once around a circle, so both return to their starting state at
   * phase 1 — which is what makes every preset seamless without any authoring.
   */
  phase?: number
  distortion: DistortionSettings
  seed: number
}

/** Safe bounds for every control, so no setting can invert or explode geometry. */
export const DISTORTION_LIMITS = {
  boundaryInfluence: { min: 0, max: 1 },
  horizontal: { min: -1, max: 1 },
  vertical: { min: -1, max: 1 },
  waveAmount: { min: 0, max: 1 },
  waveFrequency: { min: 0.1, max: 8 },
  shear: { min: -1, max: 1 },
  noiseAmount: { min: 0, max: 1 },
  noiseScale: { min: 0.2, max: 8 },
  glyphScaleVariation: { min: 0, max: 1 },
  glyphRotation: { min: 0, max: 1 },
} as const

/**
 * Hairline floor on a row's slice of the square.
 *
 * An anti-inversion guard, not a legibility one. Characters near a tapering end
 * are SUPPOSED to be squeezed to a wedge — that is what makes the type meet the
 * outline exactly — so the floor only has to stop the slice reaching zero, where
 * the map would stop being invertible and contours could fold through
 * themselves.
 */
const MIN_SLICE = 0.002
/** Smallest gap between two deformers, so the remap stays increasing. */
const MIN_DEFORM_GAP = 0.01
/** How far around the noise lattice one loop travels. */
export const NOISE_LOOP_RADIUS = 1.5

/**
 * True when curves must be subdivided before the field is applied.
 *
 * Warping a Bézier's control points approximates the image of the curve, and the
 * error grows with how fast the field varies across the curve's own width. The
 * patch map varies most steeply near the corners, and there the approximation
 * visibly tore glyphs apart — so any active field subdivides, not just the
 * high-frequency wave and noise terms.
 */
export function needsSubdivision(distortion: DistortionSettings): boolean {
  return (
    distortion.boundaryInfluence > 0.001 ||
    distortion.waveAmount > 0.001 ||
    distortion.noiseAmount > 0.001
  )
}

/** True when the field is the identity and can be skipped entirely. */
export function isIdentityWarp(distortion: DistortionSettings): boolean {
  return (
    distortion.boundaryInfluence <= 0 &&
    distortion.waveAmount <= 0 &&
    distortion.noiseAmount <= 0 &&
    distortion.shear === 0
  )
}

export function createWarpField(context: WarpContext): WarpFn {
  const {
    patch,
    bandTop,
    bandBottom,
    bandLeft,
    bandRight,
    distortion,
    seed,
  } = context

  const bandHeight = bandBottom - bandTop
  const bandWidth = bandRight - bandLeft
  const bandCentre = (bandTop + bandBottom) / 2

  const rowTop = clamp(context.rowTop ?? 0, 0, 1)
  const rowBottom = clamp(context.rowBottom ?? 1, rowTop, 1)

  const influence = clamp(distortion.boundaryInfluence, 0, 1)
  const waveAmount = clamp(distortion.waveAmount, 0, 1)
  const waveFrequency = clamp(distortion.waveFrequency, 0.1, 8)
  const shear = clamp(distortion.shear, -1, 1)
  const noiseAmount = clamp(distortion.noiseAmount, 0, 1)
  const noiseScale = clamp(distortion.noiseScale, 0.2, 8)

  // Expressive amplitudes are expressed as fractions of the band, so a setting
  // means the same thing whether the type is 12px or 400px.
  const wavePixels = waveAmount * bandHeight * 0.5
  const noisePixels = noiseAmount * bandHeight * 0.35
  const phase = context.phase ?? 0
  const wavePhase = seededValue(seed, 1) * Math.PI * 2 + phase * Math.PI * 2
  // The noise lattice is walked around a CIRCLE rather than along a line: a
  // straight drift would never come back, and the loop has to close exactly.
  const noiseDriftX = Math.cos(phase * Math.PI * 2) * NOISE_LOOP_RADIUS
  const noiseDriftY = Math.sin(phase * Math.PI * 2) * NOISE_LOOP_RADIUS

  const deformers = context.columnDeformers ?? []

  // Distance along the row is not proportional to `u`: the patch compresses
  // wherever the shape narrows. Stepping `u` evenly would bunch the letters
  // there, so the layout's own x is converted through the row's arc length.
  const midRow = (rowTop + rowBottom) / 2
  const arc = influence > 0 ? rowArcTable(patch, midRow) : null
  const arcLength = arc ? arc.total : 0

  const rows = context.rowDeformers ?? []

  /*
   * How far the type is dragged, on whichever axis is asked.
   *
   * One function for both, because they ARE both: a column deformer changes
   * where things sit across the shape and a row deformer changes where they sit
   * down it, and neither changes what they are. Written twice they drifted —
   * only one of them was a deformer at all, and the other quietly repaginated
   * the text.
   */
  const deform = (deformers: readonly GridDivider[], along: number, at: number): number => {
    const count = deformers.length
    if (count === 0) return along

    const rest: number[] = [0]
    const actual: number[] = [0]
    let previous = 0
    let previousRest = 0
    for (let i = 0; i < count; i++) {
      const deformer = deformers[i]
      if (!deformer) continue
      // Where it rests. Evenly spaced only when the deformer does not say — an
      // even resting place is an assumption about where it was put down, and it
      // was wrong for every one dropped anywhere but the middle.
      //
      // Both rows are kept strictly increasing, so the remap cannot fold the
      // type back on itself however the deformers have been dragged past one
      // another, or however their resting places happen to be ordered against
      // their current ones.
      const wanted = deformer.rest ?? (i + 1) / (count + 1)
      const restAt = clamp(wanted, previousRest + MIN_DEFORM_GAP, 1 - MIN_DEFORM_GAP)
      rest.push(restAt)
      previousRest = restAt
      const to = clamp(evaluateDivider(deformer, at), previous + MIN_DEFORM_GAP, 1 - MIN_DEFORM_GAP)
      actual.push(to)
      previous = to
    }
    rest.push(1)
    actual.push(1)

    for (let i = 1; i < rest.length; i++) {
      const restEnd = rest[i] ?? 1
      if (along <= restEnd || i === rest.length - 1) {
        const restStart = rest[i - 1] ?? 0
        const from = actual[i - 1] ?? 0
        const upto = actual[i] ?? 1
        const span = restEnd - restStart
        const t = span > 0 ? (along - restStart) / span : 0
        return from + (upto - from) * t
      }
    }
    return along
  }

  return (x: number, y: number): Vec2 => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }

    let outX = x
    let outY = y

    // --- boundary warp: lay the flat line onto the row's slice of the shape ---
    //
    // The layout rectangle's own coordinates become patch coordinates: `u` from
    // how far along the line the point is, `v` from how far down its band. The
    // patch does the rest, and because it is a genuine two-dimensional map the
    // type follows the outline in both directions at once rather than being
    // pushed up and down inside a column.
    if (influence > 0 && bandHeight > 0 && bandWidth > 0 && arc) {
      const along = ((x - bandLeft) / bandWidth) * arcLength
      const u = clamp(arc.uAt(along), 0, 1)

      const top = rowTop
      let bottom = rowBottom
      // Keep a hairline rather than inverting: `bottom > top` is what guarantees
      // the map stays a homeomorphism, so contours keep their winding and
      // counters stay open.
      if (bottom - top < MIN_SLICE) bottom = top + MIN_SLICE

      const t = (y - bandTop) / bandHeight
      const v = clamp(top + t * (bottom - top), 0, 1)

      /*
       * The deformers act LAST, on the finished position: they change how wide
       * and how tall things are, not what goes where.
       *
       * Both read from the RESTING pair rather than from each other's answer, so
       * neither chases the other and the map stays the same however they are
       * ordered.
       */
      const mapped = evaluatePatch(
        patch,
        clamp(deform(deformers, u, v), 0, 1),
        clamp(deform(rows, v, u), 0, 1),
      )
      if (Number.isFinite(mapped.x) && Number.isFinite(mapped.y)) {
        outX = lerp(x, mapped.x, influence)
        outY = lerp(y, mapped.y, influence)
      }
    }

    // --- shear: horizontal offset proportional to height within the band ---
    if (shear !== 0 && bandHeight > 0) {
      outX += shear * (y - bandCentre)
    }

    // --- wave: a travelling deformation along the line ---
    if (waveAmount > 0 && bandHeight > 0) {
      outY += Math.sin((x / Math.max(1, bandHeight)) * waveFrequency + wavePhase) * wavePixels
    }

    // --- noise: smooth seeded displacement on both axes ---
    if (noiseAmount > 0 && bandHeight > 0) {
      const cell = Math.max(1, bandHeight / noiseScale)
      const nx = x / cell + noiseDriftX
      const ny = y / cell + noiseDriftY
      outX += smoothNoise(seed, nx, ny, 0) * noisePixels
      outY += smoothNoise(seed, nx, ny, 17) * noisePixels
    }

    if (!Number.isFinite(outX) || !Number.isFinite(outY)) return { x, y }
    return { x: outX, y: outY }
  }
}

/**
 * Value noise in [-1, 1], bilinearly interpolated between seeded lattice points.
 *
 * Smooth rather than per-sample random: independent randomness at every point
 * would shred the outlines instead of displacing them, and would also break the
 * requirement that neighbouring points on a curve stay neighbours.
 */
export function smoothNoise(seed: number, x: number, y: number, channel: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0

  // Smoothstep, so the field has no visible lattice creases.
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)

  const corner = (ix: number, iy: number): number => {
    // Hash the lattice coordinate into the seeded sequence.
    const index = (ix * 73856093) ^ (iy * 19349663) ^ (channel * 83492791)
    return seededValue(seed, index >>> 0) * 2 - 1
  }

  const top = lerp(corner(x0, y0), corner(x0 + 1, y0), sx)
  const bottom = lerp(corner(x0, y0 + 1), corner(x0 + 1, y0 + 1), sx)
  return lerp(top, bottom, sy)
}
