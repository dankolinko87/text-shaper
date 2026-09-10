import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { LetterMosaicObject } from '../types/document'
import { MOSAIC_MAX_STATES, MOSAIC_MIN_STATES } from '../types/mosaic'

/**
 * The state controls, in one place.
 *
 * There are two of them on screen — the row above the tabs and the bar under the
 * selected mosaic — and they have to mean the same thing.
 *
 * Nothing here asks a question first. It used to: removing a state that held its
 * own composition put up a `window.confirm`. Two things were wrong with that. A
 * browser can suppress those — once a person ticks "prevent this page from
 * creating additional dialogs", every one of them returns false for the rest of
 * the session, so the button silently stops working with no way to tell why.
 * And it was out of step with the rest of the app, where deleting an object or a
 * tile simply happens.
 *
 * What makes that safe is the history. Every one of these commits, so undo puts
 * the state back exactly — which is a better answer than a modal, because it
 * costs nothing when you meant it and still saves you when you did not.
 */

/**
 * Show the composition at `index`, and leave any preview that is running.
 *
 * Selecting a state is asking to see it exactly, which an interpolated frame is
 * not — so playback stops rather than fighting the choice.
 */
export function showMosaicState(object: LetterMosaicObject, index: number): void {
  if (index < 0 || index >= object.states.length) return
  const ui = useUiStore.getState()
  ui.stopMosaicPlayback()
  ui.setMosaicState(object.id, index)
}

/**
 * Grow or shrink the timeline.
 *
 * Shrinking takes states from the end and is undoable like everything else here.
 * Returns false when nothing changed.
 */
export function changeMosaicStateCount(object: LetterMosaicObject, wanted: number): boolean {
  const count = object.states.length
  if (wanted === count) return false

  const store = useDocumentStore.getState()
  if (!store.setMosaicStateCount(object.id, wanted)) return false
  store.commit('Change state count')
  useUiStore.getState().clampMosaicState(object.id, wanted)
  return true
}

/**
 * Copy the state on show, and go to the copy.
 *
 * The copy lands straight after the original and is selected, because
 * duplicating is how you say "another one like this, then I will change it" —
 * leaving the original selected would put the next edit on the wrong state.
 */
export function duplicateStateAt(object: LetterMosaicObject, at: number): boolean {
  if (object.states.length >= MOSAIC_MAX_STATES) return false
  const store = useDocumentStore.getState()
  const made = store.duplicateMosaicState(object.id, at)
  if (made === null) return false
  store.commit('Duplicate state')

  // The object as it is NOW: it has one more state than the one passed in, and
  // `showMosaicState` checks the index against the states it can see.
  const fresh = useDocumentStore.getState().doc.objects[object.id]
  if (fresh?.kind === 'mosaic') showMosaicState(fresh, made)
  return true
}

/**
 * Remove the state on show, and land on the nearest survivor.
 *
 * Two states is the floor — a timeline needs two ends — and below it this
 * refuses rather than asking. Everything else about it is undoable.
 */
export function deleteStateAt(object: LetterMosaicObject, at: number): boolean {
  if (object.states.length <= MOSAIC_MIN_STATES) return false

  const store = useDocumentStore.getState()
  const next = store.deleteMosaicState(object.id, at)
  if (next === null) return false
  store.commit('Delete state')

  const fresh = useDocumentStore.getState().doc.objects[object.id]
  if (fresh?.kind === 'mosaic') showMosaicState(fresh, next)
  return true
}

/**
 * Put a state somewhere else in the sequence.
 *
 * The order IS the animation, so this is the one edit here that changes what
 * plays without touching a single composition. Every state carries its own
 * lines, colours, letters and timing along with it — a state's hold is its
 * own, not the slot's.
 *
 * The canvas follows the state that MOVED, not the slot it left. Dragging
 * something is holding on to it, and coming to rest looking at whichever state
 * happened to slide into the old position would be the panel letting go.
 */
export function moveStateTo(object: LetterMosaicObject, from: number, to: number): boolean {
  const store = useDocumentStore.getState()
  if (!store.moveMosaicState(object.id, from, to)) return false
  store.commit('Reorder states')

  const fresh = useDocumentStore.getState().doc.objects[object.id]
  if (fresh?.kind === 'mosaic') {
    showMosaicState(fresh, Math.min(Math.max(0, to), fresh.states.length - 1))
  }
  return true
}
