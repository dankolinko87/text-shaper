import { useDocumentStore } from './documentStore'
import { putFileAutosave, restoreFileAutosave } from './fileAutosave'
import {
  keepAutosaveAsPrevious,
  loadAutosave,
  loadPreviousAutosave,
  saveAutosave,
  serializeDocument,
} from './persistence'

/**
 * Keeping work across a page reload.
 *
 * Everything made in this tool lives only in memory: a refresh — deliberate,
 * accidental, or forced by the dev server — would take every shape with it.
 *
 * Autosave is separate from Save. Save is a checkpoint the user chose to make,
 * and Open returns to it; autosave is a safety net that follows whatever is on
 * screen. They write to different keys so that opening a save and then typing
 * does not silently destroy the save you opened.
 *
 * History is NOT restored. Undo describes a session — offering to undo past the
 * moment a document was reopened would promise something the snapshots cannot
 * deliver, since only the document itself was written down.
 *
 * ## What a safety net has to survive
 *
 * The first version of this had one slot and wrote to it on every store change.
 * That made it a single point of failure the app overwrote several times a
 * minute, and it destroyed real work like this:
 *
 * 1. Something makes the snapshot unreadable — most easily a bump to
 *    `DOCUMENT_SCHEMA_VERSION`, which makes `deserializeDocument` reject the
 *    file outright as "made with a newer version".
 * 2. Restore fails, so the canvas comes up empty.
 * 3. The subscription fired on ANY document-store change, selection included,
 *    so the very first click wrote the empty document over the only copy.
 *
 * Three rules follow, and each one alone would have prevented it:
 *
 * - **Write only when the DOCUMENT changes.** A selection is not work.
 * - **Never write an empty document over a snapshot unless the user emptied it
 *   themselves**, which `past` distinguishes: nothing committed this session
 *   means the emptiness came from a failed boot, not from a decision.
 * - **Keep what was there when the session started**, so one bad write is
 *   recoverable rather than final.
 */

/** How long the document must sit still before it is written. */
const QUIET_MS = 400

/**
 * How a session began, which decides what autosave is allowed to do next.
 *
 * `failed` is the dangerous one and the reason this is a result rather than a
 * boolean: there IS a snapshot, it holds work, and this build cannot read it.
 * Everything about the session that follows has to avoid destroying it.
 */
export type RestoreResult =
  | { kind: 'restored'; from: 'current' | 'previous' }
  | { kind: 'nothing' }
  | { kind: 'failed'; error: string }

export function restoreAutosave(): RestoreResult {
  /*
   * Nothing on the canvas yet is the only safe moment to replace the document
   * wholesale: doing it later would throw away whatever is already there.
   */
  if (useDocumentStore.getState().doc.objectOrder.length > 0) return { kind: 'nothing' }

  const current = loadAutosave()
  if (current.ok && current.doc) {
    useDocumentStore.getState().loadDocument(current.doc)
    return { kind: 'restored', from: 'current' }
  }

  /*
   * The current snapshot is unreadable, so fall back to what the last session
   * started with. This is the whole point of keeping two: a build that cannot
   * read the newest file can very often read the one before it.
   */
  const previous = loadPreviousAutosave()
  if (previous.ok && previous.doc) {
    useDocumentStore.getState().loadDocument(previous.doc)
    return { kind: 'restored', from: 'previous' }
  }

  // Told apart deliberately. "Nothing saved" is an ordinary first run; a snapshot
  // that exists and will not load is work at risk, and the caller must know.
  if (current.error === 'Nothing autosaved.') {
    /*
     * Nothing in THIS browser's storage — which is not the same as nothing
     * saved. The preview pane in the desktop app opens a fresh profile every
     * session, so the dev server keeps a copy as a file; it is asked now, and
     * loads only into a session that is still empty when it answers.
     */
    void restoreFileAutosave()
    return { kind: 'nothing' }
  }
  return { kind: 'failed', error: current.error ?? 'The autosave could not be read.' }
}

/**
 * Write the document whenever it settles, until the returned function is called.
 *
 * Debounced rather than written on every change: a drag streams updates at
 * pointer rate, and serialising a document full of path data on each one would
 * be felt in the gesture.
 *
 * `restored` is how the session began — pass what `restoreAutosave` returned.
 * Without it this cannot tell an empty canvas that is a fresh start from an
 * empty canvas that is a failure to load, and those need opposite treatment.
 */
export function startAutosave(restored: RestoreResult): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let keptPrevious = false

  /*
   * A snapshot this build could not read is the only copy of that work. Writing
   * ANYTHING over it destroys it, so this session does not write at all — it
   * runs without a net rather than cutting someone else's.
   */
  if (restored.kind === 'failed') {
    console.warn(
      `[autosave] disabled for this session: the stored document could not be read (${restored.error}). ` +
        'It has been left untouched so it can be recovered.',
    )
    return () => {}
  }

  const write = (): void => {
    const state = useDocumentStore.getState()

    /*
     * An empty document is only worth writing when the user emptied it.
     *
     * Nothing committed this session means nothing has been done, so an empty
     * canvas is how the session STARTED — a failed load, a storage hiccup, a
     * race — and writing it would replace real work with the evidence of a bug.
     * Delete everything by hand and `past` says so, and the write goes ahead.
     */
    if (state.doc.objectOrder.length === 0 && state.past.length === 0) return

    // Once per session, before anything of ours can land on it, so there is
    // always a copy of what this session inherited.
    if (!keptPrevious) {
      keptPrevious = true
      keepAutosaveAsPrevious()
    }

    if (!saveAutosave(state.doc)) {
      // Almost always the storage quota. Silence here is how a net that stopped
      // working goes unnoticed until it is needed.
      console.warn('[autosave] could not write the document to local storage.')
    }
    // And the copy that outlives this browser profile, while there is a server to keep it.
    putFileAutosave(serializeDocument(state.doc))
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      write()
    }, QUIET_MS)
  }

  /*
   * The DOCUMENT, not the store.
   *
   * Selection lives in the same store and changes on every click, so
   * subscribing to the whole thing re-serialised the document — and gave a bare
   * click the power to overwrite the snapshot. Comparing the reference is
   * enough: every mutation replaces `doc` wholesale.
   */
  let seen = useDocumentStore.getState().doc
  const unsubscribe = useDocumentStore.subscribe((state) => {
    if (state.doc === seen) return
    seen = state.doc
    schedule()
  })

  // A reload during the quiet window would otherwise lose the last few edits.
  const flush = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
    write()
  }
  window.addEventListener('beforeunload', flush)

  return () => {
    unsubscribe()
    window.removeEventListener('beforeunload', flush)
    if (timer) clearTimeout(timer)
  }
}
