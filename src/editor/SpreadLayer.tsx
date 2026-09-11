import type { Canvas as FabricCanvas, FabricObject } from 'fabric'
import { useEffect } from 'react'

import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { Stated } from '../types/document'
import { isStated } from '../types/document'
import { doublePressOutside, showState, windowIndexAt } from './stated'

/**
 * What a press means while an object is laid out as a row — for every kind.
 *
 * Two rules, and they are the whole of it. A press on a window shows that
 * window's state: the row exists to compare states, and pointing at one is
 * how you say which. A double-click on the ground outside every window folds
 * the row: a single press beside it is only looking about (`spreadHoldsGround`
 * keeps the object selected through it), and folding on the first stray click
 * threw away the comparison you had just set up.
 *
 * Which window: Fabric's target answers when it has one — a member child's
 * parent, or a window's own stamp — and the row's geometry answers when target
 * finding is off, which it is while you are inside a mosaic. One layer, drawn
 * from nothing, so a frame and a mosaic cannot come to read a press
 * differently. `FrameLayer` keeps what is about MEMBERS; this is about
 * windows.
 */
export function SpreadLayer({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: Stated | undefined
}) {
  const id = object?.id

  useEffect(() => {
    if (!canvas || !id) return

    /** The object as the STORES have it, and only while it is the one spread. */
    const live = (): Stated | null => {
      if (useUiStore.getState().spread !== id) return null
      const found = useDocumentStore.getState().doc.objects[id]
      return found && isStated(found) ? found : null
    }

    /** Which window a press landed in, or null for none of this object's. */
    const windowAt = (
      target: FabricObject | undefined,
      e: Event,
      object: Stated,
    ): number | null => {
      // A member's parent is its window; a window is its own.
      const hit = target?.get('memberId') ? (target.group as FabricObject | undefined) : target
      const owner = hit?.get('statedId') as string | undefined
      if (owner !== undefined) {
        if (owner !== object.id) return null
        const at = hit?.get('stateIndex')
        return typeof at === 'number' ? at : null
      }
      // Something else's, or — with nothing under the pointer at all — the
      // row's own geometry, which is all there is once Fabric stops looking.
      if (target) return null
      return windowIndexAt(object, canvas.getScenePoint(e as MouseEvent))
    }

    const onDown = (opt: { e: Event; target?: FabricObject }): void => {
      const target = live()
      if (!target) return
      const at = windowAt(opt.target, opt.e, target)
      if (at !== null) showState(target, at)
    }

    const onDoubleClick = (opt: { e: Event; target?: FabricObject }): void => {
      const target = live()
      if (!target) return
      if (windowAt(opt.target, opt.e, target) === null) doublePressOutside(target.id)
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:dblclick', onDoubleClick)
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:dblclick', onDoubleClick)
    }
  }, [canvas, id])

  return null
}
