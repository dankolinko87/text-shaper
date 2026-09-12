import { paintCss } from './gradientCss'
import type { ImageAsset } from '../types/paint'
import { useState } from 'react'
import { useUiStore } from '../state/uiStore'

import { IconButton } from '../components/controls'
import { Icon } from '../components/Icon'
import { useDocumentStore } from '../state/documentStore'
import type { DocumentObject } from '../types/document'
import './panels.css'

export function LayersPanel() {
  const order = useDocumentStore((s) => s.doc.objectOrder)
  const objects = useDocumentStore((s) => s.doc.objects)
  const assets = useDocumentStore((s) => s.doc.assets)
  const selection = useDocumentStore((s) => s.selection)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  // Topmost object first, which is how layer lists read.
  const rows = [...order].reverse()

  const commitRename = (id: string): void => {
    const store = useDocumentStore.getState()
    const current = store.doc.objects[id]
    if (current && draftName.trim() && draftName !== current.name) {
      store.renameObject(id, draftName.trim())
      store.commit('Rename layer')
    }
    setEditingId(null)
  }

  return (
    <section className="panel panel--layers" aria-label="Layers">
      <header className="panel__header">
        <h2 className="panel__title">Layers</h2>
        <span className="panel__count">{order.length}</span>
      </header>

      {rows.length === 0 ? (
        <p className="panel__empty">No shapes yet.</p>
      ) : (
        <ul className="layers">
          {rows.map((id, rowIndex) => {
            const object = objects[id]
            if (!object) return null
            const selected = selection.includes(id)
            const stackIndex = order.length - 1 - rowIndex

            return (
              <li key={id}>
                <div
                  className="layer"
                  data-selected={selected}
                  data-hidden={!object.visible}
                  onClick={(e) => {
                    const store = useDocumentStore.getState()
                    if (e.shiftKey || e.metaKey || e.ctrlKey) store.toggleSelection(id)
                    else store.setSelection([id])
                  }}
                  onDoubleClick={() => {
                    setEditingId(id)
                    setDraftName(object.name)
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      useDocumentStore.getState().setSelection([id])
                    }
                  }}
                >
                  <span className="layer__swatch" style={{ background: layerSwatch(object, assets) }} />

                  {editingId === id ? (
                    <input
                      className="layer__name-input"
                      value={draftName}
                      autoFocus
                      aria-label="Layer name"
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => commitRename(id)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename(id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <span className="layer__name" title={object.name}>
                      {object.name}
                      {layerHint(object) ? (
                        <span className="layer__hint">{truncate(layerHint(object))}</span>
                      ) : null}
                    </span>
                  )}

                  <span className="layer__actions" onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      icon="chevronUp"
                      label="Move up"
                      small
                      disabled={stackIndex === order.length - 1}
                      onClick={() => {
                        const store = useDocumentStore.getState()
                        store.reorderObject(id, stackIndex + 1)
                        store.commit('Reorder layer')
                      }}
                    />
                    <IconButton
                      icon="chevronDown"
                      label="Move down"
                      small
                      disabled={stackIndex === 0}
                      onClick={() => {
                        const store = useDocumentStore.getState()
                        store.reorderObject(id, stackIndex - 1)
                        store.commit('Reorder layer')
                      }}
                    />
                    <IconButton
                      icon={object.visible ? 'eye' : 'eyeOff'}
                      label={object.visible ? 'Hide layer' : 'Show layer'}
                      small
                      onClick={() => {
                        const store = useDocumentStore.getState()
                        store.setVisible(id, !object.visible)
                        store.commit(object.visible ? 'Hide layer' : 'Show layer')
                      }}
                    />
                    <IconButton
                      icon={object.locked ? 'lock' : 'unlock'}
                      label={object.locked ? 'Unlock layer' : 'Lock layer'}
                      small
                      onClick={() => {
                        const store = useDocumentStore.getState()
                        store.setLocked(id, !object.locked)
                        store.commit(object.locked ? 'Unlock layer' : 'Lock layer')
                      }}
                    />
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean
}

export function LayerWarning({ message }: { message: string }) {
  return (
    <p className="warning" role="status">
      <Icon name="warning" size={13} />
      {message}
    </p>
  )
}

/**
 * The colour chip beside a layer's name.
 *
 * A typography object is its text, so the text colour identifies it; a mosaic is
 * a field of tiles, so it takes its first tile colour, or its glyph colour when
 * the tiles are bare. A frame has no colour of its own — it is a place, not a
 * mark — so it borrows its first member's.
 */
function layerSwatch(object: DocumentObject, assets: Readonly<Record<string, ImageAsset>>): string {
  if (object.kind === 'typography') return paintCss(object.appearance.textFill, assets)
  if (object.kind === 'frame') {
    const first = object.members[0]
    return first ? layerSwatch(first.object, assets) : '#101014'
  }
  const state = object.states[useUiStore.getState().mosaicStates[object.id] ?? 0] ?? object.states[0]
  const tile = Object.values(state?.tileColour ?? {}).find((c) => c !== null)
  return paintCss(tile ?? Object.values(state?.glyphColour ?? {})[0] ?? '#101014', assets)
}

/** What the layer is OF, in a few characters — the text, or the letters. */
function layerHint(object: DocumentObject): string {
  if (object.kind === 'typography') return object.text.trim()
  if (object.kind === 'frame') {
    const count = object.members.length
    return count === 1 ? '1 object' : `${count} objects`
  }
  return object.tiles
    .map((tile) => object.states[0]?.chars[tile.id] ?? ' ')
    .join('')
    .trim()
}
