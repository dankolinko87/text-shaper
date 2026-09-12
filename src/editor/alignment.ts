import { valuesFor } from '../frame/frame'
import { alignmentShifts, type Alignment } from '../geometry/align'
import { objectToArtboard } from '../geometry/objectSpace'
import { transformBounds } from '../geometry/transform'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { IconName } from '../components/Icon'
import type { Rect, Transform2D } from '../types/document'

/**
 * Lining the selection up — the context menu's row of icons and the ⌥-key
 * shortcuts, Figma's own.
 *
 * The same two doors a nudge goes through: objects on the artboard through
 * their base transform, and members picked inside a frame through the shown
 * state's transform, measured in the frame's own space so a row lined up
 * inside a turned frame is lined up along the frame. Boxes are the objects'
 * local bounds carried through their transform, which is the box the canvas
 * draws round them. One history entry per alignment. False when nothing moved.
 */

export interface AlignmentOption {
  how: Alignment
  label: string
  icon: IconName
  /** Shown beside the label, as the menu writes shortcuts. */
  shortcut: string
  /** The key, by position — ⌥ with a letter types a symbol on a Mac. */
  code: string
  /** ⌃ as well as ⌥, as Figma distributes. */
  ctrl?: boolean
}

export const ALIGNMENT_OPTIONS: readonly AlignmentOption[] = [
  { how: 'left', label: 'Align left', icon: 'alignLeft', shortcut: '⌥A', code: 'KeyA' },
  { how: 'centre', label: 'Align horizontal centres', icon: 'alignHCentre', shortcut: '⌥H', code: 'KeyH' },
  { how: 'right', label: 'Align right', icon: 'alignRight', shortcut: '⌥D', code: 'KeyD' },
  { how: 'top', label: 'Align top', icon: 'alignTop', shortcut: '⌥W', code: 'KeyW' },
  { how: 'middle', label: 'Align vertical centres', icon: 'alignVCentre', shortcut: '⌥V', code: 'KeyV' },
  { how: 'bottom', label: 'Align bottom', icon: 'alignBottom', shortcut: '⌥S', code: 'KeyS' },
]

export const DISTRIBUTION_OPTIONS: readonly AlignmentOption[] = [
  { how: 'distributeHorizontal', label: 'Distribute horizontally', icon: 'distributeH', shortcut: '⌃⌥H', code: 'KeyH', ctrl: true },
  { how: 'distributeVertical', label: 'Distribute vertically', icon: 'distributeV', shortcut: '⌃⌥V', code: 'KeyV', ctrl: true },
]

/** The option a key press asks for, if it asks for one. */
export function alignmentForKey(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): AlignmentOption | null {
  if (!e.altKey || e.metaKey || e.shiftKey) return null
  const pool = e.ctrlKey ? DISTRIBUTION_OPTIONS : ALIGNMENT_OPTIONS
  return pool.find((option) => option.code === e.code) ?? null
}

/** How many things are lined up, for whether the menu offers it at all. */
export function alignableCount(): number {
  const ui = useUiStore.getState()
  if (ui.insideFrame) return ui.frameSelection.length
  return useDocumentStore.getState().selection.length
}

const boxOf = (transform: Transform2D, local: Rect): Rect =>
  transformBounds(objectToArtboard(transform), local)

export function alignSelection(how: Alignment): boolean {
  const store = useDocumentStore.getState()
  const ui = useUiStore.getState()
  const before = store.doc

  if (ui.insideFrame && ui.frameSelection.length > 1) {
    const frame = store.doc.objects[ui.insideFrame]
    if (!frame || frame.kind !== 'frame') return false
    const at = Math.min(ui.mosaicStates[frame.id] ?? 0, frame.states.length - 1)
    const members = ui.frameSelection
      .map((id) => frame.members.find((each) => each.id === id))
      .filter((member): member is NonNullable<typeof member> => Boolean(member) && !member!.object.locked)
    const transforms = members.map((member) => valuesFor(member, frame.states[at]).transform)
    const shifts = alignmentShifts(
      members.map((member, i) => boxOf(transforms[i]!, member.object.localBounds)),
      how,
    )
    members.forEach((member, i) => {
      const t = transforms[i]!
      const d = shifts[i]!
      if (d.x === 0 && d.y === 0) return
      useDocumentStore
        .getState()
        .setMemberValues(frame.id, at, member.id, { transform: { ...t, x: t.x + d.x, y: t.y + d.y } })
    })
  } else if (!ui.insideFrame && store.selection.length > 1) {
    const objects = store.selection
      .map((id) => store.doc.objects[id])
      .filter((object): object is NonNullable<typeof object> => Boolean(object) && !object!.locked)
    const shifts = alignmentShifts(
      objects.map((object) => boxOf(object.transform, object.localBounds)),
      how,
    )
    objects.forEach((object, i) => {
      const d = shifts[i]!
      if (d.x === 0 && d.y === 0) return
      const t = object.transform
      useDocumentStore.getState().setBase(object.id, { transform: { ...t, x: t.x + d.x, y: t.y + d.y } })
    })
  }

  if (useDocumentStore.getState().doc === before) return false
  const label = [...ALIGNMENT_OPTIONS, ...DISTRIBUTION_OPTIONS].find((o) => o.how === how)?.label ?? 'Align'
  useDocumentStore.getState().commit(label)
  return true
}
