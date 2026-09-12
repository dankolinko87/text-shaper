import { valuesFor } from '../frame/frame'
import { pathBounds } from '../geometry/path'
import { mosaicTiles } from '../mosaic/tiles'
import { meshTiles } from '../mesh/layout'
import { polygonBounds } from '../mesh/mesh'
import { isImagePaint } from '../typography/paint'
import type { DocumentObject, Rect, TextShaperDocument } from '../types/document'
import type { ImagePaint } from '../types/paint'

/**
 * Cropping a picture where it is painted.
 *
 * A picture fills a box — a shape's outline, a banner, a tile, a letter's
 * box, an object's background — and its crop says where it sits in that
 * box. The crop layer needs to know, for any fill the user asked to crop,
 * which box that is and which picture paint it holds; and the store needs
 * to know where a changed crop is written back. This is the one place that
 * answers both, so the layer and the store cannot disagree.
 */

export type CropSurface = 'text' | 'shape' | 'banner' | 'background' | 'tile' | 'glyph'

export interface CropTarget {
  objectId: string
  surface: CropSurface
  /**
   * Which state's fill: the object's own states, or, for a member of a frame,
   * the frame's state whose patch holds the member's fill.
   */
  stateIndex: number
  /** The tiles being cropped, for a tile or a letter fill. */
  leafIds?: string[]
  /** The frame the object is a member of, when it is one. */
  member?: { frameId: string; memberId: string }
}

/** The object a target names, on the artboard or inside a frame. */
export function cropObjectOf(doc: TextShaperDocument, target: CropTarget): DocumentObject | undefined {
  const top = doc.objects[target.objectId]
  if (top) return top
  for (const object of Object.values(doc.objects)) {
    if (object.kind !== 'frame') continue
    const member = object.members.find((each) => each.object.id === target.objectId)
    if (member) return member.object
  }
  return undefined
}

/** The picture paint the target holds now, or null when it holds something else. */
export function cropPaintFor(doc: TextShaperDocument, target: CropTarget): ImagePaint | null {
  const object = cropObjectOf(doc, target)
  if (!object) return null
  const paint = paintOf(doc, object, target)
  return paint && isImagePaint(paint) ? paint : null
}

function paintOf(doc: TextShaperDocument, object: DocumentObject, target: CropTarget) {
  if (object.kind === 'typography') {
    const appearance = memberAppearance(doc, target) ?? object.appearance
    if (target.surface === 'text') return appearance.textFill
    if (target.surface === 'shape') return appearance.containerFill
    if (target.surface === 'banner') return appearance.lineFill
    return null
  }
  if (target.surface === 'background') {
    const state = object.states[target.stateIndex] ?? object.states[0]
    return state?.background ?? null
  }
  if (object.kind === 'frame') return null
  const state = object.states[target.stateIndex] ?? object.states[0]
  const leaf = target.leafIds?.[0]
  if (!state || !leaf) return null
  if (target.surface === 'tile') return state.tileColour[leaf] ?? null
  if (target.surface === 'glyph') return state.glyphColour[leaf] ?? null
  return null
}

/** A member's appearance as its frame's state has it, when the target names a member. */
function memberAppearance(doc: TextShaperDocument, target: CropTarget) {
  if (!target.member) return undefined
  const frame = doc.objects[target.member.frameId]
  if (!frame || frame.kind !== 'frame') return undefined
  const member = frame.members.find((each) => each.id === target.member!.memberId)
  if (!member) return undefined
  const at = Math.min(target.stateIndex, frame.states.length - 1)
  return valuesFor(member, frame.states[at]).appearance
}

/**
 * The box the picture covers, in the object's own units: the outline of a
 * shape's fill, the banner's box, a tile's face or a letter's box, or the
 * whole object for a background. Null when the target no longer has one.
 */
export function cropBoxFor(
  doc: TextShaperDocument,
  target: CropTarget,
  paths: { textPath?: string; bandPath?: string },
): Rect | null {
  const object = cropObjectOf(doc, target)
  if (!object) return null
  if (object.kind === 'typography') {
    if (target.surface === 'text') return paths.textPath ? pathBounds(paths.textPath) : null
    if (target.surface === 'banner') return paths.bandPath ? pathBounds(paths.bandPath) : null
    if (target.surface === 'shape') return pathBounds(object.currentSourcePath)
    return null
  }
  if (target.surface === 'background') return object.localBounds
  if (object.kind === 'frame') return null
  const leaf = target.leafIds?.[0]
  if (!leaf) return null
  if (object.kind === 'mosaic') {
    const layout = mosaicTiles(object, target.stateIndex).get(leaf)
    if (!layout) return null
    return target.surface === 'tile' ? layout.visible : layout.glyph
  }
  const layout = meshTiles(object, target.stateIndex).get(leaf)
  if (!layout) return null
  return polygonBounds(target.surface === 'tile' ? layout.visible : layout.glyph)
}
