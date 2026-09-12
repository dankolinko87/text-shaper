import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreAutosave, startAutosave } from '../../src/state/autosave'
import { createEmptyDocument } from '../../src/state/defaults'
import { useDocumentStore } from '../../src/state/documentStore'
import { saveAutosave, serializeDocument } from '../../src/state/persistence'
import { readProject, readProjectRaw, readWorkspace, writeProjectRaw, writeWorkspace, recordFor } from '../../src/state/projects'
import { resetKeptForTests, useProjectsStore } from '../../src/state/projectsStore'
import { useUiStore } from '../../src/state/uiStore'

/**
 * The shelf of projects: switching puts the current document away and takes
 * another out, intact; the cards stay in step with the documents; and a
 * session that begins with the old single autosave keeps it as project 1.
 */

const storage = new Map<string, string>()
const store = () => useDocumentStore.getState()
const shelf = () => useProjectsStore.getState()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 204 })))
  store().resetDocument()
  useProjectsStore.setState({ projects: [], currentId: null, snapshot: () => null })
  resetKeptForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const draw = (text: string): void => {
  store().createMosaic({ columns: text.length, rows: 1, artboardCenter: { x: 0, y: 0 }, text })
  store().commit('Draw')
}
const letters = (): string => {
  const doc = store().doc
  return doc.objectOrder
    .map((id) => doc.objects[id])
    .map((object) => (object && 'states' in object && object.kind === 'mosaic' ? Object.values(object.states[0]!.chars).join('') : '?'))
    .join('|')
}

describe('a fresh start', () => {
  it('makes the empty document project 1 and writes its card, not its document', () => {
    expect(restoreAutosave()).toEqual({ kind: 'nothing' })
    const id = shelf().currentId
    expect(id).toBe(store().doc.id)
    expect(readWorkspace()?.projects.map((each) => each.id)).toEqual([id])
    expect(readProjectRaw(id!)).toBeNull()
  })

  it('takes the old single autosave as project 1, with its own identity', () => {
    const old = createEmptyDocument('From before')
    store().loadDocument(old)
    draw('AB')
    saveAutosave(store().doc)
    store().resetDocument()
    expect(restoreAutosave()).toEqual({ kind: 'restored', from: 'legacy' })
    expect(shelf().projects).toHaveLength(1)
    expect(shelf().projects[0]).toMatchObject({ id: old.id, name: 'From before', createdAt: old.createdAt })
    expect(letters()).toBe('AB')
    expect(readProject(old.id).ok).toBe(true)
  })
})

describe('switching', () => {
  it('puts the current away and brings the other back intact, clearing the editor furniture', () => {
    restoreAutosave()
    draw('AB')
    const first = shelf().currentId!
    useUiStore.setState({ typing: { object: 'x', leaf: 'y' }, viewportAdjusted: true })
    const second = shelf().newProject('Second')
    expect(shelf().currentId).toBe(second)
    expect(store().doc.name).toBe('Second')
    expect(store().doc.objectOrder).toHaveLength(0)
    expect(useUiStore.getState().typing).toBeNull()
    expect(useUiStore.getState().viewportAdjusted).toBe(false)
    expect(readProject(first).doc?.objectOrder).toHaveLength(1)

    draw('CDE')
    expect(shelf().openProject(first)).toBe(true)
    expect(letters()).toBe('AB')
    expect(store().past, 'undo does not follow a project across a switch').toHaveLength(0)
    expect(readProject(second).doc?.objectOrder).toHaveLength(1)
    expect(shelf().projects.map((each) => each.name)).toEqual(['Second', 'Untitled'])
    expect(readWorkspace()?.current).toBe(first)
  })

  it('duplicates with a fresh identity, and names the copy', () => {
    restoreAutosave()
    draw('AB')
    const original = shelf().currentId!
    const copy = shelf().duplicateProject(original)!
    expect(copy).not.toBe(original)
    expect(shelf().currentId).toBe(copy)
    expect(store().doc.id).toBe(copy)
    expect(store().doc.name).toBe('Untitled copy')
    expect(letters()).toBe('AB')
    expect(readProject(original).doc?.objectOrder).toHaveLength(1)
    expect(shelf().projects.map((each) => each.id)).toEqual([copy, original])
  })

  it('deletes: the current opens the most recently edited other; the last is replaced by a fresh one', () => {
    restoreAutosave()
    const first = shelf().currentId!
    draw('A')
    const second = shelf().newProject('Second')
    draw('BB')
    const third = shelf().newProject('Third')
    // Second was edited after First; deleting Third (current) lands on Second.
    expect(shelf().deleteProject(third)).toBe(second)
    expect(store().doc.id).toBe(second)
    expect(letters()).toBe('BB')
    expect(readProjectRaw(third)).toBeNull()
    // Deleting one that is not current leaves the canvas alone.
    expect(shelf().deleteProject(first)).toBe(second)
    expect(store().doc.id).toBe(second)
    expect(shelf().projects).toHaveLength(1)
    // The last one goes: a fresh empty project stands in.
    const fresh = shelf().deleteProject(second)!
    expect(fresh).not.toBe(second)
    expect(shelf().projects).toHaveLength(1)
    expect(store().doc.objectOrder).toHaveLength(0)
    expect(readProjectRaw(second)).toBeNull()
  })

  it('keeps the card and the document named alike, from either side', () => {
    restoreAutosave()
    const first = shelf().currentId!
    store().setDocumentName('Typed in the bar')
    store().commit('Rename document')
    expect(shelf().projects[0]!.name).toBe('Typed in the bar')

    shelf().renameProject(first, '  From the card  ')
    expect(store().doc.name).toBe('From the card')
    expect(shelf().projects[0]!.name).toBe('From the card')

    draw('A')
    const second = shelf().newProject('Second')
    shelf().renameProject(first, 'Renamed on the shelf')
    expect(readProject(first).doc?.name).toBe('Renamed on the shelf')
    expect(store().doc.id).toBe(second)
  })

  it('imports a file as a new project and exports one as its document', () => {
    restoreAutosave()
    draw('AB')
    const exported = shelf().exportProject(shelf().currentId!)!
    expect(JSON.parse(exported).name).toBe('Untitled')
    expect(shelf().importProject('garbage')).toBeTruthy()
    expect(shelf().importProject(exported)).toBeNull()
    expect(shelf().projects).toHaveLength(2)
    expect(store().doc.id).not.toBe(JSON.parse(exported).id)
    expect(letters()).toBe('AB')
  })
})

describe('booting a workspace', () => {
  it('opens the current project, or the most recent one that reads', () => {
    const a = createEmptyDocument('A')
    const b = createEmptyDocument('B')
    writeProjectRaw(a.id, serializeDocument(a))
    writeProjectRaw(b.id, '{"broken":true}')
    writeWorkspace({ current: b.id, projects: [recordFor(a), recordFor(b)] })
    expect(restoreAutosave()).toEqual({ kind: 'restored', from: 'previous' })
    expect(store().doc.id).toBe(a.id)
    expect(shelf().currentId).toBe(a.id)
    expect(shelf().projects, 'the unreadable card is kept, not dropped').toHaveLength(2)
  })

  it('reports work at risk when nothing reads, and writes nothing over it', () => {
    const a = createEmptyDocument('A')
    writeProjectRaw(a.id, '{"broken":true}')
    writeWorkspace({ current: a.id, projects: [recordFor(a)] })
    const restored = restoreAutosave()
    expect(restored.kind).toBe('failed')
    const stop = startAutosave(restored)
    draw('X')
    vi.advanceTimersByTime(1000)
    expect(readProjectRaw(a.id)).toBe('{"broken":true}')
    stop()
  })
})

describe('the autosave, per project', () => {
  it('writes the current project and its card, keeping the copy it inherited', () => {
    const a = createEmptyDocument('A')
    writeProjectRaw(a.id, serializeDocument({ ...a, name: 'Before' }))
    writeWorkspace({ current: a.id, projects: [recordFor(a)] })
    const stop = startAutosave(restoreAutosave())
    useProjectsStore.setState({ snapshot: () => 'data:image/png;base64,pic' })
    draw('AB')
    vi.advanceTimersByTime(1000)
    expect(readProject(a.id).doc?.objectOrder).toHaveLength(1)
    expect(shelf().projects[0]!.thumbnail).toBe('data:image/png;base64,pic')
    expect(readWorkspace()?.projects[0]!.thumbnail).toBe('data:image/png;base64,pic')
    expect(storage.get(`text-shaper:project:${a.id}:previous:v1`)).toContain('"Before"')
    stop()
  })
})
