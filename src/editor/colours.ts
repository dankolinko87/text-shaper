/**
 * Canvas colours, read from the stylesheet.
 *
 * The palette lives in `tokens.css` and nowhere else. The canvas is drawn by
 * Fabric, which needs a concrete colour string rather than a CSS variable, so
 * these are resolved once from the document's computed style and cached — which
 * keeps the panels and the canvas the same colour by construction instead of by
 * two literals that agree until somebody edits one of them.
 *
 * The fallback is for the headless test run, where there is no document to ask.
 */
const resolved = new Map<string, string>()

export function token(name: string, fallback: string): string {
  const seen = resolved.get(name)
  if (seen !== undefined) return seen
  if (typeof document === 'undefined' || !document.documentElement) return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const colour = value || fallback
  resolved.set(name, colour)
  return colour
}

/**
 * What "this is selected" looks like, everywhere it is said.
 *
 * A blue distinct from the app's mint accent, deliberately: the accent marks
 * what you can DO — the save button, the active tab — and selection marks what
 * you are working ON. Sharing one colour made a selected object and a primary
 * button read as the same kind of thing.
 */
export const selectionColour = (): string => token('--selection', '#2f80ed')

/** The tint inside a selection box on the canvas. */
export const selectionWash = (): string => token('--selection-wash', 'rgba(47, 128, 237, 0.1)')
