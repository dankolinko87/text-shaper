import { useEffect } from 'react'

import { isTypedCharacter } from '../mosaic/graphemes'
import { readingOrder, stepThrough, tileInDirection, type Placed } from '../mosaic/order'
import {
  appendCharacter,
  backspaceCharacter,
  backspaceLetter,
  deleteCharacter,
  pasteCharacters,
  pasteWords,
  typeCharacter,
} from '../mosaic/typing'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { Tiled } from '../types/document'
import type { MosaicTileLayout } from '../types/mosaic'

/**
 * Typing into tiles: the keyboard, once, for every kind of object that has
 * them.
 *
 * What the caret needs of an object is small — which tile it is in, the
 * reading order of the state on show, and somewhere to write letters — so the
 * handler asks for those and nothing else. A mosaic and a mesh both answer.
 * The one thing a caller may add is a claim on Escape: a drag in flight is
 * cancelled by Escape rather than the mode being left, and only the layer that
 * owns the drag knows whether one is.
 */

export interface TypingTarget {
  object: Tiled
  /** The tile the caret is in. */
  leaf: string
  /** The state's tiles, for the order and the arrows. */
  layout: ReadonlyMap<string, MosaicTileLayout | Placed>
  /** The state the letters are written into. */
  at: number
  /**
   * What a cell holds. A LETTER cell takes one keystroke and moves on; a WORD
   * cell keeps taking them, and Space or Return is what moves on. Letter when
   * unsaid.
   */
  holds?: 'letter' | 'word'
}

export function useTileTyping(options: {
  /** The target as the STORES have it now, or null when nothing is being typed into. */
  live: () => TypingTarget | null
  /** Called first on Escape; returning true means it was spent on something else, like a drag. */
  onEscape?: () => boolean
}): void {
  const { live, onEscape } = options
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && isFormField(e.target)) return
      const current = live()
      if (!current) return
      const { object: target, leaf: at, layout, at: shown } = current
      const words = current.holds === 'word'

      const store = useDocumentStore.getState()
      const ui = useUiStore.getState()
      const order = readingOrder(layout)
      const modified = e.metaKey || e.ctrlKey || e.altKey
      const chars = target.states[shown]?.chars ?? {}

      // Written into the state on show, and carried forward through the states
      // that are still copies of it.
      const apply = (
        result: { chars: Record<string, string>; focus: string | null },
        label: string,
      ): void => {
        store.setMosaicChars(target.id, shown, result.chars)
        store.commit(label)
        if (result.focus) ui.setTyping({ object: target.id, leaf: result.focus })
      }
      const move = (leaf: string | null): void => {
        if (leaf) ui.setTyping({ object: target.id, leaf })
      }

      switch (e.key) {
        case 'Escape': {
          e.preventDefault()
          // The caret's Escape is the caret's alone: the editor's ladder
          // listens on the same window after this, and must not take a rung.
          e.stopImmediatePropagation()
          if (onEscape?.()) return
          ui.setTyping(null)
          ui.setMosaicSelection([])
          return
        }
        case 'Tab':
          e.preventDefault()
          move(stepThrough(order, at, e.shiftKey ? -1 : 1))
          return
        case 'Enter':
          // In a word cell, Return is how you move on; a letter cell moves on by itself.
          if (!words) break
          e.preventDefault()
          move(stepThrough(order, at, e.shiftKey ? -1 : 1))
          return
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          const direction = e.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down'
          move(tileInDirection(layout, at, direction))
          return
        }
        case 'Delete':
          e.preventDefault()
          apply(deleteCharacter(chars, at), 'Clear tile')
          return
        case 'Backspace':
          e.preventDefault()
          apply(words ? backspaceLetter(chars, order, at) : backspaceCharacter(chars, order, at), 'Clear tile')
          return
        default:
          break
      }

      if (!isTypedCharacter(e.key, modified)) return
      e.preventDefault()
      if (words && e.key === ' ') {
        // A space between words is the step to the next cell.
        move(stepThrough(order, at, 1))
        return
      }
      apply(words ? appendCharacter(chars, at, e.key) : typeCharacter(chars, order, at, e.key), 'Type')
    }

    /** Paste fills consecutive tiles from the caret; its own listener because the clipboard is only readable there. */
    const onPaste = (e: ClipboardEvent): void => {
      const current = live()
      if (!current) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()

      const { object: target, leaf: at, layout, at: shown } = current
      const store = useDocumentStore.getState()
      const chars = target.states[shown]?.chars ?? {}
      const result =
        current.holds === 'word'
          ? pasteWords(chars, readingOrder(layout), at, text)
          : pasteCharacters(chars, readingOrder(layout), at, text)
      store.setMosaicChars(target.id, shown, result.chars)
      store.commit('Paste')
      useUiStore.getState().setTyping({ object: target.id, leaf: result.focus ?? at })
      store.setWarning(
        target.id,
        result.dropped > 0
          ? `${result.dropped} ${current.holds === 'word' ? 'word' : 'character'}${result.dropped === 1 ? '' : 's'} did not fit.`
          : null,
      )
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [live, onEscape])
}

function isFormField(target: HTMLElement): boolean {
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
