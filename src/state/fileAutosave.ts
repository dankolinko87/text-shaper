import { useDocumentStore } from './documentStore'
import { deserializeDocument } from './persistence'

/**
 * The dev server's copy of the autosave — see `vite/fileAutosave.ts`.
 *
 * The browser's storage is the first net and this is the second: a file the
 * server keeps, which a new browser profile, a new port or a new session
 * cannot lose. Read when the browser has nothing; written after every
 * autosave. Only where there is a dev server to talk to.
 */

const PATH = '/__autosave'

const available = (): boolean => import.meta.env.DEV && typeof fetch === 'function'

/** The document the server holds, or null for none (or no server). */
export async function fetchFileAutosave(): Promise<string | null> {
  if (!available()) return null
  try {
    const response = await fetch(PATH, { cache: 'no-store' })
    if (response.status !== 200) return null
    const raw = await response.text()
    return raw || null
  } catch {
    return null
  }
}

/** Put a serialised document on the server; silent when there is no server. */
export function putFileAutosave(raw: string): void {
  if (!available()) return
  void fetch(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: raw }).catch(
    () => {},
  )
}

/**
 * Load the server's copy into an EMPTY session — one with nothing on the
 * canvas and nothing done. Anything else is work, and this must never write
 * over work. True when the document was taken.
 */
export async function restoreFileAutosave(): Promise<boolean> {
  const raw = await fetchFileAutosave()
  if (!raw) return false
  const state = useDocumentStore.getState()
  if (state.doc.objectOrder.length > 0 || state.past.length > 0) return false
  const result = deserializeDocument(raw)
  if (!result.ok || !result.doc || result.doc.objectOrder.length === 0) return false
  state.loadDocument(result.doc)
  return true
}
