import { graphemes } from './graphemes'
import { stepThrough } from './order'

/**
 * Typing into a mosaic, as plain functions over what is written in it.
 *
 * Every one takes the letters, the reading order and where the caret is, and
 * hands back new letters and where the caret goes. No canvas, no store, no
 * events — which is what makes "typing in the last tile keeps focus there" and
 * "backspace in an empty tile clears the one before it" things a test can state
 * rather than things somebody has to click through.
 *
 * Letters are keyed by TILE ID and belong to a state. Tiles are the places; what
 * is written in them is part of the composition, so it changes from state to
 * state exactly as the colours do. Nothing here knows about states — it is
 * handed one state's letters and returns them changed.
 *
 * Absent is empty. One representation, so a tile that was cleared and one that
 * was never written compare as the same thing.
 */

/** What each tile holds, by tile id. Absent means an empty tile. */
export type MosaicChars = Record<string, string>

export interface Typed {
  chars: MosaicChars
  /** Where the caret ends up. Null only when the mosaic has no tiles at all. */
  focus: string | null
}

/** A copy with one tile's character replaced, or removed when it is null. */
export function setCharacter(chars: MosaicChars, tileId: string, char: string | null): MosaicChars {
  const next = { ...chars }
  if (char === null || char === '') delete next[tileId]
  else next[tileId] = char
  return next
}

export function characterAt(chars: MosaicChars, tileId: string): string | null {
  return chars[tileId] ?? null
}

/**
 * Put a character in the focused tile and move on.
 *
 * Replaces whatever was there — a tile holds one character, so typing into a
 * full tile is how you change it rather than something to refuse.
 *
 * The caret STOPS at the last tile rather than wrapping. Wrapping would read as
 * the caret jumping, and the next keystroke would overwrite the first tile.
 */
export function typeCharacter(
  chars: MosaicChars,
  order: readonly string[],
  focus: string,
  char: string,
): Typed {
  return {
    chars: setCharacter(chars, focus, char),
    focus: stepThrough(order, focus, 1),
  }
}

export interface Pasted extends Typed {
  /** Characters there was no tile left for. */
  dropped: number
}

/**
 * Fill consecutive tiles from the caret onward.
 *
 * What will not fit is DROPPED and counted rather than wrapped round to the
 * start or silently truncated. Wrapping would overwrite the beginning of the
 * mosaic with the end of the paste; saying nothing would leave the user
 * believing it all went in.
 */
export function pasteCharacters(
  chars: MosaicChars,
  order: readonly string[],
  focus: string,
  text: string,
): Pasted {
  const letters = graphemes(text)
  const start = order.indexOf(focus)
  if (start === -1 || letters.length === 0) return { chars: { ...chars }, focus, dropped: 0 }

  const room = order.length - start
  const placed = Math.min(room, letters.length)

  let next = { ...chars }
  for (let i = 0; i < placed; i++) {
    next = setCharacter(next, order[start + i] as string, letters[i] as string)
  }

  return {
    chars: next,
    // On the tile after the last one filled, or on the last one when the paste
    // ran to the end — the same place a run of typing would have left it.
    focus: order[Math.min(order.length - 1, start + placed)] ?? focus,
    dropped: letters.length - placed,
  }
}

/**
 * Delete: empty this tile and stay.
 *
 * An empty tile is a real tile, so there is somewhere to stay — which is the
 * difference from a text field, where deleting closes the gap.
 */
export function deleteCharacter(chars: MosaicChars, focus: string): Typed {
  return { chars: setCharacter(chars, focus, null), focus }
}

/**
 * Backspace: empty this tile, or step back and empty that one.
 *
 * The two-step behaviour is what makes holding backspace walk back through what
 * was typed. Emptying in place first means one press after typing undoes that
 * keystroke without moving, which is what the caret's position implies.
 */
export function backspaceCharacter(
  chars: MosaicChars,
  order: readonly string[],
  focus: string,
): Typed {
  if (characterAt(chars, focus) !== null) {
    return { chars: setCharacter(chars, focus, null), focus }
  }
  const previous = stepThrough(order, focus, -1)
  if (!previous || previous === focus) return { chars: { ...chars }, focus }
  return { chars: setCharacter(chars, previous, null), focus: previous }
}

/* ------------------------------------------------------------- words */

/*
 * A cell that holds a WORD rather than a letter — the mesh's cells.
 *
 * The rules above are a letter-per-tile keyboard: a keystroke fills the tile
 * and moves on, because there is nothing more to put in it. A mesh cell is
 * poured with whatever string it holds, so typing APPENDS and the caret stays
 * where it is; moving on is a deliberate act — Space or Return — and Backspace
 * takes back one letter at a time before it steps back a cell. The same
 * letters-by-tile-id, the same "absent is empty".
 */

/** Add a character to the end of what the focused cell holds, and stay. */
export function appendCharacter(chars: MosaicChars, focus: string, char: string): Typed {
  return { chars: setCharacter(chars, focus, (chars[focus] ?? '') + char), focus }
}

/**
 * Backspace in a word cell: take the last letter off, or, from an empty cell,
 * step back to the cell before — leaving what it holds, so that holding the
 * key walks back across the cells without eating a word by surprise.
 */
export function backspaceLetter(chars: MosaicChars, order: readonly string[], focus: string): Typed {
  const held = graphemes(chars[focus] ?? '')
  if (held.length > 0) {
    return { chars: setCharacter(chars, focus, held.slice(0, -1).join('')), focus }
  }
  const previous = stepThrough(order, focus, -1)
  return { chars: { ...chars }, focus: previous ?? focus }
}

/**
 * Paste into word cells: one word per cell from the caret onward, split on
 * whitespace, the first word joining whatever the caret's cell already holds.
 * What will not fit is dropped and counted, as `pasteCharacters` does.
 */
export function pasteWords(
  chars: MosaicChars,
  order: readonly string[],
  focus: string,
  text: string,
): Pasted {
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const start = order.indexOf(focus)
  if (start === -1 || words.length === 0) return { chars: { ...chars }, focus, dropped: 0 }

  const room = order.length - start
  const placed = Math.min(room, words.length)
  let next = { ...chars }
  for (let i = 0; i < placed; i++) {
    const cell = order[start + i] as string
    const before = i === 0 ? (next[cell] ?? '') : ''
    next = setCharacter(next, cell, before + (words[i] as string))
  }
  return {
    chars: next,
    focus: order[Math.min(order.length - 1, start + placed - 1)] ?? focus,
    dropped: words.length - placed,
  }
}
