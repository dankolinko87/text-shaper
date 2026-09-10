import type { DocumentObject, Transform2D } from '../types/document'
import { readTransformFromGroup, type RenderedObject } from './renderer'
import { splitTransform, type BakedScale } from './transformIntent'

/**
 * Canvas -> document: what a finished gesture did to the objects.
 *
 * The direction that had to be pulled out of the canvas component, because the
 * bug it kept producing was in the ORDER of what it did rather than in any one
 * step. It used to read one object and write it, then read the next and write
 * that — and a write goes through the store, whose subscriber re-renders the
 * canvas, which takes the objects out of Fabric's selection and puts them back
 * where the document says they are. So the second object of a moved pair was
 * read AFTER the first object's write had already moved it, in a coordinate
 * space that no longer matched the one it was measured in, and it jumped by the
 * distance between the two — backwards, since that distance is the offset from
 * the selection's centre.
 *
 * Reading every object before writing any of them is what removes that, and it
 * is not a guard around the symptom: interleaving reads of a live canvas with
 * writes that redraw it has no correct ordering, so the two passes have to be
 * separate. It also makes the operation IDEMPOTENT — running it again on a
 * canvas that has already been reconciled finds no differences and writes
 * nothing — which matters because Fabric fires `object:modified` once per
 * member of a selection, so it always runs more than once per gesture.
 */

/** Below this, a difference is Fabric's float jitter rather than a gesture. */
const MOVED = 1e-4
/** Degrees. Rotation is jittered a little harder than position. */
const TURNED = 1e-3

export interface TransformUpdate {
  id: string
  /** What to store on the object. */
  transform: Transform2D
  /** Folded into the outline, or null when the gesture only moved or turned it. */
  bake: BakedScale | null
}

/**
 * Every object whose placement on the canvas no longer matches the document.
 *
 * Pure, and pure on purpose: it touches neither the store nor the canvas, so
 * the whole read pass can be taken in one go and the result applied afterwards.
 */
export function collectTransforms(
  rendered: ReadonlyMap<string, RenderedObject>,
  objects: Readonly<Record<string, DocumentObject>>,
): TransformUpdate[] {
  const updates: TransformUpdate[] = []

  for (const [id, entry] of rendered) {
    const object = objects[id]
    if (!object) continue

    const next = readTransformFromGroup(entry.group)
    if (unchanged(next, object.transform)) continue

    /*
     * A resize changes what a SHAPE is, so it is folded into the outline and the
     * text is fitted again; a move or a rotation only places it. See
     * `splitTransform` for why rotation is treated differently.
     *
     * A mosaic is the exception, and deliberately: its scale stays on the
     * transform so the whole composition — tiles, gaps, glyph insets — grows
     * together. Baking would leave the partition the size it was and only the
     * spacing would fail to follow, which is the one thing a mosaic must not do.
     */
    /*
     * A FRAME keeps its scale for the same reason, and had been losing it.
     *
     * Baking folds a resize into an outline, and only typography has one — so a
     * frame's scale was split off into a bake that `bakeTransform` then dropped
     * on the floor, and dragging a frame's corner moved it without ever
     * resizing it. Its scale belongs on the transform in any case: the group is
     * built from it and every member is drawn inside that, so scaling the frame
     * scales its whole arrangement together, which is what resizing one means.
     */
    if (object.kind === 'mosaic' || object.kind === 'frame') {
      updates.push({ id, transform: next, bake: null })
      continue
    }

    const split = splitTransform(next)
    updates.push({ id, transform: split.transform, bake: split.bake })
  }

  return updates
}

function unchanged(next: Transform2D, current: Transform2D): boolean {
  return (
    Math.abs(next.x - current.x) < MOVED &&
    Math.abs(next.y - current.y) < MOVED &&
    Math.abs(next.scaleX - current.scaleX) < MOVED &&
    Math.abs(next.scaleY - current.scaleY) < MOVED &&
    Math.abs(next.rotation - current.rotation) < TURNED &&
    next.flipX === current.flipX &&
    next.flipY === current.flipY
  )
}
