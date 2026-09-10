/**
 * Splitting text into the characters a person would count.
 *
 * A tile holds ONE character, and JavaScript disagrees with people about what
 * that is. `'é'.length` can be 2 when the accent is a combining mark; a flag
 * emoji is 4 code units and 2 code points; 👩‍👩‍👧 is three people joined by
 * zero-width joiners and comes to 8. Splitting by code unit puts half a letter
 * in one tile and its accent in the next, and splitting by code point does the
 * same to anything built out of joiners.
 *
 * `Intl.Segmenter` knows the real rule and every browser this runs in has it.
 * The fallback exists for the test runner and for anything older: it is not as
 * correct, but it is correct about the cases that actually turn up — combining
 * marks, surrogate pairs, joined sequences and variation selectors.
 */

/** Built once: constructing a segmenter is not free and the rule never changes. */
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

export function graphemes(text: string): string[] {
  if (!text) return []
  if (segmenter) return [...segmenter.segment(text)].map((part) => part.segment)
  return fallbackGraphemes(text)
}

/** The first character, or null when there is not one. */
export function firstGrapheme(text: string): string | null {
  return graphemes(text)[0] ?? null
}

/**
 * Whether a keystroke is a character to type rather than a command.
 *
 * `key` is a single grapheme for a printable key and a word — `Enter`,
 * `ArrowLeft`, `Backspace` — for everything else, so the length of the grapheme
 * list is the whole test. The modifier check keeps ⌘Z and ⌘A as commands: they
 * arrive with `key` of one letter and would otherwise be typed into a tile.
 */
export function isTypedCharacter(key: string, modified: boolean): boolean {
  if (modified) return false
  return graphemes(key).length === 1
}

/**
 * Grapheme clusters without `Intl.Segmenter`.
 *
 * Keeps together: surrogate pairs, anything joined by a zero-width joiner, marks
 * that combine onto the character before them, variation selectors, regional
 * indicator pairs (flags), and keycap sequences. That is not the full Unicode
 * rule — it does not handle every Indic cluster — but it never SPLITS something
 * the full rule would keep whole, which is the failure that would show up as
 * half a letter in a tile.
 */
function fallbackGraphemes(text: string): string[] {
  const points = [...text]
  const out: string[] = []
  let current = ''

  for (let i = 0; i < points.length; i++) {
    const point = points[i] as string
    const code = point.codePointAt(0) ?? 0

    if (current === '') {
      current = point
      continue
    }

    const joined = current.endsWith('‍')
    const combining = isCombining(code)
    const variation = code >= 0xfe00 && code <= 0xfe0f
    const keycap = point === '⃣'
    const zwj = point === '‍'
    const flagPair = isRegionalIndicator(code) && isRegionalIndicator(current.codePointAt(0) ?? 0) && [...current].length === 1

    if (joined || combining || variation || keycap || zwj || flagPair) {
      current += point
      continue
    }

    out.push(current)
    current = point
  }

  if (current !== '') out.push(current)
  return out
}

const isRegionalIndicator = (code: number): boolean => code >= 0x1f1e6 && code <= 0x1f1ff

/** The combining ranges that turn up in ordinary text. */
function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) || // combining marks for symbols
    (code >= 0xfe20 && code <= 0xfe2f)
  )
}
