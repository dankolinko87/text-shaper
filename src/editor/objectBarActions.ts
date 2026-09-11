import { useUiStore, type UiState } from '../state/uiStore'
import { isMoving } from '../typography/objectFit'
import type { DocumentObject, FrameObject, LetterMosaicObject, Rect } from '../types/document'
import { isTypography } from '../types/document'
import { frameRuns, mosaicMoves } from './animationPlayback'
import { duplicateFrameStateAt } from './frameStates'
import { duplicateStateAt } from './mosaicStates'
import { windowOffset } from './renderer'

/**
 * What the bar under a selected object does, apart from drawing itself.
 *
 * Kept out of the component so the rules can be called from a test without a
 * DOM: which objects have anything to play, what play means while a frame is
 * spread, and where a new state goes. The component is the thin part.
 */

/** An object whose states the bar steps through. */
export type Stated = LetterMosaicObject | FrameObject

/** Whether pressing play would show anything happening. */
export function moves(object: DocumentObject): boolean {
  if (object.kind === 'mosaic') return mosaicMoves(object)
  if (object.kind === 'frame') return frameRuns(object)
  return isTypography(object) && isMoving(object)
}

/**
 * Whether the object is the one running, on whichever transport it uses.
 *
 * A frame previews through the same transport a mosaic does, and deliberately:
 * both animate between authored states on a clock of their own, so "play this
 * one thing and keep its position" means the same for each. A shape carrying a
 * preset loops on its own, so it has its own switch.
 */
export function playing(
  object: DocumentObject,
  ui: Pick<UiState, 'mosaicPlayback' | 'previewObject'>,
): boolean {
  if (object.kind === 'mosaic' || object.kind === 'frame') {
    return ui.mosaicPlayback?.object === object.id && Boolean(ui.mosaicPlayback.playing)
  }
  return ui.previewObject === object.id
}

/**
 * Play, or stop — never pause.
 *
 * Stopping ends the preview and puts the object back where it rests; pausing a
 * mosaic leaves an interpolated frame on screen that belongs to no state and
 * cannot be edited — a dead end reached by pressing the obvious button.
 *
 * A spread frame folds back to one frame first. The row shows every keyframe
 * at once, so there is no window for a preview to run in; one press does both,
 * because a dead play button on a bar that plainly has one is worse than
 * either.
 */
export function togglePlay(object: DocumentObject): void {
  const ui = useUiStore.getState()
  if (object.kind === 'mosaic' || object.kind === 'frame') {
    if (playing(object, ui)) {
      ui.stopMosaicPlayback()
      return
    }
    if (ui.spreadFrame === object.id) ui.setSpreadFrame(null)
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
  if (object.kind === 'mosaic') return duplicateStateAt(object, shown)
  const spread = useUiStore.getState().spreadFrame === object.id
  return duplicateFrameStateAt(object, spread ? object.states.length - 1 : shown)
}

/** Lay the states out, or fold them back; nothing plays into or out of a spread. */
export function toggleSpread(object: FrameObject): void {
  const ui = useUiStore.getState()
  if (ui.spreadFrame === object.id) {
    ui.setSpreadFrame(null)
    return
  }
  ui.stopMosaicPlayback()
  ui.setSpreadFrame(object.id)
}

/**
 * The box a spread frame's bar hangs from: the whole row, in the frame's own
 * units. `windowOffset` answers in artboard units, scale included, and the
 * anchor applies the frame's transform itself — so the scale comes back out.
 */
export function spreadBounds(object: FrameObject): Rect {
  const box = object.localBounds
  const last = object.states.length - 1
  return { ...box, width: box.width + windowOffset(object, last) / (object.transform.scaleX || 1) }
}

/** How far the plate stands off the frame at the sides and bottom, as a share of its width. */
const PLATE_PAD = 0.06
/** Screen pixels the spread's number chips need above each window. */
const CHIP_ROOM = 28

/**
 * The plate behind a held frame, in the frame's own units: the frame (or the
 * whole spread row) with padding round it. Defined once, because the plate is
 * drawn from it AND the bar hangs from it — a bar that hung from the frame's
 * edge sat on the plate's bottom strip.
 *
 * Spread, the chips ride above each window at screen size, so the top edge
 * makes room for them at whatever the zoom is; collapsed there are no chips
 * and the padding is even.
 */
export function plateBounds(object: FrameObject, spread: boolean, zoom: number): Rect {
  const box = spread ? spreadBounds(object) : object.localBounds
  const pad = object.localBounds.width * PLATE_PAD
  const scaleY = object.transform.scaleY || 1
  const padTop = spread ? Math.max(pad, CHIP_ROOM / ((zoom || 1) * scaleY)) : pad
  return {
    x: box.x - pad,
    y: box.y - padTop,
    width: box.width + pad * 2,
    height: box.height + pad + padTop,
  }
}
