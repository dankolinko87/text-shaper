import { useEffect, useState } from 'react'

import { EditorCanvas } from '../editor/Canvas'
import { snapshotArtwork } from '../editor/liveCanvas'
import { ProjectsDrawer } from '../editor/ProjectsDrawer'
import { PropertiesPanel } from '../editor/PropertiesPanel'
import { StatesRail } from '../editor/StatesRail'
import { Toolbar } from '../editor/Toolbar'
import { TopBar } from '../editor/TopBar'
import { useShortcuts } from '../editor/useShortcuts'
import { useTextPaths } from '../editor/useTextPaths'
import { initClipper } from '../geometry/clipper'
import { DEFAULT_FONT_ID } from '../fonts/manifest'
import { restoreAutosave, startAutosave } from '../state/autosave'
import { useDocumentStore } from '../state/documentStore'
import { useProjectsStore } from '../state/projectsStore'
import { useUiStore } from '../state/uiStore'
import { forgetTokens } from '../editor/colours'
import { applyTheme, writeTheme } from '../state/theme'
import { loadFont } from '../typography/fontRegistry'
import './app.css'

export function App() {
  const fontLoaded = useUiStore((s) => s.fontLoaded)
  const theme = useUiStore((s) => s.theme)
  const clipperReady = useUiStore((s) => s.clipperReady)
  const [loadError, setLoadError] = useState<string | null>(null)

  useShortcuts()
  const { warnings: fitWarnings, autoSizes, lineCounts } = useTextPaths()

  /*
   * The two kinds of warning an object can carry, in one place.
   *
   * `useTextPaths` reports what the fit could not do — text that would not go
   * in, a run with nowhere to start. The store holds what an ACTION could not
   * do, said once at the moment it was refused. They share a slot in the panel
   * because they are the same thing to a reader: something about this object did
   * not work. The action's own message wins, being the answer to a question just
   * asked.
   */
  const storeWarnings = useDocumentStore((s) => s.warnings)
  const warnings = { ...fitWarnings, ...storeWarnings }

  /*
   * The palette: on the document, kept, and forgotten by the canvas.
   *
   * The canvas caches the tokens it reads, because Fabric wants strings; a
   * change of palette makes that cache stale, so it is emptied here and the
   * next read asks the stylesheet again.
   */
  useEffect(() => {
    applyTheme(theme)
    forgetTokens()
    writeTheme(window.localStorage, theme)
  }, [theme])

  /* Boot the two async engines. Both must be ready before text can be fitted. */
  useEffect(() => {
    let cancelled = false

    initClipper()
      .then(() => {
        if (!cancelled) useUiStore.getState().setClipperReady(true)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not start the geometry engine.')
      })

    loadFont(DEFAULT_FONT_ID)
      .then(() => {
        if (!cancelled) useUiStore.getState().setFontLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the bundled font.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  /*
   * Keep the work across a reload.
   *
   * Restore FIRST, then start watching: starting the other way round would
   * write the empty starting document over what was there a moment before the
   * restore could read it.
   */
  useEffect(() => {
    // How a project is pictured on its card: the editor's canvas, cropped to the artwork.
    useProjectsStore.getState().setSnapshot(snapshotArtwork)
    // What the restore found decides what autosave may do: a snapshot this build
    // cannot read must not be written over. See `startAutosave`.
    return startAutosave(restoreAutosave())
  }, [])
  const projectsOpen = useUiStore((s) => s.projectsOpen)

  const ready = fontLoaded && clipperReady

  return (
    <div className="app" data-projects={projectsOpen}>
      {/* Beside the whole app, top bar included: it pushes everything, covers nothing. */}
      <ProjectsDrawer />
      <div className="app__main">
        <TopBar />
        <div className="app__body">
          <StatesRail />
          <main className="app__stage">
            <EditorCanvas />
            {/*
            The tools float over the stage rather than standing beside it: a
            child of the stage so they follow its edges, and an absolute one so
            the canvas underneath is still measured by the stage's own box.
          */}
            <Toolbar />
            {!ready || loadError ? (
              <div className="loading-overlay" role="status" aria-live="polite">
                {loadError ? (
                  <>
                    <span>{loadError}</span>
                    <span className="loading-overlay__detail">Reload the page to try again.</span>
                  </>
                ) : (
                  <>
                    <span>Starting the typography engine…</span>
                    <span className="loading-overlay__bar" />
                  </>
                )}
              </div>
            ) : null}
          </main>
          {/*
          The layers list is not mounted. With one shape at a time it was a
          panel showing a list of one, taking a third of the sidebar to do it.
          `editor/LayersPanel.tsx` is still there for when there is a reason to
          bring it back.
        */}
          <div className="app__sidebar">
            <PropertiesPanel warnings={warnings} autoSizes={autoSizes} lineCounts={lineCounts} />
          </div>
        </div>
      </div>
    </div>
  )
}
