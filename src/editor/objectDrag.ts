import { valuesFor } from '../frame/frame'
import { vectorArtboardToObject } from '../geometry/objectSpace'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { Vec2 } from '../types/document'

/**
 * Moving an object by something that is not the object: its plate, its name.
 *
 * Fabric drags the artwork itself. The plate under a thing with states and
 * the name above any object are handles of ours, and a drag on either moves
 * the whole object — every window of a spread row, since they are all one
 * transform. The drag writes the document as it goes, the way a node drag
 * does, so the renderer carries the group and everything hanging from it
 * along; the history hears about it once, at the end.
 */

export interface ObjectDrag {
  /** The pointer is here now, in artboard units. */
  move: (scene: Vec2) => void
  /** Let go: one history entry, if it went anywhere. */
  end: () => void
  /** Escape: back where it started, nothing recorded. */
  cancel: () => void
}

/** Begin dragging `id` from a press at `from` (artboard units). Null for an object that cannot move. */
export function beginObjectDrag(id: string, from: Vec2): ObjectDrag | null {
  const store = useDocumentStore.getState()
  const object = store.doc.objects[id]
  if (!object || object.locked) return null
  const start = { ...object.transform }
  const ui = useUiStore.getState()
  ui.setInteracting(id)
  let moved = false
  let done = false

  const finish = (): void => {
    done = true
    const now = useUiStore.getState()
    if (now.interacting === id) now.setInteracting(null)
  }

  return {
    move(scene) {
      if (done) return
      const dx = scene.x - from.x
      const dy = scene.y - from.y
      const current = useDocumentStore.getState().doc.objects[id]
      if (!current) return
      const x = start.x + dx
      const y = start.y + dy
      if (current.transform.x === x && current.transform.y === y) return
      moved = true
      useDocumentStore.getState().setBase(id, { transform: { ...start, x, y } })
    },
    end() {
      if (done) return
      finish()
      if (moved) useDocumentStore.getState().commit('Move')
    },
    cancel() {
      if (done) return
      finish()
      if (moved) useDocumentStore.getState().setBase(id, { transform: start })
    },
  }
}

/**
 * Move the selection by an offset in artboard units — the arrow keys.
 *
 * The same write a drag makes, once: objects on the artboard through their
 * base transform, and a member picked inside a frame through the shown
 * state's transform for it, the offset carried into the frame's own space so
 * a nudge inside a turned frame still goes the way the arrow points. One
 * history entry per press, the way Figma undoes a nudge. False when nothing
 * could move.
 */
export function nudgeSelection(delta: Vec2): boolean {
  const store = useDocumentStore.getState()
  const ui = useUiStore.getState()
  const before = store.doc

  if (ui.insideFrame && ui.frameSelection.length > 0) {
    const frame = store.doc.objects[ui.insideFrame]
    if (!frame || frame.kind !== 'frame') return false
    const at = Math.min(ui.mosaicStates[frame.id] ?? 0, frame.states.length - 1)
    const local = vectorArtboardToObject(frame.transform, delta)
    for (const memberId of ui.frameSelection) {
      const member = frame.members.find((each) => each.id === memberId)
      if (!member || member.object.locked) continue
      const transform = valuesFor(member, frame.states[at]).transform
      useDocumentStore
        .getState()
        .setMemberValues(frame.id, at, memberId, {
          transform: { ...transform, x: transform.x + local.x, y: transform.y + local.y },
        })
    }
  } else {
    for (const id of store.selection) {
      const object = useDocumentStore.getState().doc.objects[id]
      if (!object || object.locked) continue
      const t = object.transform
      useDocumentStore.getState().setBase(id, { transform: { ...t, x: t.x + delta.x, y: t.y + delta.y } })
    }
  }

  if (useDocumentStore.getState().doc === before) return false
  useDocumentStore.getState().commit('Nudge')
  return true
}
