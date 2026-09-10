import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { itemArea } from '../../src/geometry/regions'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'
import type { GridDivider } from '../../src/types/document'

const FONT_ID = 'anton'
const SHAPE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const TEXT = 'RONESHA IS THE VERY BEST OF ALL TIME'

beforeAll(() => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
})

afterEach(() => {
  resetPaperScope()
})

function row(id: string, v: number): GridDivider {
  return {
    id,
    points: [
      { x: 0, y: v },
      { x: 0.5, y: v },
      { x: 1, y: v },
    ],
    axis: 'row',
  }
}

/** A vertical deformer standing at `u`, all the way down the shape. */
function deformer(id: string, u: number, bow = 0): GridDivider {
  return {
    id,
    // A deformer's points are (v, u): the parameter runs DOWN the shape.
    points: [
      { x: 0, y: u },
      { x: 0.5, y: u + bow },
      { x: 1, y: u },
    ],
    axis: 'column',
  }
}

function fit(dividers: GridDivider[]) {
  const result = fitTextToShape({
    text: TEXT,
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

/** The x with half the line's outline points either side of it. */
function medianX(path: string): number {
  const numbers = path.match(/-?\d+(\.\d+)?/g) ?? []
  const xs: number[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) xs.push(Number(numbers[i]))
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)] ?? 0
}

const ROWS = [row('r1', 0.34), row('r2', 0.67)]

describe('vertical deformers', () => {
  it('does nothing at its resting place', () => {
    // A single deformer rests in the middle. Standing there it must be exactly
    // the identity — it is a handle on the type, not a boundary in it.
    expect(fit([...ROWS, deformer('d', 0.5)]).path).toBe(fit(ROWS).path)
  })

  it('squeezes one side and stretches the other when dragged', () => {
    const rest = fit([...ROWS, deformer('d', 0.5)])
    const pulled = fit([...ROWS, deformer('d', 0.28)])
    expect(pulled.path).not.toBe(rest.path)

    // Dragged left, the type on its left is compressed, so the weight of the
    // ink shifts that way too.
    for (let i = 0; i < rest.lines.length; i++) {
      expect(medianX(pulled.lines[i]!.path)).toBeLessThan(medianX(rest.lines[i]!.path))
    }
  })

  it('does not move a single word between rows', () => {
    // The whole point of the correction: a deformer changes proportions, never
    // content. Same rows, same words, in the same order.
    const rest = fit([...ROWS, deformer('d', 0.5)])
    const pulled = fit([...ROWS, deformer('d', 0.25)])
    expect(pulled.lineCount).toBe(rest.lineCount)
    expect(pulled.lines.map((l) => l.text)).toEqual(rest.lines.map((l) => l.text))
  })

  it('leaves the row count alone however many deformers there are', () => {
    const none = fit(ROWS).lineCount
    expect(fit([...ROWS, deformer('a', 0.3)]).lineCount).toBe(none)
    expect(fit([...ROWS, deformer('a', 0.2), deformer('b', 0.8)]).lineCount).toBe(none)
  })

  it('keeps the text exact', () => {
    const result = fit([...ROWS, deformer('a', 0.2), deformer('b', 0.75)])
    expect(verifyExactText(TEXT, result.lines.map((l) => l.text), 'word').ok).toBe(true)
  })

  it('varies the squeeze down the shape when the deformer is bowed', () => {
    // A deformer is a CURVE, so it can pinch the middle of the block while
    // leaving the top and bottom rows where they were.
    const straight = fit([...ROWS, deformer('d', 0.5)])
    const bowed = fit([...ROWS, deformer('d', 0.5, -0.2)])
    const shifts = straight.lines.map((line, i) =>
      Math.abs(medianX(bowed.lines[i]!.path) - medianX(line.path)),
    )
    expect(Math.max(...shifts)).toBeGreaterThan(Math.min(...shifts) + 1)
  })

  it('keeps the type inside the container', () => {
    const result = fit([...ROWS, deformer('a', 0.22), deformer('b', 0.8)])
    const escaped = withPaper((scope) => {
      const text = parsePathInScope(scope, result.path)
      const shape = parsePathInScope(scope, SHAPE)
      const total = Math.abs(itemArea(text))
      const outside = text.subtract(shape)
      const value = total > 0 ? Math.abs(itemArea(outside)) / total : 0
      outside.remove()
      text.remove()
      shape.remove()
      return value
    })
    expect(escaped).toBeLessThan(0.02)
  })

  it('cannot be folded over by dragging deformers past each other', () => {
    // Two deformers crossed over: the remap must stay increasing, or the row
    // would turn inside out.
    const crossed = fit([...ROWS, deformer('a', 0.8), deformer('b', 0.2)])
    expect(crossed.path).not.toMatch(/NaN|Infinity/)
    expect(verifyExactText(TEXT, crossed.lines.map((l) => l.text), 'word').ok).toBe(true)
  })

  it('needs no more text than the rows alone', () => {
    // Deformers used to be text-flow boundaries, so each one DOUBLED the words
    // a grid required and switched the whole grid off when it could not be met.
    const result = fitTextToShape({
      text: 'RONESHA IS THE BEST',
      shapePath: SHAPE,
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: 1.14,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'boundary-warp',
      distortion: defaultDistortionSettings,
      seed: 1,
      dividers: [...ROWS, deformer('a', 0.3), deformer('b', 0.7)],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lineCount).toBe(3)
  })
})
