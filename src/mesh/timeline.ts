import { ease } from '../anim/easing'
import {
  authoredDuration as totalDuration,
  authoredTimeFor as authoredTimeAt,
  momentAt,
  playbackDuration as watchedDuration,
  segmentsOf as segmentsOfStates,
} from '../anim/timeline'
import { blendStroke } from '../geometry/stroke'
import { blendColours, blendGlyphColours } from '../mosaic/timeline'
import { blendColour } from '../typography/colour'
import type {
  FontSettings,
  MeshBackdrop,
  MeshObject,
  PositionedStroke,
  Stroke,
  Vec2,
} from '../types/document'
import type { MeshCorners, MeshSpacing, MeshState, MeshTileLayout } from '../types/mesh'
import {
  MESH_DEFAULT_CORNERS,
  MESH_DEFAULT_SPACING,
  MESH_MIN_TRANSITION_MS,
} from '../types/mesh'
import { layoutMesh } from './layout'

/**
 * Where a mesh is at a given moment, worked out and never written down — the
 * mosaic's evaluator, with node positions where it has coordinates.
 *
 * One evaluator, shared by the live preview, the GIF and the tests. It takes
 * AUTHORED time, before playback speed, for the reason the mosaic's does.
 * Positions blend as plain points: a tile's polygon is linear in its nodes,
 * so a blend of two arrangements is the blend of their polygons. Letters and
 * font are cuts taken on arrival; colours, strokes, spacing and corners blend.
 */

const FALLBACK_FONT: FontSettings = { fontId: 'anton', weight: 400, italic: false }

export interface EvaluatedMeshFrame {
  stateIndex: number
  nextStateIndex: number | null
  segment: 'hold' | 'transition'
  localTime: number
  progress: number
  easedProgress: number
  nodes: Record<string, Vec2>
  spacing: MeshSpacing
  corners: MeshCorners
  font: FontSettings
  fontKey: string
  chars: Record<string, string>
  glyphKeys: Record<string, string>
  glyphColours: Record<string, string>
  tileColours: Record<string, string | null>
  background: string | null
  stroke: PositionedStroke | null
  lines: Stroke | null
  /** The object's, carried on the frame so the painter needs nothing else. */
  backdrop: MeshBackdrop
  tileLayouts: Map<string, MeshTileLayout>
}

export const meshSegmentsOf = (mesh: MeshObject) => segmentsOfStates(mesh.states, MESH_MIN_TRANSITION_MS)
export const meshAuthoredDuration = (mesh: MeshObject): number =>
  totalDuration(mesh.states, MESH_MIN_TRANSITION_MS)
export const meshPlaybackDuration = (mesh: MeshObject): number =>
  watchedDuration(mesh.states, mesh.speed, MESH_MIN_TRANSITION_MS)
export const meshAuthoredTimeFor = (mesh: MeshObject, elapsedWallMs: number): number =>
  authoredTimeAt(mesh.speed, elapsedWallMs)

/**
 * Every node named by either state, blended by one factor. A node missing
 * from one side holds still at the value the other gives it, rather than
 * sliding out of the origin — every state names every node, so this is a
 * guard rather than a path.
 */
function blendNodes(
  from: Record<string, Vec2>,
  to: Record<string, Vec2>,
  t: number,
): Record<string, Vec2> {
  const out: Record<string, Vec2> = {}
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = from[key] ?? to[key]
    const b = to[key] ?? from[key]
    if (!a || !b) continue
    out[key] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  return out
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const fontKeyOf = (font: FontSettings): string =>
  `${font.fontId}|${font.weight}|${font.italic ? 'i' : 'r'}`

interface FrameInput {
  stateIndex: number
  nextStateIndex: number | null
  segment: 'hold' | 'transition'
  localTime: number
  progress: number
  easedProgress: number
  nodes: Record<string, Vec2>
  spacing: MeshSpacing
  corners: MeshCorners
  chars: Record<string, string>
  font: FontSettings
  glyphColours: Record<string, string>
  tileColours: Record<string, string | null>
  background: string | null
  stroke: PositionedStroke | null
  lines: Stroke | null
}

function frameFor(mesh: MeshObject, input: FrameInput): EvaluatedMeshFrame {
  const fontKey = fontKeyOf(input.font)
  return {
    ...input,
    backdrop: mesh.backdrop,
    fontKey,
    glyphKeys: Object.fromEntries(
      Object.entries(input.chars).map(([tile, char]) => [tile, `${char}|${fontKey}`]),
    ),
    tileLayouts: layoutMesh(mesh.tiles, input.nodes, input.spacing),
  }
}

const spacingOf = (state: MeshState): MeshSpacing => ({
  gap: state.gap,
  glyphInset: state.glyphInset,
  outerPadding: state.outerPadding,
})
const cornersOf = (state: MeshState): MeshCorners => ({
  tileRadius: state.tileRadius,
  outerRadius: state.outerRadius,
})

/** One state, at rest — what the canvas shows when nothing plays. */
export function restingMeshFrame(mesh: MeshObject, at: number): EvaluatedMeshFrame {
  const index = Math.min(Math.max(0, Math.floor(at)), Math.max(0, mesh.states.length - 1))
  const state = mesh.states[index]
  if (!state) {
    return frameFor(mesh, {
      stateIndex: 0,
      nextStateIndex: null,
      segment: 'hold',
      localTime: 0,
      progress: 0,
      easedProgress: 0,
      nodes: {},
      spacing: { ...MESH_DEFAULT_SPACING },
      corners: { ...MESH_DEFAULT_CORNERS },
      chars: {},
      font: FALLBACK_FONT,
      glyphColours: {},
      tileColours: {},
      background: null,
      stroke: null,
      lines: null,
    })
  }
  return frameFor(mesh, {
    stateIndex: index,
    nextStateIndex: index + 1 < mesh.states.length ? index + 1 : null,
    segment: 'hold',
    localTime: 0,
    progress: 0,
    easedProgress: 0,
    nodes: state.nodes,
    spacing: spacingOf(state),
    corners: cornersOf(state),
    chars: state.chars,
    font: state.font,
    glyphColours: state.glyphColour,
    tileColours: state.tileColour,
    background: state.background ?? null,
    stroke: state.stroke ?? null,
    lines: state.lines ?? null,
  })
}

export function evaluateMeshAtTime(mesh: MeshObject, authoredTimeMs: number): EvaluatedMeshFrame {
  const states = mesh.states
  if (!states[0]) return restingMeshFrame(mesh, 0)
  const time = Number.isFinite(authoredTimeMs) ? authoredTimeMs : 0

  const moment = momentAt(states, time, MESH_MIN_TRANSITION_MS)
  if (!moment) return restingMeshFrame(mesh, 0)

  const from = states[moment.from] as MeshState
  if (moment.kind === 'hold') {
    return frameFor(mesh, {
      stateIndex: moment.from,
      nextStateIndex: moment.to,
      segment: 'hold',
      localTime: moment.localTime,
      progress: moment.progress,
      easedProgress: 0,
      nodes: from.nodes,
      spacing: spacingOf(from),
      corners: cornersOf(from),
      chars: from.chars,
      font: from.font,
      glyphColours: from.glyphColour,
      tileColours: from.tileColour,
      background: from.background ?? null,
      stroke: from.stroke ?? null,
      lines: from.lines ?? null,
    })
  }

  const to = states[moment.to] as MeshState
  // One curve for the whole transition, taken from the state being LEFT.
  const e = ease(from.easing, moment.progress)
  return frameFor(mesh, {
    stateIndex: moment.from,
    nextStateIndex: moment.to,
    segment: 'transition',
    localTime: moment.localTime,
    progress: moment.progress,
    easedProgress: e,
    nodes: blendNodes(from.nodes, to.nodes, e),
    spacing: {
      gap: mix(from.gap, to.gap, e),
      glyphInset: mix(from.glyphInset, to.glyphInset, e),
      outerPadding: mix(from.outerPadding, to.outerPadding, e),
    },
    corners: {
      tileRadius: mix(from.tileRadius, to.tileRadius, e),
      outerRadius: mix(from.outerRadius, to.outerRadius, e),
    },
    // The writing and the font of the state being LEFT: both cut on arrival.
    chars: from.chars,
    font: from.font,
    glyphColours: blendGlyphColours(from.glyphColour, to.glyphColour, e),
    tileColours: blendColours(from.tileColour, to.tileColour, e, null),
    background: blendColour(from.background ?? null, to.background ?? null, e),
    stroke: blendStroke(from.stroke ?? null, to.stroke ?? null, e),
    lines: blendStroke(from.lines ?? null, to.lines ?? null, e),
  })
}
