import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import type { GridDivider } from '../../src/types/document'

const FONT_ID = 'anton'
const SHAPE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const TEXT = 'RONESHA IS THE VERY BEST OF ALL'

beforeAll(() => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
})

afterEach(() => {
  resetPaperScope()
})

function fit(letterSpacing: number, dividers?: readonly GridDivider[]) {
  const result = fitTextToShape({
    text: TEXT,
    shapePath: SHAPE,
    fontId: FONT_ID,
    flowMode: 'word',
    lineSpacing: 1.14,
    letterSpacing,
    quality: 'final',
    fittingMode: 'boundary-warp',
    distortion: defaultDistortionSettings,
    seed: 1,
    ...(dividers ? { dividers } : {}),
  })
  if (!result.ok) throw new Error(`fit failed: ${result.reason}`)
  return result
}

/**
 * The cuts the grid editor materialises when it opens: halfway through the gap
 * between one row and the next, taken from the layout that is on screen.
 */
function cutsFromLayout(): GridDivider[] {
  const base = fit(0)
  const out: GridDivider[] = []
  for (let i = 1; i < base.lines.length; i++) {
    const above = base.lines[i - 1]!
    const below = base.lines[i]!
    const v = (above.rowBottom + below.rowTop) / 2
    out.push({
      id: `d${i}`,
      points: [
        { x: 0, y: v },
        { x: 0.5, y: v },
        { x: 1, y: v },
      ],
    })
  }
  return out
}

/** Vertical extent of each row's ink. */
function rowHeights(lines: readonly { path: string }[]): number[] {
  return lines.map((line) =>
    withPaper((scope) => {
      if (!line.path) return 0
      const item = parsePathInScope(scope, line.path)
      const h = item.bounds.height
      item.remove()
      return h
    }),
  )
}

describe('opening the grid editor', () => {
  it('does not move the type', () => {
    // The reported jump. The editor materialises cuts from the layout on
    // screen, so applying them must reproduce that same layout. It did not:
    // dividers are stored in PATCH space, and the fit was clamping a fraction
    // between 0 and 1 into the object-space y range, which put every inner cut
    // at very nearly zero and left the middle rows a fifth of a unit tall.
    const before = rowHeights(fit(0).lines)
    const after = rowHeights(fit(0, cutsFromLayout()).lines)

    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i++) {
      const a = before[i]!
      const b = after[i]!
      expect(Math.abs(a - b) / Math.max(a, b), `row ${i}: ${a.toFixed(0)} -> ${b.toFixed(0)}`).toBeLessThan(0.15)
    }
  })

  it('gives every row a real height', () => {
    const heights = rowHeights(fit(0, cutsFromLayout()).lines)
    for (const h of heights) expect(h).toBeGreaterThan(20)
  })
})

describe('letter spacing with a grid', () => {
  it('affects the middle rows, not just the first and last', () => {
    // With the cuts collapsed, `tracking = letterSpacing * bandHeight` was
    // multiplying by nearly nothing on every row bounded by two dividers, so
    // only the outermost rows — which are bounded by the container — responded.
    const dividers = cutsFromLayout()
    const loose = fit(0.4, dividers)
    const tight = fit(0, dividers)

    expect(loose.lines).toHaveLength(tight.lines.length)
    for (let i = 0; i < tight.lines.length; i++) {
      expect(loose.lines[i]!.path, `row ${i} ignored letter spacing`).not.toBe(tight.lines[i]!.path)
    }
  })

  it('changes each row about as much as it would without a grid', () => {
    const dividers = cutsFromLayout()
    const withGrid = rowHeights(fit(0.4, dividers).lines)
    const without = rowHeights(fit(0.4).lines)
    for (let i = 0; i < without.length; i++) {
      const a = without[i]!
      const b = withGrid[i]!
      expect(Math.abs(a - b) / Math.max(a, b), `row ${i}`).toBeLessThan(0.15)
    }
  })
})
