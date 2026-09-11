import { useMemo } from 'react'

import { valuesFor } from '../frame/frame'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { DocumentObject, Stated } from '../types/document'
import { isStated } from '../types/document'
import type { FrameMember } from '../types/frame'
import { memberAsDrawn } from './renderer'

/**
 * What is selected, answered once.
 *
 * Three places used to work this out for themselves — the properties panel,
 * the play control and the canvas — and each answered a slightly different
 * question. The rail that opens for an object with states is a fourth, and a
 * fourth copy is where the answers start to disagree: a member picked inside a
 * frame IS the frame's selection to the rail and the play control, and IS the
 * member to the panel editing its colour. Both are right, and one function
 * says both.
 */
export interface Selected {
  /**
   * The OUTER object: the frame while you are inside it, whatever member is
   * picked. This is what has states, what the bar under the object follows and
   * what the rail opens for.
   */
  selected: DocumentObject | undefined
  /** The member picked inside that frame, if exactly one is. */
  member: FrameMember | undefined
  /**
   * What the panel edits: the member as the shown state draws it, else the
   * selected object itself.
   *
   * Through the renderer's own function, so the panel describes exactly what is
   * drawn. A second copy of "the member as this state has it" is how the colour
   * and the shape would come to disagree about which state they were showing.
   */
  object: DocumentObject | undefined
  /** Where the panel's edits go: the member's own object id, or the selection's. */
  id: string | undefined
  /** The object whose STATES are on show, if the selection has any. */
  stated: Stated | undefined
}

const NOTHING: Selected = {
  selected: undefined,
  member: undefined,
  object: undefined,
  id: undefined,
  stated: undefined,
}

/** The ephemeral half of the question: what is being worked inside, and where. */
export interface SelectionView {
  insideFrame: string | null
  frameSelection: readonly string[]
  mosaicStates: Readonly<Record<string, number>>
}

/**
 * Exactly one thing selected is the only case with an answer. Several things
 * selected is several answers, and the panel and the bar both say so in their
 * own way rather than picking one.
 */
export function selectedObject(
  selection: readonly string[],
  objects: Readonly<Record<string, DocumentObject>>,
  ui: SelectionView,
): Selected {
  if (selection.length !== 1) return NOTHING
  const selectedId = selection[0] as string
  const selected = objects[selectedId]
  if (!selected) return NOTHING

  /*
   * A member picked inside a frame is what the panel is about.
   *
   * The SELECTION is still the frame while you are inside it — that is what
   * keeps the frame's bar and its own transform available — but the thing you
   * are working on is the member you picked, so that is what its properties
   * should be. Same rule as everywhere else: the panel describes the innermost
   * thing you have hold of.
   *
   * Its STRUCTURE is shared by every state — its outline, its text, its font —
   * but how it LOOKS belongs to the arrangement on show, so the panel is handed
   * the member as that state has it. Without this the controls would read the
   * member's resting colours while the canvas showed the state's, and every
   * colour edit would begin by looking wrong.
   */
  const member =
    selected.kind === 'frame' && ui.insideFrame === selected.id && ui.frameSelection.length === 1
      ? selected.members.find((each) => each.id === ui.frameSelection[0])
      : undefined

  const memberState =
    member && selected.kind === 'frame'
      ? selected.states[
          Math.min(ui.mosaicStates[selected.id] ?? 0, selected.states.length - 1)
        ]
      : undefined

  return {
    selected,
    member,
    object: member ? memberAsDrawn(member, valuesFor(member, memberState)) : selected,
    id: member ? member.object.id : selectedId,
    stated: isStated(selected) ? selected : undefined,
  }
}

/** The same answer, live, for a component. */
export function useSelectedObject(): Selected {
  const selection = useDocumentStore((s) => s.selection)
  const objects = useDocumentStore((s) => s.doc.objects)
  const insideFrame = useUiStore((s) => s.insideFrame)
  const frameSelection = useUiStore((s) => s.frameSelection)
  // Only the shown state of the frame being worked inside can change the
  // answer, so only that one is subscribed to — not every object's.
  const shown = useUiStore((s) => (insideFrame ? (s.mosaicStates[insideFrame] ?? 0) : 0))
  return useMemo(
    () =>
      selectedObject(selection, objects, {
        insideFrame,
        frameSelection,
        mosaicStates: insideFrame ? { [insideFrame]: shown } : {},
      }),
    [selection, objects, insideFrame, frameSelection, shown],
  )
}
