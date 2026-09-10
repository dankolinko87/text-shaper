import { useEffect, type RefObject } from 'react'

/**
 * Close on a press anywhere else, or on Escape.
 *
 * Captured on the document rather than on the control: a menu that closes only
 * on its own button is a menu that stays open behind the next thing you do, and
 * these float over the canvas, where the next thing is usually a click on the
 * artboard.
 *
 * Shared by every menu in the app, so they cannot drift into dismissing
 * differently — which is exactly the sort of difference nobody notices until one
 * of them is stuck open. `close` should be stable (a `useCallback`), or the
 * listeners are re-bound on every render.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, ref])
}
