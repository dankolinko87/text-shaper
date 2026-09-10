import type { TextFlowMode } from '../types/document'

/**
 * Splitting the source text into the atomic units the fitting engine may
 * distribute across lines.
 *
 * Every mode preserves order and content exactly — these functions only decide
 * WHERE a break is permitted, never what the characters are.
 */

export interface TextUnits {
  /** The atomic pieces, in source order. */
  units: string[]
  /** How units rejoin within a line. */
  separator: string
  /** Hard breaks the user typed: index into `units` where a new line must start. */
  forcedBreaks: number[]
}

export function splitIntoUnits(text: string, mode: TextFlowMode): TextUnits {
  switch (mode) {
    case 'character':
      return { units: Array.from(text), separator: '', forcedBreaks: [] }

    case 'preserve-lines': {
      const lines = text.split(/\r\n|\r|\n/)
      // Each source line is one unit; the engine may not merge them.
      return { units: lines, separator: '\n', forcedBreaks: lines.map((_, i) => i) }
    }

    case 'word':
    default: {
      const units = text.trim().split(/\s+/).filter(Boolean)
      return { units, separator: ' ', forcedBreaks: [] }
    }
  }
}

/**
 * Distribute units across `lineCount` lines, weighted by how much room each
 * line has.
 *
 * Guarantees, which together are what make the text invariant hold:
 * - every unit is placed exactly once,
 * - order is never changed,
 * - no line is left empty, unless `allowEmpty` says otherwise.
 *
 * `allowEmpty` exists for the CELLS of a row. A column divider splits a row in
 * two whether or not that row has two words to give, and a blank cell is a
 * legitimate piece of a layout — refusing to leave one meant a single column
 * could double the text a grid required and switch the whole thing off. With it
 * set, exactly `lineCount` groups come back and some of them may be empty.
 */
export function distributeUnits(
  units: readonly string[],
  weights: readonly number[],
  lineCount: number,
  options: { allowEmpty?: boolean } = {},
): string[][] {
  const allowEmpty = options.allowEmpty === true
  if (allowEmpty) return distributeAllowingEmpty(units, weights, lineCount)

  const n = Math.max(1, Math.min(lineCount, units.length))
  const lines: string[][] = []

  const usableWeights = weights.slice(0, n)
  const totalWeight = usableWeights.reduce((sum, w) => sum + Math.max(0, w), 0)

  let cursor = 0
  for (let i = 0; i < n; i++) {
    const remainingLines = n - i - 1
    // Always leave at least one unit for each remaining line.
    const maxTake = units.length - cursor - remainingLines
    if (maxTake <= 0) {
      lines.push([])
      continue
    }

    let take: number
    if (i === n - 1) {
      take = units.length - cursor
    } else if (totalWeight > 0) {
      const share = Math.max(0, usableWeights[i] ?? 0) / totalWeight
      take = Math.round(share * units.length)
    } else {
      take = Math.round(units.length / n)
    }

    take = Math.max(1, Math.min(take, maxTake))
    lines.push(units.slice(cursor, cursor + take) as string[])
    cursor += take
  }

  // Anything left over (rounding) joins the last line rather than being dropped.
  if (cursor < units.length) {
    const last = lines[lines.length - 1]
    if (last) last.push(...units.slice(cursor))
    else lines.push(units.slice(cursor) as string[])
  }

  return lines.filter((line) => line.length > 0)
}

/** Join a line's units back into renderable text. */
export function joinUnits(units: readonly string[], separator: string): string {
  return units.join(separator)
}

/**
 * The same split, but a group may come back empty and the count is exact.
 *
 * Units are handed out in order, each group taking its share of what is left by
 * weight. Whatever rounding leaves over joins the last group that has anything,
 * so nothing is ever dropped.
 */
function distributeAllowingEmpty(
  units: readonly string[],
  weights: readonly number[],
  count: number,
): string[][] {
  const n = Math.max(1, count)
  const groups: string[][] = Array.from({ length: n }, () => [])
  if (units.length === 0) return groups

  const usable = Array.from({ length: n }, (_, i) => Math.max(0, weights[i] ?? 0))
  const total = usable.reduce((sum, w) => sum + w, 0)

  let cursor = 0
  for (let i = 0; i < n && cursor < units.length; i++) {
    const remaining = units.length - cursor
    const take =
      i === n - 1
        ? remaining
        : total > 0
          ? Math.min(remaining, Math.round(((usable[i] ?? 0) / total) * units.length))
          : Math.min(remaining, Math.round(units.length / n))
    const group = groups[i]
    if (group && take > 0) {
      group.push(...units.slice(cursor, cursor + take))
      cursor += take
    }
  }

  // Rounding can leave a tail. It joins the last group that already has text,
  // so no unit is lost and none appears out of order.
  if (cursor < units.length) {
    for (let i = n - 1; i >= 0; i--) {
      const group = groups[i]
      if (group && group.length > 0) {
        group.push(...units.slice(cursor))
        break
      }
    }
  }
  return groups
}
