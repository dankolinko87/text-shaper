/**
 * Which of the two palettes the UI wears.
 *
 * A preference of the person, not of the document: it lives in the browser's
 * storage rather than in the file, so a document opened by somebody else comes
 * up in their own colours. Dark is the default — the app's own face — and a
 * choice, once made, is kept.
 */
export type Theme = 'dark' | 'light'

const KEY = 'text-shaper:theme'

const isTheme = (value: unknown): value is Theme => value === 'dark' || value === 'light'

/** The kept choice, or dark when there is none or the storage cannot be read. */
export function readTheme(storage: Pick<Storage, 'getItem'> | null | undefined): Theme {
  try {
    const stored = storage?.getItem(KEY)
    return isTheme(stored) ? stored : 'dark'
  } catch {
    return 'dark'
  }
}

/** Keep the choice; a storage that refuses (private mode, quota) is not an error. */
export function writeTheme(storage: Pick<Storage, 'setItem'> | null | undefined, theme: Theme): void {
  try {
    storage?.setItem(KEY, theme)
  } catch {
    /* nothing to do: the choice still holds for this session */
  }
}

export const other = (theme: Theme): Theme => (theme === 'dark' ? 'light' : 'dark')

/**
 * Put the palette on the document. The stylesheet keys every token off this
 * one attribute, so this is the whole switch; it runs once before the first
 * render, so a kept light choice never flashes dark on the way in.
 */
export function applyTheme(theme: Theme, root: { dataset: DOMStringMap } = document.documentElement): void {
  root.dataset.theme = theme
}
