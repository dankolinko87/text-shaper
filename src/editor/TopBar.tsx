import { useEffect, useState } from 'react'

import { IconButton } from '../components/controls'
import { Logo } from '../components/Logo'
import { useDocumentStore } from '../state/documentStore'
import { ExportMenu } from './ExportMenu'
import { ZoomControl } from './ZoomControl'
import './panels.css'

/**
 * Open and Save are gone for now.
 *
 * Both wrote to this browser's local storage, which autosave already does and
 * does better — see `state/autosave.ts`. Two buttons offering a weaker version
 * of something that happens by itself were mostly a way to be confused about
 * which copy of the work was the real one. What is missing, and what these were
 * NOT, is a way to get a document out of the browser as a file.
 */
export function TopBar() {
  const name = useDocumentStore((s) => s.doc.name)
  const past = useDocumentStore((s) => s.past)
  const future = useDocumentStore((s) => s.future)
  const [draftName, setDraftName] = useState(name)

  useEffect(() => setDraftName(name), [name])

  return (
    <header className="topbar">
      <div className="topbar__section">
        {/* The mark, then the document's name — nothing between them but space. */}
        <span className="topbar__logo">
          <Logo />
        </span>
        <input
          className="topbar__name"
          value={draftName}
          aria-label="Document name"
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => {
            if (draftName !== name) {
              useDocumentStore.getState().setDocumentName(draftName || 'Untitled')
              useDocumentStore.getState().commit('Rename document')
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraftName(name)
              e.currentTarget.blur()
            }
          }}
        />
      </div>

      <div className="topbar__section topbar__section--center">
        <IconButton
          icon="undo"
          label="Undo"
          shortcut="⌘Z"
          disabled={past.length === 0}
          onClick={() => useDocumentStore.getState().undo()}
        />
        <IconButton
          icon="redo"
          label="Redo"
          shortcut="⇧⌘Z"
          disabled={future.length === 0}
          onClick={() => useDocumentStore.getState().redo()}
        />
      </div>

      {/*
        Zoom, fit and play live up here rather than floating over the artboard.
        
        They are about the VIEW rather than about the drawing, which is the same
        thing undo and redo are — and a bar hovering over the canvas covers the
        one thing it exists to help you look at.
      */}
      <div className="topbar__section topbar__section--end">
        <ZoomControl />
        {/*
          Getting the work OUT sits beside the controls for looking at it, not
          at the bottom of a properties tab. It belongs to the document rather
          than to any one setting on the thing selected.
        */}
        <ExportMenu />
      </div>
    </header>
  )
}
