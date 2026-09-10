import { useCallback, useRef, useState } from 'react'

import { IconButton } from './controls'
import { useDismiss } from './useDismiss'
import './controls.css'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
}

/**
 * A few actions behind one small button — the ⋯ on a card.
 *
 * For actions that are real but rare: two ghost buttons standing on every card
 * for the thing you do once a session are two buttons' worth of noise on every
 * card. Behind a menu they cost one glyph until they are wanted, and the menu
 * can say what they act on, which a pair of buttons had to say in a label
 * above them.
 */
export function Menu({
  label,
  heading,
  items,
}: {
  label: string
  /** What the actions are about, at the top of the list. */
  heading?: string
  items: MenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, ref)

  return (
    <div className="menu" ref={ref}>
      <IconButton
        icon="more"
        label={label}
        small
        tooltipSide="top"
        active={open}
        onClick={() => setOpen((was) => !was)}
      />
      {open ? (
        <div className="menu__list popover" role="menu" aria-label={label}>
          {heading ? <div className="menu__heading">{heading}</div> : null}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu__item"
              disabled={item.disabled}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
