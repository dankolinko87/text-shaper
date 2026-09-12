import { collectAssetIds, samePaint } from '../typography/paint'
import type { ImageAsset, ImageCrop, Paint } from '../types/paint'
import { cropObjectOf, cropPaintFor, type CropTarget } from './cropModel'
import { restack, type Stacking } from './stacking'
import { create } from 'zustand'

import { copyOutline, sameTopology, transformOutline } from '../geometry/outline'
import { pathBounds, transformPathData } from '../geometry/path'
import type { StrokeToShapeResult } from '../geometry/strokeToPath'
import { MIN_TRANSITION_MS } from '../anim/timeline'
import type { Easing } from '../anim/easing'
import {
  copyFrameIdentity,
  emptyState,
  memberAsFreed,
  sameValues,
  valuesFor,
} from '../frame/frame'
import type { FrameMember, MemberValues } from '../types/frame'
import { FRAME_MAX_STATES, FRAME_MIN_STATES } from '../types/frame'
import { sameStroke } from '../geometry/stroke'
import { compose } from '../geometry/transform'
import type { AppearanceSettings,
  MeshBackdrop,
  ColorValue,
  DocumentObject,
  FrameObject,
  DocumentObjectBase,
  GridDivider,
  LetterMosaicObject,
  PathData,
  PathOutline,
  PositionedStroke,
  Rect,
  TextShaperDocument,
  TypographyObject,
  Vec2,
} from '../types/document'
import { isStated,
  isTiled, isTypography } from '../types/document'
import { thicknessFloor } from '../mesh/edit'
import { allMeshTiles, meshSpacing } from '../mesh/layout'
import { meshBounds, seedMesh } from '../mesh/mesh'
import {
  addPoint,
  cutTile,
  extrudeEdge,
  latticeOf,
  removePoint,
  removeTile as removeTileFromMesh,
  resetPositions,
  type MeshShape,
} from '../mesh/ops'
import {
  copyMeshIdentity,
  copyMeshState,
  initialMeshState,
  meshFromMosaic,
  sameMeshGeometry,
} from '../mesh/dissection'
import type { MeshState } from '../types/mesh'
import { MESH_CELL, MESH_DEFAULT_STATES, MESH_MAX_SIDE } from '../types/mesh'
import { createId, createSeed } from '../utils/id'

/** How far a copy sits from what it was copied from, in artboard units. */
const DUPLICATE_OFFSET = 24
import { clamp } from '../utils/math'
import {
  copyMosaicIdentity,
  copyState,
  forkCoordinate,
  type Span,
  initialState,
  mergeCoordinates,
  gridRanks,
  reseedMosaic,
  sameGeometry,
  seedMosaic,
  valueOf,
  withCharacters,
} from '../mosaic/dissection'
import {
  clampSpacing,
  clampTo,
  maximumGap,
  maximumGlyphInset,
  maximumOuterPadding,
} from '../mosaic/spacing'
import { canReshape } from '../mosaic/boundaries'
import { layoutMosaic } from '../mosaic/layout'
import { readingOrder } from '../mosaic/order'
import { MOSAIC_DEFAULT_SNAP } from '../mosaic/snap'
import { removeTile, splitTile } from '../mosaic/topology'
import {
  MOSAIC_CELL,
  MOSAIC_DEFAULT_STATES,
  MOSAIC_MAX_STATES,
  MOSAIC_MIN_STATES,
  MOSAIC_MIN_TRANSITION_MS,
  X_MAX,
  X_MIN,
  Y_MAX,
  Y_MIN,
} from '../types/mosaic'
import type { FontSettings, MeshObject, Stroke, Tiled } from '../types/document'
import type { MosaicCorners, MosaicEasing, MosaicSpacing } from '../types/mosaic'
import { MOSAIC_MAX_SIDE } from '../types/mosaic'
import type { MosaicState, MosaicTile } from '../types/mosaic'
import { createEmptyDocument, documentDefaults } from './defaults'

/** Side of one cell in a freshly created mosaic, in object-local units. */

/** What a new mosaic is spaced with, and what Reset puts back. */
export const MOSAIC_DEFAULT_SPACING = {
  /** Small but visible, so a new mosaic reads as tiles rather than one block. */
  gap: 6,
  outerPadding: 0,
  /** Enough that a glyph does not touch its tile's edge. */
  glyphInset: 6,
} as const

const HISTORY_LIMIT = 100

/** A coordinate's value, with the rim answered without being stored. */
const coordinateValue = (values: Record<string, number>, id: string): number =>
  id === X_MIN || id === Y_MIN ? 0 : id === X_MAX || id === Y_MAX ? 1 : (values[id] ?? 0)

/**
 * Whether a mosaic already has this spacing.
 *
 * Asking for what is already there is not a change, and must not look like one:
 * a slider pressed and released without moving, or a number field opened and
 * left alone, would otherwise put an empty entry in the undo history.
 */
function sameSpacing(
  state: MosaicState | undefined,
  next: { gap: number; outerPadding: number; glyphInset: number },
): boolean {
  return (
    state?.gap === next.gap &&
    state.outerPadding === next.outerPadding &&
    state.glyphInset === next.glyphInset
  )
}

interface HistoryEntry {
  label: string
  doc: TextShaperDocument
  selection: string[]
}

export interface DocumentState {
  doc: TextShaperDocument
  selection: string[]
  past: HistoryEntry[]
  future: HistoryEntry[]
  /**
   * The document as it stood at the last commit.
   *
   * Mutations are applied immediately (so a gesture can stream updates and stay
   * responsive) but `commit` needs to record the state from BEFORE the change.
   * Holding that baseline is what lets callers write "mutate freely, then
   * commit once" without the store having to intercept every write.
   */
  baseline: { doc: TextShaperDocument; selection: string[] }
  /** Non-blocking per-object warnings, keyed by object id. */
  warnings: Record<string, string>

  /* --- history --- */
  commit: (label: string) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  /* --- objects --- */
  createObjectFromStroke: (stroke: Extract<StrokeToShapeResult, { ok: true }>) => string
  /** Create a shape from geometry that did not come from a brush stroke. */
  createObjectFromGeometry: (geometry: {
    /**
     * True for a drawn LINE — something to write along rather than to fill.
     *
     * Passed in rather than read off the geometry, and it decides `fittingMode`
     * here and nowhere else. Derived at read time instead, a closed pen path
     * would report a container while its mode said it had none, and closing a
     * path by dragging one node onto another would change what the object is
     * halfway through a drag.
     *
     * REQUIRED, and not for tidiness. It replaced an earlier discriminator that
     * a caller could simply not pass, and one of them stopped passing anything:
     * every line the line tool drew came out a filled shape, silently, because
     * the default was the other answer. A caller that must say which it means
     * cannot forget to.
     */
    open: boolean
    pathData: PathData
    /**
     * The same geometry as editable nodes, when there is anything worth editing.
     *
     * Absent for a primitive: an ellipse is a preset, not a drawing, and giving
     * it four draggable nodes would be offering an edit the tool does not mean.
     */
    outline?: PathOutline
    localBounds: Rect
    artboardCenter: Vec2
    name?: string
  }) => string
  /**
   * The one way an object's geometry changes after it exists.
   *
   * An object carries its shape twice: `currentSourcePath`, which every
   * downstream reader consumes, and `outline`, the nodes the editor takes hold
   * of. Written apart, they drift — and the drift is silent until someone drags
   * a handle and the shape jumps back to whatever the stale list said.
   *
   * So they are written together, always, here. `also` is for what a caller
   * changes ALONGSIDE the geometry — a grid edit's dividers — and its type
   * excludes every geometry field, so routing one round the side is a compile
   * error rather than a bug found months later.
   *
   * `outline: null` is a real answer, not an omission: it says this geometry is
   * no longer worth editing by node. The grid's edge editing says exactly that.
   */
  setGeometry: (
    id: string,
    geometry: { path: PathData; outline: PathOutline | null },
    also?: Omit<
      Partial<TypographyObject>,
      'currentSourcePath' | 'simplifiedRenderPath' | 'localBounds' | 'geometryRevision' | 'outline'
    >,
  ) => void
  /**
   * Fold a resize or rotation into the outline itself and clear the transform.
   *
   * The text is then re-fitted to the shape it has actually become, instead of
   * being stretched along with it as part of one picture.
   */
  bakeTransform: (id: string, applied: { scaleX: number; scaleY: number; rotation: number; flipX: boolean; flipY: boolean }) => void
  /**
   * Change what every object has, whatever kind it is.
   *
   * Name, placement, visibility, lock. These belong to `DocumentObjectBase`, so
   * the systems that use them — the layers panel, the canvas, the transform
   * sync — do not care what kind of object they are holding and must not have
   * to. `updateObject` is the typography-only counterpart, and routing a
   * transform through it dropped every drag of a mosaic on the floor: the write
   * was refused and the next redraw put the object back where it started.
   */
  setBase: (id: string, patch: Partial<Omit<DocumentObjectBase, 'id'>>) => void
  /** Typography's own settings. See `updateMosaic` for the other kind. */
  updateObject: (id: string, patch: Partial<TypographyObject>) => void
  updateMosaic: (id: string, patch: Partial<LetterMosaicObject>) => void
  /**
   * The one way a mosaic's three spacing values change.
   *
   * Clamped on the way in, so a document can never hold a gap wider than its own
   * tiles. The panel's sliders are already ranged to the legal maxima, so this
   * should never actually bite there — it is for a pasted or hand-edited
   * document, and for the numeric field, where anything at all can be typed.
   */
  setMosaicSpacing: (
    id: string,
    patch: Partial<MosaicSpacing>,
    stateIndex?: number,
  ) => void
  /**
   * The corner radii of one state, with the same follow rule as spacing.
   *
   * A patch: a field left out is not written. Nothing is clamped against the
   * layout because nothing here enters it — a radius too large for its tile is
   * fitted when it is drawn, so the number asked for survives a tile that grows.
   */
  /**
   * What is written in a mosaic, in one state, with the same follow rule as
   * everything else a state holds.
   *
   * The whole map at once rather than one tile, because that is what the typing
   * functions produce — they answer "here are the letters now", and splitting
   * that back into per-tile writes would only invite the two to disagree.
   */
  setMosaicChars: (id: string, stateIndex: number, chars: Record<string, string>) => void
  setMosaicCorners: (
    id: string,
    patch: Partial<MosaicCorners>,
    stateIndex?: number,
  ) => void
  /** The typeface for one state. Not interpolated — a font change is a cut. */
  setMosaicFont: (id: string, font: FontSettings, stateIndex?: number) => void

  /* --- mosaic colour --- */

  /**
   * The colour of the letters in the named tiles, in one state.
   *
   * Focused deliberately: it touches one map, in one state, for the tiles asked
   * about, and nothing else. A generic update that rewrote a whole state would
   * be free to carry a neighbouring property along with it, which is how a
   * colour change quietly loses somebody's spacing.
   *
   * Kept even for a tile with no letter in it, so typing into that tile later
   * finds the colour already chosen for it.
   */
  setMosaicGlyphColour: (
    id: string,
    stateIndex: number,
    leafIds: readonly string[],
    colour: Paint,
  ) => void
  /**
   * The colour behind the named tiles, in one state. Null clears it.
   *
   * Null means no background was authored — not black, not white, and not a
   * transparent black, which is what would make a fade pick up a dark edge.
   */
  setMosaicTileColour: (
    id: string,
    stateIndex: number,
    leafIds: readonly string[],
    colour: Paint | null,
  ) => void
  /**
   * The colour behind the WHOLE mosaic, in one state. Null clears it.
   *
   * One value, not a map: the backdrop fills the outer padding and the gaps
   * between tiles, which no tile owns. Null means no backdrop was authored — the
   * same distinction a tile background makes, and for the same reason.
   */
  setMosaicBackground: (id: string, stateIndex: number, colour: Paint | null) => void
  /**
   * The border on one state's silhouette; null removes it.
   *
   * Follows the same rules as the backdrop it sits beside — carried forward
   * through the states that are still copies, and a no-op when it lands back
   * where it started so an undo entry is never spent on nothing.
   */
  setMosaicStroke: (id: string, stateIndex: number, stroke: PositionedStroke | null) => void

  /* --- frames --- */

  /**
   * A frame, drawn empty at the given box.
   *
   * Empty on purpose: you draw a place and then put things in it, the way the
   * mosaic tool drags out a grid before anything is written in it. Two states,
   * identical, so it is already a timeline with nothing happening on it yet.
   */
  createFrame: (input: { box: Rect; artboardCenter: Vec2 }) => string
  /**
   * Move a top-level object INTO a frame, at the place it already occupies.
   *
   * Structural: it joins every state, at the transform it currently has, so
   * dropping something in changes nothing about how the artwork looks — the
   * frame simply starts carrying it. To make it arrive later, fade it in.
   *
   * Returns false when there was nothing to move.
   */
  addToFrame: (frameId: string, objectIds: readonly string[]) => boolean
  /**
   * Delete members outright — they leave the document, not just the frame.
   *
   * Distinct from `removeFromFrame`, which hands them back to the artboard.
   * Delete means delete, and inside a frame the thing being deleted is the
   * member you picked, never the frame around it.
   */
  deleteFrameMembers: (frameId: string, memberIds: readonly string[]) => boolean
  /**
   * Take a member back out, at wherever the SHOWN state has it standing.
   *
   * Deliberately not something a drag does. A member dragged outside the bounds
   * is how a slide-in reveal is authored, so that gesture stays a move; leaving
   * a frame is asked for explicitly or it would happen by accident every time
   * somebody built a wipe.
   */
  removeFromFrame: (frameId: string, memberIds: readonly string[], stateIndex: number) => boolean
  /**
   * A copy of one member, inside the same frame.
   *
   * Structural, like joining: the copy exists in EVERY state, at whatever the
   * original has there — so a duplicate of a member that already animates
   * arrives animating with it, rather than sitting still until each state is
   * visited. Fresh ids throughout, or the two would read each other's values.
   *
   * Returns the new member's id, for the caller to pick up and drag.
   */
  duplicateFrameMember: (frameId: string, memberId: string) => string | null
  /**
   * What one state says about one member — merged into that state's own patch,
   * two levels deep, and written to that state alone. A state is a thing you
   * arranged, not a thing that inherits from its neighbours.
   */
  setMemberValues: (
    frameId: string,
    stateIndex: number,
    memberId: string,
    patch: Partial<MemberValues>,
  ) => void
  /** Whether the bounds cut what is inside. Off is a place; on is a window. */
  setFrameClip: (id: string, clip: boolean) => void
  /** A rate on the whole timeline. Never rewrites a state's own timing. */
  setFrameSpeed: (id: string, speed: number) => void
  /** A copy of one state, inserted after it. Null when the frame is at its limit. */
  duplicateFrameState: (id: string, index: number) => number | null
  /** Take one away, keeping at least two. Returns the nearest survivor, or null. */
  deleteFrameState: (id: string, index: number) => number | null
  setFrameStateTiming: (
    id: string,
    index: number,
    patch: { holdMs?: number; transitionMs?: number },
  ) => void
  setFrameStateEasing: (id: string, index: number, easing: Easing) => void
  /**
   * The colour behind everything in one state, or null for none.
   *
   * Per state, so it animates like any other colour — and set on that state
   * alone, the rule every other frame edit follows.
   */
  setFrameStateBackground: (id: string, index: number, background: Paint | null) => void
  /** The backdrop of every state of any object with states, at once. */
  setStatedBackground: (id: string, background: Paint | null) => void
  /** Move a state to another slot. False when nothing changed. */
  moveFrameState: (id: string, from: number, to: number) => boolean
  /**
   * Copy what one state says about a member into every other state — or, with
   * no member named, what it says about all of them. The escape hatch from
   * "an edit lands on one state": author it once, then push it everywhere.
   */
  applyFrameStateToAll: (id: string, index: number, memberId?: string) => boolean
  /**
   * Forget what one state says about a member — or about all of them — so it
   * follows the member's own values again. What undoes a frozen state, and
   * what says "this one is like the shape" after a change of mind.
   */
  resetFrameStateToMember: (id: string, index: number, memberId?: string) => boolean
  /** The grid a dragged line lands on, in object-local units. Zero drags freely. */
  setMosaicSnap: (id: string, step: number) => void

  /* --- mosaic states --- */

  /**
   * A copy of one state, inserted immediately after it.
   *
   * Copied rather than seeded, so adding a state never makes the mosaic jump:
   * the new one looks exactly like the one before it until somebody moves it.
   * Returns the index of the state that was made, or null when the mosaic is
   * already at its limit.
   */
  addMosaicState: (id: string, after: number) => number | null
  /** The same operation, under the name people reach for. */
  duplicateMosaicState: (id: string, index: number) => number | null
  /**
   * Take a state away, keeping at least two.
   *
   * Returns the index to look at afterwards — the nearest survivor — or null
   * when nothing was removed.
   */
  deleteMosaicState: (id: string, index: number) => number | null
  /**
   * Move a state to another position in the sequence.
   *
   * The order IS the animation, so this is the one mosaic edit that changes
   * what plays without changing any composition: every state keeps its own
   * lines, colours, letters and timing, and only the route between them moves.
   *
   * Returns false when nothing moved, so a drag that ends where it began does
   * not put an entry in the undo history.
   */
  moveMosaicState: (id: string, from: number, to: number) => boolean
  /**
   * Grow or shrink the timeline from its END.
   *
   * Deliberately not the same as adding after the current state: growing the
   * count appends, and each new state copies the state that was last at the
   * time, never whatever happens to be selected in the middle.
   */
  setMosaicStateCount: (id: string, count: number) => boolean
  setMosaicStateTiming: (
    id: string,
    index: number,
    patch: { holdMs?: number; transitionMs?: number },
  ) => void
  setMosaicEasing: (id: string, index: number, easing: MosaicEasing) => void
  setMosaicSpeed: (id: string, speed: number) => void
  /**
   * Unify the lines that hold the same value, so they move together again.
   *
   * The inverse of `forkMosaicCoordinate`, run at the end of a drag. Nothing
   * moves — two coordinates with one value describe the same layout either way —
   * so this is safe to attempt after every gesture, and returns false when it
   * found nothing to join.
   */
  mergeMosaicCoordinates: (id: string, axis: 'x' | 'y', only?: ReadonlySet<string>) => boolean
  /**
   * Put a mosaic back to the grid it was made as.
   *
   * Not an evening-out of the lines that exist now: dragging forks them, so a
   * reshaped mosaic holds coordinates its seed never had, and spreading those
   * evenly would give a tidy mosaic that is not the one that was made. This
   * rebuilds from `seed`, which drops every fork by construction.
   *
   * Letters travel in reading order and tile ids come with them, so the caret,
   * the selection and any colour keyed by tile id survive. Returns false when
   * the mosaic is already the grid it was seeded as.
   */
  /**
   * Put ONE state's lines back on the grid the mosaic was made as.
   *
   * A tool rather than an erasing agent: topology and every other state are left
   * exactly as they are, so this is usable while animating. Refuses when a split
   * tile means a line cannot reach a seeded position without collapsing
   * something, and when the state is already there.
   */
  resetMosaicGrid: (id: string, stateIndex?: number) => boolean
  /**
   * Recreate the seeded structure itself, across every state.
   *
   * The destructive sibling: it mints new coordinates, so every state has to be
   * given the new set, and any authored animation is flattened. Characters
   * travel in reading order and are never silently dropped. Ask before calling.
   */
  rebuildMosaicGrid: (id: string) => boolean
  /**
   * Change how many cells the grid has, keeping the letters.
   *
   * Global, not per state: which tiles exist is what every state shares, and a
   * state with its own tile set could not be interpolated with its neighbours —
   * there would be no correspondence between their letters to blend. Positions
   * on an axis whose count is unchanged are carried across per state, so
   * resizing the columns leaves the rows' animation alone.
   */
  resizeMosaicGrid: (id: string, columns: number, rows: number) => boolean
  /**
   * One split's proportions, in the state on show.
   *
   * What a boundary drag writes, many times a second, without committing. The
   * shares arrive already clamped — `sharesForDrag` owns that, because the legal
   * range depends on geometry the store has no business computing — and a write
   * that changes nothing is dropped so a gesture that ends where it began leaves
   * no mark on the history.
   */
  /**
   * Where one line sits, in the state on show.
   *
   * What a drag writes, many times a second, without committing. The value
   * arrives already clamped — `moveEdge` owns that, because the legal range
   * depends on geometry the store has no business computing — and a write that
   * changes nothing is dropped so a gesture that ends where it began leaves no
   * mark on the history.
   */
  setMosaicCoordinates: (
    id: string,
    axis: 'x' | 'y',
    updates: readonly { id: string; value: number }[],
    stateIndex?: number,
  ) => void
  /**
   * Pull a line apart from the tiles that share it.
   *
   * Alignment is the default and should be: tiles reading the same number stay
   * in line. This is how a selection stops being aligned — a new line at the
   * same place, with only the selected tiles repointed at it. Returns false when
   * a tile straddles the selection, which is the one case that cannot be done
   * without tearing something.
   */
  forkMosaicCoordinate: (
    id: string,
    axis: 'x' | 'y',
    coordinate: string,
    /**
     * The runs along the other axis that the selection covers — a LIST, because
     * a selection can have holes and a bounding range would detach the line for
     * the tiles sitting in them too.
     */
    spans: Span | readonly Span[],
    stateIndex?: number,
  ) => boolean
  /**
   * Cut a tile in two, or take an empty one away.
   *
   * Both reach EVERY state, not just the one on show. A state says where the
   * lines of a given set of tiles sit, so tiles that changed under one state and
   * not another would leave the others describing a mosaic that no longer
   * exists. There is one state today; this is what makes that stay true when
   * there are several.
   */
  splitMosaicTile: (id: string, tile: string, axis: 'x' | 'y', stateIndex?: number) => string | null
  /** Returns the tile that took the space, for the caret to follow. */
  removeMosaicTile: (id: string, tile: string) => string | null
  /* --- meshes --- */

  /** A new mesh, seeded as a regular `columns × rows` grid of free corners. */
  createMesh: (input: {
    columns: number
    rows: number
    artboardCenter: { x: number; y: number }
    text?: string
  }) => string
  /**
   * Move nodes in one state. Carried forward through the states that are still
   * copies, like a mosaic's lines; a write that moves nothing leaves no mark.
   * The object's bounds follow, so a node can leave the box it was seeded in.
   */
  setMeshNodes: (
    id: string,
    stateIndex: number,
    updates: readonly { id: string; at: { x: number; y: number } }[],
  ) => void
  /** The mesh's lines as artwork, per state, carried forward like its border. */
  setMeshLines: (id: string, stateIndex: number, lines: Stroke | null) => void
  /** What the backdrop, clip and border follow: the whole box, or the rim. */
  setMeshBackdrop: (id: string, backdrop: MeshBackdrop) => void
  /** Reseed as a fresh grid; letters and colours carry in reading order. */
  resizeMeshGrid: (id: string, columns: number, rows: number) => boolean
  /** Rebuild every state as the seed grid — the mesh's `rebuildMosaicGrid`. */
  rebuildMeshGrid: (id: string) => boolean
  /**
   * One state's nodes back on the plain grid its tiles still form, the
   * other states untouched and its copies following. False when the tiles
   * no longer form a grid (a cut, an extrusion) — Rebuild is the way then.
   */
  resetMeshGrid: (id: string, stateIndex?: number) => boolean
  /** A point on an edge, in every state at the same fraction. Returns its id. */
  addMeshPoint: (id: string, edge: readonly [string, string], t: number) => string | null
  /** A bend point taken out of every ring and every state. */
  removeMeshPoint: (id: string, nodeId: string) => boolean
  /** A tile in two along a line between two of its edges. Returns the new tile's id. */
  cutMeshTile: (
    id: string,
    tileId: string,
    entry: { edge: readonly [string, string]; t: number },
    exit: { edge: readonly [string, string]; t: number },
  ) => string | null
  /** A new empty tile grown out of a rim edge by a drag read in the edited state. Returns its id. */
  extrudeMeshEdge: (
    id: string,
    edge: readonly [string, string],
    delta: { x: number; y: number },
    stateIndex: number,
  ) => string | null
  /** Tiles gone, holes allowed; the last tile stays. */
  removeMeshTiles: (id: string, tileIds: readonly string[]) => boolean
  /**
   * A mosaic becomes a mesh in its place: the same picture, every corner now a
   * node. The mosaic is gone; undo brings it back. Returns the mesh's id.
   */
  convertMosaicToMesh: (id: string) => string | null

  /** A new letter mosaic, seeded as a regular `columns × rows` grid. */
  createMosaic: (input: {
    columns: number
    rows: number
    artboardCenter: Vec2
    /** Filled into the leaves in reading order; the rest stay empty. */
    text?: string
  }) => string
  deleteObjects: (ids: string[]) => void
  /**
   * The colour behind everything.
   *
   * The canvas is endless, so this is the whole surface rather than a page
   * within it — there is no rectangle to fall off. It lives in the document
   * because it is part of the drawing, not a preference: two documents can want
   * different grounds, and export has to know which.
   */
  setArtboardBackground: (colour: ColorValue) => void
  duplicateObjects: (ids: string[]) => string[]
  /**
   * Copies placed exactly on top of their sources, leaving the selection alone.
   *
   * For Alt-drag, which needs the copy to stay behind while the object under the
   * pointer keeps being dragged. Does not commit: the copy belongs in the same
   * history entry as the move that made it.
   */
  duplicateInPlace: (ids: string[]) => string[]
  /**
   * Objects from the clipboard, put into the document with ids of their own.
   *
   * Takes the objects rather than their ids, because what was copied may since
   * have been deleted — a clipboard of ids would paste nothing exactly when it
   * was most wanted.
   */
  pasteObjects: (sources: readonly DocumentObject[], assets?: Readonly<Record<string, ImageAsset>>) => string[]
  /**
   * Part of a shape's appearance, onto the object — or, inside a frame, onto
   * the shown state's patch for the member, and only the field given.
   */
  setAppearancePatch: (
    id: string,
    patch: Partial<AppearanceSettings>,
    member?: { frameId: string; memberId: string; at: number },
  ) => void
  /** Change the crop of the picture a target holds, through `change`; nothing if it holds no picture. */
  editPaintCrop: (target: CropTarget, change: (crop: ImageCrop) => ImageCrop) => void
  /** Keep a picture, by its content id; the same picture twice is one asset. Returns the id. */
  addAsset: (asset: ImageAsset) => string
  /** Drop every picture nothing refers to any more. */
  sweepAssets: () => void
  reorderObject: (id: string, toIndex: number) => void
  /**
   * Move some objects through the stack together, keeping their order among
   * themselves: to the very front or back, or one step past the nearest
   * object that is not one of them. Nothing changes when they are there
   * already.
   */
  reorderObjects: (ids: readonly string[], to: 'front' | 'back' | 'forward' | 'backward') => void
  /**
   * The same move among a frame's members: their order in the list is their
   * order on the canvas, last on top, as `objectOrder` is for the artboard.
   */
  reorderFrameMembers: (frameId: string, memberIds: readonly string[], to: Stacking) => void
  renameObject: (id: string, name: string) => void
  setVisible: (id: string, visible: boolean) => void
  setLocked: (id: string, locked: boolean) => void

  /* --- text grid --- */
  addDivider: (id: string, divider: GridDivider) => void
  updateDivider: (id: string, dividerId: string, points: Vec2[]) => void
  removeDivider: (id: string, dividerId: string) => void
  clearGrid: (id: string) => void

  /* --- selection --- */
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  clearSelection: () => void

  /* --- document --- */
  setDocumentName: (name: string) => void
  loadDocument: (doc: TextShaperDocument) => void
  resetDocument: () => void
  setWarning: (id: string, message: string | null) => void
}

/**
 * History model: snapshot on explicit commit.
 *
 * Entries are pushed only by an explicit `commit(label)` call, never by a
 * middleware watching every mutation. That is what makes "one brush gesture =
 * one history entry" fall out naturally — a drag streams updates into the store
 * with no commit, and `commit()` fires once on pointer release.
 *
 * Snapshots rather than patches: documents are small (paths are strings), and
 * correctness matters more than memory here. Because every mutation replaces
 * only the objects it touches, unchanged objects are shared by reference
 * between snapshots rather than copied.
 */
/**
 * The later states that are still copies of this one, and so follow it.
 *
 * A state nobody has authored is not a composition, it is a placeholder — three
 * identical states are what a new mosaic has, and they exist so there is a
 * timeline to work on, not because anybody chose them. Editing the first one and
 * leaving the rest behind would invent movement out of nothing: the mosaic would
 * start animating the moment it was first touched, between a composition
 * somebody made and two nobody did.
 *
 * So an edit carries forward through every following state that still matches,
 * and stops at the first that does not. Once a state differs it has been
 * authored, and neither it nor anything after it is anyone's to rewrite.
 */
/** A mesh with new nodes and rings, in the document; its bounds follow. */
function reshapeMesh(doc: TextShaperDocument, id: string, shape: MeshShape): TextShaperDocument {
  const object = doc.objects[id]
  if (!object || object.kind !== 'mesh') return doc
  return {
    ...doc,
    objects: {
      ...doc.objects,
      [id]: {
        ...object,
        nodes: shape.nodes,
        tiles: shape.tiles,
        states: shape.states,
        localBounds: meshBounds(shape.states),
      },
    },
  }
}

function followersOf(object: Tiled, at: number): number[] {
  const states = tiledStates(object)
  const source = states[at]
  if (!source) return []
  const out: number[] = []
  for (let next = at + 1; next < states.length; next++) {
    const candidate = states[next]
    if (!candidate || !samePictureOf(object)(candidate, source)) break
    out.push(next)
  }
  return out
}

/** One state of a tiled object, whichever kind: the fields both kinds share are what the shared actions write. */
type TiledState = MosaicState | MeshState

/** The states as an array the shared actions can write into — a copy. */
function tiledStates(object: Tiled): TiledState[] {
  return [...(object.states as TiledState[])]
}

/**
 * The object with new states. The one cast in the file: the shared actions
 * write only fields both kinds have, so the states still match the object's
 * kind, which the type system cannot see across the union.
 */
function withStates(object: Tiled, states: TiledState[]): Tiled {
  return { ...object, states } as Tiled
}

/** "Do these two states look the same", for whichever kind the object is. */
function samePictureOf(object: Tiled): (a: TiledState, b: TiledState) => boolean {
  return object.kind === 'mesh'
    ? (a, b) => sameMeshGeometry(a as MeshState, b as MeshState)
    : (a, b) => sameGeometry(a as MosaicState, b as MosaicState)
}

/** A state copied for a new one, whichever kind. */
function copyStateOf(object: Tiled, state: TiledState): TiledState {
  return object.kind === 'mesh' ? copyMeshState(state as MeshState) : copyState(state as MosaicState)
}

/**
 * Change one object wherever it lives — on the artboard, or inside a frame.
 *
 * A frame's members are objects in every sense except that they are not in
 * `doc.objects`: they belong to the frame, which is what makes membership
 * structural. So every editor that reaches for an object by id — the colour
 * fields, the run controls, the text area — would have found nothing once that
 * object was dropped into a frame, and the panel would have gone quietly inert.
 *
 * Rather than teach each of them about frames, the LOOKUP learns it once. A
 * member's structure is shared by every state, which is exactly what this
 * writes to; where a state has its own answer — a transform, an opacity — the
 * state's value wins at render time and this never sees it.
 */
function editObject(
  doc: TextShaperDocument,
  id: string,
  change: (object: DocumentObject) => DocumentObject,
): TextShaperDocument {
  const top = doc.objects[id]
  if (top) {
    const next = change(top)
    return next === top ? doc : { ...doc, objects: { ...doc.objects, [id]: next } }
  }

  const found = locateMember(doc, id)
  if (!found) return doc

  const frame = doc.objects[found.frameId] as FrameObject
  const member = frame.members[found.at] as (typeof frame.members)[number]
  const next = change(member.object)
  if (next === member.object) return doc
  const members = [...frame.members]
  members[found.at] = { ...member, object: next }
  return { ...doc, objects: { ...doc.objects, [found.frameId]: { ...frame, members } } }
}

/**
 * Which frame holds the object with this id, and where in it.
 *
 * The one place that knows members are not in `doc.objects`. Reading and writing
 * both need it, and they were taught separately: `editObject` learned to find a
 * member, `typographyById` did not — so a colour picker could read nothing,
 * bail out before writing, and leave the shape its old colour with no error
 * anywhere. Every read-before-write control in the panel went the same way,
 * because they all reach for the object first to merge onto what the store holds
 * rather than onto what their render saw.
 */
function locateMember(
  doc: TextShaperDocument,
  id: string,
): { frameId: string; at: number } | null {
  for (const frameId of doc.objectOrder) {
    const frame = doc.objects[frameId]
    if (!frame || frame.kind !== 'frame') continue
    const at = frame.members.findIndex((member) => member.object.id === id)
    if (at !== -1) return { frameId, at }
  }
  return null
}

/**
 * An object by id, wherever it lives — on the artboard or inside a frame.
 *
 * The read half of `editObject`, sharing its locator so the two cannot drift
 * apart again.
 */
export function objectById(doc: TextShaperDocument, id: string): DocumentObject | undefined {
  const top = doc.objects[id]
  if (top) return top
  const found = locateMember(doc, id)
  if (!found) return undefined
  const frame = doc.objects[found.frameId] as FrameObject
  return frame.members[found.at]?.object
}

export const useDocumentStore = create<DocumentState>()((set, get) => {
  /**
   * Apply a document mutation without touching history.
   *
   * A mutation that hands back the document it was given changed nothing, and
   * must leave the document's IDENTITY alone as well as its contents. `commit`
   * decides whether there is anything to record by comparing references, so
   * stamping `updatedAt` on a refused write was enough to put an empty entry in
   * the undo stack — and every guard clause in this store ends in `return doc`.
   * A slider clicked and not moved is the everyday version of that.
   */
  const mutate = (fn: (doc: TextShaperDocument) => TextShaperDocument): void => {
    set((state) => {
      const next = fn(state.doc)
      if (next === state.doc) return {}
      return { doc: { ...next, updatedAt: new Date().toISOString() } }
    })
  }

  /**
   * One colour map, in one state, for a set of tiles.
   *
   * Both colour actions are the same write with a different key, so they are the
   * same function — two copies would be two places for the no-op check and the
   * carry-forward rule to drift apart.
   *
   * Ignores tiles, states and mosaics that are not there rather than throwing: the
   * selection is ephemeral and can name a tile that a topology change has just
   * taken away.
   */
  /**
   * Put copies of some objects into the document, with ids of their own.
   *
   * The one place that knows how to copy an object, because there are now three
   * ways to ask for one — Duplicate, Paste, and Alt-drag — and they differ only
   * in where the copy lands, what it is called and whether it becomes the
   * selection. Three implementations of the mosaic id remapping below would be
   * three chances to forget it.
   *
   * `above` inserts each copy directly over its source, which is where a
   * duplicate is expected; a paste has no source in the document to sit above,
   * so it goes on top of everything.
   *
   * Does NOT commit. Every caller either commits itself or is part of a larger
   * gesture that will.
   */
  function placeCopies(
    sources: readonly DocumentObject[],
    options: { offset: number; rename: boolean; select: boolean; above: boolean },
  ): string[] {
    const doc = get().doc
    const created: string[] = []
    const objects = { ...doc.objects }
    const order = [...doc.objectOrder]

    for (const source of sources) {
      const newId = createId()
      const placed = {
        x: source.transform.x + options.offset,
        y: source.transform.y + options.offset,
      }
      const name = options.rename ? `${source.name} copy` : source.name
      objects[newId] =
        source.kind === 'mosaic'
          ? {
              ...source,
              id: newId,
              name,
              transform: { ...source.transform, ...placed },
              /*
               * Fresh ids throughout, not a deep copy. Ids are unique across the
               * document and every state keys its proportions and colours by
               * them, so two mosaics sharing ids would read each other's
               * entries.
               */
              ...copyMosaicIdentity(source.tiles, source.states),
            }
          : source.kind === 'mesh'
            ? {
                ...source,
                id: newId,
                name,
                transform: { ...source.transform, ...placed },
                // Fresh node and tile ids, for the reason a mosaic's tiles get them.
                ...copyMeshIdentity(source.nodes, source.tiles, source.states),
              }
          : source.kind === 'frame'
            ? {
                ...source,
                id: newId,
                name,
                transform: { ...source.transform, ...placed },
                /*
                 * Fresh member ids, for the reason a mosaic gets fresh tile ids:
                 * every state keys its values by them, so two frames sharing ids
                 * would read each other's arrangements.
                 */
                ...copyFrameIdentity(source.members, source.states),
              }
            : {
                ...source,
                id: newId,
                name,
                seed: createSeed(),
                transform: { ...source.transform, ...placed },
              }

      const index = options.above ? order.indexOf(source.id) : -1
      if (index === -1) order.push(newId)
      else order.splice(index + 1, 0, newId)
      created.push(newId)
    }

    if (created.length === 0) return []
    set((state) => ({
      doc: { ...state.doc, objects, objectOrder: order, updatedAt: new Date().toISOString() },
      ...(options.select ? { selection: created } : {}),
    }))
    return created
  }

  function writeColour(
    id: string,
    stateIndex: number,
    leafIds: readonly string[],
    key: 'glyphColour' | 'tileColour',
    colour: Paint | null,
  ): void {
    if (leafIds.length === 0) return
    mutate((doc) => {
      const object = doc.objects[id]
      if (!object || !isTiled(object)) return doc
      const at = object.states[stateIndex] ? stateIndex : 0
      const state = tiledStates(object)[at]
      if (!state) return doc

      const known = new Set(object.tiles.map((tile) => tile.id))
      const wanted = leafIds.filter((leaf) => known.has(leaf))
      if (wanted.length === 0) return doc

      /*
       * Asking for what is already there is not a change, and must not look like
       * one: a picker that lands back where it started leaves no undo entry.
       *
       * A tile with no entry reads as `null`, which is the same answer clearing
       * gives — so clearing something that was never coloured is a no-op too.
       */
      const current = state[key] as Record<string, Paint | null>
      const changed = wanted.filter((leaf) => !samePaint(current[leaf] ?? null, colour))
      if (changed.length === 0) return doc

      /*
       * Clearing REMOVES the entry rather than writing a null over it.
       *
       * "No colour" has to have one representation. With two, a tile that was
       * cleared and one that was never coloured hold the same picture but
       * compare as different — so a state would stop counting as a copy of the
       * one before it and the follow rule would quietly stop carrying edits
       * forward. It also keeps a cleared map empty rather than a hundred nulls.
       */
      const next = { ...current }
      for (const leaf of changed) {
        if (colour === null) delete next[leaf]
        else next[leaf] = colour
      }

      const states = tiledStates(object)
      // Carried forward through the states that are still copies of this one, the
      // same way geometry, spacing and font are.
      for (const index of [at, ...followersOf(object, at)]) {
        const each = states[index]
        if (each) states[index] = { ...each, [key]: { ...next } }
      }
      return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
    })
  }

  const initial = createEmptyDocument()

  return {
    doc: initial,
    selection: [],
    past: [],
    future: [],
    baseline: { doc: initial, selection: [] },
    warnings: {},

    commit(label) {
      set((state) => {
        // Nothing actually changed since the last commit — do not litter the
        // history with empty entries (a click that starts and cancels a
        // gesture, say).
        if (state.baseline.doc === state.doc) return {}
        return {
          past: [...state.past, { label, ...state.baseline }].slice(-HISTORY_LIMIT),
          future: [],
          baseline: { doc: state.doc, selection: state.selection },
        }
      })
    },

    undo() {
      set((state) => {
        const previous = state.past[state.past.length - 1]
        if (!previous) return {}
        return {
          doc: previous.doc,
          selection: previous.selection.filter((id) => previous.doc.objects[id]),
          past: state.past.slice(0, -1),
          // Undo restores the document and selection only. Viewport and active
          // tool are deliberately never part of history — undoing should not
          // teleport the user's view or change their tool.
          future: [
            { label: previous.label, doc: state.doc, selection: state.selection },
            ...state.future,
          ].slice(0, HISTORY_LIMIT),
          baseline: { doc: previous.doc, selection: previous.selection },
        }
      })
    },

    redo() {
      set((state) => {
        const next = state.future[0]
        if (!next) return {}
        return {
          doc: next.doc,
          selection: next.selection.filter((id) => next.doc.objects[id]),
          past: [
            ...state.past,
            { label: next.label, doc: state.doc, selection: state.selection },
          ].slice(-HISTORY_LIMIT),
          future: state.future.slice(1),
          baseline: { doc: next.doc, selection: next.selection },
        }
      })
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    createObjectFromStroke(stroke) {
      return get().createObjectFromGeometry(stroke)
    },

    createObjectFromGeometry(geometry) {
      const id = createId()
      const count = get().doc.objectOrder.length + 1
      const object: TypographyObject = {
        kind: 'typography',
        id,
        name: geometry.name ?? `Shape ${count}`,
        originalSourcePath: geometry.pathData,
        currentSourcePath: geometry.pathData,
        simplifiedRenderPath: geometry.pathData,
        insetPath: null,
        localBounds: geometry.localBounds,
        geometryRevision: 1,
        transform: {
          x: geometry.artboardCenter.x,
          y: geometry.artboardCenter.y,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          flipX: false,
          flipY: false,
        },
        text: '',
        textFlowMode: 'word',
        /*
         * A LINE can only be written along, so it is put in that mode on
         * creation and the Fill control is not offered for it. A shape starts
         * where it always has.
         */
        fittingMode: geometry.open ? 'path' : 'boundary-warp',
        dividers: [],
        font: { ...documentDefaults.font },
        typography: { ...documentDefaults.typography },
        run: { ...documentDefaults.run },
        // Copied, not aliased: the caller's outline came out of a pipeline that
        // may still be holding it, and an object's geometry is its own.
        outline: geometry.outline ? copyOutline(geometry.outline) : null,
        distortion: { ...documentDefaults.distortion },
        appearance: {
          ...documentDefaults.appearance,
          // A drawn line is a guide, not artwork: no fill, which is what makes
          // the renderer draw it as the thin placeholder stroke instead.
          ...(geometry.open ? { containerFill: null } : {}),
        },
        animation: { ...documentDefaults.animation },
        seed: createSeed(),
        visible: true,
        locked: false,
      }

      set((state) => ({
        doc: {
          ...state.doc,
          objects: { ...state.doc.objects, [id]: object },
          objectOrder: [...state.doc.objectOrder, id],
          updatedAt: new Date().toISOString(),
        },
        selection: [id],
      }))
      return id
    },

    setGeometry(id, geometry, also) {
      mutate((doc) => {
        // Geometry in this sense is an outline and a node list. A mosaic's shape
        // is its partition, which is edited through its own operations.
        const current = objectById(doc, id)
        if (!current || !isTypography(current)) return doc

        // Wherever it lives: on the artboard, or inside a frame as a member's
        // own structure, which every state shares.
        const next = editObject(doc, id, (object) =>
          isTypography(object)
            ? {
                ...object,
                ...also,
                currentSourcePath: geometry.path,
                simplifiedRenderPath: geometry.path,
                localBounds: pathBounds(geometry.path),
                outline: geometry.outline,
                // The shape itself changed, so the fit has to run again.
                geometryRevision: object.geometryRevision + 1,
              }
            : object,
        )

        /*
         * A member whose TOPOLOGY changed loses every state's own nodes.
         *
         * A state's nodes are positions for the member's points, blended
         * point against point — well defined only while every state has the
         * same points. Once the member has a different number of them, the
         * old per-state lists describe a shape that no longer exists and could
         * not be blended with anything, so they are dropped and every state
         * follows the member's new shape until somebody reshapes it again.
         */
        const found = locateMember(next, id)
        if (!found) return next
        const before = current.outline
        const after = geometry.outline
        if (before && after && sameTopology(before, after)) return next
        const frame = next.objects[found.frameId] as FrameObject
        const memberId = frame.members[found.at]?.id
        if (!memberId) return next
        const states = frame.states.map((state) => {
          const values = state.values[memberId]
          if (!values?.nodes) return state
          const { nodes: _dropped, ...rest } = values
          return { ...state, values: { ...state.values, [memberId]: rest } }
        })
        return { ...next, objects: { ...next.objects, [found.frameId]: { ...frame, states } } }
      })
    },

    bakeTransform(id, applied) {
      mutate((doc) => {
        const object = doc.objects[id]
        /*
         * Typography only, and not an oversight.
         *
         * Baking folds a resize into the outline so the text is fitted again to
         * the shape it has become. A mosaic keeps its scale on the transform
         * instead, so the whole composition — tiles, gaps, glyphs — grows
         * together. See `collectTransforms`, which decides not to ask for a bake
         * in the first place.
         */
        if (!object || !isTypography(object)) return doc

        // Scale and rotation about the object's LOCAL ORIGIN, with no
        // translation: the origin is where `transform.x/y` already places the
        // shape, so folding the matrix in here leaves it exactly where it looks
        // like it is and only changes its form.
        const matrix = compose({
          x: 0,
          y: 0,
          scaleX: applied.scaleX,
          scaleY: applied.scaleY,
          rotation: applied.rotation,
          flipX: applied.flipX,
          flipY: applied.flipY,
        })

        const path = transformPathData(object.currentSourcePath, matrix)
        /*
         * The nodes go through the SAME matrix, so the two halves of the
         * geometry stay two accounts of one shape. Anchors take the whole
         * affine; handles take its linear part only, because they are measured
         * from their anchor rather than from the origin — `transformOutline`
         * draws that line, and it is why the handles are stored relative.
         */
        const outline = object.outline ? transformOutline(object.outline, matrix) : null

        // The grid is deliberately NOT transformed. Dividers live in patch
        // space, where the container is a unit square however it is stretched,
        // so "a third of the way down" survives a resize untouched — the patch
        // is simply rebuilt from the new outline. Carrying them through the
        // matrix, as they were when they held object coordinates, sent a row at
        // v = 0.5 to v = 1.0 on a shape scaled by two: resizing destroyed the
        // grid.
        const dividers = object.dividers

        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              currentSourcePath: path,
              simplifiedRenderPath: path,
              localBounds: pathBounds(path),
              outline,
              dividers,
              // The shape itself changed, so the fit has to run again.
              geometryRevision: object.geometryRevision + 1,
              transform: {
                ...object.transform,
                scaleX: 1,
                scaleY: 1,
                flipX: false,
                flipY: false,
                /*
                 * What was folded in is TAKEN OFF, rather than the whole angle
                 * being cleared.
                 *
                 * The object's appearance is its stored rotation applied on top
                 * of its geometry, so folding an angle into the geometry has to
                 * come off the stored one or the shape turns by that much the
                 * moment it is baked. Clearing it outright was the same
                 * arithmetic only when there was nothing to clear — and there
                 * usually is: `splitTransform` bakes the SCALE of a gesture and
                 * deliberately leaves its rotation on the object, so every
                 * resize of a turned shape snapped it back to square.
                 */
                rotation: object.transform.rotation - applied.rotation,
              },
            },
          },
        }
      })
    },

    setBase(id, patch) {
      mutate((doc) => editObject(doc, id, (existing) => ({ ...existing, ...patch })))
    },

    updateObject(id, patch) {
      mutate((doc) =>
        editObject(doc, id, (existing) =>
          // Typography's own settings. A mosaic is edited through the operations
          // that understand its partition; there is nothing here it shares.
          isTypography(existing) ? { ...existing, ...patch } : existing,
        ),
      )
    },

    updateMosaic(id, patch) {
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || existing.kind !== 'mosaic') return doc
        return { ...doc, objects: { ...doc.objects, [id]: { ...existing, ...patch } } }
      })
    },

    setMosaicSpacing(id, patch, stateIndex = 0) {
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || !isTiled(existing)) return doc
        if (existing.kind === 'mesh') {
          /*
           * A mesh has no content box to pad and no closed-form maxima: a tile
           * that cannot take an inset collapses in the layout instead. So the
           * two numbers are only floored at zero.
           */
          const at = existing.states[stateIndex] ? stateIndex : 0
          const state = existing.states[at]
          if (!state) return doc
          const clean = (value: number | undefined, fallback: number): number =>
            value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value)
          const settled = {
            gap: clean(patch.gap, state.gap),
            glyphInset: clean(patch.glyphInset, state.glyphInset),
            outerPadding: clean(patch.outerPadding, state.outerPadding),
          }
          if (
            settled.gap === state.gap &&
            settled.glyphInset === state.glyphInset &&
            settled.outerPadding === state.outerPadding
          ) {
            return doc
          }
          const states = [...existing.states]
          for (const index of [at, ...followersOf(existing, at)]) {
            const each = states[index]
            if (each) states[index] = { ...each, ...settled }
          }
          return { ...doc, objects: { ...doc.objects, [id]: { ...existing, states } } }
        }

        const at = existing.states[stateIndex] ? stateIndex : 0
        const state = existing.states[at]
        if (!state) return doc
        const sets = [{ x: state.x, y: state.y }]
        const { tiles, localBounds } = existing

        /*
         * All three at once is a different question from one of them.
         *
         * Setting the whole triple — what Reset does — has no neighbour to
         * protect, so it goes through the repair chain, which resolves the three
         * against each other in dependency order.
         */
        const settled =
          patch.gap !== undefined && patch.outerPadding !== undefined && patch.glyphInset !== undefined
            ? clampSpacing(tiles, sets, localBounds, {
                gap: patch.gap,
                outerPadding: patch.outerPadding,
                glyphInset: patch.glyphInset,
              })
            : /*
               * Otherwise each requested value is clamped against the OTHERS AS
               * THEY STAND, and a value that was not asked about is never
               * written.
               *
               * Running a single-field change through the repair chain instead
               * quietly rewrote its neighbours: typing an over-large gap dropped
               * the glyph inset to zero as a side effect, and Escape then put the
               * gap back while leaving the inset where the accident had left it.
               * A control may narrow another control's RANGE. It may not change
               * its value.
               */
              {
                gap:
                  patch.gap === undefined
                    ? state.gap
                    : clampTo(
                        patch.gap,
                        maximumGap(tiles, sets, localBounds, {
                          outerPadding: state.outerPadding,
                          glyphInset: state.glyphInset,
                          ...patch,
                        }),
                      ),
                outerPadding:
                  patch.outerPadding === undefined
                    ? state.outerPadding
                    : clampTo(
                        patch.outerPadding,
                        maximumOuterPadding(tiles, sets, localBounds, {
                          gap: state.gap,
                          glyphInset: state.glyphInset,
                          ...patch,
                        }),
                      ),
                glyphInset:
                  patch.glyphInset === undefined
                    ? state.glyphInset
                    : clampTo(
                        patch.glyphInset,
                        maximumGlyphInset(tiles, sets, localBounds, {
                          gap: state.gap,
                          outerPadding: state.outerPadding,
                          ...patch,
                        }),
                      ),
              }

        if (sameSpacing(state, settled)) return doc

        const states = [...existing.states]
        // The states after this one that are still copies of it come along, the
        // same way a geometry edit carries forward.
        for (const index of [at, ...followersOf(existing, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, ...settled }
        }
        return { ...doc, objects: { ...doc.objects, [id]: { ...existing, states } } }
      })
    },

    setMosaicChars(id, stateIndex, chars) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const at = object.states[stateIndex] ? stateIndex : 0
        const state = object.states[at]
        if (!state) return doc

        // Only tiles that exist, and only letters that are letters. A map
        // arriving with a key for a removed tile would keep it alive forever.
        const known = new Set(object.tiles.map((tile) => tile.id))
        const settled: Record<string, string> = {}
        for (const [tile, char] of Object.entries(chars)) {
          if (known.has(tile) && typeof char === 'string' && char !== '') settled[tile] = char
        }

        const same =
          Object.keys(settled).length === Object.keys(state.chars).length &&
          Object.entries(settled).every(([tile, char]) => state.chars[tile] === char)
        if (same) return doc

        const states = tiledStates(object)
        /*
         * Carried forward through the states that are still copies of this one.
         *
         * Which is what makes typing feel like editing the mosaic rather than
         * editing one frame of it: a word typed into a fresh mosaic appears in
         * every state, and only a state somebody has actually authored keeps its
         * own letters.
         */
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, chars: { ...settled } }
        }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
    },

    setMosaicCorners(id, patch, stateIndex = 0) {
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || !isTiled(existing)) return doc
        const at = existing.states[stateIndex] ? stateIndex : 0
        const state = existing.states[at]
        if (!state) return doc

        // Negative rounding is not a shape. Anything above the tile is fitted at
        // paint time rather than here, so growing a tile rounds it further.
        const clean = (value: number | undefined, fallback: number): number =>
          value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value)

        const settled: MosaicCorners = {
          tileRadius: clean(patch.tileRadius, state.tileRadius),
          outerRadius: clean(patch.outerRadius, state.outerRadius),
        }
        if (
          settled.tileRadius === state.tileRadius &&
          settled.outerRadius === state.outerRadius
        ) {
          return doc
        }

        const states = tiledStates(existing)
        // Carried forward through the states that are still copies of this one,
        // exactly as spacing, font and geometry are.
        for (const index of [at, ...followersOf(existing, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, ...settled }
        }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(existing, states) } }
      })
    },

    setMosaicFont(id, font, stateIndex = 0) {
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || !isTiled(existing)) return doc
        const at = existing.states[stateIndex] ? stateIndex : 0
        const state = existing.states[at]
        if (!state) return doc
        if (
          state.font.fontId === font.fontId &&
          state.font.weight === font.weight &&
          state.font.italic === font.italic
        ) {
          return doc
        }
        const states = tiledStates(existing)
        for (const index of [at, ...followersOf(existing, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, font: { ...font } }
        }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(existing, states) } }
      })
    },

    setMosaicCoordinates(id, axis, updates, stateIndex = 0) {
      if (updates.length === 0) return
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || existing.kind !== 'mosaic') return doc

        const at = existing.states[stateIndex] ? stateIndex : 0
        const state = existing.states[at]
        if (!state) return doc
        const current = axis === 'x' ? state.x : state.y

        // Asking for what is already there is not a change, and must not look
        // like one: a press that moved nothing would leave an empty undo entry.
        const changed = updates.filter((u) => current[u.id] !== u.value)
        if (changed.length === 0) return doc

        const next = { ...current }
        for (const update of changed) next[update.id] = update.value
        const states = [...existing.states]
        // The states after this one that are still copies of it come along, so a
        // mosaic does not start moving the moment it is first touched.
        for (const index of [at, ...followersOf(existing, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, [axis]: { ...next } }
        }
        return { ...doc, objects: { ...doc.objects, [id]: { ...existing, states } } }
      })
    },

    setMosaicSnap(id, step) {
      mutate((doc) => {
        const existing = doc.objects[id]
        if (!existing || !isTiled(existing)) return doc
        const snapStep = Number.isFinite(step) ? Math.max(0, step) : 0
        if (existing.snapStep === snapStep) return doc
        return { ...doc, objects: { ...doc.objects, [id]: { ...existing, snapStep } } }
      })
    },

    mergeMosaicCoordinates(id, axis, only) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return false

      // Every state, not just the one on show: two lines that coincide here but
      // part company in another state are different lines, and joining them
      // would flatten the animation between them.
      const result = mergeCoordinates(
        existing.tiles,
        existing.states.map((state) => (axis === 'x' ? state.x : state.y)),
        axis,
        only,
      )
      if (!result) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        const retired = new Set(result.retired)
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              tiles: result.tiles,
              states: object.states.map((each) => {
                const values = axis === 'x' ? each.x : each.y
                const kept: Record<string, number> = {}
                for (const [key, value] of Object.entries(values)) {
                  if (!retired.has(key)) kept[key] = value
                }
                return { ...each, [axis]: kept }
              }),
            },
          },
        }
      })
      return true
    },

    addMosaicState(id, after) {
      const existing = get().doc.objects[id]
      if (!existing || !isTiled(existing)) return null
      if (existing.states.length >= MOSAIC_MAX_STATES) return null

      const at = Math.min(Math.max(0, Math.floor(after)), existing.states.length - 1)
      const source = existing.states[at]
      if (!source) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const states = tiledStates(object)
        states.splice(at + 1, 0, copyStateOf(existing, source))
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
      return at + 1
    },

    duplicateMosaicState(id, index) {
      return get().addMosaicState(id, index)
    },

    deleteMosaicState(id, index) {
      const existing = get().doc.objects[id]
      if (!existing || !isTiled(existing)) return null
      // A timeline needs two ends. One state is a still picture, not an
      // animation, and there would be nothing for a transition to reach.
      if (existing.states.length <= MOSAIC_MIN_STATES) return null

      const at = Math.floor(index)
      if (!existing.states[at]) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const states = tiledStates(object).filter((_, position) => position !== at)
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
      // The nearest survivor: the one that slid into this slot, or the new last.
      return Math.min(at, existing.states.length - 2)
    },

    moveMosaicState(id, from, to) {
      const existing = get().doc.objects[id]
      if (!existing || !isTiled(existing)) return false

      const count = existing.states.length
      const at = Math.floor(from)
      // Clamped rather than refused: a drop past the last card means "the end",
      // which is what the pointer was saying.
      const target = clamp(Math.floor(to), 0, count - 1)
      if (!existing.states[at] || at === target) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const states = tiledStates(object)
        const [moved] = states.splice(at, 1)
        if (!moved) return doc
        states.splice(target, 0, moved)
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
      return true
    },

    setMosaicStateCount(id, count) {
      const existing = get().doc.objects[id]
      if (!existing || !isTiled(existing)) return false
      const wanted = Math.min(MOSAIC_MAX_STATES, Math.max(MOSAIC_MIN_STATES, Math.floor(count)))
      if (wanted === existing.states.length) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const states = tiledStates(object)
        /*
         * Growing appends, each new state copied from whatever is last AT THAT
         * MOMENT — so a run of new states continues the movement rather than all
         * being copies of one. Shrinking takes from the end; the caller asks
         * before calling when the states being lost hold work.
         */
        while (states.length < wanted) {
          const last = states[states.length - 1]
          if (!last) break
          states.push(copyStateOf(object, last))
        }
        if (states.length > wanted) states.length = wanted
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
      return true
    },

    setMosaicStateTiming(id, index, patch) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const at = Math.floor(index)
        const state = object.states[at]
        if (!state) return doc

        const holdMs =
          patch.holdMs === undefined
            ? state.holdMs
            : Math.max(0, Number.isFinite(patch.holdMs) ? patch.holdMs : 0)
        // A transition of zero is not a fast transition, it is a division by
        // nothing: the timeline has to place a progress inside it.
        const transitionMs =
          patch.transitionMs === undefined
            ? state.transitionMs
            : Math.max(
                MOSAIC_MIN_TRANSITION_MS,
                Number.isFinite(patch.transitionMs) ? patch.transitionMs : MOSAIC_MIN_TRANSITION_MS,
              )

        if (holdMs === state.holdMs && transitionMs === state.transitionMs) return doc
        const states = tiledStates(object)
        states[at] = { ...state, holdMs, transitionMs }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
    },

    setMosaicEasing(id, index, easing) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const at = Math.floor(index)
        const state = object.states[at]
        if (!state || state.easing === easing) return doc
        const states = tiledStates(object)
        states[at] = { ...state, easing }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
    },

    setMosaicSpeed(id, speed) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const next = Number.isFinite(speed) ? Math.min(8, Math.max(0.1, speed)) : 1
        if (object.speed === next) return doc
        // Speed is a rate, not a duration: it never rewrites a state's timing.
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, speed: next } } }
      })
    },

    setMosaicGlyphColour(id, stateIndex, leafIds, colour) {
      writeColour(id, stateIndex, leafIds, 'glyphColour', colour)
    },

    setMosaicTileColour(id, stateIndex, leafIds, colour) {
      writeColour(id, stateIndex, leafIds, 'tileColour', colour)
    },

    setMosaicBackground(id, stateIndex, colour) {
      // Through `editObject`, so a mosaic or mesh INSIDE a frame is reached
      // too: looked up at the top level only, a member's backdrop was a
      // silent no-op.
      mutate((doc) =>
        editObject(doc, id, (object) => {
          if (!isTiled(object)) return object
          const at = object.states[stateIndex] ? stateIndex : 0
          const state = object.states[at]
          if (!state) return object

          // Landing back where it started is not a change, and must not leave an
          // undo entry — the same rule the tile colours follow.
          if (samePaint(state.background ?? null, colour)) return object

          const states = tiledStates(object)
          // Carried forward through the states that are still copies of this one,
          // the same way geometry, spacing, font and the tile colours are.
          for (const index of [at, ...followersOf(object, at)]) {
            const each = states[index]
            if (each) states[index] = { ...each, background: colour }
          }
          return withStates(object, states)
        }),
      )
    },

    setMosaicStroke(id, stateIndex, stroke) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTiled(object)) return doc
        const at = object.states[stateIndex] ? stateIndex : 0
        const state = object.states[at]
        if (!state) return doc

        if (sameStroke(state.stroke ?? null, stroke)) return doc

        const states = tiledStates(object)
        // Carried forward through the states that are still copies of this one,
        // the same way the backdrop and the corners are.
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, stroke }
        }
        return { ...doc, objects: { ...doc.objects, [id]: withStates(object, states) } }
      })
    },

    /* --- frames --- */

    createFrame({ box, artboardCenter }) {
      const id = createId()
      const count = get().doc.objectOrder.length + 1
      const width = Math.max(1, box.width)
      const height = Math.max(1, box.height)

      const object: FrameObject = {
        kind: 'frame',
        id,
        name: `Frame ${count}`,
        // Centred on its own origin, like every other object.
        localBounds: { x: -width / 2, y: -height / 2, width, height },
        transform: {
          x: artboardCenter.x,
          y: artboardCenter.y,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          flipX: false,
          flipY: false,
        },
        members: [],
        /*
         * Two, identical. A timeline needs two ends, and a frame with one state
         * is a place rather than a sequence — the same reason a mosaic starts
         * with more than one.
         */
        states: [emptyState(), emptyState()],
        speed: 1,
        clip: false,
        opacity: 1,
        visible: true,
        locked: false,
      }

      mutate((doc) => ({
        ...doc,
        objects: { ...doc.objects, [id]: object },
        objectOrder: [...doc.objectOrder, id],
      }))
      set({ selection: [id] })
      return id
    },

    addToFrame(frameId, objectIds) {
      const doc = get().doc
      const frame = doc.objects[frameId]
      if (!frame || frame.kind !== 'frame') return false

      const moving = objectIds
        .map((id) => doc.objects[id])
        .filter(
          (object): object is DocumentObject =>
            Boolean(object) && object!.id !== frameId && object!.kind !== 'frame',
        )
      if (moving.length === 0) return false

      mutate((current) => {
        const target = current.objects[frameId]
        if (!target || target.kind !== 'frame') return current

        const members = [...target.members]
        for (const object of moving) {
          /*
           * The transform is rebased into the frame's own space, so the object
           * does not jump when it changes hands. Both are artboard-space today —
           * the frame is never rotated on creation — so this is a subtraction;
           * it becomes a real change of basis when a rotated frame can take
           * members, and lives here so there is one place to change.
           */
          members.push({
            id: createId(),
            object: {
              ...object,
              transform: {
                ...object.transform,
                x: object.transform.x - target.transform.x,
                y: object.transform.y - target.transform.y,
              },
            },
          })
        }

        /*
         * The states are not told. A member the states are silent about rests
         * at its own transform, which is exactly where it was just placed — so
         * dropping something in changes nothing about how the artwork looks,
         * and no state looks authored until somebody authors it.
         */
        const objects = { ...current.objects, [frameId]: { ...target, members } }
        for (const object of moving) delete objects[object.id]
        return {
          ...current,
          objects,
          objectOrder: current.objectOrder.filter((id) => !moving.some((o) => o.id === id)),
        }
      })
      set({ selection: [frameId] })
      return true
    },

    deleteFrameMembers(frameId, memberIds) {
      const frame = get().doc.objects[frameId]
      if (!frame || frame.kind !== 'frame') return false
      if (!frame.members.some((member) => memberIds.includes(member.id))) return false

      mutate((doc) => {
        const target = doc.objects[frameId]
        if (!target || target.kind !== 'frame') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [frameId]: {
              ...target,
              members: target.members.filter((member) => !memberIds.includes(member.id)),
              // Out of every state as well, or a state would keep values for
              // something that no longer exists and the next edit would read
              // them back.
              states: target.states.map((state) => {
                const values = { ...state.values }
                for (const id of memberIds) delete values[id]
                return { ...state, values }
              }),
            },
          },
        }
      })
      return true
    },

    removeFromFrame(frameId, memberIds, stateIndex) {
      const doc = get().doc
      const frame = doc.objects[frameId]
      if (!frame || frame.kind !== 'frame') return false
      const leaving = frame.members.filter((member) => memberIds.includes(member.id))
      if (leaving.length === 0) return false

      const freed: string[] = []
      mutate((current) => {
        const target = current.objects[frameId]
        if (!target || target.kind !== 'frame') return current
        const state = target.states[stateIndex] ?? target.states[0]

        const objects = { ...current.objects }
        for (const member of leaving) {
          const id = createId()
          freed.push(id)
          /*
           * As the SHOWN state has it — where it stands, and also how it looks
           * and what shape it is. That is what is on screen, and an object that
           * changed on leaving would be the frame editing something as a
           * parting gesture. Through the same function the renderer draws it
           * with, so the two cannot disagree.
           */
          objects[id] = { ...memberAsFreed(member, state, target.transform), id } as DocumentObject
        }

        objects[frameId] = {
          ...target,
          members: target.members.filter((member) => !memberIds.includes(member.id)),
          states: target.states.map((each) => {
            const values = { ...each.values }
            for (const id of memberIds) delete values[id]
            return { ...each, values }
          }),
        }
        return { ...current, objects, objectOrder: [...current.objectOrder, ...freed] }
      })
      set({ selection: freed })
      return true
    },

    setMemberValues(frameId, stateIndex, memberId, patch) {
      mutate((doc) => {
        const object = doc.objects[frameId]
        if (!object || object.kind !== 'frame') return doc
        // Past the end lands on the LAST state, the same answer every gesture
        // gives when a stale index comes in — not silently on the first.
        const at = Math.min(Math.max(0, Math.floor(stateIndex)), object.states.length - 1)
        const source = object.states[at]
        const member = object.members.find((each) => each.id === memberId)
        if (!source || !member) return doc

        /*
         * Judged by what it would DRAW, recorded as what was ASKED.
         *
         * The guard resolves both sides, so a patch that only restates what the
         * member already gives is no change. The write merges the patch into
         * the state's own patch — never into the resolved values, which is what
         * a state holds when it is a copy of the member and not a description
         * of what is different about it. Two levels: `appearance` and
         * `typeSettings` merge field by field, everything else replaces.
         */
        const own = source.values[memberId] ?? {}
        const next: MemberValues = { ...own, ...patch }
        if (patch.appearance) next.appearance = { ...own.appearance, ...patch.appearance }
        if (patch.typeSettings) next.typeSettings = { ...own.typeSettings, ...patch.typeSettings }

        // Resolved through the one resolver on both sides, so "no change" means
        // "would draw the same", whatever the patch happens to spell out.
        const written = { ...source, values: { ...source.values, [memberId]: next } }
        if (sameValues(valuesFor(member, source), valuesFor(member, written))) return doc

        /*
         * To this state and no other. An edit is an authoring of the state it
         * is made in; a state is a thing you arranged, not a thing that
         * inherits from its neighbours.
         */
        const states = [...object.states]
        states[at] = written
        return { ...doc, objects: { ...doc.objects, [frameId]: { ...object, states } } }
      })
    },

    setFrameClip(id, clip) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame' || object.clip === clip) return doc
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, clip } } }
      })
    },

    setFrameSpeed(id, speed) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const next = Number.isFinite(speed) ? Math.min(8, Math.max(0.1, speed)) : 1
        if (object.speed === next) return doc
        // A rate, not a duration: it never rewrites a state's timing.
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, speed: next } } }
      })
    },

    duplicateFrameState(id, index) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'frame') return null
      if (existing.states.length >= FRAME_MAX_STATES) return null
      const at = existing.states[index] ? Math.floor(index) : 0
      const source = existing.states[at]
      if (!source) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const states = [...object.states]
        /*
         * A deep-enough copy: the values map is rebuilt so the two states do not
         * share one, or moving a member in the copy would move it in the
         * original. The values themselves are replaced wholesale on every edit.
         */
        states.splice(at + 1, 0, {
          ...source,
          id: createId(),
          values: Object.fromEntries(
            Object.entries(source.values).map(([member, values]) => [member, { ...values }]),
          ),
        })
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
      return at + 1
    },

    deleteFrameState(id, index) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'frame') return null
      // A timeline needs two ends. One state is a picture, not an animation.
      if (existing.states.length <= FRAME_MIN_STATES) return null
      const at = Math.floor(index)
      if (!existing.states[at]) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: { ...object, states: object.states.filter((_, i) => i !== at) },
          },
        }
      })
      // The nearest survivor: the one that slid into this slot, or the new last.
      return Math.min(at, existing.states.length - 2)
    },

    moveFrameState(id, from, to) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'frame') return false

      const count = existing.states.length
      const at = Math.floor(from)
      // Clamped rather than refused: a drop past the last card means "the end",
      // which is what the pointer was saying.
      const target = clamp(Math.floor(to), 0, count - 1)
      if (!existing.states[at] || at === target) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const states = [...object.states]
        const [moved] = states.splice(at, 1)
        if (!moved) return doc
        states.splice(target, 0, moved)
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
      return true
    },

    applyFrameStateToAll(id, index, memberId) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'frame') return false
      const source = existing.states[index]
      if (!source) return false
      const members = memberId ? [memberId] : Object.keys(source.values)
      if (members.length === 0) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const states = object.states.map((state, i) => {
          if (i === index) return state
          const values = { ...state.values }
          for (const member of members) {
            const said = source.values[member]
            if (!said) continue
            /*
             * Laid OVER what the other state says, at both levels, rather than
             * replacing it — "apply this colour everywhere" must not throw away
             * a position another state authored for the same member.
             */
            const own = values[member] ?? {}
            const next = { ...own, ...said }
            if (said.appearance) next.appearance = { ...own.appearance, ...said.appearance }
            if (said.typeSettings) next.typeSettings = { ...own.typeSettings, ...said.typeSettings }
            values[member] = next
          }
          return { ...state, values }
        })
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
      return true
    },

    resetFrameStateToMember(id, index, memberId) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'frame') return false
      const state = existing.states[index]
      if (!state) return false
      const members = memberId ? [memberId] : Object.keys(state.values)
      if (!members.some((member) => state.values[member])) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const target = object.states[index]
        if (!target) return doc
        const values = { ...target.values }
        for (const member of members) delete values[member]
        const states = [...object.states]
        states[index] = { ...target, values }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
      return true
    },

    setFrameStateTiming(id, index, patch) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const at = object.states[index] ? index : 0
        const state = object.states[at]
        if (!state) return doc

        const holdMs =
          patch.holdMs === undefined
            ? state.holdMs
            : Math.max(0, Number.isFinite(patch.holdMs) ? patch.holdMs : 0)
        const transitionMs =
          patch.transitionMs === undefined
            ? state.transitionMs
            : Math.max(
                MIN_TRANSITION_MS,
                Number.isFinite(patch.transitionMs) ? patch.transitionMs : MIN_TRANSITION_MS,
              )
        if (holdMs === state.holdMs && transitionMs === state.transitionMs) return doc

        const states = [...object.states]
        states[at] = { ...state, holdMs, transitionMs }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
    },

    setFrameStateEasing(id, index, easing) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const at = object.states[index] ? index : 0
        const state = object.states[at]
        if (!state || state.easing === easing) return doc
        const states = [...object.states]
        states[at] = { ...state, easing }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
    },

    duplicateFrameMember(frameId, memberId) {
      const frame = get().doc.objects[frameId]
      if (!frame || frame.kind !== 'frame') return null
      const source = frame.members.find((each) => each.id === memberId)
      if (!source) return null

      const made: FrameMember = {
        id: createId(),
        object: { ...source.object, id: createId(), name: `${source.object.name} copy` },
      }

      mutate((doc) => {
        const object = doc.objects[frameId]
        if (!object || object.kind !== 'frame') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [frameId]: {
              ...object,
              members: [...object.members, made],
              /*
               * Into every state, carrying what the original AUTHORED there —
               * its patch, not its resolved values, so the copy keeps following
               * its own object wherever the original did. A copy that only
               * existed in one state could not be blended with its neighbours;
               * membership is structural, exactly as a mosaic's tiles are.
               */
              states: object.states.map((state) => {
                const authored = state.values[source.id]
                if (!authored) return state
                return { ...state, values: { ...state.values, [made.id]: { ...authored } } }
              }),
            },
          },
        }
      })
      return made.id
    },

    setStatedBackground(id, background) {
      // Through `editObject`, for the member inside a frame as much as the
      // object on the artboard.
      mutate((doc) =>
        editObject(doc, id, (object) => {
          if (!isStated(object)) return object
          if (object.states.every((state) => samePaint(state.background ?? null, background))) return object
          const states = object.states.map((state) => ({ ...state, background }))
          return { ...object, states } as typeof object
        }),
      )
    },

    setFrameStateBackground(id, index, background) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'frame') return doc
        const at = object.states[index] ? index : 0
        const state = object.states[at]
        if (!state || samePaint(state.background ?? null, background)) return doc

        // To this state and no other, the rule a member's values follow.
        const states = [...object.states]
        states[at] = { ...state, background }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
    },

    resetMosaicGrid(id, stateIndex = 0) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return false
      const at = existing.states[stateIndex] ? stateIndex : 0
      const state = existing.states[at]
      if (!state) return false

      /*
       * A tool, not an erasing agent.
       *
       * This puts the state you are looking at back where it started and leaves
       * everything else exactly as it is — the topology, and every other state.
       * That is what makes it usable WHILE animating: reset state 3 to the plain
       * grid and states 1 and 2 keep the compositions they were given.
       *
       * The old behaviour rebuilt the dissection from the seed, which minted new
       * coordinate ids and so forced every state to be rewritten — flattening
       * the animation. That operation still exists, under `rebuildMosaicGrid`,
       * where its cost is in its name.
       *
       * Where each line belongs is read off the TILES, not off its own number.
       * A line's home is the number of cells to its left, which the chain of
       * tiles states exactly — so a pair of forked halves, with nothing between
       * them, comes home to the one line they were forked from. Going by the
       * nearest value instead sent a fork that had been dragged past the next
       * seed position on top of its neighbour, collapsing the tile between them,
       * and the reset then had to refuse itself. See `gridRanks`.
       */
      const across = gridRanks(existing.tiles, 'x')
      const down = gridRanks(existing.tiles, 'y')
      /*
       * A SPLIT tile makes the mosaic one cell deeper than the grid it was made
       * as, and there is no honest place to send the line it added. Refused
       * rather than approximated: a reset that quietly destroyed a tile would be
       * the erasing agent this is not.
       */
      if (!across || across.get(X_MAX) !== existing.seed.columns) return false
      if (!down || down.get(Y_MAX) !== existing.seed.rows) return false

      const x: Record<string, number> = {}
      for (const key of Object.keys(state.x)) {
        const rank = across.get(key)
        if (rank === undefined) return false
        x[key] = rank / existing.seed.columns
      }
      const y: Record<string, number> = {}
      for (const key of Object.keys(state.y)) {
        const rank = down.get(key)
        if (rank === undefined) return false
        y[key] = rank / existing.seed.rows
      }

      const spacing = {
        gap: state.gap,
        outerPadding: state.outerPadding,
        glyphInset: state.glyphInset,
      }
      if (!canReshape(existing.tiles, x, y, existing.localBounds, spacing)) return false

      const already =
        Object.entries(x).every(([key, value]) => state.x[key] === value) &&
        Object.entries(y).every(([key, value]) => state.y[key] === value)
      if (already) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        const current = object.states[at]
        if (!current) return doc
        const states = [...object.states]
        /*
         * Carried forward the same way a drag is. Resetting a state and leaving
         * its untouched copies behind would invent exactly the movement this
         * rule exists to prevent — and an unauthored state is not work, so
         * nothing is lost. An authored one still stops it dead.
         */
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, x: { ...x }, y: { ...y } }
        }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
      return true
    },

    rebuildMosaicGrid(id) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return false
      return this.resizeMosaicGrid(id, existing.seed.columns, existing.seed.rows)
    },

    resizeMosaicGrid(id, columns, rows) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return false
      const state = existing.states[0]
      if (!state) return false
      const wanted = {
        columns: Math.max(1, Math.min(MOSAIC_MAX_SIDE, Math.floor(columns))),
        rows: Math.max(1, Math.min(MOSAIC_MAX_SIDE, Math.floor(rows))),
      }

      /*
       * Reading order, not the order the tiles happen to sit in the array. A
       * mosaic that has been split and reshaped has an array order that stopped
       * matching what anyone sees a long time ago, and the letters have to come
       * back where they read.
       */
      const layout = layoutMosaic(existing.tiles, state.x, state.y, existing.localBounds, {
        gap: state.gap,
        outerPadding: state.outerPadding,
        glyphInset: state.glyphInset,
      })
      const byId = new Map(existing.tiles.map((tile) => [tile.id, tile]))
      const ordered = readingOrder(layout)
        .map((tileId) => byId.get(tileId))
        .filter((tile): tile is MosaicTile => tile !== undefined)
      // Anything the layout could not place still deserves its letter carried.
      for (const tile of existing.tiles) if (!ordered.includes(tile)) ordered.push(tile)

      const result = reseedMosaic(ordered, wanted.columns, wanted.rows)

      /*
       * Per-state line positions, carried across on an axis that did not change.
       *
       * Reseeding mints new coordinate ids, so a state's numbers cannot simply
       * be kept — but they can be MATCHED, by how many cells lie to a line's
       * left. Resizing the columns has nothing to say about the rows, and
       * flattening them too would throw away half an animation for no reason.
       *
       * Null when the values cannot be matched honestly: a different number of
       * lines on that axis, or a tile that has been split, which makes the chain
       * deeper than any seeded grid and leaves a line with no rank to come home
       * to. Then the fresh even positions are the only truthful answer.
       */
      /*
       * The seeded values WITHOUT the rim.
       *
       * `reseedMosaic` reports every line including the mosaic's own edges; a
       * state stores only the interior ones, because the rim is the object's box
       * and belongs to the object. `initialState` is what draws that line, so it
       * is what says which values a state may hold.
       */
      const fresh = initialState(result.x, result.y, state.font)

      /*
       * Whether this is a RESIZE or a rebuild, which want opposite things.
       *
       * Asking for the size it already is means "even this out" — that is what
       * Rebuild is for, and carrying the positions across would make it do
       * nothing at all. Asking for a different size means "change the count and
       * keep what you can", and there the axis nobody touched should survive.
       */
      const resizing =
        wanted.columns !== existing.seed.columns || wanted.rows !== existing.seed.rows

      const carried = (
        axis: 'x' | 'y',
        held: Record<string, number>,
      ): Record<string, number> | null => {
        if (!resizing) return null
        const same =
          axis === 'x'
            ? wanted.columns === existing.seed.columns
            : wanted.rows === existing.seed.rows
        if (!same) return null
        const before = gridRanks(existing.tiles, axis)
        const after = gridRanks(result.tiles, axis)
        if (!before || !after) return null

        const byRank = new Map<number, number>()
        for (const [line, rank] of before) {
          const value = held[line]
          // A fork puts two lines at one rank; the first is taken, because a
          // resize is a rebuild and collapsing forks is part of what it does.
          if (value !== undefined && !byRank.has(rank)) byRank.set(rank, value)
        }

        const out: Record<string, number> = {}
        const source = axis === 'x' ? fresh.x : fresh.y
        for (const [line, rank] of after) {
          if (!(line in source)) continue
          const value = byRank.get(rank)
          if (value === undefined) return null
          out[line] = value
        }
        // Every line the fresh grid holds has to come out with a value, or the
        // state would be missing one and its tiles would collapse.
        return Object.keys(out).length === Object.keys(source).length ? out : null
      }

      /*
       * Compared by GEOMETRY, not by coordinate id. Reseeding mints fresh ids
       * every time, so the two dissections describe the same rectangles through
       * different names — identity would report a change on every press and
       * churn the ids for nothing.
       */
      const signature = (
        list: readonly MosaicTile[],
        xs: Record<string, number>,
        ys: Record<string, number>,
      ): string =>
        list
          .map(
            (tile) =>
              `${tile.id}|${valueOf(xs, tile.left)},${valueOf(xs, tile.right)},` +
              `${valueOf(ys, tile.top)},${valueOf(ys, tile.bottom)}`,
          )
          .sort()
          .join(';')

      const target = signature(result.tiles, result.x, result.y)
      if (existing.states.every((each) => signature(existing.tiles, each.x, each.y) === target)) {
        return false
      }

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              tiles: result.tiles,
              // The grid it is now, so Reset comes back here rather than to the
              // shape it was first drawn as.
              seed: wanted,
              /*
               * Every state, because which tiles exist and which lines they name
               * is global — a state left holding the old coordinates would be
               * describing a mosaic that no longer exists. That this flattens the
               * animation is exactly why it is a separate verb with a
               * confirmation in front of it.
               */
              states: object.states.map((each) => {
                /*
                 * Colours survive by tile id — the reseed reuses them in reading
                 * order — so only the tiles the smaller grid could not keep lose
                 * theirs. Their entries go with them rather than lingering as
                 * keys for tiles that no longer exist.
                 */
                const glyphColour = { ...each.glyphColour }
                const tileColour = { ...each.tileColour }
                const chars = { ...each.chars }
                for (const gone of result.dropped) {
                  delete glyphColour[gone]
                  delete tileColour[gone]
                  delete chars[gone]
                }
                return {
                  ...each,
                  x: carried('x', each.x) ?? { ...fresh.x },
                  y: carried('y', each.y) ?? { ...fresh.y },
                  glyphColour,
                  tileColour,
                  chars,
                }
              }),
            },
          },
        }
      })
      return true
    },

    forkMosaicCoordinate(id, axis, coordinate, spans, stateIndex = 0) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return false
      const state = existing.states[stateIndex] ?? existing.states[0]
      if (!state) return false

      const result = forkCoordinate(
        existing.tiles,
        axis === 'x' ? state.x : state.y,
        axis,
        coordinate,
        spans,
        axis === 'x' ? state.y : state.x,
      )
      if (!result) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              tiles: result.tiles,
              // The new line starts where the old one is, in EVERY state, so
              // nothing moves until it is dragged.
              states: object.states.map((each) => ({
                ...each,
                [axis]: {
                  ...(axis === 'x' ? each.x : each.y),
                  [result.created]:
                    (axis === 'x' ? each.x : each.y)[coordinate] ?? result.value,
                },
              })),
            },
          },
        }
      })
      return true
    },

    splitMosaicTile(id, tile, axis, stateIndex = 0) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return null
      const state = existing.states[stateIndex] ?? existing.states[0]
      if (!state) return null

      const result = splitTile(existing.tiles, state.x, state.y, tile, axis)
      if (!result) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              tiles: result.tiles,
              // Every state learns the new line. Halfway across the tile AS THAT
              // STATE HAS IT, so the cut looks even in each of them rather than
              // only in the one that was on show.
              states: object.states.map((each) => {
                const values = axis === 'x' ? each.x : each.y
                const source = axis === 'x' ? existing.tiles : existing.tiles
                void source
                const original = existing.tiles.find((t) => t.id === tile)
                const startId = original ? (axis === 'x' ? original.left : original.top) : null
                const endId = original ? (axis === 'x' ? original.right : original.bottom) : null
                const start = startId ? coordinateValue(values, startId) : 0
                const end = endId ? coordinateValue(values, endId) : 1
                /*
                 * The new tile inherits the colours of the one it was cut from,
                 * in every state. A split is one tile becoming two, not one tile
                 * and one blank — the halves should look like what they came
                 * from until somebody decides otherwise.
                 */
                const born = result.created.tile
                const glyphColour = { ...each.glyphColour }
                const tileColour = { ...each.tileColour }
                if (Object.prototype.hasOwnProperty.call(glyphColour, tile)) {
                  glyphColour[born] = glyphColour[tile] as string
                }
                if (Object.prototype.hasOwnProperty.call(tileColour, tile)) {
                  tileColour[born] = tileColour[tile] as string | null
                }

                return {
                  ...each,
                  [axis]: { ...values, [result.created.coordinate]: (start + end) / 2 },
                  glyphColour,
                  tileColour,
                }
              }),
            },
          },
        }
      })
      return result.created.tile
    },

    removeMosaicTile(id, tile) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return null

      // Empty in EVERY state, not just the one on show — otherwise removing a
      // tile would quietly take a letter out of a state nobody was looking at.
      const empty = existing.states.every((state) => !state.chars[tile])
      const result = removeTile(existing.tiles, tile, empty)
      if (!result) return null

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mosaic') return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              tiles: result.tiles,
              states: object.states.map((state) => {
                const { [tile]: droppedGlyph, ...glyphColour } = state.glyphColour
                const { [tile]: droppedTile, ...tileColour } = state.tileColour
                const { [tile]: droppedChar, ...chars } = state.chars
                void droppedGlyph
                void droppedTile
                void droppedChar
                // Lines nothing names any more go with it, so a mosaic does not
                // accumulate numbers for edges that no longer exist.
                const x = { ...state.x }
                const y = { ...state.y }
                for (const id of result.retired.x) delete x[id]
                for (const id of result.retired.y) delete y[id]
                return { ...state, x, y, glyphColour, tileColour, chars }
              }),
            },
          },
        }
      })
      return result.absorbedBy
    },

    createMesh({ columns, rows, artboardCenter, text }) {
      const id = createId()
      const count = get().doc.objectOrder.length + 1
      const seeded = seedMesh(columns, rows, MESH_CELL)
      const written = withCharacters(seeded.tiles, text ?? '')
      const states: MeshState[] = Array.from({ length: MESH_DEFAULT_STATES }, () => ({
        ...initialMeshState(seeded.positions, documentDefaults.font),
        chars: { ...written },
      }))

      const object: MeshObject = {
        kind: 'mesh',
        id,
        name: `Mesh ${count}`,
        // A new mesh's backdrop is the whole box, as a mosaic's is.
        backdrop: 'box',
        // The seed is centred on the origin, so the box is too — and it
        // follows the nodes from here on rather than staying what it was made as.
        localBounds: meshBounds(states),
        transform: {
          x: artboardCenter.x,
          y: artboardCenter.y,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          flipX: false,
          flipY: false,
        },
        nodes: seeded.nodes,
        tiles: seeded.tiles,
        seed: { columns: Math.max(1, Math.floor(columns)), rows: Math.max(1, Math.floor(rows)) },
        states,
        snapStep: MOSAIC_DEFAULT_SNAP,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      }

      set((state) => ({
        doc: {
          ...state.doc,
          objects: { ...state.doc.objects, [id]: object },
          objectOrder: [...state.doc.objectOrder, id],
          updatedAt: new Date().toISOString(),
        },
        selection: [id],
      }))
      return id
    },

    setMeshNodes(id, stateIndex, updates) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh') return doc
        const at = object.states[stateIndex] ? stateIndex : 0
        const state = object.states[at]
        if (!state) return doc

        const known = new Set(object.nodes.map((node) => node.id))
        const next = { ...state.nodes }
        let changed = false
        for (const update of updates) {
          if (!known.has(update.id)) continue
          if (!Number.isFinite(update.at.x) || !Number.isFinite(update.at.y)) continue
          const was = next[update.id]
          if (was && was.x === update.at.x && was.y === update.at.y) continue
          next[update.id] = { x: update.at.x, y: update.at.y }
          changed = true
        }
        if (!changed) return doc

        const states = [...object.states]
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, nodes: { ...next } }
        }
        return {
          ...doc,
          objects: { ...doc.objects, [id]: { ...object, states, localBounds: meshBounds(states) } },
        }
      })
    },

    setMeshBackdrop(id, backdrop) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh' || object.backdrop === backdrop) return doc
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, backdrop } } }
      })
    },

    setMeshLines(id, stateIndex, lines) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh') return doc
        const at = object.states[stateIndex] ? stateIndex : 0
        const state = object.states[at]
        if (!state) return doc
        if (sameStroke(state.lines ?? null, lines)) return doc
        const states = [...object.states]
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, lines }
        }
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, states } } }
      })
    },

    resizeMeshGrid(id, columns, rows) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return false
      const cols = Math.max(1, Math.min(MESH_MAX_SIDE, Math.floor(columns)))
      const count = Math.max(1, Math.min(MESH_MAX_SIDE, Math.floor(rows)))
      if (cols === existing.seed.columns && count === existing.seed.rows) return false

      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh') return doc
        const seeded = seedMesh(cols, count, MESH_CELL)
        // Letters and colours travel in reading order, as a mosaic's do on
        // a resize; positions are fresh in every state.
        const states = object.states.map((state, at) => {
          const order = allMeshTiles(object, at)
          const carry = <T,>(map: Record<string, T>): Record<string, T> => {
            const out: Record<string, T> = {}
            order.forEach((from, index) => {
              const to = seeded.tiles[index]
              const value = map[from]
              if (to && value !== undefined) out[to.id] = value
            })
            return out
          }
          return {
            ...state,
            nodes: Object.fromEntries(
              Object.entries(seeded.positions).map(([node, p]) => [node, { x: p.x, y: p.y }]),
            ),
            chars: carry(state.chars),
            glyphColour: carry(state.glyphColour),
            tileColour: carry(state.tileColour),
          }
        })
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              nodes: seeded.nodes,
              tiles: seeded.tiles,
              seed: { columns: cols, rows: count },
              states,
              localBounds: meshBounds(states),
            },
          },
        }
      })
      return true
    },

    rebuildMeshGrid(id) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return false
      const seeded = seedMesh(existing.seed.columns, existing.seed.rows, MESH_CELL)
      const nodes = Object.fromEntries(
        Object.entries(seeded.positions).map(([node, p]) => [node, { x: p.x, y: p.y }]),
      )
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh') return doc
        const states = object.states.map((state, at) => {
          const order = allMeshTiles(object, at)
          const carry = <T,>(map: Record<string, T>): Record<string, T> => {
            const out: Record<string, T> = {}
            order.forEach((from, index) => {
              const to = seeded.tiles[index]
              const value = map[from]
              if (to && value !== undefined) out[to.id] = value
            })
            return out
          }
          return {
            ...state,
            nodes: { ...nodes },
            chars: carry(state.chars),
            glyphColour: carry(state.glyphColour),
            tileColour: carry(state.tileColour),
          }
        })
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: { ...object, nodes: seeded.nodes, tiles: seeded.tiles, states, localBounds: meshBounds(states) },
          },
        }
      })
      return true
    },

    resetMeshGrid(id, stateIndex = 0) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return false
      const at = existing.states[stateIndex] ? stateIndex : 0
      const state = existing.states[at]
      if (!state) return false
      const lattice = latticeOf(existing.tiles)
      if (!lattice) return false
      const placed = resetPositions(existing.tiles, lattice, state.nodes, MESH_CELL)
      const same = Object.entries(placed).every(([node, p]) => {
        const was = state.nodes[node]
        return was && was.x === p.x && was.y === p.y
      })
      if (same) return false
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || object.kind !== 'mesh') return doc
        const states = [...object.states]
        for (const index of [at, ...followersOf(object, at)]) {
          const each = states[index]
          if (each) states[index] = { ...each, nodes: { ...placed } }
        }
        return {
          ...doc,
          objects: { ...doc.objects, [id]: { ...object, states, localBounds: meshBounds(states) } },
        }
      })
      return true
    },

    addMeshPoint(id, edge, t) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return null
      const shape = addPoint(existing, edge, t)
      if (!shape) return null
      const made = shape.nodes[shape.nodes.length - 1]?.id ?? null
      mutate((doc) => reshapeMesh(doc, id, shape))
      return made
    },

    removeMeshPoint(id, nodeId) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return false
      const shape = removePoint(existing, nodeId)
      if (!shape) return false
      mutate((doc) => reshapeMesh(doc, id, shape))
      return true
    },

    cutMeshTile(id, tileId, entry, exit) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return null
      const shape = cutTile(existing, tileId, entry, exit)
      if (!shape) return null
      const before = new Set(existing.tiles.map((tile) => tile.id))
      const made = shape.tiles.find((tile) => !before.has(tile.id))?.id ?? null
      mutate((doc) => reshapeMesh(doc, id, shape))
      return made
    },

    extrudeMeshEdge(id, edge, delta, stateIndex) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return null
      const at = existing.states[stateIndex] ? stateIndex : 0
      const shape = extrudeEdge(existing, edge, delta, at, thicknessFloor(meshSpacing(existing, at)))
      if (!shape) return null
      const made = shape.tiles[shape.tiles.length - 1]?.id ?? null
      mutate((doc) => reshapeMesh(doc, id, shape))
      return made
    },

    removeMeshTiles(id, tileIds) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mesh') return false
      let shape: MeshShape = existing
      let changed = false
      for (const tileId of tileIds) {
        const next = removeTileFromMesh(shape, tileId)
        if (next) {
          shape = next
          changed = true
        }
      }
      if (!changed) return false
      const final = shape
      mutate((doc) => reshapeMesh(doc, id, final))
      return true
    },

    convertMosaicToMesh(id) {
      const existing = get().doc.objects[id]
      if (!existing || existing.kind !== 'mosaic') return null
      const converted = meshFromMosaic(existing)
      // Fresh ids for the nodes and tiles, so converting twice — or undoing and
      // converting again — never lets two objects share a key.
      const fresh = copyMeshIdentity(converted.nodes, converted.tiles, converted.states)
      const meshId = createId()
      const object: MeshObject = {
        kind: 'mesh',
        id: meshId,
        name: existing.name,
        localBounds: meshBounds(fresh.states),
        transform: { ...existing.transform },
        nodes: fresh.nodes,
        tiles: fresh.tiles,
        seed: { ...existing.seed },
        states: fresh.states,
        snapStep: existing.snapStep,
        // A mosaic's backdrop is its box, and the picture must not change.
        backdrop: 'box',
        loop: existing.loop,
        speed: existing.speed,
        opacity: existing.opacity,
        visible: existing.visible,
        locked: existing.locked,
      }
      mutate((doc) => {
        const objects = { ...doc.objects }
        delete objects[id]
        objects[meshId] = object
        return {
          ...doc,
          objects,
          objectOrder: doc.objectOrder.map((each) => (each === id ? meshId : each)),
        }
      })
      set({ selection: [meshId] })
      return meshId
    },

    createMosaic({ columns, rows, artboardCenter, text }) {
      const id = createId()
      const count = get().doc.objectOrder.length + 1
      const seeded = seedMosaic(columns, rows)
      const written = withCharacters(seeded.tiles, text ?? '')
      const width = Math.max(columns, 1) * MOSAIC_CELL
      const height = Math.max(rows, 1) * MOSAIC_CELL

      const object: LetterMosaicObject = {
        kind: 'mosaic',
        id,
        name: `Mosaic ${count}`,
        // Centred on its own origin, like every other object: the local origin
        // is the middle of the composition and never moves again.
        localBounds: { x: -width / 2, y: -height / 2, width, height },
        transform: {
          x: artboardCenter.x,
          y: artboardCenter.y,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          flipX: false,
          flipY: false,
        },
        tiles: seeded.tiles,
        // What Reset puts it back to. Recorded now because nothing in a reshaped
        // dissection remembers which of its lines were there at the start.
        seed: { columns: Math.max(1, Math.floor(columns)), rows: Math.max(1, Math.floor(rows)) },
        /*
         * Three, all identical, and all holding the same text — a new mosaic is
         * already a timeline with nothing happening on it yet, and what is
         * written is part of each of those compositions rather than of the
         * tiles they share.
         */
        states: Array.from({ length: MOSAIC_DEFAULT_STATES }, () => ({
          ...initialState(seeded.x, seeded.y, documentDefaults.font),
          chars: { ...written },
        })),
        snapStep: MOSAIC_DEFAULT_SNAP,
        loop: true,
        speed: 1,
        opacity: 1,
        visible: true,
        locked: false,
      }

      set((state) => ({
        doc: {
          ...state.doc,
          objects: { ...state.doc.objects, [id]: object },
          objectOrder: [...state.doc.objectOrder, id],
          updatedAt: new Date().toISOString(),
        },
        selection: [id],
      }))
      return id
    },

    deleteObjects(ids) {
      if (ids.length === 0) return
      const remove = new Set(ids)
      mutate((doc) => {
        const objects = { ...doc.objects }
        for (const id of remove) delete objects[id]
        return {
          ...doc,
          objects,
          objectOrder: doc.objectOrder.filter((id) => !remove.has(id)),
        }
      })
      set((state) => ({ selection: state.selection.filter((id) => !remove.has(id)) }))
    },

    setArtboardBackground(colour) {
      mutate((doc) =>
        doc.artboard.background === colour
          ? doc
          : { ...doc, artboard: { ...doc.artboard, background: colour } },
      )
    },

    duplicateObjects(ids) {
      const doc = get().doc
      return placeCopies(
        ids.map((id) => doc.objects[id]).filter((o): o is DocumentObject => Boolean(o)),
        { offset: DUPLICATE_OFFSET, rename: true, select: true, above: true },
      )
    },

    /**
     * Copies left exactly where the originals are, with the selection untouched.
     *
     * What Alt-drag needs. The object under the pointer goes on being dragged by
     * Fabric — swapping the drag onto a new object mid-gesture would mean
     * rebuilding Fabric's transform around it — so the COPY is the one that
     * stays behind. The two are identical, so what you see is the thing you
     * grabbed moving away and a copy left where it was, which is exactly what
     * was asked for.
     *
     * No commit: the caller is in the middle of a gesture, and the copy belongs
     * in the same history entry as the move that produced it.
     */
    duplicateInPlace(ids) {
      const doc = get().doc
      return placeCopies(
        ids.map((id) => doc.objects[id]).filter((o): o is DocumentObject => Boolean(o)),
        { offset: 0, rename: false, select: false, above: true },
      )
    },

    pasteObjects(sources, assets = {}) {
      // The pictures first, so the pasted paints have something to name.
      const wanted = collectAssetIds(sources)
      mutate((doc) => {
        let next = doc.assets
        for (const id of wanted) {
          const asset = assets[id]
          if (asset && !next[id]) next = { ...next, [id]: asset }
        }
        return next === doc.assets ? doc : { ...doc, assets: next }
      })
      /*
       * Named as they were, not "copy".
       *
       * A pasted object is not a second version of something on the artboard —
       * the original may be in another document, or deleted. It is that object,
       * put here.
       */
      return placeCopies(sources, {
        offset: DUPLICATE_OFFSET,
        rename: false,
        select: true,
        above: false,
      })
    },

    reorderObject(id, toIndex) {
      mutate((doc) => {
        const from = doc.objectOrder.indexOf(id)
        if (from === -1) return doc
        const order = [...doc.objectOrder]
        order.splice(from, 1)
        order.splice(clamp(toIndex, 0, order.length), 0, id)
        return { ...doc, objectOrder: order }
      })
    },

    reorderObjects(ids, to) {
      mutate((doc) => {
        const next = restack(doc.objectOrder, ids, to)
        return next ? { ...doc, objectOrder: next } : doc
      })
    },

    reorderFrameMembers(frameId, memberIds, to) {
      mutate((doc) => {
        const frame = doc.objects[frameId]
        if (!frame || frame.kind !== 'frame') return doc
        const next = restack(
          frame.members.map((member) => member.id),
          memberIds,
          to,
        )
        if (!next) return doc
        const byId = new Map(frame.members.map((member) => [member.id, member]))
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [frameId]: { ...frame, members: next.map((id) => byId.get(id)!) },
          },
        }
      })
    },

    renameObject(id, name) {
      get().setBase(id, { name })
    },

    setVisible(id, visible) {
      get().setBase(id, { visible })
    },

    setLocked(id, locked) {
      get().setBase(id, { locked })
      if (locked) {
        set((state) => ({ selection: state.selection.filter((s) => s !== id) }))
      }
    },

    addDivider(id, divider) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTypography(object)) return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: { ...object, dividers: [...object.dividers, divider] },
          },
        }
      })
    },

    updateDivider(id, dividerId, points) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTypography(object)) return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: {
              ...object,
              dividers: object.dividers.map((d) => (d.id === dividerId ? { ...d, points } : d)),
            },
          },
        }
      })
    },

    removeDivider(id, dividerId) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTypography(object)) return doc
        return {
          ...doc,
          objects: {
            ...doc.objects,
            [id]: { ...object, dividers: object.dividers.filter((d) => d.id !== dividerId) },
          },
        }
      })
    },

    clearGrid(id) {
      mutate((doc) => {
        const object = doc.objects[id]
        if (!object || !isTypography(object)) return doc
        return { ...doc, objects: { ...doc.objects, [id]: { ...object, dividers: [] } } }
      })
    },

    setSelection(ids) {
      set({ selection: ids })
    },

    toggleSelection(id) {
      set((state) => ({
        selection: state.selection.includes(id)
          ? state.selection.filter((s) => s !== id)
          : [...state.selection, id],
      }))
    },

    clearSelection() {
      set({ selection: [] })
    },

    setDocumentName(name) {
      mutate((doc) => ({ ...doc, name }))
    },

    loadDocument(doc) {
      set({
        doc,
        selection: [],
        past: [],
        future: [],
        baseline: { doc, selection: [] },
        warnings: {},
      })
    },

    resetDocument() {
      const doc = createEmptyDocument()
      set({
        doc,
        selection: [],
        past: [],
        future: [],
        baseline: { doc, selection: [] },
        warnings: {},
      })
    },

    setAppearancePatch(id, patch, member) {
      if (member) {
        get().setMemberValues(member.frameId, member.at, member.memberId, { appearance: patch })
        return
      }
      const object = objectById(get().doc, id)
      if (!object || object.kind !== 'typography') return
      get().updateObject(id, { appearance: { ...object.appearance, ...patch } })
    },

    editPaintCrop(target, change) {
      const object = cropObjectOf(get().doc, target)
      if (!object) return
      const cropped = (paint: Paint | null | undefined): Paint | null | undefined =>
        paint && typeof paint === 'object' && paint.kind === 'image' ? { ...paint, crop: change(paint.crop) } : paint
      if (object.kind === 'typography') {
        const current = cropPaintFor(get().doc, target)
        if (!current) return
        const next = cropped(current) as Paint
        const member = target.member ? { ...target.member, at: target.stateIndex } : undefined
        if (target.surface === 'text') get().setAppearancePatch(object.id, { textFill: next }, member)
        else if (target.surface === 'shape') get().setAppearancePatch(object.id, { containerFill: next }, member)
        else if (target.surface === 'banner') get().setAppearancePatch(object.id, { lineFill: next }, member)
        return
      }
      if (target.surface === 'background') {
        const held = object.states[target.stateIndex] ?? object.states[0]
        const next = cropped(held?.background)
        if (!next || typeof next !== 'object' || next.kind !== 'image') return
        if (object.kind === 'frame') get().setFrameStateBackground(object.id, target.stateIndex, next)
        else get().setMosaicBackground(object.id, target.stateIndex, next)
        return
      }
      if (object.kind === 'frame') return
      const state = object.states[target.stateIndex] ?? object.states[0]
      if (!state) return
      for (const leaf of target.leafIds ?? []) {
        if (target.surface === 'tile') {
          const next = cropped(state.tileColour[leaf])
          if (next && typeof next === 'object' && next.kind === 'image') get().setMosaicTileColour(object.id, target.stateIndex, [leaf], next)
        } else if (target.surface === 'glyph') {
          const next = cropped(state.glyphColour[leaf])
          if (next && typeof next === 'object' && next.kind === 'image') get().setMosaicGlyphColour(object.id, target.stateIndex, [leaf], next)
        }
      }
    },

    addAsset(asset) {
      mutate((doc) => (doc.assets[asset.id] ? doc : { ...doc, assets: { ...doc.assets, [asset.id]: asset } }))
      return asset.id
    },

    sweepAssets() {
      mutate((doc) => {
        const wanted = collectAssetIds(Object.values(doc.objects))
        const kept: Record<string, ImageAsset> = {}
        let dropped = false
        for (const [id, asset] of Object.entries(doc.assets)) {
          if (wanted.has(id)) kept[id] = asset
          else dropped = true
        }
        return dropped ? { ...doc, assets: kept } : doc
      })
    },

    setWarning(id, message) {
      set((state) => {
        const warnings = { ...state.warnings }
        if (message === null) delete warnings[id]
        else warnings[id] = message
        return { warnings }
      })
    },
  }
})

// Dev-only handle, for inspecting document state from the browser console.
// The `typeof window` guard keeps this out of the way of the headless test run.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __store?: typeof useDocumentStore }).__store = useDocumentStore
}

/**
 * The stored object under an id, when it is a typography object.
 *
 * The panels read the store directly rather than trusting their props, because
 * spreading a prop would drop any change made since React last rendered —
 * picking an effect and immediately dragging its slider would undo the pick.
 * They also only ever handle one kind, so the narrowing belongs with the lookup.
 */
export function typographyById(id: string): TypographyObject | undefined {
  // Through `objectById`, so a shape inside a frame answers too. Looking only in
  // `doc.objects` made every one of these controls a no-op on a member: they
  // read first to merge onto the live value, found nothing, and returned before
  // writing anything at all.
  const object = objectById(useDocumentStore.getState().doc, id)
  return object && isTypography(object) ? object : undefined
}
