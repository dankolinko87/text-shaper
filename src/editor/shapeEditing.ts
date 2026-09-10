import { pathToOutline, refitDensePath } from '../geometry/outline'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { isTypography } from '../types/document'
import type { PathOutline } from '../types/document'

/**
 * Going inside a shape, from wherever the request came from.
 *
 * There is ONE mode for editing a shape — its outline's nodes and the grid lines
 * the text flows through, together — and more than one way to ask for it: a
 * double-click on the canvas, the toolbar button, the `G` key. They have to mean
 * exactly the same thing, including the work of deriving nodes for a shape that
 * has none yet, so that work lives here rather than in whichever handler
 * happened to be written first.
 *
 * The canvas has its own business to do afterwards — taking the object's
 * bounding box away so a press lands on a node rather than dragging the whole
 * shape — and that stays with the canvas, because only it can do it
 * synchronously.
 */

/**
 * Most points an object may have before its nodes stop being editable by hand.
 *
 * A drawn shape settles at a few dozen after the fit; a shape whose outline was
 * once replaced by a grid edge drag is a polyline of several hundred, and showing
 * a marker for each is a wall of dots at one every few units rather than
 * something to aim at. The gap between the two populations is wide enough that
 * the exact number does not matter much.
 */
export const MAX_EDITABLE_NODES = 120

/**
 * Fit tolerance used when a dense outline is refitted so it can be edited.
 *
 * A SQUARED distance, which is how paper compares it — so about half a unit of
 * licence, not the fifth it reads as. The same value the freehand pipeline uses,
 * for the same reason: looser than this and the fit starts dropping the segments
 * a curve needs.
 */
export const REFIT_TOLERANCE = 0.2

/**
 * How far a refit may move the shape before it is thrown away, in artboard
 * units.
 *
 * Under a unit on a shape hundreds of units across is beneath noticing; anything
 * more is the drawing changing under the user, which is not a trade worth making
 * for the convenience of editing it.
 */
export const REFIT_DRIFT = 1

export const countNodes = (outline: PathOutline): number =>
  outline.subpaths.reduce((n, subpath) => n + subpath.nodes.length, 0)

/**
 * Open shape editing on one object.
 *
 * Returns false when the object cannot be edited — the wrong kind, or an outline
 * so dense that no fit can recover it — having said why through the object's own
 * warning. The caller does not need to know which; there is nothing useful for
 * it to do differently.
 */
export function openShapeEditing(id: string): boolean {
  const store = useDocumentStore.getState()
  const object = store.doc.objects[id]
  // Only a shape has an outline. A mosaic is a partition with its own editor.
  if (!object || !isTypography(object)) return false

  /*
   * An object that has no nodes yet gets them now, from its own path.
   *
   * Deriving on the way IN rather than at creation is what makes this work for
   * everything: a shape saved before nodes existed, one whose outline was
   * replaced by an older build's grid edit, and anything a future tool produces.
   * The path is the truth either way, and reading it back is exact.
   */
  let outline = object.outline
  let path = object.currentSourcePath
  if (!outline) {
    outline = pathToOutline(path)

    /*
     * Too many points to work with? Refit them, rather than refusing — but only
     * if the refit leaves the shape where it was. `refitDensePath` measures that
     * and hands back nothing when it cannot promise it, which is the only honest
     * way to do this: a shape that visibly changed the moment its points were
     * opened would be worse than one that could not be opened at all.
     */
    if (outline && countNodes(outline) > MAX_EDITABLE_NODES) {
      const refitted = refitDensePath(path, REFIT_TOLERANCE, REFIT_DRIFT)
      if (refitted && countNodes(refitted.outline) <= MAX_EDITABLE_NODES) {
        outline = refitted.outline
        path = refitted.path
      }
    }

    if (!outline || countNodes(outline) > MAX_EDITABLE_NODES) {
      /*
       * Said out loud, and said WHY. An entry that does nothing is
       * indistinguishable from a broken one.
       *
       * Only shapes from an older build reach this now: the grid editor no
       * longer touches the container's outline at all, so nothing being drawn
       * today can end up in this state.
       */
      store.setWarning(
        id,
        'This shape’s outline was replaced by several hundred points when its grid was edited, and they cannot be simplified without changing its shape. Its points cannot be edited by hand.',
      )
      return false
    }
    store.setGeometry(id, { path, outline })
    store.commit('Edit shape')
  }

  // A refusal from a previous attempt has been answered by getting in.
  store.setWarning(id, null)
  store.setSelection([id])
  useUiStore.getState().setEditingPoints(id)
  return true
}

/** Open shape editing on the sole selection, for the toolbar and the keyboard. */
export function openShapeEditingOnSelection(): boolean {
  const store = useDocumentStore.getState()
  if (store.selection.length !== 1) return false
  return openShapeEditing(store.selection[0] as string)
}
