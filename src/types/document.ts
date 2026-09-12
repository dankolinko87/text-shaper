/**
 * The versioned, serializable document model.
 *
 * This file defines the FULL product vision, not just what Phase 1 uses, so that
 * later phases populate fields rather than reshape interfaces. Phase 1 populates
 * a subset; everything else is created from `doc.defaults` and simply not
 * surfaced in the UI until its phase lands.
 */

/**
 * The thinnest a banner may be drawn, as a share of the type's own height.
 *
 * A stripe rather than a band by this point, which is a look people want. Below
 * it the fill is thinner than the strokes it sits behind and stops reading as
 * anything at all.
 */
export const MIN_LINE_HEIGHT = 0.15

/**
 * The smallest type a run may be set in, in object units per em.
 *
 * Below this the words stop being the artwork whatever the shape is.
 */
export const MIN_FONT_SIZE = 4

import type { FrameMember, FrameState } from './frame'
import type { MeshNode, MeshState, MeshTile } from './mesh'
import type { MosaicState, MosaicTile } from './mosaic'
import type { ImageAsset, Paint, StrokePaint } from './paint'

export const DOCUMENT_SCHEMA_VERSION = 32

/**
 * SVG path `d` string, in absolute commands.
 *
 * Not necessarily closed, and not necessarily one subpath: a drawn line is open,
 * and a shape drawn as a figure eight or a donut is several.
 */
export type PathData = string

/** `#rrggbb` or `#rrggbbaa`. */
export type ColorValue = string

/** One colour along a gradient: `at` is 0..1 along the blend; the colour may carry opacity. */
export interface GradientStop {
  at: number
  colour: ColorValue
}

/** What a colour effect's config may hold: a number, a hex colour, or a gradient's stops. */
export type ColourConfigValue = number | string | GradientStop[]

export interface Vec2 {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/* ------------------------------------------------------------------ *
 * Transform
 * ------------------------------------------------------------------ */

export interface Transform2D {
  /** Artboard-space position of the object's LOCAL ORIGIN. */
  x: number
  y: number
  /** Always positive; mirroring lives in flipX/flipY. */
  scaleX: number
  scaleY: number
  /** Degrees, clockwise, about the local origin. */
  rotation: number
  flipX: boolean
  flipY: boolean
}

/* ------------------------------------------------------------------ *
 * Text and typography
 * ------------------------------------------------------------------ */

export type TextFlowMode = 'word' | 'character' | 'preserve-lines'

export type FittingMode =
  | 'line-stretch'
  | 'glyph-stretch'
  | 'boundary-warp'
  // A lap and a spiral are one mode; `RunSettings.turns` says which.
  | 'ring'
  // Along a line the user drew. The only mode an open path can be in.
  | 'path'

export interface FontSettings {
  fontId: string
  weight: number
  italic: boolean
}

export interface TypographySettings {
  /** Multiple of em; 1 = the font's default leading. */
  lineSpacing: number
  /** Em units. */
  letterSpacing: number
  /** Uniform inset applied to the container before text is fitted. */
  padding: number
}

/**
 * One point of a path, and the handles that shape the curve either side of it.
 *
 * The same model paper.js uses, down to the field names, so converting between
 * the two is a field-for-field copy that can be checked at a glance — see
 * `geometry/outline.ts`. Handles are RELATIVE to the anchor, as paper's are:
 * that is what makes moving a point a one-field write, and what lets the smooth
 * invariant below be stated without reading the anchor at all.
 */
export interface PathNode {
  /** The anchor, in object-local space. */
  point: Vec2
  /** Control point of the incoming curve, relative to `point`. Zero for a kink. */
  handleIn: Vec2
  /** Control point of the outgoing curve, relative to `point`. */
  handleOut: Vec2
  /**
   * The handles are kept COLLINEAR, so the curve does not kink here.
   *
   * Collinear, not mirrored: the two lengths are independent. A Bézier fit
   * produces collinear handles of unequal length constantly — the one in
   * `strokeToLinePath` does — so a mirrored invariant would either classify
   * every fitted point as a corner or reshape the line the first time one was
   * written back.
   *
   * AUTHORED, not derived. `pathToOutline` guesses it once for geometry that has
   * never had a node list; after that this flag is what is true, and nothing
   * re-measures it. That is what lets "make this a corner" leave the curve alone
   * and still survive a save.
   */
  smooth: boolean
}

/**
 * One continuous run of nodes.
 *
 * A path can be several: `strokeToShapePath` keeps every significant region, so
 * a shape drawn as a figure eight really is two loops and a donut really is a
 * loop and a hole. The pen only ever authors ONE — the list is here to carry
 * geometry that already has more, not an invitation to draw it.
 */
export interface PathSubpath {
  nodes: PathNode[]
  closed: boolean
}

/** A path's editable points. Null on a primitive, and on anything not taken apart. */
export interface PathOutline {
  subpaths: PathSubpath[]
}

export interface RunSettings {
  /**
   * How big the type is, in object units per em. 0 asks for as big as fits.
   *
   * Capped at what the shape can hold: a lap SHORTENS as the type grows, since
   * the band pushes further inside the outline, and a spiral loses whole turns,
   * since the pitch is the line height and wider letters push the turns apart.
   * Measured on a 700x620 ellipse with one line, 40 units winds four turns, 60
   * winds two, 67 winds one, and at 90 no spiral exists at all — more loops come
   * from SMALLER type, not bigger. The way to get bigger type is a bigger shape,
   * and the ceiling moves with it.
   */
  fontSize: number
  /**
   * Once round, or winding inward until the text runs out.
   *
   * Not a number. The turn count on `many` falls out of the pitch and the shape
   * — thirty characters make one big turn, six hundred make eight small ones —
   * so a number here would be a cap pretending to be a target.
   */
  turns: 'one' | 'many'
  /**
   * Where the band sits across the outline: 1 inside, 0 centred, -1 outside.
   *
   * A position rather than a mode, so it can sit anywhere between.
   */
  side: number
  /**
   * Travels the run the other way round.
   *
   * On a spiral this winds out from the middle instead of in from the edge. On a
   * lap it flips which side of the line the capitals stand on, which is the
   * badge look: reversing the direction and the normal together preserves
   * handedness, so the type stays readable rather than mirrored.
   */
  outward: boolean
  /**
   * Least share of the shape left empty in the middle, 0..0.9. Many turns only.
   *
   * A floor, not a target. Winding deeper with the same words means smaller type
   * and more turns, so the run grows while the text shrinks, and the only thing
   * that can make up the difference is stretching the letters — past a point the
   * depth is simply unbuyable. It used to be read as a target and kept the
   * promise by drawing letters more than twice their designed width.
   */
  centreHole: number
  /**
   * Begin and end the line at the side of the shape. One turn only.
   *
   * The line is one continuous run of words the whole way round either way,
   * upside down along the bottom as type on a closed path is. This decides only
   * WHERE its two ends sit: left alone they land wherever the offsetter happened
   * to start the outline, which is a different angle on every shape.
   */
  split: boolean
  /**
   * Where the break sits, as a clock bearing: 0 is twelve, 90 three, 270 nine.
   *
   * A bearing from the shape's middle rather than a distance along the lap,
   * because that is the question being asked — "put the join at the bottom" —
   * and a lap's length changes with the type size while its bearings do not.
   * One turn only, and only when `split` is on.
   */
  splitAngle: number
  /** Share of the lap left empty where the words begin and end. One turn only. */
  gap: number
  /**
   * How tall the band the type travels in is, in ink heights.
   *
   * Separate from the gap between the lines, which is the point of it. The two
   * used to be one number — a turn was the letters' own height plus a share of
   * it — so there was no way to ask for room AROUND the letters without also
   * changing how far apart the turns sat, and a banner is exactly that: room
   * around the letters, with the turns moved apart to keep it.
   *
   * 1 is the letters' own height, which is what every mode did before this
   * existed.
   */
  lineHeight: number
  /**
   * Set the letters at their drawn widths instead of packing them into the run.
   *
   * The two ways type can meet a curve, and both are wanted. PACKED, every
   * character is scaled independently into its own slot, so the letterforms
   * themselves carry the shape — the house style of this tool, and what a spiral
   * looks like. SET, the letters keep the proportions they were drawn at and the
   * run decides only where they sit and which way they face — what a type-on-path
   * tool does, and what a lap of a badge wants.
   */
  rigid: boolean
  /** Keeps letters vertical instead of turning them to follow the run. */
  upright: boolean
  /** Lifts the type off its line, in ems. */
  baselineShift: number
}

/** Phase 5. Present in the model from v1 so documents never need migrating for it. */
export interface DistortionSettings {
  horizontal: number
  vertical: number
  boundaryInfluence: number
  glyphScaleVariation: number
  glyphRotation: number
  waveAmount: number
  waveFrequency: number
  shear: number
  noiseAmount: number
  noiseScale: number
}

/**
 * How the TYPE moves. Motion only — colour is chosen separately.
 *
 * Colour used to sit in this list, which meant a sticker could either shimmer or
 * bounce but never both, and put a colour picker in among the motion controls
 * where nobody looked for it.
 */
export type AnimationPreset =
  | 'none'
  | 'wave'
  | 'boil'
  | 'bounce'
  | 'sweep'
  | 'sway'
  | 'pop'
  | 'jitter'
  | 'travel'

/**
 * How a SOLID colour moves through the loop. Applies to the type or the
 * container. A gradient is a paint of its own and carries its own motion,
 * so it is no longer an effect here.
 */
export type ColourEffect = 'none' | 'cycle' | 'flicker'

/**
 * A colour and what it does over the loop.
 *
 * The resting colour itself stays in `AppearanceSettings` — it is what the
 * artwork IS, and it must still mean something with no animation at all.
 */
export interface ColourSettings {
  effect: ColourEffect
  /** Effect-specific values, keyed by control id: numbers, hex colours, or a gradient's stop list. */
  config: Record<string, ColourConfigValue>
}

/**
 * How a shape loops.
 *
 * There is no timeline: a preset plus its own settings is the whole animation.
 * Each preset declares which controls it wants (see `typography/animation.ts`),
 * so `config` is keyed by control rather than being one shared "intensity" that
 * would have to mean something different for every preset.
 *
 * Whether it is currently PLAYING is deliberately absent: that describes an
 * editing session, not the artwork, and lives in the UI store.
 */
export interface AnimationSettings {
  preset: AnimationPreset
  /** Seconds. State at t=0 and t=loopDuration must match exactly. */
  loopDuration: number
  /** Preset-specific values, keyed by control id. Numbers or hex colours. */
  config: Record<string, number | string>
  /**
   * The CONTAINER's own loop, chosen separately from the type's.
   *
   * A shape preset deforms the patch the type is laid out through, so the type
   * follows the shape's new form by itself — squash the shape and the letters
   * squash with it. The two menus therefore compose rather than competing.
   */
  shapePreset: string
  shapeConfig: Record<string, number | string>
  /**
   * Whether the shape's motion reaches the type inside it.
   *
   * On, the type is laid out through the deformed container and follows its
   * form. Off, the container moves alone and the type holds its place — which is
   * what you want when the shape is a frame around the words rather than a
   * vessel they are poured into.
   */
  shapeAffectsText: boolean
  /**
   * The BANNER's own loop, chosen separately from the type's.
   *
   * The banner is a shape, not a decoration on the letters — so it gets a menu
   * of its own, the way the container does. That is what lets the two be set
   * against each other: the words travelling round inside a banner that holds
   * still, or a banner rippling under type that does not.
   *
   * `'follow'` is the banner taking whatever the type is doing, which is what it
   * did before it had a choice and remains the default: a ripple that moved the
   * words and left their background behind would tear the two apart.
   */
  bannerPreset: AnimationPreset | 'follow'
  bannerConfig: Record<string, number | string>
  /** What the type's colour does over the loop. */
  textColour: ColourSettings
  /** What the container's colour does over the loop. */
  shapeColour: ColourSettings
}

/**
 * A drawn edge.
 *
 * Width and dash are in the object's own units, like padding, the gap and the
 * corner radii — so a border scales with the thing it is on, and an export at
 * any size draws it in the same proportion the canvas did.
 *
 * Called a Stroke here and a Border in the panel, deliberately. "Stroke" in
 * this app already means the pen and pencil GESTURE that draws a path (see
 * `geometry/strokeToPath.ts`), and a user asking for a border is not asking
 * about that; the renderer and the canvas both call it a stroke, and this is
 * their word.
 */
export interface Stroke {
  colour: StrokePaint
  /** In object units. */
  width: number
  /** Null is solid. Both numbers are in object units, so dashes scale too. */
  dash: { length: number; gap: number } | null
}

/**
 * Where the band sits relative to the outline it follows.
 *
 * Canvas and Fabric only ever stroke down the CENTRE of a path; inside and
 * outside are that centred stroke at double width with half of it clipped away.
 * See `editor/strokePaint.ts`, which is the only place that knows it.
 */
export type StrokePosition = 'inside' | 'centre' | 'outside'

/**
 * A border on something that can honour a position.
 *
 * `Stroke` is deliberately the narrow type and this extends it: a part whose
 * position cannot be honoured — the mosaic's silhouette, which is clipped to
 * itself — is typed as `Stroke` and so cannot be handed one, rather than
 * carrying a field it quietly ignores.
 */
export interface PositionedStroke extends Stroke {
  position: StrokePosition
}

export interface AppearanceSettings {
  textFill: Paint
  /** Optional container/background fill; null renders no container. */
  containerFill: Paint | null
  /**
   * Optional banner behind the type, following the run; null draws none.
   *
   * Only the run modes have one — a spiral and a ring have a line to follow,
   * and rows in a shape do not.
   */
  lineFill: Paint | null
  /**
   * The container's own edge; null draws none.
   *
   * Null rather than a zero width, for the same reason `containerFill` is null
   * rather than transparent: a border nobody has added is not a border of no
   * width, and the panel says so by having no controls for one at all.
   */
  containerStroke: PositionedStroke | null
  /** Object-level opacity, 0..1. */
  opacity: number
}

/* ------------------------------------------------------------------ *
 * Objects
 * ------------------------------------------------------------------ */

/**
 * A boundary between two rows of text, in object-local space.
 *
 * Stored as a full-width curve rather than as endpoints anchored to the
 * outline: when the container is later reshaped, a divider stored this way is
 * simply re-clipped to the new outline, where anchored endpoints would be left
 * floating outside it or falling short.
 *
 * The points are control points of a smooth curve, ordered left to right. Two
 * points give a straight divider; adding more lets a row take any profile.
 */
/**
 * A boundary inside the container, in PATCH space.
 *
 * A ROW divider runs across the shape: its points are `(u, v)` and it reads as
 * `v = f(u)`. A COLUMN divider runs down it: its points are `(v, u)` and it
 * reads as `u = g(v)`. Both are the same curve with its axes swapped, which is
 * only possible because patch space is a square — in object coordinates a
 * column would have been a vertical line, which no function can describe.
 *
 * Omitted, the axis is a row. Documents written before columns existed have no
 * axis on their dividers and every one of them is a row.
 */
export interface GridDivider {
  id: string
  points: Vec2[]
  axis?: 'row' | 'column'
  /**
   * Where a COLUMN deformer sits when it is doing nothing, across the row.
   *
   * A column squeezes the type from where it rests to where it has been
   * dragged, so the resting place is what decides whether it is deforming
   * anything at all. Recorded when the column is created, at the position it was
   * created AT, so putting one down changes nothing until it is moved.
   *
   * It used to be assumed — evenly spaced, `(i + 1) / (count + 1)` — which meant
   * dropping a column anywhere but the exact centre yanked the type across to it
   * on the spot, and adding a second one re-spaced the first and moved the type
   * again. Absent, that assumption still applies, so documents made before this
   * keep the artwork they were saved with.
   */
  rest?: number
}

/**
 * What every object on the artboard has, whatever kind it is.
 *
 * Deliberately small. These are the properties the systems that do not care what
 * an object IS still need — the canvas to place it, the layers panel to list it,
 * selection to hold it, undo to restore it. Everything else belongs to one kind
 * or the other, and putting it here would mean a field that is null on half the
 * document, which is how `line` came to be read as "this is a line" on every
 * shape ever drawn.
 */
export interface DocumentObjectBase {
  id: string
  name: string
  transform: Transform2D
  /** Bounding box in object-local space. */
  localBounds: Rect
  visible: boolean
  locked: boolean
}

/**
 * Text fitted into a drawn outline — everything the tool made before mosaics.
 *
 * The `kind` discriminator is required rather than optional, so an object that
 * does not say what it is cannot be constructed. Migration 17 writes it on every
 * object that predates the union.
 */
export interface TypographyObject extends DocumentObjectBase {
  kind: 'typography'

  /* --- geometry: ALL path fields are in OBJECT-LOCAL space --- *
   *
   * Local origin (0,0) is the object's bounding-box centre AT CREATION TIME,
   * and is never moved again — not by scaling, not by rotation, and not by
   * brush reshaping. Phase 4 depends on this: if the origin were re-centred
   * on every edit, each brush dab would visually translate the object.
   */

  /** Exactly as first drawn. Never mutated — the target of Restore and Reset Shape. */
  originalSourcePath: PathData
  /** Authoritative editable geometry, full fidelity. */
  currentSourcePath: PathData
  /** Cache: lower-resolution path used for interactive preview during gestures. */
  simplifiedRenderPath: PathData
  /** Cache: `currentSourcePath` inset by padding. `null` when padding collapses the interior. */
  insetPath: PathData | null
  /** Incremented on ANY change to `currentSourcePath`; lets stale async results be discarded. */
  geometryRevision: number

  /** The exact text the user entered. Never transformed, reordered, or truncated. */
  text: string
  textFlowMode: TextFlowMode
  fittingMode: FittingMode

  /**
   * Manual row boundaries. Empty means the engine chooses the rows itself.
   *
   * N dividers produce N+1 rows. Rows keep the words the engine gave them —
   * dragging a divider changes a row's FORM, not its content.
   */
  dividers: GridDivider[]

  font: FontSettings
  typography: TypographySettings
  run: RunSettings
  /**
   * The object's geometry as editable nodes, or null when it has none.
   *
   * The second half of a pair: `currentSourcePath` is what every downstream
   * reader consumes, and this is the same curve in the form the editor can take
   * hold of — anchors with Bézier handles, one subpath per contour. The two must
   * be written together or a stale node list will jump the shape the first time
   * a handle is dragged, which is why `setGeometry` exists.
   *
   * Null for geometry there is nothing useful to edit: a primitive, and a shape
   * whose edges were rewritten by the grid into a several-hundred-point
   * polyline.
   */
  outline: PathOutline | null
  distortion: DistortionSettings
  appearance: AppearanceSettings
  animation: AnimationSettings

  /** Per-object deterministic randomness. */
  seed: number
}

/**
 * A grid of letters, each stretched to fill its tile, animated between authored
 * states. See `types/mosaic.ts` for the coordinate model.
 */
export interface LetterMosaicObject extends DocumentObjectBase {
  kind: 'mosaic'
  /**
   * The tiles and the lines they name. Shared by every state — which tiles exist
   * is global; only where the lines sit differs.
   */
  tiles: MosaicTile[]
  /**
   * The grid this mosaic was made as, which is what Reset puts it back to.
   *
   * Kept rather than worked out from the tiles, because dragging FORKS lines: a
   * mosaic seeded as four columns can be holding seven coordinates once it has
   * been reshaped, and nothing left in that dissection says which of them were
   * there at the start.
   */
  seed: { columns: number; rows: number }
  /**
   * At least one. Every state shares the tiles, their ids and their characters,
   * and differs only in where the lines sit and in colour.
   */
  states: MosaicState[]
  /**
   * The grid a dragged line lands on, in object-local units. Zero drags freely.
   *
   * Not part of `MosaicSpacing`, and deliberately not passed to the layout: the
   * rectangles are a pure function of the coordinates, and a mosaic whose lines
   * are already off the grid must keep drawing exactly as it did. This only ever
   * decides where a drag is allowed to come to rest. See `mosaic/snap.ts`.
   */
  snapStep: number
  loop: boolean
  /** Multiplier on the whole timeline. 1 is as authored. */
  speed: number
  opacity: number
}

/**
 * Anything that can sit on the artboard.
 *
 * Narrow on `kind` before touching anything kind-specific. The compiler will
 * insist, which is the point of the discriminator being required.
 */
/**
 * A frame: objects arranged differently in each of several states.
 *
 * The mosaic's model one level out — `members` is what every state shares, and
 * `states` is what each member is worth. See `types/frame.ts` for the whole of
 * it; this is only where it joins the union.
 */
export interface FrameObject extends DocumentObjectBase {
  kind: 'frame'
  /** Which objects are in it. Structural: every state has all of them. */
  members: FrameMember[]
  states: FrameState[]
  /** Multiplier on the whole timeline. A rate, not a duration. */
  speed: number
  /**
   * Whether the bounds cut what is inside.
   *
   * Off by default, so the rectangle is a drop target and a place rather than a
   * cage — least surprising for a container you have just drawn around some
   * work. On, it is a window, and a member sliding through the edge wipes on,
   * which is a masked reveal and most of what a motion container is for.
   */
  clip: boolean
  /** Object-level opacity, 0..1, like a mosaic's. */
  opacity: number
}

/**
 * Letters in the cells of a grid whose corners are free: nodes with a position
 * per state, tiles as rings of them. See `types/mesh.ts` for the model, and
 * for what it shares with the mosaic — everything that is not geometry.
 */
export interface MeshObject extends DocumentObjectBase {
  kind: 'mesh'
  /** Every node's identity. Shared by every state; positions are per state. */
  nodes: MeshNode[]
  /** The rings. Shared by every state, like a mosaic's tiles. */
  tiles: MeshTile[]
  /** The grid this mesh was seeded as, which is what Reset straightens back to. */
  seed: { columns: number; rows: number }
  states: MeshState[]
  /** The grid a dragged node lands on, in object-local units. Zero drags freely. */
  snapStep: number
  /**
   * What the backdrop, the silhouette clip and the border follow: the whole
   * BOX round the state's nodes, as a mosaic's do, or the rim of the tiles.
   */
  backdrop: MeshBackdrop
  loop: boolean
  speed: number
  opacity: number
}

export type MeshBackdrop = 'box' | 'silhouette'

export type DocumentObject = TypographyObject | LetterMosaicObject | FrameObject | MeshObject

/**
 * Narrowing helpers.
 *
 * `object.kind === 'typography'` narrows perfectly well on its own; these exist
 * because the filter form reads better at the call sites that have one — and
 * because a named predicate is somewhere to hang the reason a system only
 * handles one kind.
 */
export const isTypography = (object: DocumentObject): object is TypographyObject =>
  object.kind === 'typography'

export const isMosaic = (object: DocumentObject): object is LetterMosaicObject =>
  object.kind === 'mosaic'

export const isFrame = (object: DocumentObject): object is FrameObject =>
  object.kind === 'frame'

export const isMesh = (object: DocumentObject): object is MeshObject => object.kind === 'mesh'

/**
 * An object made of TILES that hold letters and colours per state: a mosaic
 * or a mesh. The two differ in how a tile is placed and in nothing else, so
 * the actions and panels that write letters, colours, backdrop, border, font,
 * spacing, corners and timing serve both.
 */
export type Tiled = LetterMosaicObject | MeshObject

export const isTiled = (object: DocumentObject): object is Tiled =>
  object.kind === 'mosaic' || object.kind === 'mesh'

/**
 * An object with STATES: a sequence of authored arrangements it plays
 * through, shows one of, and can lay out side by side. A mosaic and a frame
 * today; anything that joins them gets the same list, bar, chips, spread and
 * rules, because those are written once against this type.
 */
export type Stated = LetterMosaicObject | FrameObject | MeshObject

export const isStated = (object: DocumentObject): object is Stated =>
  object.kind === 'mosaic' || object.kind === 'frame' || object.kind === 'mesh'

/**
 * How see-through an object is, whichever kind it is.
 *
 * Typography keeps opacity inside its `appearance` group, which is a
 * typography-shaped thing; a mosaic and a frame have no such group. The renderer
 * applies this to the Fabric group and does not care which, so it asks here.
 */
export function opacityOf(object: DocumentObject): number {
  return object.kind === 'typography' ? object.appearance.opacity : object.opacity
}

/* ------------------------------------------------------------------ *
 * Artboard and document
 * ------------------------------------------------------------------ */

export interface Artboard {
  width: number
  height: number
  background: ColorValue
}

export interface DocumentDefaults {
  font: FontSettings
  typography: TypographySettings
  run: RunSettings
  distortion: DistortionSettings
  appearance: AppearanceSettings
  animation: AnimationSettings
}

export interface TextShaperDocument {
  schemaVersion: number
  id: string
  name: string
  /** ISO timestamps. */
  createdAt: string
  updatedAt: string
  artboard: Artboard
  objects: Record<string, DocumentObject>
  /**
   * Canonical z-order; index 0 is the BOTTOM of the stack.
   *
   * This is deliberately the single source of stacking truth rather than a
   * per-object `zIndex`. A stored index plus an implied array order would be
   * two sources of truth that must be renumbered on every reorder, delete, and
   * duplicate — an N-object write per reorder, where any missed renumber
   * produces duplicate or gapped indices. Z-index is a derived selector instead.
   */
  objectOrder: string[]
  defaults: DocumentDefaults
  /**
   * The pictures the document's paints refer to, by id.
   *
   * Kept once each and named from their contents, so a picture on twenty
   * tiles is one string, and a paste of the same picture lands on the one
   * already here. Swept of anything nothing refers to when the document is
   * saved.
   */
  assets: Record<string, ImageAsset>
}
