import { layoutMosaic } from './layout'
import { readingOrder } from './order'
import type { FontSettings, LetterMosaicObject, Vec2 } from '../types/document'
import type { MosaicCorners, MosaicSpacing, MosaicTileLayout } from '../types/mosaic'
import { MOSAIC_DEFAULT_CORNERS, MOSAIC_DEFAULT_SPACING } from '../types/mosaic'

/**
 * A mosaic object's tiles, and the questions asked of them by hand.
 *
 * Separate from `layout.ts`, which knows about coordinates and rectangles and
 * nothing about objects. These take a whole `LetterMosaicObject` — they are what
 * the canvas asks when a pointer lands somewhere, and what the tool asks when a
 * new mosaic needs its caret put in.
 */

/**
 * The state being looked at, or the first if the index has gone stale.
 *
 * The index is passed in rather than read off the object: which state is on
 * screen is where the cursor is standing, not part of the artwork, so it lives
 * in `uiStore`. Everything here stays a pure function of what it is handed.
 */
export function activeState(object: LetterMosaicObject, at = 0) {
  /*
   * An index past the end means the LAST state, not the first.
   *
   * It happens whenever states are removed while one of the later ones is on
   * show, and every panel that displays the number already clamps it that way.
   * Falling back to the first here made the canvas draw one composition while
   * the picker named another — and any press was then measured against
   * rectangles nobody could see.
   */
  if (object.states.length === 0) return undefined
  const index = Math.min(Math.max(0, Math.floor(at)), object.states.length - 1)
  return object.states[index]
}

/**
 * The spacing of the state being looked at, as the layout wants it.
 *
 * Per state now, along with the font: the three of them are as much a part of a
 * composition as where its lines sit, and they animate with it. Taken from the
 * state rather than the object, with the first state answering for a stale index.
 */
export function mosaicSpacing(object: LetterMosaicObject, at = 0): MosaicSpacing {
  const state = activeState(object, at)
  return {
    gap: state?.gap ?? MOSAIC_DEFAULT_SPACING.gap,
    outerPadding: state?.outerPadding ?? MOSAIC_DEFAULT_SPACING.outerPadding,
    glyphInset: state?.glyphInset ?? MOSAIC_DEFAULT_SPACING.glyphInset,
  }
}

/**
 * The corner radii of the state being looked at.
 *
 * Separate from `mosaicSpacing` because they are a different kind of number:
 * spacing decides where things are and has to be clamped against the layout,
 * while these only decide how what is already there is painted.
 */
export function mosaicCorners(object: LetterMosaicObject, at = 0): MosaicCorners {
  const state = activeState(object, at)
  return {
    tileRadius: state?.tileRadius ?? MOSAIC_DEFAULT_CORNERS.tileRadius,
    outerRadius: state?.outerRadius ?? MOSAIC_DEFAULT_CORNERS.outerRadius,
  }
}

/**
 * What is written in each tile, in the state being looked at.
 *
 * Empty when the index has gone stale, rather than the first state's letters:
 * `activeState` clamps, so this only returns nothing for a mosaic with no states
 * at all.
 */
export function mosaicChars(object: LetterMosaicObject, at = 0): Record<string, string> {
  return activeState(object, at)?.chars ?? {}
}

/** The font of the state being looked at. */
export function mosaicFont(object: LetterMosaicObject, at = 0): FontSettings | undefined {
  return activeState(object, at)?.font
}

/** This mosaic's tiles, in its own local space, for the state being looked at. */
export function mosaicTiles(
  object: LetterMosaicObject,
  at = 0,
): Map<string, MosaicTileLayout> {
  const state = activeState(object, at)
  return layoutMosaic(
    object.tiles,
    state?.x ?? {},
    state?.y ?? {},
    object.localBounds,
    mosaicSpacing(object, at),
  )
}

/**
 * The tile under a point, in the mosaic's own space.
 *
 * Measured against the STRUCTURAL rectangles, which cover the mosaic exactly — so
 * a press anywhere inside lands on something. Using the visible ones would leave
 * the gaps as dead ground, and a click that does nothing because it fell between
 * two tiles reads as broken rather than as precise.
 *
 * In the state given, which the caller must pass as the one on screen. Every
 * state puts the same lines in its own places, so where a tile IS is a question
 * about a state and not about the mosaic. Answered from state 0 while the canvas
 * drew another, presses landed on whichever tile held that spot in the first
 * composition — and a tile squeezed thin in the state on show could not be
 * clicked at all, because every point that looked like it was inside belonged to
 * a neighbour back in state 0.
 */
export function tileAt(object: LetterMosaicObject, point: Vec2, at = 0): string | null {
  for (const [id, tile] of mosaicTiles(object, at)) {
    const r = tile.structural
    if (point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height) {
      return id
    }
  }
  return null
}

/**
 * The first tile in reading order — where a new mosaic's caret goes.
 *
 * Reading order is derived from the rectangles, so it too belongs to a state:
 * lines dragged far enough can change which tile comes first.
 */
export function firstTile(object: LetterMosaicObject, at = 0): string | null {
  return allTiles(object, at)[0] ?? null
}

/**
 * Every tile, in reading order — what "the whole mosaic" means.
 *
 * Reading order rather than the layout map's own order so that "all of them" is
 * the same sequence the caret walks, and a write across the lot lands in an
 * order that does not depend on how the dissection tree happened to be built.
 *
 * Belongs to a state like every other question about rectangles: lines dragged
 * far enough change which tile comes first. See `tileAt`.
 */
export function allTiles(object: LetterMosaicObject, at = 0): string[] {
  return readingOrder(mosaicTiles(object, at))
}

/**
 * The tiles a colour edit writes to.
 *
 * Picking tiles out means those; picking none means the whole mosaic, because
 * selecting the object and opening the Colour tab has already said which thing
 * is being coloured. The panel used to read an empty tile selection as "nothing
 * to colour" and disable both fields, so painting every glyph meant sweeping the
 * whole mosaic first, every time, to repeat what the object selection said.
 */
export function colourTargets(
  object: LetterMosaicObject,
  at: number,
  selection: readonly string[],
): string[] {
  return selection.length > 0 ? [...selection] : allTiles(object, at)
}
