import { useEffect, useState } from 'react'

import { Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { Logo } from '../components/Logo'
import { useProjectsStore } from '../state/projectsStore'
import { useDocumentStore } from '../state/documentStore'
import { other } from '../state/theme'
import { useUiStore } from '../state/uiStore'
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
  const [draftName, setDraftName] = useState(name)
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const switchTo = other(theme)
  const projectsOpen = useUiStore((s) => s.projectsOpen)
  const setProjectsOpen = useUiStore((s) => s.setProjectsOpen)
  const projectCount = useProjectsStore((s) => s.projects.length)

  useEffect(() => setDraftName(name), [name])

  return (
    <header className="topbar">
      <div className="topbar__section">
        {/* The way into the projects: a chevron toward the drawer's edge. */}
        <Tooltip label={projectsOpen ? 'Hide projects' : `Show projects (${projectCount})`}>
          <button
            type="button"
            className="topbar__projects"
            aria-expanded={projectsOpen}
            aria-label={`${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`}
            onClick={() => setProjectsOpen(!projectsOpen)}
          >
            <Icon name={projectsOpen ? 'chevronRight' : 'chevronLeft'} size={20} />
          </button>
        </Tooltip>
        {/*
          The mark is the light switch. Pressing it turns the palette over —
          the one control that is about the app itself rather than the
          document, on the one element that is the app itself.
        */}
        <Tooltip label={`Switch to ${switchTo} mode`}>
          <button
            type="button"
            className="topbar__logo"
            aria-label={`Switch to ${switchTo} mode`}
            onClick={() => setTheme(switchTo)}
          >
            <Logo />
          </button>
        </Tooltip>
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

      {/* Undo and redo live on the keyboard (⌘Z, ⇧⌘Z); the header keeps to the document and the view. */}
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
