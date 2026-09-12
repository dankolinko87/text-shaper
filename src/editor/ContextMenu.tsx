import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { Icon, type IconName } from '../components/Icon'
import { useDismiss } from '../components/useDismiss'
import './panels.css'

/**
 * A menu at the pointer: what a right-click on a thing offers.
 *
 * Portalled and fixed at the press, nudged to stay inside the window. The
 * items are given, not known here, so the same menu serves whatever is
 * under the pointer; Escape and a press anywhere else close it.
 */
export interface ContextMenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/**
 * A row of icon buttons in the menu — the alignment set, which is six things
 * that read better as glyphs side by side than as six lines of text, the
 * way Figma's bar draws them. Each names itself on hover.
 */
export interface ContextMenuIconRow {
  row: readonly (ContextMenuItem & { icon: IconName })[]
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuIconRow | 'divider'

const MARGIN = 8

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number }
  items: readonly ContextMenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(true, onClose, ref)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const left = Math.min(at.x, window.innerWidth - element.offsetWidth - MARGIN)
    const top = Math.min(at.y, window.innerHeight - element.offsetHeight - MARGIN)
    element.style.left = `${Math.max(MARGIN, left)}px`
    element.style.top = `${Math.max(MARGIN, top)}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])

  return createPortal(
    <div
      className="context-menu popover"
      role="menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'divider' ? (
          <hr key={`d${i}`} className="context-menu__divider" />
        ) : 'row' in item ? (
          <div key={`r${i}`} className="context-menu__row" role="group">
            {item.row.map((each) => (
              <button
                key={each.label}
                type="button"
                role="menuitem"
                className="context-menu__icon"
                title={each.shortcut ? `${each.label} (${each.shortcut})` : each.label}
                aria-label={each.label}
                disabled={each.disabled}
                onClick={() => {
                  onClose()
                  each.onSelect()
                }}
              >
                <Icon name={each.icon} size={16} />
              </button>
            ))}
          </div>
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="menu__item context-menu__item"
            data-danger={item.danger || undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <span className="context-menu__shortcut">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
