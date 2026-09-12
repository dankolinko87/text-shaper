import { ActiveSelection, type FabricObject, type Group } from 'fabric'

/**
 * What a Fabric target says about frame MEMBERS.
 *
 * A member child carries its own object's `shapeId` as well as a `memberId`,
 * so it is asked for the member first. And more than one member held at once
 * is an `ActiveSelection` — Fabric names the selection as the target of the
 * press and the drag, and the selection itself carries no `memberId`, so
 * every handler that used to ask the target has to look through it. One
 * place for that look, or each handler would answer it a little differently.
 */

/** Every member a target stands for: the members of a selection, the one member, or none. */
export function membersOf(target: FabricObject | undefined): string[] {
  if (!target) return []
  const held = target instanceof ActiveSelection ? target.getObjects() : [target]
  return held
    .map((o) => o.get('memberId') as string | undefined)
    .filter((id): id is string => Boolean(id))
}

/**
 * The object a gesture is really about: a member when the target is one, or
 * the first member inside an `ActiveSelection` of them; the target itself
 * otherwise.
 */
export function memberProbe(target: FabricObject | undefined): FabricObject | undefined {
  if (target instanceof ActiveSelection) {
    return target.getObjects().find((o) => o.get('memberId')) ?? target
  }
  return target
}

/**
 * The group a member child belongs to — its frame's window — whether Fabric
 * is holding it alone (`group`) or with others in an `ActiveSelection`, which
 * takes `group` for itself and leaves the real one as `parent`.
 */
export function memberParentOf(
  child: FabricObject | undefined,
): { get?: (key: string) => unknown } | undefined {
  if (!child) return undefined
  const held = child as FabricObject & { parent?: Group }
  return (held.parent ?? held.group) as { get?: (key: string) => unknown } | undefined
}
