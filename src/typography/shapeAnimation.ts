import { refreshPatch, type OutlinePatch, type PatchEdge } from '../geometry/patch'
import type { Vec2 } from '../types/document'
import { seededValue } from '../utils/rng'
import type { AnimationConfig, AnimationControl } from './animation'

/**
 * Animating the CONTAINER, and with it the type inside.
 *
 * These are not transforms applied to a picture. Each one bends the PLANE, and
 * that one bending is applied to two things: the container's outline, and the
 * patch the type is laid out through. Because the type is laid out through the
 * bent patch, it follows the new form by itself — squash the shape and the
 * letters squash; ripple its sides and the rows bow out to meet them.
 *
 * That is the point of doing it this way rather than by scaling a rendered
 * group: the shape drives the type, which is what the whole tool is about, and
 * it means these presets compose with whatever the type is doing on its own.
 *
 * The layout is still solved once and frozen — only the patch it is drawn
 * through changes — so no word ever moves to another row mid-loop.
 */

export type ShapePreset = 'none' | 'pulse' | 'jelly' | 'rock' | 'bulge' | 'wobble'

/** How a preset moves one point of the plane. */
export type PointMap = (point: Vec2) => Vec2

export interface ShapePresetDef {
  id: ShapePreset
  label: string
  hint: string
  controls: AnimationControl[]
  /**
   * How this preset is bending the plane at this moment, or null to leave
   * everything exactly as it is.
   *
   * A map of the PLANE rather than of the shape, because the same map has to be
   * applied to two things: the container outline, and the patch the type is laid
   * out through. Anything else would let the two drift apart, with the type
   * sliding around inside its own container.
   *
   * The patch is passed only as a frame of reference — where the middle is, and
   * how big the thing is — not as something to rebuild.
   */
  map(patch: OutlinePatch, config: AnimationConfig, phase: number, seed: number): PointMap | null
}

/** Half the diagonal: the distance deformations are measured against. */
function reachOf(patch: OutlinePatch): number {
  const { p00, p11 } = patch.corners
  return Math.max(1, Math.hypot(p11.x - p00.x, p11.y - p00.y) / 2)
}

const percent = (v: number): string => `${Math.round(v * 100)}%`

function read(config: AnimationConfig, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function swing(phase: number): number {
  return Math.sin(phase * Math.PI * 2)
}

/** The middle of the patch, which every deformation works about. */
function centreOf(patch: OutlinePatch): Vec2 {
  const { p00, p10, p01, p11 } = patch.corners
  return {
    x: (p00.x + p10.x + p01.x + p11.x) / 4,
    y: (p00.y + p10.y + p01.y + p11.y) / 4,
  }
}

/**
 * Rebuild a patch with every point moved by `move`.
 *
 * Edge control points live in each edge's OWN parameter space — (x, y) for the
 * top and bottom, (y, x) for the left and right — so they are turned back into
 * object coordinates, moved, and turned round again. Getting that swap wrong
 * would send the sides moving vertically and the top sideways.
 */
export function mapPatch(patch: OutlinePatch, move: PointMap): OutlinePatch {
  const mapEdge = (edge: PatchEdge): PatchEdge => ({
    ...edge,
    points: edge.points.map((point) => {
      const object = edge.axis === 'x' ? { x: point.x, y: point.y } : { x: point.y, y: point.x }
      const moved = move(object)
      return edge.axis === 'x' ? { x: moved.x, y: moved.y } : { x: moved.y, y: moved.x }
    }),
  })

  return refreshPatch({
    ...patch,
    top: mapEdge(patch.top),
    bottom: mapEdge(patch.bottom),
    left: mapEdge(patch.left),
    right: mapEdge(patch.right),
    corners: {
      p00: move(patch.corners.p00),
      p10: move(patch.corners.p10),
      p01: move(patch.corners.p01),
      p11: move(patch.corners.p11),
    },
  })
}

export const SHAPE_ANIMATIONS: readonly ShapePresetDef[] = [
  {
    id: 'none',
    label: 'None',
    hint: 'The shape holds still.',
    controls: [],
    map: () => null,
  },
  {
    id: 'pulse',
    label: 'Pulse',
    hint: 'The whole sticker breathes in and out.',
    controls: [
      { kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 0.4, step: 0.01, value: 0.08, format: percent },
    ],
    map: (patch, config, phase) => {
      const factor = 1 + read(config, 'amount', 0.08) * swing(phase)
      const centre = centreOf(patch)
      return (p) => ({
        x: centre.x + (p.x - centre.x) * factor,
        y: centre.y + (p.y - centre.y) * factor,
      })
    },
  },
  {
    id: 'jelly',
    label: 'Jelly',
    hint: 'Squashes wide, then tall. The type squashes with it.',
    controls: [
      { kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 0.4, step: 0.01, value: 0.12, format: percent },
    ],
    map: (patch, config, phase) => {
      // Widening and shortening by the same amount keeps the area roughly
      // constant, which is what makes it read as squash rather than as growth.
      const amount = read(config, 'amount', 0.12) * swing(phase)
      const centre = centreOf(patch)
      return (p) => ({
        x: centre.x + (p.x - centre.x) * (1 + amount),
        y: centre.y + (p.y - centre.y) * (1 - amount),
      })
    },
  },
  {
    id: 'rock',
    label: 'Rock',
    hint: 'Tips from side to side.',
    controls: [
      { kind: 'number', key: 'angle', label: 'Angle', min: 0, max: 20, step: 0.5, value: 6, format: (v) => `${v.toFixed(1)}°` },
    ],
    map: (patch, config, phase) => {
      const radians = ((read(config, 'angle', 6) * swing(phase)) * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const centre = centreOf(patch)
      return (p) => {
        const dx = p.x - centre.x
        const dy = p.y - centre.y
        return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos }
      }
    },
  },
  {
    id: 'bulge',
    label: 'Bulge',
    hint: 'The sides push outward, as if inflating.',
    controls: [
      { kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 0.5, step: 0.01, value: 0.15, format: percent },
    ],
    map: (patch, config, phase) => {
      const amount = read(config, 'amount', 0.15) * swing(phase)
      const centre = centreOf(patch)
      const reach = reachOf(patch)
      return (p) => {
        const dx = p.x - centre.x
        const dy = p.y - centre.y
        const distance = Math.hypot(dx, dy)
        if (distance < 1e-6) return p
        // Strongest around the middle of the shape's reach and easing off at the
        // far corners, so the sides bow out while the extremes stay put.
        const weight = Math.sin(Math.min(distance / reach, 1) * Math.PI)
        const push = 1 + amount * weight
        return { x: centre.x + dx * push, y: centre.y + dy * push }
      }
    },
  },
  {
    id: 'wobble',
    label: 'Wobble',
    hint: 'The outline ripples, like a blob that will not settle.',
    controls: [
      { kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 0.3, step: 0.01, value: 0.06, format: percent },
      { kind: 'number', key: 'lobes', label: 'Lobes', min: 1, max: 6, step: 1, value: 3, format: (v) => `${Math.round(v)}` },
    ],
    map: (patch, config, phase, seed) => {
      const amount = read(config, 'amount', 0.06)
      const lobes = Math.max(1, Math.round(read(config, 'lobes', 3)))
      const centre = centreOf(patch)
      const reach = reachOf(patch)
      const offset = seededValue(seed, 17) * Math.PI * 2
      return (p) => {
        const dx = p.x - centre.x
        const dy = p.y - centre.y
        const angle = Math.atan2(dy, dx)
        // A standing wave around the outline that travels with the phase. It
        // returns exactly after one turn, so the loop closes.
        const ripple = Math.sin(angle * lobes + phase * Math.PI * 2 + offset)
        const push = 1 + amount * ripple
        const distance = Math.hypot(dx, dy)
        if (distance < 1e-6) return p
        const scaled = Math.min(distance / reach, 1)
        return {
          x: centre.x + dx * (1 + (push - 1) * scaled),
          y: centre.y + dy * (1 + (push - 1) * scaled),
        }
      }
    },
  },
]

export function shapeAnimationById(id: ShapePreset): ShapePresetDef {
  return (
    SHAPE_ANIMATIONS.find((preset) => preset.id === id) ?? (SHAPE_ANIMATIONS[0] as ShapePresetDef)
  )
}

export function defaultShapeConfig(id: ShapePreset): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const control of shapeAnimationById(id).controls) out[control.key] = control.value
  return out
}
