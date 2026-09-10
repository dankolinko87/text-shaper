import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import type { GridDivider } from '../../src/types/document'

const FONT_ID = 'anton'

beforeAll(() => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
})

afterEach(() => {
  resetPaperScope()
})

const SHAPE = 'M100 100 L500 100 L500 700 L100 700 Z'

/** Flat dividers cutting the shape into `count + 1` rows, as grid mode makes. */
function rows(count: number): GridDivider[] {
  const out: GridDivider[] = []
  for (let i = 1; i <= count; i++) {
    const y = 100 + (600 * i) / (count + 1)
    out.push({
      id: `d${i}`,
      points: [
        { x: 100, y },
        { x: 300, y },
        { x: 500, y },
      ],
    })
  }
  return out
}

function fit(text: string, dividers: readonly GridDivider[]) {
  const result = fitTextToShape({
    text,
    shapePath: SHAPE,
    fontId: FONT_ID,
    flowMode: 'word',
    lineSpacing: 1.14,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'boundary-warp',
    distortion: defaultDistortionSettings,
    seed: 1,
    dividers,
  })
  if (!result.ok) throw new Error(`fit failed: ${result.reason}`)
  return result
}

/** Vertical extent of the ink as a fraction of the shape's height. */
function verticalCoverage(path: string): number {
  return withPaper((scope) => {
    const text = parsePathInScope(scope, path)
    const shape = parsePathInScope(scope, SHAPE)
    const t = text.bounds
    const s = shape.bounds
    text.remove()
    shape.remove()
    return t.height / s.height
  })
}

describe('a grid left over from longer text', () => {
  /*
   * A divider is a decision about the SHAPE of the type. How much text there is
   * at any moment is not that decision's business, on either axis.
   *
   * Row dividers used to decide how many lines there were and which words went
   * on them, as well as bending the band they bounded. That second job is what
   * these tests are about: it meant drawing a divider repaginated the text, and
   * shortening the text repaginated it again — or switched the grid off outright
   * when two rows could not be filled by one word, taking the deformers with it.
   */
  it('does not trap a single word in the top row', () => {
    // The reported bug, and now impossible by construction rather than by a
    // fallback: the rows never had a say in where the word went.
    const trapped = verticalCoverage(fit('WORD', rows(3)).path)
    const free = verticalCoverage(fit('WORD', []).path)

    expect(trapped).toBeGreaterThan(free * 0.9)
  })

  it('lays the text out the same with dividers as without, at any length', () => {
    // The contract, stated directly. Adding, removing or crossing a divider
    // must not change which words are on which line.
    for (const text of ['WORD', 'ONE TWO', 'ONE TWO THREE FOUR', 'ONE TWO THREE FOUR FIVE']) {
      const plain = fit(text, [])
      for (const count of [1, 2, 3]) {
        const gridded = fit(text, rows(count))
        expect(gridded.lineCount, `${text} with ${count} dividers`).toBe(plain.lineCount)
        expect(
          gridded.lines.map((l) => l.text),
          `${text} with ${count} dividers`,
        ).toEqual(plain.lines.map((l) => l.text))
      }
    }
  })

  it('still deforms the type, which is the whole of what a divider does', () => {
    // Laying the text out identically would be worth nothing if the dividers
    // then did nothing at all. A curved one has to bend what is drawn.
    const flat = fit('ONE TWO THREE FOUR', [])
    const curved = fit('ONE TWO THREE FOUR', [
      {
        id: 'c',
        points: [
          { x: 100, y: 300 },
          { x: 300, y: 220 },
          { x: 500, y: 300 },
        ],
      },
    ])

    expect(curved.lineCount).toBe(flat.lineCount)
    expect(curved.path, 'the divider did not bend anything').not.toBe(flat.path)
  })
})
