import { solidOf } from '../typography/paint'
import { paintCss } from './gradientCss'
import { useCallback, useRef, useState } from 'react'

import { Icon } from '../components/Icon'
import { useDismiss } from '../components/useDismiss'
import { allMeshTiles } from '../mesh/layout'
import { allTiles } from '../mosaic/tiles'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { Tiled } from '../types/document'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'
import './panels.css'

/**
 * Which tiles the colour and corner controls act on, chosen from the panel.
 *
 * A second route to the selection the canvas already writes — the same
 * `mosaicSelection`, so the two can never disagree — and not a mode. It earns
 * its place because the canvas route has a failure the panel does not: a tile
 * squeezed thin in the state on show is a sliver to click at, and a mosaic
 * scaled down on the artboard has no usable tile targets at all.
 *
 * So the menu is a FLAT LIST of equal chips, in reading order, and deliberately
 * not a miniature of the composition. A miniature reproduces the exact problem
 * it was meant to solve: a sliver is still a sliver at a quarter of the size.
 * Every tile the same comfortable square, whatever the geometry does to it, is
 * the only version of this that is worth having.
 *
 * Empty selection means every tile — see `colourTargets` — so the trigger says
 * "All tiles" rather than "None", and the All entry simply empties it.
 */
export function TilePicker({ object, at }: { object: Tiled; at: number }) {
  const selection = useUiStore((s) => s.mosaicSelection)
  const page = useDocumentStore((s) => s.doc.artboard.background)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, wrapRef)

  const every = object.kind === 'mesh' ? allMeshTiles(object, at) : allTiles(object, at)
  const state = object.states[Math.min(Math.max(0, at), object.states.length - 1)]
  const chars = state?.chars ?? {}
  const chosen = new Set(selection)

  /*
   * What each chip is painted ON, in the order the renderer stacks it.
   *
   * A tile with no colour of its own is TRANSPARENT, not dark — what shows
   * through it is the mosaic's backdrop, or failing that the page. Taking the
   * chip's ground from the panel instead put the document's black letters on a
   * near-black square and the list read as empty boxes.
   */
  const groundFor = (id: string): string =>
    paintCss(state?.tileColour[id] ?? state?.background ?? page)

  const label =
    selection.length === 0
      ? 'All tiles'
      : selection.length === 1
        ? `Tile ${indexOf(every, selection[0]) + 1}`
        : `${selection.length} tiles`

  const pick = (id: string, add: boolean): void => {
    const ui = useUiStore.getState()
    if (!add) {
      ui.setMosaicSelection([id])
      // The caret follows, so typing goes where the picking went — the same rule
      // a click on the canvas follows.
      ui.setTyping({ object: object.id, leaf: id })
      setOpen(false)
      return
    }
    ui.toggleMosaicSelection(id)
  }

  return (
    <div className="field">
      <span className="field__label">Editing</span>
      <div className="tile-picker" ref={wrapRef}>
        <button
          type="button"
          className="tile-picker__trigger"
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((was) => !was)}
        >
          <span>{label}</span>
          <Icon name="chevronDown" size={13} />
        </button>

        {open ? (
          <div className="tile-picker__menu popover" role="listbox" aria-label="Tiles">
            <button
              type="button"
              role="option"
              aria-selected={selection.length === 0}
              className="tile-picker__all"
              data-on={selection.length === 0}
              onClick={() => {
                useUiStore.getState().setMosaicSelection([])
                setOpen(false)
              }}
            >
              All tiles
            </button>

            <div className="tile-picker__grid">
              {every.map((id, i) => {
                const char = chars[id] ?? ''
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={chosen.has(id)}
                    aria-label={char ? `Tile ${i + 1}, ${char}` : `Tile ${i + 1}, empty`}
                    className="tile-picker__tile"
                    data-on={chosen.has(id)}
                    style={{
                      background: groundFor(id),
                      color: solidOf(state?.glyphColour[id] ?? DEFAULT_GLYPH_COLOUR),
                    }}
                    onClick={(e) => pick(id, e.shiftKey)}
                  >
                    {char || <span className="tile-picker__empty" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const indexOf = (every: readonly string[], id: string | undefined): number =>
  id ? every.indexOf(id) : -1
