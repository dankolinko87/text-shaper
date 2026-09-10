import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { FRAME_MAX_STATES, FRAME_MIN_STATES } from '../types/frame'

/**
 * The frame's state controls, in one place.
 *
 * `mosaicStates.ts` for the other thing that has states, function for function.
 * There are two sets of these controls on screen — the list in the panel and
 * the bar under the frame — and they have to mean the same thing: which state
 * you are left looking at afterwards, that playback stops when you choose one,
 * and that nothing asks a question first because undo puts it all back.
 *
 * Before this existed the bar inlined its own copy of "show a state", and the
 * panel's + and delete ignored the index the store handed back and never
 * re-showed — so duplicating from the panel left you looking at the original,
 * and deleting the shown state left the cursor pointing at a state that no
 * longer existed.
 */

/** The frame as the store has it NOW, not the one a render handed in. */
function fresh(id: string): FrameObject | null {
  const object = useDocumentStore.getState().doc.objects[id]
  return object?.kind === 'frame' ? object : null
}

/**
 * Show the arrangement at `index`, and leave any preview that is running.
 *
 * Choosing a state is asking to see it exactly, which an interpolated frame is
 * not — so playback stops rather than fighting the choice.
 */
export function showFrameState(object: FrameObject, index: number): void {
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
 */
export function duplicateFrameStateAt(object: FrameObject, at: number): boolean {
  if (object.states.length >= FRAME_MAX_STATES) return false
  const store = useDocumentStore.getState()
  const made = store.duplicateFrameState(object.id, at)
  if (made === null) return false
  store.commit('Duplicate state')

  const now = fresh(object.id)
  if (now) showFrameState(now, made)
  return true
}

/**
 * Remove the state at `at`, and land on the nearest survivor.
 *
 * Two states is the floor — a timeline needs two ends — and below it this
 * refuses rather than asking. Everything else about it is undoable.
 */
export function deleteFrameStateAt(object: FrameObject, at: number): boolean {
  if (object.states.length <= FRAME_MIN_STATES) return false
  const store = useDocumentStore.getState()
  const next = store.deleteFrameState(object.id, at)
  if (next === null) return false
  store.commit('Delete state')

  const now = fresh(object.id)
  if (now) showFrameState(now, next)
  return true
}

/**
 * Put a state somewhere else in the sequence.
 *
 * The order IS the animation, so this is the one edit here that changes what
 * plays without touching a single arrangement. The canvas follows the state
 * that MOVED, not the slot it left: dragging something is holding on to it.
 */
export function moveFrameStateTo(object: FrameObject, from: number, to: number): boolean {
  const store = useDocumentStore.getState()
  if (!store.moveFrameState(object.id, from, to)) return false
  store.commit('Reorder states')

  const now = fresh(object.id)
  if (now) showFrameState(now, Math.min(Math.max(0, to), now.states.length - 1))
  return true
}

/**
 * Whether a press on empty ground keeps the frame: it does while the frame is
 * spread.
 *
 * The row is laid out to be looked at, and looking involves clicking about —
 * putting a member down, missing a window by a pixel. Folding the row on the
 * first such click threw away the comparison you had just set up. So while
 * spread, a single press outside only drops the member pick; the row folds on
 * a DOUBLE-click outside, on Escape, or on its own button.
 */
export function spreadHoldsGround(): boolean {
  return useUiStore.getState().spreadFrame !== null
}

/** A single press on the ground outside the frame: leave — unless it is spread. */
export function pressOutside(frameId: string): void {
  const ui = useUiStore.getState()
  ui.setFrameSelection([])
  if (ui.spreadFrame === frameId) return
  ui.setInsideFrame(null)
}

/** A double-click on the ground outside a spread frame folds the row. */
export function doublePressOutside(frameId: string): boolean {
  const ui = useUiStore.getState()
  if (ui.spreadFrame !== frameId) return false
  ui.setSpreadFrame(null)
  return true
}
