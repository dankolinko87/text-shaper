import { useEffect } from 'react'

import { memberAsFreed } from '../frame/frame'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { openShapeEditingOnSelection } from './shapeEditing'

/** True when the user is typing, so shortcuts must not steal the keystroke. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

/**
 * Whether a keystroke belongs to the caret in a mosaic tile rather than to the
 * editor around it.
 *
 * A tile with the caret in it is text entry, but it is not a DOM field — the
 * caret lives on the canvas — so `isTextEntry` cannot see it. Without this,
 * typing `V` into a tile would switch to the Select tool and `B` would arm the
 * brush.
 *
 * Only unmodified keys, though. `Cmd`/`Ctrl` held means a command, not a letter
 * going into the tile — the mosaic's own handler refuses to type those anyway —
 * so swallowing them left undo, duplicate and select-all dead for as long as a
 * caret was in a tile. In the Colour tab that is the whole time, since choosing
 * a tile is what puts the caret there.
 *
 * Escape falls through as well, which is what lets it still mean "stop typing".
 */
export function suppressedByCaret(
  e: { key: string; metaKey: boolean; ctrlKey: boolean },
  typing: boolean,
): boolean {
  if (!typing) return false
  if (e.key === 'Escape') return false
  return !(e.metaKey || e.ctrlKey)
}

/**
 * Global keyboard shortcuts.
 *
 * Every binding guards against text entry first — typing "v" in the layer-name
 * field must not switch tools.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target)) return
      if (suppressedByCaret(e, Boolean(useUiStore.getState().typing))) return

      const mod = e.metaKey || e.ctrlKey
      const doc = useDocumentStore.getState()
      const ui = useUiStore.getState()

      // Undo / redo
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) doc.redo()
        else doc.undo()
        return
      }
      // Windows convention for redo.
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        doc.redo()
        return
      }

      /** The member being worked on inside a frame, if that is where we are. */
      const memberPick = (): { frameId: string; memberId: string; at: number } | null => {
        const frameId = ui.insideFrame
        const memberId = ui.frameSelection[0]
        if (!frameId || !memberId) return null
        const frame = doc.doc.objects[frameId]
        if (!frame || frame.kind !== 'frame') return null
        return { frameId, memberId, at: Math.min(ui.mosaicStates[frameId] ?? 0, frame.states.length - 1) }
      }

      // Duplicate — preventDefault matters, or the browser bookmarks the page.
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        /*
         * Inside a frame, the MEMBER you picked. The selection is still the
         * frame while you are inside it — that is what keeps its panel and bar
         * on screen — so duplicating "the selection" copied the whole frame
         * every time somebody asked for one more shape inside it.
         */
        const picked = memberPick()
        if (picked) {
          if (doc.duplicateFrameMember(picked.frameId, picked.memberId)) {
            doc.commit('Duplicate in frame')
          }
          return
        }
        if (doc.selection.length > 0) {
          doc.duplicateObjects(doc.selection)
          doc.commit('Duplicate')
        }
        return
      }

      /*
       * Copy and paste, over the app's own clipboard rather than the system's.
       *
       * A shape is not text and not an image: there is no format the OS
       * clipboard could carry it in that anything else would understand, and
       * serialising it to one would lose the parts that make it this app's —
       * a mosaic's states, a path's editable outline. So ⌘C remembers the
       * objects and ⌘V puts copies of them back.
       *
       * `preventDefault` on copy only when something is selected, so ⌘C over a
       * text field still copies the text.
       */
      if (mod && e.key.toLowerCase() === 'c') {
        /*
         * The member, as it would stand on the artboard if it left the frame
         * from the state on show — the one rule taking it out uses too.
         */
        const picked = memberPick()
        if (picked) {
          e.preventDefault()
          const frame = doc.doc.objects[picked.frameId]
          const member =
            frame?.kind === 'frame'
              ? frame.members.find((each) => each.id === picked.memberId)
              : undefined
          if (frame?.kind === 'frame' && member) {
            ui.setClipboard([memberAsFreed(member, frame.states[picked.at], frame.transform)])
          }
          return
        }
        if (doc.selection.length === 0) return
        e.preventDefault()
        ui.setClipboard(
          doc.selection
            .map((id) => doc.doc.objects[id])
            .filter((object): object is NonNullable<typeof object> => Boolean(object)),
        )
        return
      }

      if (mod && e.key.toLowerCase() === 'v') {
        const clipboard = ui.clipboard
        if (clipboard.length === 0) return
        e.preventDefault()

        /*
         * Pasting while inside a frame puts it IN the frame: the objects arrive
         * on the artboard as any paste does and are then moved in, so rebasing
         * them into the frame's space stays `addToFrame`'s job.
         */
        const made = doc.pasteObjects(clipboard)
        const inside = ui.insideFrame
        if (inside && made.length > 0) doc.addToFrame(inside, made)
        doc.commit('Paste')
        return
      }

      // Select all
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        /*
         * Inside a mosaic, "all" means all TILES.
         *
         * Selecting every object on the artboard while somebody is picking tiles
         * to colour would be answering a question they did not ask — and would
         * throw away the tile selection they had built up.
         */
        const sole = doc.selection.length === 1 ? doc.doc.objects[doc.selection[0] as string] : undefined
        // Tile-editing mode: one mosaic, and the caret is INSIDE it.
        if (sole && sole.kind === 'mosaic' && ui.typing?.object === sole.id) {
          ui.setMosaicSelection(sole.tiles.map((tile) => tile.id))
          return
        }
        doc.setSelection(
          doc.doc.objectOrder.filter((id) => {
            const object = doc.doc.objects[id]
            return object ? !object.locked && object.visible : false
          }),
        )
        return
      }

      if (mod) return

      switch (e.key) {
        case 'v':
        case 'V':
          e.preventDefault()
          ui.setTool('select')
          break

        case 'b':
        case 'B':
          e.preventDefault()
          ui.setTool('draw')
          break

        case 'l':
        case 'L':
          e.preventDefault()
          ui.setTool('line')
          break

        case 'p':
        case 'P':
          e.preventDefault()
          ui.setTool('pen')
          break

        case 'm':
        case 'M':
          e.preventDefault()
          ui.setTool('mosaic')
          break

        case 'f':
        case 'F':
          e.preventDefault()
          ui.setTool('frame')
          break

        case 'h':
        case 'H':
          e.preventDefault()
          ui.setTool('pan')
          break

        case 'g':
        case 'G':
          e.preventDefault()
          // Goes INSIDE the selected shape rather than switching tool: editing a
          // shape is one mode, and this is one of the three ways into it.
          openShapeEditingOnSelection()
          break

        case ' ':
          // Temporary pan while held.
          if (!e.repeat && ui.temporaryTool === null) {
            e.preventDefault()
            ui.setTemporaryTool('pan')
          }
          break

        case 'Delete':
        case 'Backspace':
          /*
           * A half-drawn gesture owns these keys.
           *
           * The pen answers Backspace by taking back its last anchor, and while
           * it is EXTENDING a path that path is the selection — so letting this
           * run as well would delete the very object being drawn into.
           */
          if (ui.isDrawing) break
          /*
           * Inside a frame, Delete means the MEMBER you picked.
           *
           * The selection is still the frame while you are inside it — that is
           * what makes the frame's own panel keep showing — so without this,
           * deleting one shape deleted the whole frame and everything in it.
           */
          if (ui.insideFrame && ui.frameSelection.length > 0) {
            e.preventDefault()
            if (doc.deleteFrameMembers(ui.insideFrame, ui.frameSelection)) {
              doc.commit('Delete from frame')
              ui.setFrameSelection([])
            }
            break
          }
          if (doc.selection.length > 0) {
            e.preventDefault()
            doc.deleteObjects(doc.selection)
            doc.commit('Delete')
          }
          break

        case 'Escape':
          e.preventDefault()
          /*
           * Out one layer at a time, innermost first: a half-drawn gesture, then
           * the points of the object you went inside, then the selection itself.
           * Escaping straight out to nothing would make leaving point editing
           * cost the selection as well, and the next thing you want is almost
           * always to move the object you were just editing.
           */
          if (ui.isDrawing) ui.setDrawing(false)
          /*
           * The caret is one layer in from everything below: its own handler
           * takes Escape out of text entry (or out of a drag in flight), and
           * nothing further out moves for the same keypress. Without this
           * rung, leaving a mosaic also folded its row and dropped the
           * selection — three layers for one Escape.
           */
          else if (ui.typing) {
            // Handled by the mosaic's caret; the ladder stops here.
          }
          else if (ui.editingPoints) ui.setEditingPoints(null)
          /*
           * A member picked inside a frame is one layer in from the frame
           * itself, so it goes first: putting a member down should not also
           * throw you out of the frame you are arranging.
           */
          else if (ui.insideFrame && ui.frameSelection.length > 0) ui.setFrameSelection([])
          else if (ui.insideFrame) {
            /*
             * Out to the FRAME, not to nothing.
             *
             * Coming out of something should hand you the thing you came out
             * of — the next thing you want is almost always to move it, and
             * escaping to an empty selection means finding and clicking it
             * again. The same courtesy leaving point editing pays.
             */
            const frame = ui.insideFrame
            ui.setInsideFrame(null)
            doc.setSelection([frame])
          }
          // A row laid out is one layer in from plain selection: fold it first.
          else if (ui.spread) ui.setSpread(null)
          else doc.clearSelection()
          break

        case '!':
          // Shift+1 — fit artboard. Handled here so it works canvas-wide.
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('text-shaper:fit'))
          break

        default:
          break
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') {
        useUiStore.getState().setTemporaryTool(null)
      }
    }

    // Releasing Space outside the window would otherwise leave pan stuck on.
    const onBlur = (): void => useUiStore.getState().setTemporaryTool(null)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
