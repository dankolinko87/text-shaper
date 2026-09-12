import { Polygon, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useRef } from 'react'

import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { FrameObject } from '../types/document'
import { selectionColour } from './colours'
import { frameCorners } from './frameBoxes'
import { pressOutside } from './stated'
import { windowOffset } from './renderer'
import { membersOf } from './memberTarget'
import { outlineToPath, pathToOutline } from '../geometry/outline'

/**
 * Picking and moving the objects inside a frame.
 *
 * Modelled on `MosaicLayer`, and for the same reason it exists: a frame is ONE
 * Fabric group, and letting Fabric target its children would mean fighting
 * group-relative coordinates on every drag. So the overlay hit-tests members on
 * the artboard, draws their outlines, and writes moves to the store — exactly as
 * the mosaic does for its tiles. `frameBoxes` owns the one conversion that makes
 * that safe, because group-relative coordinates are precisely what Fabric hands
 * back and precisely what neither a canvas rectangle nor a pointer is in.
 *
 * Everything it writes goes to the state that is OPEN. That is the whole point
 * of being inside a frame: you are not moving an object, you are saying where
 * that object stands in this arrangement.
 */

const FOCUS = selectionColour

export function FrameLayer({
  canvas,
  object: frame,
}: {
  canvas: FabricCanvas | null
  object: FrameObject | undefined
}) {
  const inside = useUiStore((s) => s.insideFrame)
  const picked = useUiStore((s) => s.frameSelection)
  /*
   * One layer further in, the points own the pointer.
   *
   * `PathLayer` hit-tests handles on the same canvas events this does, so both
   * running at once means a press on a node also picks the member up and drags
   * it out from under the point being moved — the same collision `skipTargetFind`
   * exists to stop between Fabric and the node editor.
   */
  const editingPoints = useUiStore((s) => s.editingPoints)
  const shown = useUiStore((s) => s.mosaicStates[frame?.id ?? ''] ?? 0)
  const spread = useUiStore((s) => Boolean(frame) && s.spread === frame?.id)
  const shapesRef = useRef<FabricObject[]>([])

  const active = Boolean(frame) && inside === frame?.id
  const owning = active && !editingPoints
  const state = frame?.states[Math.min(shown, (frame?.states.length ?? 1) - 1)]

  /* Draw an outline round every member, and mark the picked one. */
  useEffect(() => {
    if (!canvas) return

    const clear = (): void => {
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }
    clear()
    if (!active || !frame) {
      canvas.requestRenderAll()
      return
    }

    /*
     * The frame's own edge, kept while you are inside it.
     *
     * Going inside takes Fabric's selection off the frame — the members are
     * what is being picked now — and with the selection went the only strong
     * outline the frame had, so the thing being worked inside of vanished the
     * moment a member was chosen. The mosaic never has this problem because its
     * tile grid covers its whole box; a frame is mostly empty, so it has to say
     * where it is itself.
     *
     * A polygon rather than a rectangle: the frame can be rotated, and an
     * upright box drawn round a turned frame is a lie about where its edge is.
     */
    // One edge per WINDOW while spread: every window is the frame, drawn again.
    const corners = frameCorners(canvas, frame)
    const count = spread ? frame.states.length : 1
    for (let i = 0; i < count; i++) {
      const offset = windowOffset(frame, i)
      const outer = new Polygon(
        corners.map((point) => ({ x: point.x + offset, y: point.y })),
        {
          fill: 'transparent',
          stroke: FOCUS(),
          strokeWidth: 1 / (canvas.getZoom() || 1),
          strokeUniform: true,
          strokeDashArray: [6 / (canvas.getZoom() || 1), 4 / (canvas.getZoom() || 1)],
          opacity: 0.7,
          selectable: false,
          evented: false,
          objectCaching: false,
        },
      )
      outer.set('gridRole', 'frame-bounds')
      shapesRef.current.push(outer)
      canvas.add(outer)
    }

    canvas.requestRenderAll()

    return clear
  }, [canvas, active, frame, state, picked, spread])

  /*
   * What Fabric does not do for us.
   *
   * Picking, dragging, scaling and rotating a member are Fabric's now — the
   * frame's group is interactive while you are inside it, so a member has the
   * same controls, cursors and handles an object on the artboard has, because it
   * IS one. Reimplementing them here was the mistake this replaces: handles
   * drawn on top look right and behave like nothing else in the editor.
   *
   * What is left are the three things that are about the FRAME rather than about
   * the object: leaving, taking a member out, and duplicating one.
   */
  useEffect(() => {
    if (!canvas || !owning) return

    /** The frame as the STORE has it — never a render-time copy. */
    const live = (): FrameObject | null => {
      const id = useUiStore.getState().insideFrame
      if (!id) return null
      const found = useDocumentStore.getState().doc.objects[id]
      return found && found.kind === 'frame' ? found : null
    }

    const shownState = (target: FrameObject) =>
      Math.min(useUiStore.getState().mosaicStates[target.id] ?? 0, target.states.length - 1)

    /** The members a gesture began on — one, or a whole selection of them — and which modifiers it began with. */
    let gesture: { members: string[]; takeOut: boolean; cloned: boolean } | null = null

    const onDown = (opt: { e: Event; target?: FabricObject }): void => {
      const target = live()
      if (!target) return
      const mouse = opt.e as MouseEvent
      const members = membersOf(opt.target)

      if (members.length > 0) {
        gesture = {
          members,
          // Held from the press: a modifier let go mid-drag should not change
          // what the gesture was.
          takeOut: mouse.metaKey || mouse.ctrlKey,
          cloned: false,
        }
        return
      }

      /*
       * No member under the press. Ask the PRESS what it landed on: the frame's
       * own group (its ground — put the member down, stay), or something else
       * or nothing (outside — leave). Fabric's target is the truth about where
       * the pointer is, including over a member's overhang; testing the
       * document's box here called a press on the overhang a press outside.
       */
      const hit = opt.target as { get?: (key: string) => unknown } | undefined
      if (hit?.get?.('statedId') === target.id) {
        useUiStore.getState().setFrameSelection([])
        return
      }

      // Outside. Leave — unless the frame is spread, when a single press only
      // puts the member down and a double-click is what folds the row.
      pressOutside(target.id)
    }

    /*
     * Alt leaves a COPY behind, on the first move rather than on the press.
     *
     * The copy is what stays and the original is what moves, exactly as on the
     * artboard: Fabric's transform is already bound to the object under the
     * pointer, and swapping it mid-gesture would mean rebuilding that transform.
     * Since the two are identical it reads the same either way.
     *
     * On the first MOVE, because Alt-clicking without dragging should select
     * rather than litter the frame with copies.
     */
    const onMove = (opt: { e: Event }): void => {
      if (!gesture || gesture.cloned) return
      if (!(opt.e as MouseEvent).altKey) return
      const target = live()
      if (!target) return
      gesture.cloned = true
      const store = useDocumentStore.getState()
      const copied = gesture.members.filter((member) => store.duplicateFrameMember(target.id, member))
      if (copied.length > 0) useDocumentStore.getState().commit('Duplicate in frame')
    }

    const onUp = (): void => {
      const finished = gesture
      gesture = null
      if (!finished?.takeOut) return

      /*
       * Held with Cmd, the drag TAKES THE MEMBER OUT — decided on release
       * rather than as it moves, so the member follows the pointer inside the
       * frame the whole way. With clipping off a member is allowed to overhang,
       * so one that popped out the instant the pointer crossed the edge would be
       * impossible to place.
       */
      const target = live()
      if (!target) return
      const store = useDocumentStore.getState()
      if (store.removeFromFrame(target.id, finished.members, shownState(target))) {
        store.commit('Take out of frame')
        const ui = useUiStore.getState()
        ui.setFrameSelection([])
        ui.setInsideFrame(null)
      }
    }

    /**
     * A double-click goes in one more layer, to the member's own points.
     *
     * Handled here rather than beside the canvas's other double-click, because
     * that one resolves a top-level object by `shapeId` and a member has none.
     */
    const onDoubleClick = (opt: { target?: FabricObject; subTargets?: FabricObject[] }): void => {
      const target = live()
      if (!target) return
      /*
       * Off the frame's ground there is nothing here to go into. Whether the
       * row folds is `SpreadLayer`'s question, asked once for every kind.
       */
      const pressed = opt.target as (FabricObject & { group?: FabricObject }) | undefined
      const owner = pressed?.get('statedId') ?? pressed?.group?.get('statedId')
      if (owner !== target.id) return
      /*
       * Which member: whatever Fabric has hold of.
       *
       * `opt.target` is the GROUP — Fabric reports the top-level object it hit
       * and lists the child under `subTargets` — and by the time a double-click
       * lands the first click has already selected the member, so the active
       * object is the most direct answer and the one that cannot disagree with
       * what is on screen.
       */
      const memberId =
        (canvas.getActiveObject()?.get('memberId') as string | undefined) ??
        (opt.subTargets?.[0]?.get('memberId') as string | undefined) ??
        (opt.target?.get('memberId') as string | undefined)
      if (!memberId) return
      const hit = target.members.find((each) => each.id === memberId)
      if (!hit || hit.object.kind !== 'typography') return

      /*
       * A primitive carries no node list until something asks to edit it.
       * Derived onto the MEMBER, not into a state: how many points there are is
       * what every state shares — a topology written into one state is one its
       * neighbours could not be blended with.
       */
      const outline = hit.object.outline ?? pathToOutline(hit.object.currentSourcePath)
      if (!outline) return
      if (!hit.object.outline) {
        // Through the geometry action, wherever the member lives — so the
        // bounds and the fit revision move with it, as they do for any shape.
        useDocumentStore.getState().setGeometry(hit.object.id, {
          path: outlineToPath(outline),
          outline,
        })
        useDocumentStore.getState().commit('Edit shape')
      }
      const ui = useUiStore.getState()
      ui.setFrameSelection([memberId])
      ui.setEditingPoints(hit.object.id)
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    canvas.on('mouse:dblclick', onDoubleClick)
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      canvas.off('mouse:dblclick', onDoubleClick)
    }
  }, [canvas, owning])

  return null
}
