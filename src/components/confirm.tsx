import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import './controls.css'

/**
 * "Are you sure?", asked by the app itself.
 *
 * `window.confirm` was the dialog before, and inside an embedded browser —
 * the desktop app's pane, a web view — the host answers it: `false`, at
 * once, with nothing shown. So deleting a project was impossible there, and
 * would have been anywhere else that suppresses native dialogs. This is the
 * same question with the same answer, drawn by the app: one call that
 * resolves to whether the person said yes, and one host that renders whatever
 * is being asked.
 *
 * Escape and Cancel say no; Enter and the named button say yes. The first
 * press lands on Cancel, so a stray Enter refuses rather than destroys.
 */
export interface ConfirmRequest {
  title: string
  message: string
  /** What the yes button says — the verb, as in "Delete". */
  confirmLabel: string
  /** A destructive yes wears the danger colour. */
  danger?: boolean
}

interface Pending extends ConfirmRequest {
  resolve: (answer: boolean) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

/** Ask, and hear back once the person has answered. A second question while one is open answers the first with no. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = { ...request, resolve }
    notify()
  })
}

function answer(yes: boolean): void {
  const current = pending
  pending = null
  notify()
  current?.resolve(yes)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ConfirmHost() {
  const request = useSyncExternalStore(subscribe, () => pending)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        answer(false)
      } else if (e.key === 'Enter') {
        e.stopImmediatePropagation()
        answer(true)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [request])

  if (!request) return null
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={() => answer(false)}>
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="confirm__title" id="confirm-title">
          {request.title}
        </h2>
        <p className="confirm__message" id="confirm-message">
          {request.message}
        </p>
        <div className="confirm__actions">
          <button type="button" className="button" ref={cancelRef} onClick={() => answer(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${request.danger ? 'button--danger' : 'button--primary'}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
