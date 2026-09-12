import { layoutMosaic } from '../mosaic/layout'
import { placeInk } from '../mosaic/glyphFit'
import type { EvaluatedMosaicFrame } from '../mosaic/timeline'
import { applyStroke, mosaicClip } from './strokePaint'
import { strokeBand } from '../geometry/stroke'
import type { LetterMosaicObject, Rect } from '../types/document'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'

/**
 * Painting a mosaic frame onto the group the static renderer already built.
 *
 * A frame is not a rebuild. The children are tagged with `role` and `leafId`, so
 * every tile and every glyph can be found and given new geometry in place —
 * sixty times a second, without serialising a single path.
 *
 * That last part is the whole reason this file exists, and it rests on one
 * observation. `glyphInRect` chooses its draw size FROM the rectangle it is
 * filling, so the residual scale is never above 1 and the serialiser's three
 * decimal places can only ever be shrunk, never magnified. A glyph built for one
 * rectangle and then stretched into a bigger one loses that guarantee.
 *
 * But a tile's width is `right − left`, which is LINEAR in the coordinates, and
 * every frame is a convex blend of two authored states. So no interpolated width
 * can exceed the larger of the two authored widths. Build each glyph at the
 * largest rectangle it reaches across every state and the residual scale stays
 * at or below 1 for every frame of the animation — exactly the guarantee the
 * static renderer has. Nothing is traded away, and there is no threshold to
 * cross, so nothing can pop part-way through a transition.
 */

/**
 * The biggest glyph rectangle each tile reaches, across every authored state.
 *
 * Per axis rather than per state: a tile can be at its widest in one state and
 * its tallest in another, and the outline has to be good for both.
 */
export function glyphReferenceRects(object: LetterMosaicObject): Map<string, Rect> {
  const widest = new Map<string, Rect>()
  for (const state of object.states) {
    /*
     * Each state's OWN spacing. Gap, padding and inset are per state now and
     * interpolate with everything else, so a tile's glyph rectangle depends on
     * which state is being measured — one spacing for all of them would size the
     * outlines for a composition that never appears.
     */
    const layout = layoutMosaic(object.tiles, state.x, state.y, object.localBounds, {
      gap: state.gap,
      outerPadding: state.outerPadding,
      glyphInset: state.glyphInset,
    })
    for (const [leafId, tile] of layout) {
      const seen = widest.get(leafId)
      widest.set(
        leafId,
        seen
          ? {
              x: Math.min(seen.x, tile.glyph.x),
              y: Math.min(seen.y, tile.glyph.y),
              width: Math.max(seen.width, tile.glyph.width),
              height: Math.max(seen.height, tile.glyph.height),
            }
          : { ...tile.glyph },
      )
    }
  }
  return widest
}

/** A fabric child, as much of one as this file needs to know about. */
interface Child {
  get(key: string): unknown
  set(key: string, value: unknown): void
  set(values: Record<string, unknown>): void
  setCoords?: () => void
}

interface Group {
  getObjects(): Child[]
  /**
   * The rounded outline, when there is one. Reused rather than rebuilt: it is a
   * plain rectangle whose radius is a NUMBER, so a frame only has to assign to
   * it — the same reason tiles and glyphs are moved rather than redrawn.
   */
  clipPath?: { set(values: Record<string, unknown>): void } | undefined
}

/**
 * A radius that fits the rectangle it is drawn on.
 *
 * Half the shorter side is a full pill; past that the corners would fold through
 * each other. Clamping here rather than in the control keeps the stored number
 * the one that was asked for, so a tile that grows later rounds as far as it was
 * always meant to.
 */
export function fittedRadius(radius: number, width: number, height: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return 0
  return Math.min(radius, Math.max(0, width) / 2, Math.max(0, height) / 2)
}

/**
 * Put one evaluated frame on screen.
 *
 * Tiles take their rectangle directly. Glyphs take a translation and a scale on
 * each axis, mapping the rectangle their outline was built for onto the one the
 * frame asks for — which is the same geometry as rebuilding them there, because
 * the deformation is a plain non-uniform stretch either way.
 */
export function paintMosaicFrame(
  group: Group,
  frame: EvaluatedMosaicFrame,
  references: ReadonlyMap<string, Rect>,
  /*
   * The composition's box, which the border and the clip are both measured
   * from. Passed rather than carried on the frame: it belongs to the OBJECT and
   * never changes between frames, and a frame describes what does.
   */
  bounds: Rect,
): void {
  /*
   * Which outline each tile will show, decided before anything is drawn.
   *
   * The frame's font, when this tile has one cut in it. When it has not — a font
   * that failed to load, or one named by a state whose outlines were never
   * built — the tile keeps whatever outline it does have rather than showing
   * nothing. A letter in the wrong typeface is a visible problem; a letter that
   * silently disappears looks like the mosaic is broken.
   */
  const chosen = new Map<string, string | null>()
  for (const child of group.getObjects()) {
    if (child.get('role') !== 'glyph') continue
    const leafId = child.get('leafId')
    const key = child.get('glyphKey')
    if (typeof leafId !== 'string' || typeof key !== 'string') continue

    /*
     * Nothing at all when this state writes nothing here.
     *
     * That is the whole of "delete a letter in one state": the tile keeps its
     * rectangle, its background and its place in the reading order, and simply
     * shows no outline. Recorded as an explicit null rather than left out, so
     * the pass below can tell "no letter wanted" from "not looked at yet".
     */
    const wanted = frame.glyphKeys[leafId]
    if (wanted === undefined) {
      chosen.set(leafId, null)
      continue
    }
    const already = chosen.get(leafId)
    if (already === wanted) continue
    if (already === undefined || already === null || key === wanted) chosen.set(leafId, key)
  }

  for (const child of group.getObjects()) {
    const role = child.get('role')

    /*
     * The backdrop, which is the mosaic's own box wearing a colour.
     *
     * A fill, not a rebuild — the child exists in every frame whether or not it
     * has a colour, so a backdrop can fade in and out without the group being
     * torn down mid-transition. Its geometry never moves: the box is the
     * mosaic's, and only the outer radius (a clip on the group) changes.
     */
    if (role === 'extent') {
      child.set({ fill: frame.background ?? (child.get('restFill') as string | undefined) ?? 'transparent' })
      continue
    }

    if (role !== 'tile' && role !== 'glyph') continue

    const leafId = child.get('leafId')
    if (typeof leafId !== 'string') continue
    const tile = frame.tileLayouts.get(leafId)
    if (!tile) continue

    if (role === 'tile') {
      const rect = tile.visible
      const colour = frame.tileColours[leafId] ?? null
      const radius = fittedRadius(frame.corners.tileRadius, rect.width, rect.height)
      child.set({
        left: rect.x + rect.width / 2,
        top: rect.y + rect.height / 2,
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        scaleX: 1,
        scaleY: 1,
        // Numbers, not a path: the corner rounds without anything being
        // serialised, which is what keeps a frame cheap.
        rx: radius,
        ry: radius,
        // A fill, not a rebuild. Every tile has an object whether or not it has
        // a colour, so a background can fade in without the group being torn
        // down mid-transition.
        fill: colour ?? 'transparent',
      })
      child.setCoords?.()
      continue
    }

    const reference = references.get(leafId)
    const rect = tile.glyph
    if (!reference || !(reference.width > 0) || !(reference.height > 0)) continue

    /*
     * Which outline this frame wants — which letter, in which typeface — chosen
     * rather than cut.
     *
     * The renderer built one for every pairing the mosaic uses, so a change of
     * either costs a boolean at frame time. A glyph with no key at all is from a
     * group built before this existed: shown, so it cannot vanish.
     */
    const key = child.get('glyphKey')
    const wanted = typeof key !== 'string' ? true : chosen.get(leafId) === key
    child.set({ visible: wanted })
    if (!wanted) continue

    /*
     * Placed by its INK box rather than by the tile's centre.
     *
     * A letter's ink fills its rectangle, so for almost everything these are the
     * same point — but a full stop occupies a small box down at the baseline,
     * and centring that on the tile would haul it into the middle and undo the
     * placement `inkBoxIn` gave it. A child with no box is from a group built
     * before this existed and keeps the old centring.
     */
    const box = child.get('inkBox') as Rect | undefined
    const at = box
      ? placeInk(box, reference, rect)
      : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }

    child.set({
      left: at.x,
      top: at.y,
      scaleX: Math.max(0, rect.width) / reference.width,
      scaleY: Math.max(0, rect.height) / reference.height,
      // The letter's colour is a fill too: no path is written again for it.
      fill: frame.glyphColours[leafId] ?? DEFAULT_GLYPH_COLOUR,
    })
    child.setCoords?.()
  }

  /*
   * The outline last, because it is about the whole composition rather than any
   * one child.
   *
   * The clip rectangle is built by the renderer and only ever adjusted here — a
   * radius of zero leaves it in place with square corners, which clips nothing
   * and costs one rectangle intersection. Cheaper than attaching and detaching a
   * clip path as a radius crosses zero mid-transition.
   */
  /*
   * Grown by the border's reach, exactly as the renderer builds it — a centred
   * or outside band needs room the silhouette would otherwise cut away, and
   * `mosaicClip` is the one place that sum lives.
   */
  const clip = mosaicClip(bounds, frame.corners.outerRadius, frame.stroke)
  group.clipPath?.set({
    width: clip.width,
    height: clip.height,
    rx: clip.radius,
    ry: clip.radius,
  })

  /*
   * And the border on that outline, which follows the same curve.
   *
   * The child is always present — the renderer attaches it whether or not there
   * is a border — so this only ever adjusts it. A child appearing partway
   * through a transition would tear the group's cache down at exactly the
   * moment a border was fading in.
   */
  const outline = group.getObjects().find((child) => child.get('role') === 'outline')
  if (outline) {
    // The band's own rectangle, which is where the position lives: inflate the
    // silhouette by half the width and the radius with it, and a plain centred
    // stroke lands exactly where it was asked to.
    const band = frame.stroke
      ? strokeBand(bounds, frame.corners.outerRadius, frame.stroke)
      : { box: bounds, radius: frame.corners.outerRadius }
    outline.set({
      width: Math.max(0, band.box.width),
      height: Math.max(0, band.box.height),
      rx: Math.max(0, band.radius),
      ry: Math.max(0, band.radius),
    })
    applyStroke(outline, frame.stroke)
  }
}
