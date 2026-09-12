import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreAutosave, startAutosave } from '../../src/state/autosave'
import { createEmptyDocument, documentDefaults } from '../../src/state/defaults'
import { useDocumentStore } from '../../src/state/documentStore'
import {
  clearAutosave,
  loadAutosave,
  saveAutosave,
  saveToLocalStorage,
} from '../../src/state/persistence'
import { readProject } from '../../src/state/projects'
import { resetKeptForTests, useProjectsStore } from '../../src/state/projectsStore'
import { PRIMITIVES } from '../../src/geometry/primitives'
import type { TextShaperDocument, TypographyObject } from '../../src/types/document'

/**
 * The store and localStorage are both global, so each test starts from nothing.
 * Vitest runs in node, which has no localStorage of its own.
 */
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 204 })))
  useDocumentStore.getState().loadDocument(createEmptyDocument())
  useProjectsStore.setState({ projects: [], currentId: null, snapshot: () => null })
  resetKeptForTests()
  vi.useFakeTimers()
})

/** The current project's document as storage holds it — where autosave writes now. */
const savedDoc = (): TextShaperDocument | undefined => {
  const id = useProjectsStore.getState().currentId
  return id ? readProject(id).doc : undefined
}
/** How many writes landed on a project's own key. */
const countProjectWrites = (): { count: () => number } => {
  let writes = 0
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (k.startsWith('text-shaper:project:') && !k.endsWith(':previous:v1')) writes++
      store.set(k, v)
    },
    removeItem: (k: string) => void store.delete(k),
  })
  return { count: () => writes }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const SHAPE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)

function withShape(name = 'Ellipse'): TextShaperDocument {
  const object: TypographyObject = {
    kind: 'typography',
    id: 'a',
    name,
    originalSourcePath: SHAPE,
    currentSourcePath: SHAPE,
    simplifiedRenderPath: SHAPE,
    insetPath: null,
    localBounds: { x: -340, y: -300, width: 680, height: 600 },
    geometryRevision: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: 'HELLO',
    textFlowMode: 'word',
    fittingMode: 'boundary-warp',
    dividers: [],
    font: { ...documentDefaults.font },
    typography: { ...documentDefaults.typography },
    run: { ...documentDefaults.run },
    outline: null,
    distortion: { ...documentDefaults.distortion },
    appearance: { ...documentDefaults.appearance },
    animation: { ...documentDefaults.animation },
    seed: 7,
    visible: true,
    locked: false,
  }
  const doc = createEmptyDocument()
  return { ...doc, objects: { a: object }, objectOrder: ['a'] }
}

describe('keeping work across a reload', () => {
  it('writes the document once it settles', () => {
    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().loadDocument(withShape())
    // Nothing yet: it waits for the edits to stop.
    expect(savedDoc()).toBeUndefined()

    vi.advanceTimersByTime(500)
    expect(savedDoc()?.objectOrder).toEqual(['a'])
    stop()
  })

  it('writes once for a burst of edits, not once per edit', () => {
    // A drag streams updates at pointer rate. Serialising a document full of
    // path data on every one would be felt in the gesture.
    const stop = startAutosave(restoreAutosave())
    const writes = countProjectWrites()

    useDocumentStore.getState().loadDocument(withShape())
    for (let i = 0; i < 20; i++) {
      useDocumentStore.getState().updateObject('a', { seed: i })
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(500)
    expect(writes.count()).toBe(1)
    stop()
  })

  it('brings the work back on the next load', () => {
    saveAutosave(withShape('Restored'))
    expect(useDocumentStore.getState().doc.objectOrder).toHaveLength(0)

    // The single autosave of older builds comes back as project 1.
    expect(restoreAutosave()).toEqual({ kind: 'restored', from: 'legacy' })
    expect(useDocumentStore.getState().doc.objects['a']?.name).toBe('Restored')
    expect(useProjectsStore.getState().projects).toHaveLength(1)
  })

  it('refuses to overwrite a canvas that already has work on it', () => {
    // The restore runs on mount. If a shape is somehow already there, replacing
    // the document wholesale would throw it away.
    saveAutosave(withShape('Autosaved'))
    useDocumentStore.getState().loadDocument(withShape('Already here'))
    expect(restoreAutosave()).toEqual({ kind: 'nothing' })
    expect(useDocumentStore.getState().doc.objects['a']?.name).toBe('Already here')
  })

  it('starts empty when there is nothing saved', () => {
    expect(restoreAutosave()).toEqual({ kind: 'nothing' })
    expect(useDocumentStore.getState().doc.objectOrder).toHaveLength(0)
  })

  it('reports failure rather than throwing on a corrupted autosave', () => {
    /*
     * Told apart from "nothing saved" on purpose. A snapshot that exists and
     * will not load is work at risk, and the session that follows must not
     * write over it — which it cannot know from an empty canvas alone.
     */
    store.set('text-shaper:autosave:v1', '{ not json')
    expect(restoreAutosave().kind).toBe('failed')
  })

  it('stops writing once torn down', () => {
    const stop = startAutosave(restoreAutosave())
    stop()
    useDocumentStore.getState().loadDocument(withShape())
    vi.advanceTimersByTime(1000)
    expect(savedDoc()).toBeUndefined()
  })

  it('does not disturb an explicit save', () => {
    // Autosave follows whatever is on screen; Save is a checkpoint the user
    // chose. Sharing one key would destroy the second on the next keystroke.
    saveToLocalStorage(withShape('Checkpoint'))
    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().loadDocument(withShape('Working'))
    vi.advanceTimersByTime(500)

    expect(savedDoc()?.objects['a']?.name).toBe('Working')
    expect(store.get('text-shaper:document:v1')).toContain('Checkpoint')
    stop()
  })

  it('survives storage being unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    })
    expect(() => restoreAutosave()).not.toThrow()
    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().loadDocument(withShape())
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    stop()
  })

  it('clears cleanly', () => {
    saveAutosave(withShape())
    clearAutosave()
    expect(loadAutosave().ok).toBe(false)
  })
})

/**
 * The failure that ate real work.
 *
 * A snapshot became unreadable (a bumped `DOCUMENT_SCHEMA_VERSION` is enough —
 * `deserializeDocument` rejects a file from a newer build outright). Restore
 * failed, the canvas came up empty, and because the subscription fired on ANY
 * document-store change, the very first click wrote the empty document over the
 * only copy. Each test below is one of the three rules that now stop it.
 */
describe('a session that starts badly', () => {
  /** A snapshot this build cannot read, holding work that matters. */
  const unreadable = (): string => {
    const raw = JSON.parse(serialized(withShape('Precious'))) as Record<string, unknown>
    raw['schemaVersion'] = 999
    return JSON.stringify(raw)
  }
  const serialized = (doc: TextShaperDocument): string => {
    saveAutosave(doc)
    return store.get('text-shaper:autosave:v1') as string
  }

  it('does not write the empty document over a snapshot it could not read', () => {
    store.set('text-shaper:autosave:v1', unreadable())
    const before = store.get('text-shaper:autosave:v1')

    const stop = startAutosave(restoreAutosave())
    // Exactly what used to destroy it: a click, which is a selection change.
    useDocumentStore.getState().setSelection([])
    vi.advanceTimersByTime(2000)

    expect(store.get('text-shaper:autosave:v1')).toBe(before)
    stop()
  })

  it('falls back to what the last session started with', () => {
    store.set('text-shaper:autosave:previous:v1', serialized(withShape('Yesterday')))
    store.set('text-shaper:autosave:v1', unreadable())

    expect(restoreAutosave()).toEqual({ kind: 'restored', from: 'legacy' })
    expect(useDocumentStore.getState().doc.objects['a']?.name).toBe('Yesterday')
  })

  it('keeps what the session inherited, before writing anything of its own', () => {
    store.set('text-shaper:autosave:v1', serialized(withShape('Inherited')))
    useDocumentStore.getState().loadDocument(createEmptyDocument())

    const stop = startAutosave(restoreAutosave())
    const id = useProjectsStore.getState().currentId as string
    useDocumentStore.getState().loadDocument(withShape('Newer'))
    vi.advanceTimersByTime(500)

    expect(savedDoc()?.objects['a']?.name).toBe('Newer')
    expect(store.get(`text-shaper:project:${id}:previous:v1`)).toContain('Inherited')
    stop()
  })
})

describe('an empty canvas', () => {
  it('is not written over saved work when nothing has been done', () => {
    // The emptiness came from the session starting badly, not from a decision.
    store.set('text-shaper:autosave:v1', '{ not json')
    useDocumentStore.getState().loadDocument(createEmptyDocument())

    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().setSelection([])
    useDocumentStore.getState().loadDocument(createEmptyDocument())
    vi.advanceTimersByTime(2000)

    expect(store.get('text-shaper:autosave:v1')).toBe('{ not json')
    stop()
  })

  it('IS written once the user emptied it themselves', () => {
    // Deleting everything is a decision, and undoing it is what history is for.
    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().loadDocument(withShape('Doomed'))
    vi.advanceTimersByTime(500)
    expect(savedDoc()?.objectOrder).toEqual(['a'])

    useDocumentStore.getState().deleteObjects(['a'])
    useDocumentStore.getState().commit('Delete everything')
    vi.advanceTimersByTime(500)

    expect(savedDoc()?.objectOrder).toEqual([])
    stop()
  })
})

describe('what counts as a change worth writing', () => {
  it('ignores a selection, which is not work', () => {
    const stop = startAutosave(restoreAutosave())
    useDocumentStore.getState().loadDocument(withShape())
    vi.advanceTimersByTime(500)

    let writes = 0
    const real = localStorage.setItem
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes++
        real.call(null, k, v)
        store.set(k, v)
      },
      removeItem: (k: string) => void store.delete(k),
    })

    useDocumentStore.getState().setSelection(['a'])
    useDocumentStore.getState().setSelection([])
    vi.advanceTimersByTime(2000)

    expect(writes).toBe(0)
    stop()
  })
})
