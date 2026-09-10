import type { TextFlowMode } from '../types/document'

/**
 * The product's central guarantee, enforced mechanically.
 *
 * "The shape controls the visual distribution and appearance of the text, but
 * it never changes the text itself." The layout engine may freely change line
 * counts, scales, spacing, and glyph geometry — but the characters it emits,
 * read in order, must reconstruct the user's input exactly.
 *
 * This is checked on EVERY layout result rather than trusted, because a
 * scoring engine that silently drops a short final word or duplicates a line
 * would otherwise be very hard to notice.
 */

export interface TextInvariantFailure {
  ok: false
  reason: 'mismatch'
  expected: string
  actual: string
  /** A short human-readable description of the first difference. */
  detail: string
}

export type TextInvariantResult = { ok: true } | TextInvariantFailure

/**
 * Reconstruct the source text from laid-out lines and compare it to the input.
 *
 * How lines rejoin depends on the flow mode:
 * - `word`: lines were split at whitespace, so a single space rejoins them.
 * - `character`: lines were split mid-run, so they concatenate directly.
 * - `preserve-lines`: lines came from the user's own newlines.
 */
export function verifyExactText(
  source: string,
  lines: readonly string[],
  mode: TextFlowMode,
): TextInvariantResult {
  const rebuilt = rejoinLines(lines, mode)
  const expected = normaliseForComparison(source, mode)

  if (rebuilt === expected) return { ok: true }

  return {
    ok: false,
    reason: 'mismatch',
    expected,
    actual: rebuilt,
    detail: describeDifference(expected, rebuilt),
  }
}

export function rejoinLines(lines: readonly string[], mode: TextFlowMode): string {
  switch (mode) {
    case 'character':
      return lines.join('')
    case 'preserve-lines':
      return lines.join('\n')
    case 'word':
    default:
      return lines.join(' ')
  }
}

/**
 * The comparison target.
 *
 * In word mode the engine is allowed to normalise runs of whitespace into
 * single separators (that is layout, not content), so the source is normalised
 * the same way before comparing. Character order and every non-space character
 * are still compared exactly.
 */
export function normaliseForComparison(source: string, mode: TextFlowMode): string {
  switch (mode) {
    case 'character':
      return source
    case 'preserve-lines':
      return source.split(/\r\n|\r|\n/).join('\n')
    case 'word':
    default:
      return source.trim().split(/\s+/).filter(Boolean).join(' ')
  }
}

function describeDifference(expected: string, actual: string): string {
  if (actual.length > expected.length && actual.includes(expected)) {
    return 'Layout produced extra content — text may have been duplicated.'
  }
  if (actual.length < expected.length && expected.includes(actual)) {
    return 'Layout is missing content — text may have been truncated.'
  }
  let i = 0
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++
  const around = (s: string): string => s.slice(Math.max(0, i - 12), i + 12)
  return `First difference at index ${i}: expected "${around(expected)}", got "${around(actual)}".`
}

/** Throwing form, for use in tests and development assertions. */
export function assertExactText(
  source: string,
  lines: readonly string[],
  mode: TextFlowMode,
): void {
  const result = verifyExactText(source, lines, mode)
  if (!result.ok) {
    throw new Error(`Text invariant violated. ${result.detail}`)
  }
}
