import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'

const FONT_ID = 'anton'

beforeAll(() => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
})

afterEach(() => {
  resetPaperScope()
})

/** A rounded blob, taller than it is wide — the shape from the reference art. */
function blob(): string {
  const pts: string[] = []
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2
    const r = 1 + 0.06 * Math.sin(a * 3) + 0.04 * Math.cos(a * 2)
    pts.push(
      `${i === 0 ? 'M' : 'L'}${(300 + 210 * r * Math.cos(a)).toFixed(2)} ` +
        `${(380 + 300 * r * Math.sin(a)).toFixed(2)}`,
    )
  }
  return `${pts.join('')}Z`
}

function fit(text: string) {
  const result = fitTextToShape({
    text,
    shapePath: blob(),
    fontId: FONT_ID,
    flowMode: 'word',
    lineSpacing: 1.14,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'boundary-warp',
    distortion: defaultDistortionSettings,
    seed: 1,
  })
  if (!result.ok) throw new Error(`fit failed: ${result.reason}`)
  return result
}

/** Gap between the ink and the outline on each side, as a fraction of the shape. */
function gaps(textPath: string): { top: number; bottom: number; left: number; right: number } {
  return withPaper((scope) => {
    const text = parsePathInScope(scope, textPath)
    const shape = parsePathInScope(scope, blob())
    const t = text.bounds
    const s = shape.bounds
    text.remove()
    shape.remove()
    return {
      top: (t.y - s.y) / s.height,
      bottom: (s.y + s.height - (t.y + t.height)) / s.height,
      left: (t.x - s.x) / s.width,
      right: (s.x + s.width - (t.x + t.width)) / s.width,
    }
  })
}

describe('filling the container', () => {
  it('stretches a single line to the top and bottom of the shape', () => {
    // The regression this guards: the warp used to CLIP a flat band against the
    // container, which can only move an edge inwards. Wherever the shape was
    // taller than the band the edge stayed flat, so the type sat in a rectangle
    // inside the shape with the boundary curving away above and below it.
    const g = gaps(fit('R').path)
    expect(g.top).toBeLessThan(0.02)
    expect(g.bottom).toBeLessThan(0.02)
  })

  it('reaches the top and bottom with several lines too', () => {
    // The outermost rows bleed to the outline; line spacing is taken between
    // rows, not as a margin around the block.
    const result = fit('RONESHA IS THE BEST')
    expect(result.lineCount).toBeGreaterThan(1)
    const g = gaps(result.path)
    expect(g.top).toBeLessThan(0.02)
    expect(g.bottom).toBeLessThan(0.02)
  })

  it('reaches the left and right edges', () => {
    const g = gaps(fit('RONESHA').path)
    expect(g.left).toBeLessThan(0.03)
    expect(g.right).toBeLessThan(0.03)
  })

  it('leaves a margin no larger vertically than horizontally', () => {
    // The reduced vertical fills used to be SCORED against a full fill, and the
    // engine regularly picked one — shrinking the block by 6% while the sides
    // still ran to the outline. The result was tight at the sides and loose
    // above and below, most visible with few characters, where the block is
    // shortest and the shortfall is the largest share of it.
    for (const text of ['Rones', 'Ronesha', 'Ronesha is the best']) {
      const g = gaps(fit(text).path)
      const vertical = Math.max(g.top, g.bottom)
      const horizontal = Math.max(g.left, g.right)
      expect(vertical, `${text}: ${(vertical * 100).toFixed(1)}% vertical margin`).toBeLessThan(0.03)
      expect(
        vertical,
        `${text}: ${(vertical * 100).toFixed(1)}% vertical vs ${(horizontal * 100).toFixed(1)}% horizontal`,
      ).toBeLessThan(horizontal + 0.02)
    }
  })

  it('does not shrink the block for a two-character word either', () => {
    // A two-character word cannot close the vertical gap completely: the gap
    // between the two characters falls on the shape's apex, where by
    // construction neither of them has any ink to put there. That is the
    // letterforms' own silhouette, not a margin. What it must NOT do is add a
    // shrunken block on top of it.
    const g = gaps(fit('Ro').path)
    expect(Math.max(g.top, g.bottom)).toBeLessThan(0.05)
  })

  it('fills more of the shape as the text grows, not less', () => {
    // Every one of these used to leave a margin that grew with the line count,
    // because the block was inset by line spacing however many rows it had.
    for (const text of ['R', 'RON', 'RONESHA', 'RONESHA IS THE BEST']) {
      const g = gaps(fit(text).path)
      expect(Math.max(g.top, g.bottom), `${text} vertical gap`).toBeLessThan(0.05)
    }
  })
})
