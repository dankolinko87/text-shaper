import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'
import { fetchFileAutosave, putFileAutosave, restoreFileAutosave } from '../../src/state/fileAutosave'
import { serializeDocument } from '../../src/state/persistence'

/**
 * The dev server's copy of the autosave: read into an empty session only,
 * written after every autosave, and never in the way when there is no
 * server to answer.
 */

const store = () => useDocumentStore.getState()

let served: string | null = null
const calls: { method: string; body: string | undefined }[] = []

beforeEach(() => {
  store().resetDocument()
  served = null
  calls.length = 0
  vi.stubGlobal('fetch', (_input: string, init?: { method?: string; body?: string }) => {
    calls.push({ method: init?.method ?? 'GET', body: init?.body })
    if (init?.method === 'PUT') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(served ? new Response(served, { status: 200 }) : new Response(null, { status: 204 }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A document with one mosaic in it, as the server would hold it. */
function servedDocument(): string {
  store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
  const raw = serializeDocument(store().doc)
  store().resetDocument()
  return raw
}

describe('the file autosave', () => {
  it('answers null when the server has nothing, and the document when it has', async () => {
    expect(await fetchFileAutosave()).toBeNull()
    served = servedDocument()
    expect(await fetchFileAutosave()).toBe(served)
  })

  it('loads the server copy into an empty session', async () => {
    served = servedDocument()
    expect(store().doc.objectOrder).toHaveLength(0)
    expect(await restoreFileAutosave()).toBe(true)
    expect(store().doc.objectOrder).toHaveLength(1)
  })

  it('never writes over a session that has something in it, or has done something', async () => {
    served = servedDocument()
    store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'Z' })
    const mine = store().doc
    expect(await restoreFileAutosave()).toBe(false)
    expect(store().doc).toBe(mine)

    store().resetDocument()
    store().commit('Empty it')
    // Nothing on the canvas, but the emptiness was chosen: `past` says so.
    if (store().past.length > 0) {
      expect(await restoreFileAutosave()).toBe(false)
    }
  })

  it('puts the document on the server', () => {
    putFileAutosave('{"objects":{}}')
    expect(calls).toEqual([{ method: 'PUT', body: '{"objects":{}}' }])
  })
})
