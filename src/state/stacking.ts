/**
 * Where a thing sits among its siblings.
 *
 * One rule for every ordered list the document keeps — the objects on the
 * artboard, the members of a frame — because "bring forward" means the same
 * whichever list it is asked of, and the first time it was written twice the
 * two copies would have drifted.
 */
export type Stacking = 'front' | 'back' | 'forward' | 'backward'

/**
 * `order` with `ids` moved together, keeping their order among themselves:
 * to the very front (end) or back (start), or one step past the nearest
 * entry that is not one of them. Null when nothing would change — at an
 * end already, or none of the ids present.
 */
export function restack(
  order: readonly string[],
  ids: readonly string[],
  to: Stacking,
): string[] | null {
  const moving = order.filter((id) => ids.includes(id))
  if (moving.length === 0) return null
  const rest = order.filter((id) => !ids.includes(id))
  let next: string[]
  if (to === 'back') next = [...moving, ...rest]
  else if (to === 'front') next = [...rest, ...moving]
  else {
    // One step past the nearest outsider, as a block; the block's own
    // members are stepped over, not swapped with.
    const first = order.indexOf(moving[0]!)
    const last = order.indexOf(moving[moving.length - 1]!)
    const at =
      to === 'forward'
        ? rest.findIndex((id) => order.indexOf(id) > last)
        : rest.map((id) => order.indexOf(id) < first).lastIndexOf(true)
    if (at === -1) return null
    const cut = to === 'forward' ? at + 1 : at
    next = [...rest.slice(0, cut), ...moving, ...rest.slice(cut)]
  }
  return next.every((id, i) => id === order[i]) ? null : next
}

/** The undo label a stacking move is recorded under. */
export function stackingLabel(to: Stacking): string {
  return to === 'front'
    ? 'Bring to front'
    : to === 'back'
      ? 'Send to back'
      : to === 'forward'
        ? 'Bring forward'
        : 'Send backward'
}
