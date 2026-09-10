import { valuesFor } from '../frame/frame'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { TypographyObject } from '../types/document'
import type { MemberTypeSettings } from '../types/frame'

/**
 * Where an edit lands when the thing being edited is inside a frame.
 *
 * A member is an object in every sense except that it is not in `doc.objects` —
 * and more than that, half of what you can change about it belongs to the
 * ARRANGEMENT rather than to the member. Which half depends on the property:
 * where it stands, how it looks and what shape it is are per state; how many
 * points it has is not.
 *
 * This is the one place that answers "which frame, which member, which state",
 * and it exists as a module because it had begun to exist three times — once in
 * the colour controls, once in the point editor, and once more here. Every bug
 * in this feature so far has been two copies of one rule drifting apart.
 */
export function frameTargetFor(
  id: string,
): { frameId: string; memberId: string; at: number } | null {
  const ui = useUiStore.getState()
  const inside = ui.insideFrame
  if (!inside) return null
  const frame = useDocumentStore.getState().doc.objects[inside]
  if (!frame || frame.kind !== 'frame') return null
  const member = frame.members.find((each) => each.object.id === id)
  if (!member) return null
  return {
    frameId: inside,
    memberId: member.id,
    at: Math.min(ui.mosaicStates[inside] ?? 0, frame.states.length - 1),
  }
}

/**
 * The properties that belong to a STATE rather than to the member.
 *
 * The cut tier exactly: every one of them changes the layout, which is what
 * makes them worth animating between states and what makes them snap rather
 * than tween. Everything else about a shape — its node count, its warp, its row
 * dividers — is structure, shared by every arrangement.
 */
const CUT_KEYS = [
  'text',
  'font',
  'fittingMode',
  'textFlowMode',
  'typography',
  'run',
] as const satisfies readonly (keyof MemberTypeSettings)[]

/**
 * Change a shape, wherever it lives and whichever half of it is being changed.
 *
 * A drop-in for `updateObject` from the panel's point of view, which is the
 * point: the controls say what they are setting and this decides where it goes.
 * Outside a frame everything goes to the object, exactly as before. Inside one,
 * the cut-tier fields go to the state on show — so setting a different sentence
 * on state 2 is an animation rather than an edit to the shape — and anything
 * else still goes to the member itself.
 *
 * A patch holding both is split rather than refused, because the panel writes
 * whole settings objects and should not have to know about the split.
 */
export function updateShape(id: string, patch: Partial<TypographyObject>): void {
  const store = useDocumentStore.getState()
  const target = frameTargetFor(id)
  if (!target) {
    store.updateObject(id, patch)
    return
  }

  const cut: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if ((CUT_KEYS as readonly string[]).includes(key)) cut[key] = value
    else rest[key] = value
  }

  /*
   * Only the fields that changed. The store merges them onto what the state
   * already says — and ONLY onto that. Merging here onto the resolved settings
   * wrote all six into the state on the first edit of any one of them, and
   * from then on the state could not follow the member for the other five.
   */
  if (Object.keys(cut).length > 0) {
    store.setMemberValues(target.frameId, target.at, target.memberId, {
      typeSettings: cut as MemberTypeSettings,
    })
  }

  if (Object.keys(rest).length > 0) store.updateObject(id, rest as Partial<TypographyObject>)
}

/** The type settings as the shown state has them, for a read-before-write. */
export function currentTypeSettings(id: string): MemberTypeSettings | undefined {
  const target = frameTargetFor(id)
  if (!target) return undefined
  const frame = useDocumentStore.getState().doc.objects[target.frameId]
  if (!frame || frame.kind !== 'frame') return undefined
  const member = frame.members.find((each) => each.id === target.memberId)
  return member ? valuesFor(member, frame.states[target.at]).typeSettings : undefined
}
