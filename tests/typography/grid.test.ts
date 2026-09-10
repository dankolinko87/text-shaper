import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { addControlPoint, evaluateDivider, moveControlPoint, sortDividers, clampBetweenNeighbours } from '../../src/geometry/grid'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { itemArea } from '../../src/geometry/regions'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { verifyExactText } from '../../src/typography/invariant'
import type { GridDivider, Vec2 } from '../../src/types/document'

const FONT_ID = 'anton'
const OUT = fileURLToPath(new URL('../../preview', import.meta.url))

beforeAll(async () => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont(FONT_ID, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  await initClipper()
})
afterEach(() => resetPaperScope())

function ellipse(rx: number, ry: number): Vec2[] {
  const p: Vec2[] = []
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2
    p.push({ x: 400 + rx * Math.cos(a), y: 300 + ry * Math.sin(a) })
  }
  return p
}

describe('divider geometry', () => {
  it('evaluates a flat divider as a constant', () => {
    const d: GridDivider = { id: 'a', points: [{ x: -100, y: 40 }, { x: 0, y: 40 }, { x: 100, y: 40 }] }
    for (const x of [-200, -50, 0, 50, 200]) expect(evaluateDivider(d, x)).toBeCloseTo(40, 6)
  })

  it('passes through its control points', () => {
    const d: GridDivider = { id: 'a', points: [{ x: -100, y: 0 }, { x: 0, y: -60 }, { x: 100, y: 0 }] }
    expect(evaluateDivider(d, -100)).toBeCloseTo(0, 6)
    expect(evaluateDivider(d, 0)).toBeCloseTo(-60, 6)
    expect(evaluateDivider(d, 100)).toBeCloseTo(0, 6)
    // ...and bends smoothly between them rather than cornering.
    expect(evaluateDivider(d, -50)).toBeLessThan(0)
    expect(evaluateDivider(d, -50)).toBeGreaterThan(-60)
  })

  it('clamps beyond its ends instead of extrapolating', () => {
    const d: GridDivider = { id: 'a', points: [{ x: 0, y: 10 }, { x: 100, y: 90 }] }
    expect(evaluateDivider(d, -500)).toBe(10)
    expect(evaluateDivider(d, 500)).toBe(90)
  })

  it('orders rows top to bottom', () => {
    const a: GridDivider = { id: 'a', points: [{ x: 0, y: 80 }] }
    const b: GridDivider = { id: 'b', points: [{ x: 0, y: -40 }] }
    expect(sortDividers([a, b]).map((d) => d.id)).toEqual(['b', 'a'])
  })

  it('stops a divider crossing its neighbours', () => {
    const above: GridDivider = { id: 'x', points: [{ x: -100, y: 0 }, { x: 100, y: 0 }] }
    const dragged: GridDivider = { id: 'y', points: [{ x: -100, y: -50 }, { x: 100, y: -50 }] }
    const clamped = clampBetweenNeighbours(dragged, above, null, 10)
    for (const p of clamped.points) expect(p.y).toBeGreaterThanOrEqual(10)
  })

  it('adds a control point without moving the curve', () => {
    const d: GridDivider = { id: 'a', points: [{ x: -100, y: 0 }, { x: 100, y: 40 }] }
    const before = evaluateDivider(d, 0)
    const after = addControlPoint(d, 0)
    expect(after.points).toHaveLength(3)
    expect(evaluateDivider(after, 0)).toBeCloseTo(before, 6)
  })

  it('pins the end points to the container width when dragging', () => {
    const d: GridDivider = { id: 'a', points: [{ x: -100, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }] }
    const moved = moveControlPoint(d, 0, { x: 9999, y: 25 }, { x0: -100, x1: 100 })
    expect(moved.points[0]?.x).toBe(-100)
    expect(moved.points[0]?.y).toBe(25)
  })
})

describe('grid-driven fitting', () => {
  const text = 'Typography becomes the shape itself'

  const fit = (dividers: GridDivider[]) => {
    const shape = strokeToShapePath(ellipse(320, 240))
    const result = fitTextToShape({
      text,
      shapePath: shape.ok ? shape.pathData : '',
      fontId: FONT_ID,
      flowMode: 'word',
      lineSpacing: 1.14,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'boundary-warp',
      distortion: defaultDistortionSettings,
      seed: 3,
      dividers,
    })
    return { shape, result }
  }

  /*
   * A divider is a decision about the SHAPE of the type, not about its content.
   *
   * This used to assert the opposite — one row per divider plus one — and that
   * second job was the trouble: drawing a divider repaginated the text, and
   * shortening the text repaginated it again, or switched the whole grid off
   * because two rows could not be filled by one word.
   */
  it('does not change how many lines there are, or what is on them', () => {
    const plain = fit([])
    expect(plain.result.ok).toBe(true)
    if (!plain.result.ok) return

    for (const count of [1, 2, 3]) {
      const dividers: GridDivider[] = []
      for (let i = 0; i < count; i++) {
        const v = (i + 1) / (count + 1)
        dividers.push({ id: `d${i}`, points: [{ x: 0, y: v }, { x: 0.5, y: v }, { x: 1, y: v }] })
      }
      const { result } = fit(dividers)
      expect(result.ok, `count ${count}`).toBe(true)
      if (!result.ok) continue
      expect(result.lineCount, `count ${count}`).toBe(plain.result.lineCount)
      expect(
        result.lines.map((l) => l.text),
        `count ${count}`,
      ).toEqual(plain.result.lines.map((l) => l.text))
    }
  })

  it('bends what is drawn, which is the whole of what it is for', () => {
    /*
     * Tested with a CURVED divider, and evenly spaced flat ones above are not an
     * oversight: a deformer sitting exactly where it rests maps every point to
     * itself, so one flat divider across the middle of a shape correctly draws
     * the same artwork. It is the pulling about that shows.
     */
    const plain = fit([])
    const curved = fit([
      {
        id: 'c',
        points: [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.28 }, { x: 1, y: 0.5 }],
      },
    ])
    expect(plain.result.ok && curved.result.ok).toBe(true)
    if (!plain.result.ok || !curved.result.ok) return

    expect(curved.result.lineCount).toBe(plain.result.lineCount)
    expect(curved.result.path, 'the divider bent nothing').not.toBe(plain.result.path)
  })

  it('reshapes the rows when a divider is curved, without altering the text', () => {
    // Patch space: the same two rows, flat and then bowed, at the same mean
    // heights — so only the FORM of each boundary differs.
    const flat: GridDivider[] = [
      { id: 'a', points: [{ x: 0, y: 0.34 }, { x: 0.5, y: 0.34 }, { x: 1, y: 0.34 }] },
      { id: 'b', points: [{ x: 0, y: 0.67 }, { x: 0.5, y: 0.67 }, { x: 1, y: 0.67 }] },
    ]
    const curved: GridDivider[] = [
      { id: 'a', points: [{ x: 0, y: 0.44 }, { x: 0.5, y: 0.24 }, { x: 1, y: 0.44 }] },
      { id: 'b', points: [{ x: 0, y: 0.77 }, { x: 0.5, y: 0.57 }, { x: 1, y: 0.77 }] },
    ]

    const a = fit(flat)
    const b = fit(curved)
    expect(a.result.ok && b.result.ok).toBe(true)
    if (!a.result.ok || !b.result.ok) return

    // Same rows, same words — only the form changed.
    expect(b.result.lineCount).toBe(a.result.lineCount)
    expect(b.result.lines.map((l) => l.text)).toEqual(a.result.lines.map((l) => l.text))
    expect(b.result.path).not.toBe(a.result.path)
    expect(verifyExactText(text, b.result.lines.map((l) => l.text), 'word').ok).toBe(true)

    // Still inside the container.
    const escaped = withPaper((scope) => {
      const t = new scope.CompoundPath(b.result.ok ? b.result.path : '')
      const s = new scope.CompoundPath(b.shape.ok ? b.shape.pathData : '')
      const total = Math.abs(itemArea(t))
      const out = t.subtract(s)
      const e = Math.abs(itemArea(out))
      out.remove(); t.remove(); s.remove()
      return total > 0 ? e / total : 0
    })
    expect(escaped).toBeLessThan(0.02)

    // Written out so the deformation can be judged by eye.
    const bb = b.shape.ok ? b.shape.localBounds : { x: 0, y: 0, width: 0, height: 0 }
    const pad = 30
    const vb = `${bb.x - pad} ${bb.y - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`
    const dPath = (d: GridDivider) => {
      const pts: string[] = []
      for (let x = -320; x <= 320; x += 8) pts.push(`${x},${evaluateDivider(d, x).toFixed(1)}`)
      return `M${pts.join('L')}`
    }
    writeFileSync(`${OUT}/grid-curved.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(bb.width + pad * 2)}" height="${Math.round(bb.height + pad * 2)}">
  <rect x="${bb.x - pad}" y="${bb.y - pad}" width="${bb.width + pad * 2}" height="${bb.height + pad * 2}" fill="#f4f4f2"/>
  <path d="${b.shape.ok ? b.shape.pathData : ''}" fill="#d2d2cd"/>
  <path d="${b.result.ok ? b.result.path : ''}" fill="#101014" fill-rule="nonzero"/>
  ${curved.map((d) => `<path d="${dPath(d)}" fill="none" stroke="#e0552f" stroke-width="2"/>`).join('\n  ')}
  ${curved.flatMap((d) => d.points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="6" fill="#fff" stroke="#e0552f" stroke-width="2"/>`)).join('\n  ')}
</svg>`)
  })
})
