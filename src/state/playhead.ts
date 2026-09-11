import { create } from 'zustand'

/**
 * Where playback has got to, per object, in authored milliseconds.
 *
 * Its own store rather than a field of the UI store: it is written on every
 * animation frame, and a store that changes sixty times a second should be one
 * that only the things watching the clock subscribe to. The canvas loops write
 * it; the state lists read it to run their cards like film. Nothing is undone
 * or saved from here — it is a clock, and a clock is not a document.
 */
interface PlayheadState {
  at: Readonly<Record<string, number>>
}

export const usePlayhead = create<PlayheadState>()(() => ({ at: {} }))

export function setPlayhead(id: string, authoredMs: number): void {
  usePlayhead.setState((state) => ({ at: { ...state.at, [id]: authoredMs } }))
}

/** The loop has stopped for these objects: their clocks go, so the film stops running. */
export function clearPlayhead(ids: readonly string[]): void {
  usePlayhead.setState((state) => {
    const at = { ...state.at }
    for (const id of ids) delete at[id]
    return { at }
  })
}
