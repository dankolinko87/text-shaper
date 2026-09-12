import type { Paint } from './paint'
import type { Easing } from '../anim/easing'
import type { FontSettings, PositionedStroke, Rect } from './document'

/**
 * A letter mosaic: a rectangle cut into tiles by a set of lines, one glyph
 * stretched into each tile.
 *
 * The lines are the model. Each is a COORDINATE — a fraction of the way across
 * the mosaic — and a tile says which four it is bounded by. That is the whole
 * structure, and every property the tool needs falls out of it:
 *
 * Moving a line is changing one number. The tiles naming it respond; the tiles
 * that do not, do not. There is no cut order to reason about and no ancestry to
 * resolve, which is what makes "drag this edge" a single operation with a single
 * answer.
 *
 * Sharing a coordinate IS alignment. Tiles in different rows that name the same
 * `x` stay in line because they are reading the same number, and they come apart
 * only when one is deliberately repointed at a new one.
 *
 * Validity is a set of LINEAR inequalities — every tile at least so wide, at
 * least so tall — so any blend of two valid layouts is valid, which is what lets
 * an animation interpolate between states and be legal at every frame.
 *
 * This replaced a guillotine partition tree, where a tile's size was the product
 * of fractions on the splits above it. That model could express these layouts
 * but could not offer them as one gesture: an edge was not a thing in it, so
 * "move this line" meant two tiles, or a whole row, depending on the order the
 * cuts happened to have been made.
 */

/** Where a line sits, as a fraction of the content box: 0 is the left or top rim. */
export type Coordinate = number

/**
 * The four lines that never move: the rim of the mosaic itself.
 *
 * Named rather than special-cased at every lookup, so a tile's bounds are always
 * four coordinate ids and nothing has to ask whether an edge is an edge.
 */
export const X_MIN = 'mx_min'
export const X_MAX = 'mx_max'
export const Y_MIN = 'my_min'
export const Y_MAX = 'my_max'

export const RIM: Readonly<Record<string, Coordinate>> = {
  [X_MIN]: 0,
  [X_MAX]: 1,
  [Y_MIN]: 0,
  [Y_MAX]: 1,
}

export const isRim = (id: string): boolean => id in RIM

export interface MosaicTile {
  id: string
  /*
   * No character here. It moved onto the state, alongside the colours.
   *
   * A tile is a place in the partition — the one thing every state agrees on and
   * the reason a frame between two states can be worked out at all. What is
   * WRITTEN in that place is a property of the composition, and compositions are
   * what states hold. See `MosaicState.chars`.
   */
  /** The coordinates bounding it. Sharing one with another tile is alignment. */
  left: string
  right: string
  top: string
  bottom: string
}

/** Easing applied to a whole transition. Never per line — see `MosaicState`. */
/**
 * A new state's timing.
 *
 * No hold and a six-hundred-millisecond transition: a mosaic that never rests,
 * because a slideshow of held compositions is the thing this is not. Milliseconds
 * throughout — the unit the timeline is evaluated in, so nothing has to be
 * converted at the point it is read.
 */
export const MOSAIC_DEFAULT_HOLD_MS = 0
export const MOSAIC_DEFAULT_TRANSITION_MS = 600
export const MOSAIC_DEFAULT_EASING: MosaicEasing = 'ease-in-out'

/**
 * A new state's spacing.
 *
 * Small but visible, so a new mosaic reads as tiles rather than one block, and
 * enough inset that a glyph does not touch its tile's edge.
 */
export const MOSAIC_DEFAULT_SPACING = {
  gap: 6,
  outerPadding: 0,
  glyphInset: 6,
} as const

/**
 * A new state's corners.
 *
 * Square, so nothing that exists changes shape. Rounding is a decision, not a
 * default — and a mosaic is a partition of a rectangle, which is what it should
 * look like until somebody says otherwise.
 */
export const MOSAIC_DEFAULT_CORNERS = {
  tileRadius: 0,
  outerRadius: 0,
} as const

/**
 * How the rectangles are rounded, in object-local units.
 *
 * Two separate decisions, because they are about two different shapes. The tile
 * radius is about each tile; the outer radius is about the SILHOUETTE of the
 * whole composition, and rounds it whether or not a tile happens to reach into
 * the corner. Setting one to round the other would be impossible: with a gap
 * between tiles, rounding every tile leaves the mosaic's own corners square, and
 * rounding the outline leaves the tiles inside it sharp.
 */
export interface MosaicCorners {
  /** Applied to every tile's own rectangle. */
  tileRadius: number
  /** Applied to the mosaic's outline, clipping everything inside it. */
  outerRadius: number
}

/**
 * The colour a letter is drawn in when its tile has been given none.
 *
 * Near-black rather than black: the artboard is off-white, and pure black on it
 * reads as a hole rather than as ink.
 */
export const DEFAULT_GLYPH_COLOUR = '#101014'

/**
 * The most cells a mosaic can have on one side.
 *
 * A ceiling rather than a considered maximum: at a hundred a side the grid holds
 * ten thousand tiles, each with an outline and a background, and the editor stops
 * being usable long before the arithmetic does. Twenty is past anything the
 * control is comfortable to aim at and still well inside what draws smoothly.
 */
export const MOSAIC_MAX_SIDE = 20

/** How many states a mosaic is born with, and the range it can be taken to. */
export const MOSAIC_DEFAULT_STATES = 3
export const MOSAIC_MIN_STATES = 2
export const MOSAIC_MAX_STATES = 12

/**
 * The shortest transition worth having, in milliseconds.
 *
 * A transition of zero is not a fast transition, it is a division by nothing —
 * the timeline has to place a progress inside it. One frame is the floor.
 */
export const MOSAIC_MIN_TRANSITION_MS = 16

/**
 * The mosaic's word for it. The curves themselves are `anim/easing`, shared with
 * everything else that has states — an alias rather than a rename, because a
 * mosaic panel saying "easing" should not have to say whose.
 */
export type MosaicEasing = Easing

export interface MosaicState {
  id: string
  /**
   * Where every vertical line sits, by coordinate id. The tiles are shared by
   * every state; these numbers are the part that differs.
   */
  x: Record<string, Coordinate>
  /** And every horizontal one. */
  y: Record<string, Coordinate>
  /** By tile id. */
  glyphColour: Record<string, Paint>
  /** By tile id. Null draws no background at all, which is not the same as white. */
  tileColour: Record<string, Paint | null>
  /**
   * Behind the whole composition, padding and gaps included.
   *
   * One colour for the mosaic rather than a map, because it is not a property of
   * any tile: it fills the outer padding and the gaps between tiles, which no
   * tile owns. Drawn on the mosaic's own box and cut by the same outer radius,
   * so it is the silhouette's colour.
   *
   * Per state and interpolated, like the tile colours — null means no backdrop
   * at all, which is not the same as a transparent one. A backdrop fading OUT is
   * a colour at zero alpha; one that was never chosen is nothing.
   */
  background: Paint | null
  /**
   * The composition's own edge, drawn on the silhouette; null draws none.
   *
   * Per state and interpolated, like the backdrop and the corners — a border
   * that thickens or changes colour between two states animates with them.
   *
   * `stroke`, not `outline`: a typography object already has an `outline`, and
   * it means the editable nodes a path is made of. One word, one meaning.
   *
   * Positioned like a shape's. The group is clipped to its own rounded outline,
   * so the clip is grown by exactly the border's outward reach — an outset
   * rounded rect with its radius raised to match is the same curve offset
   * outward, so the silhouette keeps its shape and only makes room for the band.
   */
  stroke: PositionedStroke | null
  /**
   * What is written in each tile, by tile id. Absent means an empty tile.
   *
   * Per state, and the second thing here that cannot be interpolated: two
   * letters are different shapes, not two positions of one shape. So a change of
   * character is a CUT, taken on arrival exactly as a font change is — the state
   * being left keeps its letters for the whole transition and the new ones
   * appear the instant the movement finishes.
   *
   * Empty is a real answer rather than a missing one. The tile still occupies
   * its share of the mosaic, still takes a background colour, and is still where
   * the caret goes — so a letter can drop out of one state and come back in the
   * next without anything moving.
   */
  chars: Record<string, string>
  /**
   * The typeface this composition is set in.
   *
   * Per state, and the one thing here that cannot be interpolated: two
   * typefaces' outlines are different shapes, not two positions of one shape.
   * So a font change is a CUT, taken on arrival — the state being left keeps its
   * font for the whole transition and the new one appears the instant the
   * movement finishes. See `timeline.ts`.
   */
  font: FontSettings
  /**
   * Between neighbouring tiles, in object-local units.
   *
   * Per state, and interpolated. It enters the size constraint linearly, so a
   * blend of two legal states stays legal — the same argument that protects the
   * coordinates protects this.
   */
  gap: number
  /**
   * Between the mosaic and its own bounds.
   *
   * Per state, and interpolated — but it is the awkward one. It changes the size
   * of the content box, and a tile's width is a coordinate DIFFERENCE times that
   * size, so interpolating both would make the constraint a product of two
   * moving numbers and the legality guarantee would not survive it.
   *
   * Which is why `timeline.ts` blends coordinates in absolute units rather than
   * as fractions. A tile's width is then linear in time again, the guarantee
   * holds exactly, and with the padding held still the two are the same
   * arithmetic — so nothing is given up to buy it.
   */
  outerPadding: number
  /** Between a glyph and the inside edge of its tile. Per state, and interpolated. */
  glyphInset: number
  /**
   * How far each tile's own corners are rounded, in object-local units.
   *
   * Per state, and interpolated. Paint only: it never enters the layout, so no
   * legality argument depends on it and it can be blended on its own terms.
   * Clamped at paint time to half the tile it is drawn on, so a radius larger
   * than a tile makes a pill rather than a shape that folds through itself.
   */
  tileRadius: number
  /**
   * How far the mosaic's own outline is rounded, in object-local units.
   *
   * Per state, and interpolated. Applied as a clip on the whole composition
   * rather than to the tiles at the rim, so a letter that reaches the edge is
   * cut by the same curve its background is — which is what makes the silhouette
   * read as one shape instead of four rounded corners with square things poking
   * out of them.
   */
  outerRadius: number
  /**
   * Milliseconds this state is held before the transition to the next begins.
   *
   * Zero is allowed and useful: a mosaic that never rests is one continuous
   * movement rather than a slideshow.
   */
  holdMs: number
  /**
   * Milliseconds the transition OUT of this state takes.
   *
   * For every state but the last it is the transition into the next one. For
   * the LAST state it is the transition back to the first, because a mosaic
   * always loops.
   */
  transitionMs: number
  /**
   * The easing for that transition, shared by every line in it.
   *
   * One curve for the whole transition, and it must not overshoot. A layout is
   * legal when a set of linear inequalities between its coordinates hold, and a
   * blend of two points satisfying them satisfies them too — so if both states
   * are legal, every frame between them is. That needs each coordinate to move
   * through the SAME substitution; per-line easing would break it, and an
   * overshooting curve would take a coordinate outside the range its endpoints
   * define, which is a tile turned inside out.
   */
  easing: MosaicEasing
}

/**
 * A new mosaic's tile, in object-local units.
 *
 * Load-bearing beyond creation: a mosaic's `localBounds` is `columns × rows`
 * of these, so the bounds still say what grid it was made as long after the
 * lines inside it have been dragged out of shape. That is what lets a document
 * written before the seed was recorded recover it exactly.
 */
export const MOSAIC_CELL = 120

export interface MosaicSpacing {
  /** Between neighbouring tiles, in object-local units. */
  gap: number
  /** Between the mosaic and its own bounds. */
  outerPadding: number
  /** Between a glyph and the inside edge of its tile. */
  glyphInset: number
  /**
   * Below this, a rectangle collapses to nothing instead of drawing as a sliver.
   *
   * Optional, and absent means zero — the layout is a pure function of the
   * coordinates and will happily produce whatever the numbers say. The controls
   * clamp against this so it never comes up in normal use; it is here for
   * documents that arrive from somewhere else. See `mosaic/spacing.ts`.
   */
  minimumVisibleSize?: number
}

/** One tile's three rectangles, each derived from the one before it. */
export interface MosaicTileLayout {
  /** The tile's share of the mosaic. These cover the content box exactly. */
  structural: Rect
  /** What is drawn: structural, inset by half a gap on every interior edge. */
  visible: Rect
  /** Where the glyph goes: visible, inset by the glyph inset. */
  glyph: Rect
}

export interface MosaicTiming {
  /**
   * No longer read by anything.
   *
   * Every mosaic loops. The field stays so that saved documents load exactly as
   * they were written and the schema does not have to move; `timeline.ts`
   * ignores it, and a document saved with `loop: false` now loops, which is the
   * intent. Restoring the choice later means restoring one control and three
   * branches, not a migration.
   */
  loop: boolean
  /**
   * Multiplier on the whole timeline. 1 is as authored.
   *
   * A clock RATE rather than a duration — the only way to run a whole sequence
   * faster without rewriting every state's timing, which is why it survived the
   * move to per-state timing and why it sits beside the grid rather than inside
   * a state card.
   */
  speed: number
}

/** Font settings and colours for a mosaic, re-using the typography settings shape. */
export type MosaicFont = FontSettings
