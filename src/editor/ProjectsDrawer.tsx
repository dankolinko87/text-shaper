import { useEffect, useState } from 'react'

import { IconButton } from '../components/controls'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { useProjectsStore } from '../state/projectsStore'
import { useUiStore } from '../state/uiStore'
import type { ProjectRecord } from '../state/projects'
import './projects.css'

/**
 * The projects, on a shelf to the left of the stage.
 *
 * A drawer that PUSHES the stage rather than floating over it, unlike the
 * two panels: it is a place you go to choose what to work on, not a tool
 * beside the work. Each project is a card with a picture of its artboard,
 * its name, and its dates; the one on the canvas is marked. Click a card
 * to open it, double-click its name to rename it, and the ⋯ holds the rest.
 *
 * Nothing about files: the projects live here, and the dev server keeps a
 * copy of them all — a file button was one more place to wonder which copy
 * was the real one.
 */

const byRecency = (a: ProjectRecord, b: ProjectRecord): number => b.updatedAt.localeCompare(a.updatedAt)

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? DATE.format(time) : ''
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
function ago(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.round((now - time) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d ago`
  return formatDate(iso)
}

export function ProjectsDrawer() {
  const open = useUiStore((s) => s.projectsOpen)
  const setOpen = useUiStore((s) => s.setProjectsOpen)
  const projects = useProjectsStore((s) => s.projects)
  const currentId = useProjectsStore((s) => s.currentId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const shelf = () => useProjectsStore.getState()
  const ordered = [...projects].sort(byRecency)

  // The current card's picture is as fresh as the drawer: taken when it opens,
  // since the autosave only pictures a project once something has changed.
  useEffect(() => {
    if (open) shelf().refreshCurrentThumbnail()
  }, [open])

  const beginRename = (project: ProjectRecord): void => {
    setEditingId(project.id)
    setDraft(project.name)
  }
  const commitRename = (id: string): void => {
    if (draft.trim()) shelf().renameProject(id, draft)
    setEditingId(null)
  }

  const remove = (project: ProjectRecord): void => {
    const last = projects.length === 1
    const message = last
      ? `Delete “${project.name}”? It is the only project, so an empty one takes its place. This cannot be undone.`
      : `Delete “${project.name}”? This cannot be undone.`
    if (!window.confirm(message)) return
    shelf().deleteProject(project.id)
  }

  return (
    <aside
      className="app__drawer"
      data-open={open}
      inert={!open}
      aria-label="Projects"
      onKeyDown={(e) => {
        // Escape closes the drawer, unless a name is being typed — that has its own Escape.
        if (e.key === 'Escape' && editingId === null) setOpen(false)
      }}
    >
      <div className="panel panel--projects">
        <div className="panel__header">
          <h2 className="panel__title">Projects</h2>
          <span className="panel__count">{projects.length}</span>
          <div className="projects__header-actions">
            <IconButton
              icon="plus"
              label="New project"
              shortcut="⇧⌘N"
              small
              onClick={() => shelf().newProject()}
            />
          </div>
        </div>

        <div className="panel__scroll projects__list">
          {ordered.map((project) => {
            const current = project.id === currentId
            const editing = editingId === project.id
            return (
              <article
                key={project.id}
                className="project"
                data-current={current}
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  if (!current) shelf().openProject(project.id)
                }}
              >
                <div className="project__thumb">
                  {project.thumbnail ? (
                    <img src={project.thumbnail} alt="" draggable={false} />
                  ) : (
                    <span className="project__empty" aria-hidden="true">
                      <Icon name="frame" size={20} />
                    </span>
                  )}
                </div>
                <div className="project__meta">
                  {editing ? (
                    <input
                      className="layer__name-input project__name-input"
                      value={draft}
                      autoFocus
                      aria-label="Project name"
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(project.id)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename(project.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <div
                      className="project__name"
                      title="Double-click to rename"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        beginRename(project)
                      }}
                    >
                      {project.name}
                    </div>
                  )}
                  <div className="project__dates">
                    Created {formatDate(project.createdAt)} · edited {ago(project.updatedAt)}
                  </div>
                </div>
                <div className="project__actions" onClick={(e) => e.stopPropagation()}>
                  <Menu
                    label="More"
                    heading={project.name}
                    items={[
                      { label: 'Rename', onSelect: () => beginRename(project) },
                      { label: 'Duplicate', onSelect: () => shelf().duplicateProject(project.id) },
                      { label: 'Delete', onSelect: () => remove(project) },
                    ]}
                  />
                </div>
              </article>
            )
          })}
        </div>

      </div>
    </aside>
  )
}
