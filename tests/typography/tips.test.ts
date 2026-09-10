import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { parsePathInScope } from '../../src/geometry/path'
import { itemArea } from '../../src/geometry/regions'
import { PRIMITIVES } from '../../src/geometry/primitives'
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

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)

function fit(text: string, shape = ELLIPSE) {
  const result = fitTextToShape({
    text,
    shapePath: shape,
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

/** Dense samples of a path's outline. */
function samples(data: string, per = 4000): { x: number; y: number }[] {
  return withPaper((scope) => {
    const item = parsePathInScope(scope, data)
    const out: { x: number; y: number }[] = []
    const children = (item.children ?? [item]) as paper.Path[]
    for (const child of children) {
      const length = child.length
      if (!(length > 0)) continue
      const n = Math.max(24, Math.round(per * (length / 2000)))
      for (let i = 0; i <= n; i++) {
        const pt = child.getPointAt((length * i) / n)
        if (pt) out.push({ x: pt.x, y: pt.y })
      }
    }
    item.remove()
    return out
  })
}

/**
 * Vertical thickness of the ink in a narrow vertical slice.
 *
 * The artifact under test was a long horizontal spike of ink at the shape's
 * extreme, so the symptom is ink present in a slice while being far thinner
 * than the shape is there.
 */
function inkThickness(textPath: string, x: number, width: number): number {
  const inSlice = samples(textPath).filter((p) => Math.abs(p.x - x) < width / 2)
  if (inSlice.length < 2) return 0
  const ys = inSlice.map((p) => p.y)
  return Math.max(...ys) - Math.min(...ys)
}

function shapeThickness(x: number, width: number): number {
  const inSlice = samples(ELLIPSE).filter((p) => Math.abs(p.x - x) < width / 2)
  if (inSlice.length < 2) return 0
  const ys = inSlice.map((p) => p.y)
  return Math.max(...ys) - Math.min(...ys)
}

describe('the shape tips', () => {
  it('does not leave a thin spike of ink at the extremes', () => {
    // The reported defect. The boundary was modelled as y = f(x), and an
    // ellipse's edge is VERTICAL at its far left: the sampler stopped 3.5 units
    // short of the extreme while the shape was already 87 units tall there, so
    // the model claimed room the shape did not have. Type placed in that strip
    // was crushed into a horizontal spike.
    const path = fit('RONESHA IS THE BEST').path

    // A slice just inside the left extreme. Any ink here must be a reasonable
    // share of the room actually available, not a hairline.
    for (const x of [-330, 330]) {
      const room = shapeThickness(x, 12)
      const ink = inkThickness(path, x, 12)
      if (ink <= 0) continue
      expect(
        ink / room,
        `at x=${x} ink is ${ink.toFixed(1)} units in ${room.toFixed(1)} units of room`,
      ).toBeGreaterThan(0.1)
    }
  })

  it('keeps ink inside the outline at the extremes', () => {
    const path = fit('RONESHA IS THE BEST').path
    const escaped = withPaper((scope) => {
      const text = parsePathInScope(scope, path)
      const shape = parsePathInScope(scope, ELLIPSE)
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

  it('reaches the extremes at all', () => {
    // The other half of the requirement: removing the spike must not be done by
    // simply keeping the type away from the ends.
    const path = fit('RONESHA IS THE BEST').path
    const box = withPaper((scope) => {
      const item = parsePathInScope(scope, path)
      const b = { x: item.bounds.x, w: item.bounds.width }
      item.remove()
      return b
    })
    expect(box.x).toBeLessThan(-300)
    expect(box.x + box.w).toBeGreaterThan(300)
  })
})
