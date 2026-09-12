import type { TextShaperDocument } from '../types/document'
import { deserializeDocument, serializeDocument, type DeserializeResult } from './persistence'

/**
 * Several projects in one browser: what is kept where.
 *
 * A project is a document with a card: its name, when it was made and last
 * edited, and a small picture of its artboard. The INDEX of cards lives
 * under one key and each document under its own, so opening a project reads
 * one document rather than all of them, and a document too large to fit
 * cannot take the others with it. Every document goes through
 * `serializeDocument` / `deserializeDocument`, so a project is migrated and
 * checked on the way in exactly as the single autosave was.
 *
 * Pure storage: no store, no React. The projects store decides what to
 * write; this decides how.
 */

export interface ProjectRecord {
  id: string
  name: string
  /** ISO timestamps. */
  createdAt: string
  updatedAt: string
  /** A PNG data URL of the artboard, or null before anything was drawn. */
  thumbnail: string | null
}

export interface Workspace {
  /** The project on the canvas. */
  current: string
  projects: ProjectRecord[]
}

/** Everything, as one object — what the dev server keeps as a file. */
export interface WorkspaceEnvelope {
  workspace: Workspace
  /** Serialised documents by project id; a project never written has none. */
  documents: Record<string, string>
}

const WORKSPACE_KEY = 'text-shaper:workspace:v1'
const projectKey = (id: string): string => `text-shaper:project:${id}:v1`
const previousKey = (id: string): string => `text-shaper:project:${id}:previous:v1`

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
const remove = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage being unavailable is not worth surfacing here.
  }
}

/** The card a document gets. */
export function recordFor(doc: TextShaperDocument, thumbnail: string | null = null): ProjectRecord {
  return { id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt, thumbnail }
}

function isRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string' &&
    (record['thumbnail'] === null || typeof record['thumbnail'] === 'string')
  )
}

/** A workspace from its JSON, or null when it is not one. */
export function parseWorkspace(raw: string | null): Workspace | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { current?: unknown; projects?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) return null
    const projects = parsed.projects.filter(isRecord)
    if (projects.length === 0) return null
    const current =
      typeof parsed.current === 'string' && projects.some((each) => each.id === parsed.current)
        ? parsed.current
        : (projects[0] as ProjectRecord).id
    return { current, projects }
  } catch {
    return null
  }
}

export function readWorkspace(): Workspace | null {
  return parseWorkspace(read(WORKSPACE_KEY))
}

export function writeWorkspace(workspace: Workspace): boolean {
  return write(WORKSPACE_KEY, JSON.stringify(workspace))
}

export function readProjectRaw(id: string): string | null {
  return read(projectKey(id))
}

export function writeProjectRaw(id: string, raw: string): boolean {
  return write(projectKey(id), raw)
}

/** The document, migrated and checked — or why not. */
export function readProject(id: string): DeserializeResult {
  const raw = readProjectRaw(id)
  if (!raw) return { ok: false, error: 'Nothing saved for this project.' }
  return deserializeDocument(raw)
}

/** The copy of a project from before this session first wrote it. */
export function readPreviousProject(id: string): DeserializeResult {
  const raw = read(previousKey(id))
  if (!raw) return { ok: false, error: 'Nothing saved for this project.' }
  return deserializeDocument(raw)
}

/**
 * Keep what is on disk for a project before this session writes over it —
 * the autosave's rule, per project: one bad write is then recoverable.
 */
export function keepProjectAsPrevious(id: string): void {
  const raw = read(projectKey(id))
  if (raw) write(previousKey(id), raw)
}

export function removeProject(id: string): void {
  remove(projectKey(id))
  remove(previousKey(id))
}

/** Everything in storage, for the file the dev server keeps; null with no workspace. */
export function workspaceEnvelope(): WorkspaceEnvelope | null {
  const workspace = readWorkspace()
  if (!workspace) return null
  const documents: Record<string, string> = {}
  for (const record of workspace.projects) {
    const raw = readProjectRaw(record.id)
    if (raw) documents[record.id] = raw
  }
  return { workspace, documents }
}

/** Whether a parsed file is a workspace envelope rather than one document. */
export function isEnvelope(value: unknown): value is WorkspaceEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['workspace'] === 'object' &&
    candidate['workspace'] !== null &&
    typeof candidate['documents'] === 'object' &&
    candidate['documents'] !== null
  )
}

/**
 * Put an envelope into storage. Only documents that read back as documents
 * are kept, and only projects that have one or never had one stay listed.
 */
export function restoreEnvelope(envelope: WorkspaceEnvelope): Workspace | null {
  const workspace = parseWorkspace(JSON.stringify(envelope.workspace))
  if (!workspace) return null
  const kept: ProjectRecord[] = []
  for (const record of workspace.projects) {
    const raw = envelope.documents[record.id]
    if (raw === undefined) {
      kept.push(record)
      continue
    }
    if (!deserializeDocument(raw).ok) continue
    writeProjectRaw(record.id, raw)
    kept.push(record)
  }
  if (kept.length === 0) return null
  const current = kept.some((each) => each.id === workspace.current) ? workspace.current : (kept[0] as ProjectRecord).id
  const restored = { current, projects: kept }
  writeWorkspace(restored)
  return restored
}

/** The serialised form a project file holds: the document alone. */
export function projectFile(doc: TextShaperDocument): string {
  return serializeDocument(doc)
}
