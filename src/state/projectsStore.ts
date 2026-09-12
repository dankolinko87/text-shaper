import { create } from 'zustand'

import type { TextShaperDocument } from '../types/document'
import { createId } from '../utils/id'
import { createEmptyDocument } from './defaults'
import { useDocumentStore } from './documentStore'
import { loadAutosave, loadPreviousAutosave, serializeDocument, deserializeDocument } from './persistence'
import {
  keepProjectAsPrevious,
  readPreviousProject,
  readProject,
  readProjectRaw,
  readWorkspace,
  recordFor,
  removeProject,
  writeProjectRaw,
  writeWorkspace,
  type ProjectRecord,
} from './projects'
import { useUiStore } from './uiStore'

/**
 * The open projects, and which one is on the canvas.
 *
 * The document store still holds ONE document — the current project's — so
 * everything that edits, undoes or renders is untouched. This store is the
 * shelf beside it: the cards, the switching, and the writes that put a
 * document away before another is taken out. Undo is per session and does
 * not follow a project across a switch, the rule `autosave.ts` gives.
 */

export type RestoreResult =
  | { kind: 'restored'; from: 'current' | 'previous' | 'legacy' }
  | { kind: 'nothing' }
  | { kind: 'failed'; error: string }

interface ProjectsState {
  projects: ProjectRecord[]
  currentId: string | null
  /** How the current project is pictured; set by the editor once it has a canvas. */
  snapshot: () => string | null
  setSnapshot: (snapshot: () => string | null) => void

  /** Boot: the workspace, or the old single autosave as project 1, or a fresh project. */
  restoreWorkspace: () => RestoreResult
  /** Put the current document away: its key, its card, the index. */
  saveCurrent: (options?: { thumbnail?: string | null }) => boolean
  openProject: (id: string) => boolean
  newProject: (name?: string) => string
  duplicateProject: (id: string) => string | null
  /** Gone; the last one is replaced by a fresh empty project. Returns the project now open. */
  deleteProject: (id: string) => string | null
  renameProject: (id: string, name: string) => void
  /** A document from a file becomes a new project, opened. Returns an error to show, or null. */
  importProject: (raw: string) => string | null
  /** The serialised document of a project, for a file. */
  exportProject: (id: string) => string | null
  /** The document just loaded from elsewhere becomes the current project's identity. */
  adoptDocument: (doc: TextShaperDocument) => void
  /** A fresh picture of the current project on its card, without writing anything. */
  refreshCurrentThumbnail: () => void
}

const now = (): string => new Date().toISOString()

/** The editor's per-project furniture, cleared when the project changes. */
function clearProjectUi(): void {
  const ui = useUiStore.getState()
  if (ui.playing) ui.setPlaying(false)
  useUiStore.setState({
    typing: null,
    mosaicSelection: [],
    mosaicStates: {},
    mosaicPlayback: null,
    insideFrame: null,
    frameSelection: [],
    spread: null,
    editingPoints: null,
    previewObject: null,
    viewportAdjusted: false,
  })
}

/** "Untitled", or the first "Untitled N" nobody has. */
function untitledName(projects: readonly ProjectRecord[]): string {
  const taken = new Set(projects.map((each) => each.name))
  if (!taken.has('Untitled')) return 'Untitled'
  for (let n = 2; ; n++) if (!taken.has(`Untitled ${n}`)) return `Untitled ${n}`
}

const byRecency = (a: ProjectRecord, b: ProjectRecord): number => b.updatedAt.localeCompare(a.updatedAt)

export const useProjectsStore = create<ProjectsState>((set, get) => {
  const loadInto = (doc: TextShaperDocument): void => {
    useDocumentStore.getState().loadDocument(doc)
    clearProjectUi()
  }

  const persistIndex = (): void => {
    const { projects, currentId } = get()
    if (!currentId || projects.length === 0) return
    writeWorkspace({ current: currentId, projects })
  }

  /** The document a project holds: what is saved, or an empty one with its identity. */
  const documentOf = (record: ProjectRecord): TextShaperDocument | null => {
    const raw = readProjectRaw(record.id)
    if (!raw) {
      const empty = createEmptyDocument(record.name)
      return { ...empty, id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt }
    }
    const result = deserializeDocument(raw)
    return result.ok && result.doc ? result.doc : null
  }

  return {
    projects: [],
    currentId: null,
    snapshot: () => null,
    setSnapshot: (snapshot) => set({ snapshot }),

    restoreWorkspace() {
      const workspace = readWorkspace()
      if (workspace) {
        const ordered = [
          ...workspace.projects.filter((each) => each.id === workspace.current),
          ...workspace.projects.filter((each) => each.id !== workspace.current).sort(byRecency),
        ]
        let failure: string | null = null
        for (const record of ordered) {
          const raw = readProjectRaw(record.id)
          if (!raw) {
            // Never written: an empty project with its card's identity.
            set({ projects: workspace.projects, currentId: record.id })
            loadInto(documentOf(record) as TextShaperDocument)
            persistIndex()
            return { kind: 'restored', from: 'current' }
          }
          const result = deserializeDocument(raw)
          if (result.ok && result.doc) {
            set({ projects: workspace.projects, currentId: record.id })
            loadInto(result.doc)
            persistIndex()
            return { kind: 'restored', from: record.id === workspace.current ? 'current' : 'previous' }
          }
          // The copy from before the last session wrote it, if that reads.
          const previous = readPreviousProject(record.id)
          if (previous.ok && previous.doc) {
            set({ projects: workspace.projects, currentId: record.id })
            loadInto(previous.doc)
            persistIndex()
            return { kind: 'restored', from: 'previous' }
          }
          failure = failure ?? result.error ?? 'The project could not be read.'
        }
        // Every project exists and none reads: work at risk, left untouched.
        set({ projects: workspace.projects, currentId: workspace.current })
        return { kind: 'failed', error: failure ?? 'The workspace could not be read.' }
      }

      // Before there were projects there was one autosave; it becomes project 1.
      const legacy = loadAutosave()
      const fallback = legacy.ok ? legacy : loadPreviousAutosave()
      if (fallback.ok && fallback.doc) {
        const doc = fallback.doc
        const record = recordFor(doc)
        writeProjectRaw(doc.id, serializeDocument(doc))
        set({ projects: [record], currentId: doc.id })
        persistIndex()
        loadInto(doc)
        return { kind: 'restored', from: 'legacy' }
      }
      if (legacy.error && legacy.error !== 'Nothing autosaved.') {
        return { kind: 'failed', error: legacy.error }
      }

      // A fresh start: the document already in the store is project 1. Its
      // card is written now; its document only once there is work in it.
      const doc = useDocumentStore.getState().doc
      set({ projects: [recordFor(doc)], currentId: doc.id })
      persistIndex()
      return { kind: 'nothing' }
    },

    saveCurrent(options = {}) {
      const { currentId, projects } = get()
      const doc = useDocumentStore.getState().doc
      if (!currentId) return false
      const index = projects.findIndex((each) => each.id === currentId)
      if (index < 0) return false
      const was = projects[index] as ProjectRecord
      const record: ProjectRecord = {
        ...was,
        name: doc.name,
        updatedAt: doc.updatedAt,
        thumbnail: options.thumbnail === undefined ? was.thumbnail : options.thumbnail,
      }
      const next = [...projects]
      next[index] = record
      set({ projects: next })
      const wrote = writeProjectRaw(currentId, serializeDocument(doc))
      persistIndex()
      return wrote
    },

    openProject(id) {
      const { currentId, projects } = get()
      const record = projects.find((each) => each.id === id)
      if (!record) return false
      if (id === currentId) return true
      const doc = documentOf(record)
      if (!doc) return false
      get().saveCurrent({ thumbnail: get().snapshot() })
      set({ currentId: id })
      loadInto(doc)
      persistIndex()
      return true
    },

    newProject(name) {
      get().saveCurrent({ thumbnail: get().snapshot() })
      const doc = createEmptyDocument(name?.trim() || untitledName(get().projects))
      set({ projects: [recordFor(doc), ...get().projects], currentId: doc.id })
      loadInto(doc)
      persistIndex()
      return doc.id
    },

    duplicateProject(id) {
      const { currentId, projects } = get()
      const source = projects.find((each) => each.id === id)
      if (!source) return null
      const original = id === currentId ? useDocumentStore.getState().doc : documentOf(source)
      if (!original) return null
      get().saveCurrent({ thumbnail: get().snapshot() })
      const stamp = now()
      const doc: TextShaperDocument = {
        ...original,
        id: createId('doc'),
        name: `${source.name} copy`,
        createdAt: stamp,
        updatedAt: stamp,
      }
      writeProjectRaw(doc.id, serializeDocument(doc))
      const record = recordFor(doc, id === currentId ? get().snapshot() : source.thumbnail)
      set({ projects: [record, ...get().projects], currentId: doc.id })
      loadInto(doc)
      persistIndex()
      return doc.id
    },

    deleteProject(id) {
      const { currentId, projects } = get()
      if (!projects.some((each) => each.id === id)) return currentId
      const others = projects.filter((each) => each.id !== id)
      if (others.length === 0) {
        // The last project: a fresh one takes its place, so there is always a canvas.
        const doc = createEmptyDocument('Untitled')
        set({ projects: [recordFor(doc)], currentId: doc.id })
        loadInto(doc)
        removeProject(id)
        persistIndex()
        return doc.id
      }
      if (id === currentId) {
        const next = [...others].sort(byRecency)[0] as ProjectRecord
        const doc = documentOf(next)
        set({ projects: others, currentId: next.id })
        if (doc) loadInto(doc)
        removeProject(id)
        persistIndex()
        return next.id
      }
      set({ projects: others })
      removeProject(id)
      persistIndex()
      return currentId
    },

    renameProject(id, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      const { currentId, projects } = get()
      if (!projects.some((each) => each.id === id)) return
      set({ projects: projects.map((each) => (each.id === id ? { ...each, name: trimmed } : each)) })
      if (id === currentId) {
        const store = useDocumentStore.getState()
        if (store.doc.name !== trimmed) {
          store.setDocumentName(trimmed)
          store.commit('Rename document')
        }
      } else {
        // Renamed on the shelf: the document's own name follows, so a file of it says the same.
        const raw = readProjectRaw(id)
        if (raw) {
          const result = deserializeDocument(raw)
          if (result.ok && result.doc) writeProjectRaw(id, serializeDocument({ ...result.doc, name: trimmed }))
        }
      }
      persistIndex()
    },

    importProject(raw) {
      const result = deserializeDocument(raw)
      if (!result.ok || !result.doc) return result.error ?? 'That file is not a Text Shaper document.'
      get().saveCurrent({ thumbnail: get().snapshot() })
      const stamp = now()
      const doc: TextShaperDocument = { ...result.doc, id: createId('doc'), createdAt: stamp, updatedAt: stamp }
      writeProjectRaw(doc.id, serializeDocument(doc))
      set({ projects: [recordFor(doc), ...get().projects], currentId: doc.id })
      loadInto(doc)
      persistIndex()
      return null
    },

    exportProject(id) {
      const { currentId, projects } = get()
      if (id === currentId) return serializeDocument(useDocumentStore.getState().doc)
      const record = projects.find((each) => each.id === id)
      if (!record) return null
      const doc = documentOf(record)
      return doc ? serializeDocument(doc) : null
    },

    refreshCurrentThumbnail() {
      const { currentId, projects, snapshot } = get()
      if (!currentId) return
      const picture = snapshot()
      if (!picture) return
      set({ projects: projects.map((each) => (each.id === currentId ? { ...each, thumbnail: picture } : each)) })
    },

    adoptDocument(doc) {
      const { currentId, projects } = get()
      const rest = projects.filter((each) => each.id !== currentId)
      set({ projects: [recordFor(doc), ...rest], currentId: doc.id })
      if (currentId && currentId !== doc.id) removeProject(currentId)
      writeProjectRaw(doc.id, serializeDocument(doc))
      persistIndex()
    },
  }
})

/*
 * The top bar renames the DOCUMENT; the card follows. The other direction
 * (a card renamed on the shelf) goes through `renameProject`.
 */
let seenName: string | null = null
useDocumentStore.subscribe((state) => {
  const name = state.doc.name
  if (name === seenName) return
  seenName = name
  const { currentId, projects } = useProjectsStore.getState()
  if (!currentId) return
  const current = projects.find((each) => each.id === currentId)
  if (!current || current.name === name) return
  useProjectsStore.setState({
    projects: projects.map((each) => (each.id === currentId ? { ...each, name } : each)),
  })
})

/** Once per session per project: keep what was on disk before we write over it. */
const kept = new Set<string>()
export function keepBeforeFirstWrite(id: string): void {
  if (kept.has(id)) return
  kept.add(id)
  keepProjectAsPrevious(id)
}

/** For tests: forget which projects this session has already kept a copy of. */
export function resetKeptForTests(): void {
  kept.clear()
}

/** The document store's read of whether anything has been done this session. */
export function sessionHasWork(): boolean {
  const state = useDocumentStore.getState()
  return state.doc.objectOrder.length > 0 || state.past.length > 0
}

/** The project a document belongs to has that document's id — a helper for the rail. */
export function currentProject(): ProjectRecord | null {
  const { currentId, projects } = useProjectsStore.getState()
  return projects.find((each) => each.id === currentId) ?? null
}

export { readProject }
