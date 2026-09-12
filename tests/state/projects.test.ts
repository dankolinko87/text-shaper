import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEmptyDocument } from '../../src/state/defaults'
import { useDocumentStore } from '../../src/state/documentStore'
import { serializeDocument } from '../../src/state/persistence'
import {
  isEnvelope,
  keepProjectAsPrevious,
  parseWorkspace,
  readPreviousProject,
  readProject,
  readProjectRaw,
  readWorkspace,
  recordFor,
  removeProject,
  restoreEnvelope,
  workspaceEnvelope,
  writeProjectRaw,
  writeWorkspace,
} from '../../src/state/projects'

/**
 * Where projects are kept: an index of cards under one key and a document
 * under each project's own, so one project is read at a time.
 */

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  useDocumentStore.getState().resetDocument()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A document with a mosaic in it, serialised. */
function drawn(name: string): { doc: ReturnType<typeof createEmptyDocument>; raw: string } {
  const store = useDocumentStore.getState()
  store.loadDocument(createEmptyDocument(name))
  store.createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
  const doc = useDocumentStore.getState().doc
  return { doc, raw: serializeDocument(doc) }
}

describe('the index', () => {
  it('round-trips, and reads back nothing for what is not a workspace', () => {
    const a = recordFor(createEmptyDocument('A'))
    const b = recordFor(createEmptyDocument('B'), 'data:image/png;base64,xyz')
    expect(writeWorkspace({ current: b.id, projects: [a, b] })).toBe(true)
    expect(readWorkspace()).toEqual({ current: b.id, projects: [a, b] })
    expect(parseWorkspace('not json')).toBeNull()
    expect(parseWorkspace('{"projects":[]}')).toBeNull()
    // A current that names nobody falls back to the first card.
    expect(parseWorkspace(JSON.stringify({ current: 'ghost', projects: [a] }))?.current).toBe(a.id)
    // A card missing a field is dropped rather than trusted.
    expect(parseWorkspace(JSON.stringify({ current: a.id, projects: [a, { id: 'x' }] }))?.projects).toEqual([a])
  })
})

describe('a project', () => {
  it('is written under its own key and read back migrated and checked', () => {
    const { doc, raw } = drawn('One')
    expect(writeProjectRaw(doc.id, raw)).toBe(true)
    expect(readProjectRaw(doc.id)).toBe(raw)
    const result = readProject(doc.id)
    expect(result.ok).toBe(true)
    expect(result.doc?.objectOrder).toHaveLength(1)
    expect(readProject('nobody')).toEqual({ ok: false, error: 'Nothing saved for this project.' })
    writeProjectRaw('bad', '{"nope":true}')
    expect(readProject('bad').ok).toBe(false)
  })

  it('keeps a copy from before the session writes, and removes both when it goes', () => {
    const { doc, raw } = drawn('One')
    writeProjectRaw(doc.id, raw)
    keepProjectAsPrevious(doc.id)
    writeProjectRaw(doc.id, serializeDocument({ ...doc, name: 'Changed' }))
    expect(readProject(doc.id).doc?.name).toBe('Changed')
    expect(readPreviousProject(doc.id).doc?.name).toBe('One')
    removeProject(doc.id)
    expect(readProject(doc.id).ok).toBe(false)
    expect(readPreviousProject(doc.id).ok).toBe(false)
  })
})

describe('the envelope', () => {
  it('holds every card and every written document, and restores them', () => {
    const one = drawn('One')
    const two = createEmptyDocument('Two')
    writeProjectRaw(one.doc.id, one.raw)
    writeWorkspace({ current: one.doc.id, projects: [recordFor(one.doc), recordFor(two)] })
    const envelope = workspaceEnvelope()
    expect(envelope).not.toBeNull()
    expect(isEnvelope(envelope)).toBe(true)
    expect(isEnvelope(JSON.parse(one.raw))).toBe(false)
    expect(Object.keys(envelope!.documents)).toEqual([one.doc.id])

    storage.clear()
    const restored = restoreEnvelope(envelope!)
    expect(restored?.current).toBe(one.doc.id)
    expect(restored?.projects.map((each) => each.name)).toEqual(['One', 'Two'])
    expect(readProjectRaw(one.doc.id)).toBe(one.raw)
    expect(readWorkspace()?.projects).toHaveLength(2)
  })

  it('drops a project whose document will not read, and refuses an envelope with none left', () => {
    const one = drawn('One')
    const envelope = {
      workspace: { current: one.doc.id, projects: [recordFor(one.doc)] },
      documents: { [one.doc.id]: '{"broken":1}' },
    }
    expect(restoreEnvelope(envelope)).toBeNull()
    expect(readWorkspace()).toBeNull()
  })
})
