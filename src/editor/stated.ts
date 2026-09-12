import type { Canvas } from 'fabric'

import type { Easing } from '../anim/easing'
import { framePlaybackDuration } from '../frame/frame'
import { meshPlaybackDuration } from '../mesh/timeline'
import { pointArtboardToObject } from '../geometry/objectSpace'
import { playbackDuration as mosaicPlaybackDuration } from '../mosaic/timeline'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore, type UiState } from '../state/uiStore'
import { isMoving } from '../typography/objectFit'
import type {
  DocumentObject,
  FrameObject,
  LetterMosaicObject,
  MeshObject,
  Rect,
  Stated,
  Transform2D,
  Vec2,
} from '../types/document'
import { isStated, isTypography } from '../types/document'
import { FRAME_MAX_STATES, FRAME_MIN_STATES } from '../types/frame'
import { MOSAIC_MAX_STATES, MOSAIC_MIN_STATES } from '../types/mosaic'
import { frameRuns, meshMoves, mosaicMoves } from './animationPlayback'
import { liveTransform, windowOffset } from './renderer'

/**
 * Everything that is true of an object BECAUSE it has states, written once.
 *
 * A mosaic and a frame are made of different things — tiles and letters; other
 * objects — but the fact of having states is the same fact: a sequence to play
 * through, one to show, a copy to make, a slot to move to, a floor of two and a
 * ceiling, a row to lay them out in and rules about what a press beside that
 * row means. These used to be written twice, function for function, and the
 * two copies were already drifting: the frame's spread had rules the mosaic
 * could not share because they were typed to a frame.
 *
 * The rule now: what differs per kind is in `KINDS`, and it is only the store
 * actions, the limits, the word, and two predicates. Everything below that
 * table is written against the table. A new kind of object with states is a
 * new row here and a window builder in the renderer, and it inherits the list,
 * the bar, the chips, the plate, the spread and the tests.
 */

/** What one kind of stated object has to say for itself. Nothing else differs. */
export interface StatedKind<T extends Stated = Stated> {
  /** The word for it in a label: "A frame holds at most 12 states". */
  noun: string
  /** Fewer than this is a picture, not a sequence. */
  min: number
  max: number
  /** Copy the state at `at` to the slot after it. Returns the copy's index, or null. */
  duplicate(id: string, at: number): number | null
  /** Take one away, keeping at least `min`. Returns the nearest survivor, or null. */
  delete(id: string, at: number): number | null
  move(id: string, from: number, to: number): boolean
  /**
   * Set how many there are, taking from the end. Only a kind that is BORN
   * with states offers this — a frame's states are arrangements you built,
   * so + is its only honest verb and there is no count to set.
   */
  setCount?(id: string, count: number): boolean
  setTiming(id: string, at: number, patch: { holdMs?: number; transitionMs?: number }): void
  setEasing(id: string, at: number, easing: Easing): void
  /** How long one lap takes to watch, speed included. */
  playbackDuration(object: T): number
  /** Whether pressing play would show anything happening. */
  moves(object: T): boolean
}

const store = () => useDocumentStore.getState()

const MOSAIC: StatedKind<LetterMosaicObject> = {
  noun: 'mosaic',
  min: MOSAIC_MIN_STATES,
  max: MOSAIC_MAX_STATES,
  duplicate: (id, at) => store().duplicateMosaicState(id, at),
  delete: (id, at) => store().deleteMosaicState(id, at),
  move: (id, from, to) => store().moveMosaicState(id, from, to),
  setCount: (id, count) => store().setMosaicStateCount(id, count),
  setTiming: (id, at, patch) => store().setMosaicStateTiming(id, at, patch),
  setEasing: (id, at, easing) => store().setMosaicEasing(id, at, easing),
  playbackDuration: mosaicPlaybackDuration,
  moves: mosaicMoves,
}

const FRAME: StatedKind<FrameObject> = {
  noun: 'frame',
  min: FRAME_MIN_STATES,
  max: FRAME_MAX_STATES,
  duplicate: (id, at) => store().duplicateFrameState(id, at),
  delete: (id, at) => store().deleteFrameState(id, at),
  move: (id, from, to) => store().moveFrameState(id, from, to),
  setTiming: (id, at, patch) => store().setFrameStateTiming(id, at, patch),
  setEasing: (id, at, easing) => store().setFrameStateEasing(id, at, easing),
  playbackDuration: framePlaybackDuration,
  moves: frameRuns,
}

/**
 * A mesh's states are written by the mosaic's actions — every field they
 * touch is one the two kinds share — so its row is the mosaic's with its own
 * word, clock and motion test.
 */
const MESH: StatedKind<MeshObject> = {
  noun: 'mesh',
  min: MOSAIC_MIN_STATES,
  max: MOSAIC_MAX_STATES,
  duplicate: (id, at) => store().duplicateMosaicState(id, at),
  delete: (id, at) => store().deleteMosaicState(id, at),
  move: (id, from, to) => store().moveMosaicState(id, from, to),
  setCount: (id, count) => store().setMosaicStateCount(id, count),
  setTiming: (id, at, patch) => store().setMosaicStateTiming(id, at, patch),
  setEasing: (id, at, easing) => store().setMosaicEasing(id, at, easing),
  playbackDuration: meshPlaybackDuration,
  moves: meshMoves,
}

/** The one place the kinds are told apart. */
export function kindOf(object: Stated): StatedKind {
  return object.kind === 'mosaic' ? MOSAIC : object.kind === 'mesh' ? MESH : FRAME
}

/** The object as the store has it NOW, not the one a render handed in. */
function fresh(id: string): Stated | null {
  const object = store().doc.objects[id]
  return object && isStated(object) ? object : null
}

/* ------------------------------------------------------------ the states */

/**
 * Show the state at `index`, and leave any preview that is running.
 *
 * Choosing a state is asking to see it exactly, which an interpolated frame is
 * not — so playback stops rather than fighting the choice. The list in the
 * rail, the bar under the object and the chips over a spread all come here, so
 * they cannot disagree about what choosing means.
 */
export function showState(object: Stated, index: number): void {
  if (index < 0 || index >= object.states.length) return
  const ui = useUiStore.getState()
  ui.stopMosaicPlayback()
  ui.setMosaicState(object.id, index)
}

/**
 * Copy the state at `at`, and go to the copy.
 *
 * The copy lands straight after the original and is selected, because
 * duplicating is how you say "another one like this, then I will change it" —
 * leaving the original selected would put the next edit on the wrong state.
 *
 * Nothing here asks a question first, and nothing below does either. A
 * `window.confirm` used to guard deleting an authored state, and a browser that
 * suppresses dialogs — which Chrome does for the rest of a session once someone
 * ticks the box — turned the button into a no-op with no way to tell why. Every
 * one of these commits, so undo puts the state back exactly.
 */
export function duplicateStateAt(object: Stated, at: number): boolean {
  const kind = kindOf(object)
  if (object.states.length >= kind.max) return false
  const made = kind.duplicate(object.id, at)
  if (made === null) return false
  store().commit('Duplicate state')

  // The object as it is NOW: it has one more state than the one passed in, and
  // `showState` checks the index against the states it can see.
  const now = fresh(object.id)
  if (now) showState(now, made)
  return true
}

/**
 * Remove the state at `at`, and land on the nearest survivor.
 *
 * Two states is the floor — a timeline needs two ends — and below it this
 * refuses rather than asking. Everything else about it is undoable.
 */
export function deleteStateAt(object: Stated, at: number): boolean {
  const kind = kindOf(object)
  if (object.states.length <= kind.min) return false
  const next = kind.delete(object.id, at)
  if (next === null) return false
  store().commit('Delete state')

  const now = fresh(object.id)
  if (now) showState(now, next)
  return true
}

/**
 * Put a state somewhere else in the sequence.
 *
 * The order IS the animation, so this is the one edit here that changes what
 * plays without touching a single state. Every state carries its own timing
 * along with it — a state's hold is its own, not the slot's.
 *
 * The canvas follows the state that MOVED, not the slot it left. Dragging
 * something is holding on to it, and coming to rest looking at whichever state
 * happened to slide into the old position would be the panel letting go.
 */
export function moveStateTo(object: Stated, from: number, to: number): boolean {
  if (!kindOf(object).move(object.id, from, to)) return false
  store().commit('Reorder states')

  const now = fresh(object.id)
  if (now) showState(now, Math.min(Math.max(0, to), now.states.length - 1))
  return true
}

/**
 * Grow or shrink the sequence to `wanted`, for a kind that offers a count.
 *
 * Shrinking takes states from the end and is undoable like everything else
 * here. False when nothing changed, or when the kind has no count to set.
 */
export function changeStateCount(object: Stated, wanted: number): boolean {
  const kind = kindOf(object)
  if (!kind.setCount || wanted === object.states.length) return false
  if (!kind.setCount(object.id, wanted)) return false
  store().commit('Change state count')
  useUiStore.getState().clampMosaicState(object.id, wanted)
  return true
}

/* ------------------------------------------------------------ the spread */

/** Whether this object is the one laid out as a row. */
export function isSpread(ui: Pick<UiState, 'spread'>, id: string): boolean {
  return ui.spread === id
}

/**
 * Which window the shown state is drawn in: its own index while spread, and
 * the only window — 0 — otherwise. Everything that draws ON the shown state
 * (a caret, a tile's handles, a member's points) hangs from this.
 */
export function shownWindow(
  object: Stated,
  ui: Pick<UiState, 'spread' | 'mosaicStates'>,
): number {
  if (ui.spread !== object.id) return 0
  return Math.min(ui.mosaicStates[object.id] ?? 0, object.states.length - 1)
}

/**
 * The object's transform moved along the row to window `index`.
 *
 * A spread draws the same object once per state and only the first is at the
 * object's own position, so anything mapped through the transform alone lands
 * a row-step away from the window it belongs to. `windowOffset` answers in
 * artboard units, which is what a transform's `x` is in.
 */
export function windowTransform(object: Stated, index: number): Transform2D {
  if (index === 0) return object.transform
  return { ...object.transform, x: object.transform.x + windowOffset(object, index) }
}

/**
 * Where the shown state is DRAWN, in both directions: the object's LIVE
 * transform — Fabric moves the group as the pointer moves and only writes the
 * result back on release — stood along the row to the shown state's window
 * while the object is spread. Every overlay maps through this, so none can
 * disagree about which window the furniture is in.
 */
export function shownTransform(canvas: Canvas | null, object: Stated): Transform2D {
  const live = { ...object, transform: liveTransform(canvas, object.id, object.transform) }
  return windowTransform(live, shownWindow(object, useUiStore.getState()))
}

/**
 * Which window of a spread a point on the artboard is in, or null for a
 * point in a gap, above or below the row, or beyond its ends.
 *
 * Geometry, for when Fabric has no target to say — target finding is off while
 * you are inside an object. Where Fabric HAS a target, its stamp is the
 * answer, and this is the fallback, not a second opinion.
 */
export function windowIndexAt(object: Stated, scene: Vec2): number | null {
  const local = pointArtboardToObject(object.transform, scene)
  const box = object.localBounds
  if (local.y < box.y || local.y > box.y + box.height) return null
  const along = local.x - box.x
  if (along < 0) return null
  const step = windowOffset(object, 1) / (object.transform.scaleX || 1)
  const index = Math.floor(along / step)
  if (index >= object.states.length) return null
  if (along - index * step > box.width) return null
  return index
}

/**
 * Lay the states out, or fold them back; nothing plays into or out of a spread.
 *
 * Spreading a FRAME goes inside it as well, so the panel, the member write
 * paths, the point editor and the Escape ladder all work unchanged: its
 * windows exist to pick members in. A mosaic is entered by putting the caret
 * in a tile, which is a different thing to ask for, so its row opens with
 * nothing entered.
 */
export function toggleSpread(object: Stated): void {
  const ui = useUiStore.getState()
  if (ui.spread === object.id) {
    ui.setSpread(null)
    return
  }
  ui.stopMosaicPlayback()
  ui.setSpread(object.id)
  if (object.kind === 'frame') ui.setInsideFrame(object.id)
}

/**
 * Whether a press on empty ground keeps the object: it does while one is
 * spread.
 *
 * The row is laid out to be looked at, and looking involves clicking about —
 * putting a member down, missing a window by a pixel. Folding the row on the
 * first such click threw away the comparison you had just set up. So while
 * spread, a single press outside only drops what was picked inside; the row
 * folds on a DOUBLE-click outside, on Escape, or on its own button.
 */
export function spreadHoldsGround(): boolean {
  return useUiStore.getState().spread !== null
}

/** A single press on the ground outside a frame: leave — unless it is spread. */
export function pressOutside(id: string): void {
  const ui = useUiStore.getState()
  ui.setFrameSelection([])
  if (ui.spread === id) return
  ui.setInsideFrame(null)
}

/** A double-click on the ground outside a spread object folds the row. */
export function doublePressOutside(id: string): boolean {
  const ui = useUiStore.getState()
  if (ui.spread !== id) return false
  ui.setSpread(null)
  return true
}

/**
 * The box a spread object's bar hangs from: the whole row, in the object's own
 * units. `windowOffset` answers in artboard units, scale included, and the
 * anchor applies the object's transform itself — so the scale comes back out.
 */
export function spreadBounds(object: Stated): Rect {
  const box = object.localBounds
  const last = object.states.length - 1
  return { ...box, width: box.width + windowOffset(object, last) / (object.transform.scaleX || 1) }
}

/** How far the plate stands off the object at the sides and bottom, as a share of its width. */
const PLATE_PAD = 0.06
/** Screen pixels the spread's number chips need above each window. */
const CHIP_ROOM = 28

/**
 * The plate behind a held object with states, in the object's own units.
 * Defined once, because the plate is drawn from it AND the bar hangs from it
 * — a bar that hung from the object's edge sat on the plate's bottom strip.
 *
 * Spread, the plate takes the whole row in with padding round it, and its
 * top edge makes screen-sized room for the number chips at whatever the zoom
 * is — the padding is where the plate can be taken hold of. Collapsed there
 * are no chips and nothing to hold but the object, so the plate is exactly
 * the object's box: a ground under it, not a margin round it.
 */
export function plateBounds(object: Stated, spread: boolean, zoom: number): Rect {
  const box = spread ? spreadBounds(object) : object.localBounds
  const pad = spread ? object.localBounds.width * PLATE_PAD : 0
  const scaleY = object.transform.scaleY || 1
  const padTop = spread ? Math.max(pad, CHIP_ROOM / ((zoom || 1) * scaleY)) : 0
  return {
    x: box.x - pad,
    y: box.y - padTop,
    width: box.width + pad * 2,
    height: box.height + pad + padTop,
  }
}

/* --------------------------------------------------------------- the bar */

/** Whether pressing play would show anything happening. */
export function moves(object: DocumentObject): boolean {
  if (isStated(object)) return kindOf(object).moves(object)
  return isTypography(object) && isMoving(object)
}

/**
 * Whether the object is the one running, on whichever transport it uses.
 *
 * Every stated object previews through the same transport, and deliberately:
 * each animates between authored states on a clock of its own, so "play this
 * one thing and keep its position" means the same for all. A shape carrying a
 * preset loops on its own, so it has its own switch.
 */
export function playing(
  object: DocumentObject,
  ui: Pick<UiState, 'mosaicPlayback' | 'previewObject'>,
): boolean {
  if (isStated(object)) {
    return ui.mosaicPlayback?.object === object.id && Boolean(ui.mosaicPlayback.playing)
  }
  return ui.previewObject === object.id
}

/**
 * Play, or stop — never pause.
 *
 * Stopping ends the preview and puts the object back where it rests; pausing
 * leaves an interpolated frame on screen that belongs to no state and cannot
 * be edited — a dead end reached by pressing the obvious button.
 *
 * A spread object folds back to one first. The row shows every keyframe at
 * once, so there is no window for a preview to run in; one press does both,
 * because a dead play button on a bar that plainly has one is worse than
 * either.
 */
export function togglePlay(object: DocumentObject): void {
  const ui = useUiStore.getState()
  if (isStated(object)) {
    if (playing(object, ui)) {
      ui.stopMosaicPlayback()
      return
    }
    if (ui.spread === object.id) ui.setSpread(null)
    ui.playMosaic(object.id)
    return
  }
  ui.setPreviewObject(playing(object, ui) ? null : object.id)
}

/**
 * Another state: a copy of the one on show, so nothing moves until you move it.
 *
 * Spread, a copy of the LAST one instead — the row grows at its end and nothing
 * already laid out shifts.
 */
export function addState(object: Stated, shown: number): boolean {
  const spread = useUiStore.getState().spread === object.id
  return duplicateStateAt(object, spread ? object.states.length - 1 : shown)
}
