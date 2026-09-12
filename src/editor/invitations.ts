import type { IconName } from '../components/Icon'
import type { Stated, Tiled } from '../types/document'
import { token } from './colours'

/**
 * What an empty thing with states says — see `EmptyHints`, which draws it.
 * Its own module so the words can be checked without a canvas.
 */

export interface Invitation {
  icon: IconName
  hint: string
}

/**
 * Whether NOTHING has been authored in a mosaic or mesh: no letters, but also
 * no tile or letter colour, no backdrop, no border, no lines, in any state.
 *
 * Letters alone were the test, and a grid coloured tile by tile with no text
 * in it — which is a thing people make — kept inviting them to type over
 * their own work. What is authored is what the panel can author; the grid's
 * shape and spacing are not counted, because a grid is always some shape.
 */
export function untouched(object: Tiled): boolean {
  return object.states.every(
    (state) =>
      Object.keys(state.chars).length === 0 &&
      Object.keys(state.glyphColour).length === 0 &&
      Object.values(state.tileColour).every((colour) => colour === null) &&
      (state.background ?? null) === null &&
      (state.stroke ?? null) === null &&
      !('lines' in state && state.lines),
  )
}

/** Whether nothing has been put in yet, and what to say about it. */
export function invitationFor(object: Stated): Invitation | null {
  switch (object.kind) {
    case 'frame':
      return object.members.length === 0
        ? { icon: 'frame', hint: 'Drag objects in, or draw inside it' }
        : null
    case 'mosaic':
      return untouched(object) ? { icon: 'mosaic', hint: 'Double-click a tile and type' } : null
    case 'mesh':
      return untouched(object) ? { icon: 'mesh', hint: 'Double-click a cell and type' } : null
  }
}

/**
 * The ground an empty object stands on: a light grey a step darker than the
 * page, over its whole silhouette and with no lines through it, so an empty
 * frame, mosaic or mesh is a shape on the page rather than nothing. Null
 * once something has been put in.
 */
export function emptyGround(object: Stated): string | null {
  return invitationFor(object) ? token('--empty-ground', 'rgba(27, 29, 33, 0.07)') : null
}

/**
 * The ground as DRAWN under `object`, given which object the plate stands
 * under (`held`).
 *
 * The plate under a held object is the same light green over the same box,
 * so an object that painted its own ground as well would be twice as dark
 * inside the plate as the plate is — a rounded shape inside a square one.
 * Held, the plate IS the ground; the object's own is for when nothing holds
 * it.
 */
export function groundFor(object: Stated, held?: string | null): string | null {
  return held === object.id ? null : emptyGround(object)
}

/**
 * How round the ground's corners are: a share of the shorter side, so a big
 * empty frame and a small one are rounded alike. The plate under a held
 * object is square; the rounding is what says "nothing holds this".
 */
export const GROUND_ROUNDING = 0.06

export function groundRadius(width: number, height: number): number {
  return Math.max(0, Math.min(width, height)) * GROUND_ROUNDING
}
