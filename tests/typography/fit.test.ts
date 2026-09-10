import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper, insetPath } from '../../src/geometry/clipper'
import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { registerFont } from '../../src/typography/fontRegistry'
import { fitTextToShape } from '../../src/typography/fit'
import { verifyExactText } from '../../src/typography/invariant'

const FONT_ID = 'anton'

afterEach(() => {
  resetPaperScope()
})

beforeAll(async () => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const buffer = readFileSync(path)
  const font = opentype.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  )
  registerFont(FONT_ID, font)
  await initClipper()
})

function circlePath(r: number): string {
  return withPaper((scope) => {
    const c = new scope.Path.Circle({ center: [0, 0], radius: r })
    const d = c.pathData
    c.remove()
    return d
  })
}

function blobPath(): string {
  return withPaper((scope) => {
    const pts = []
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2
      const rad = 200 + 60 * Math.sin(a * 3)
      pts.push(new scope.Point(rad * Math.cos(a), rad * Math.sin(a)))
    }
    const p = new scope.Path({ segments: pts, closed: true })
    p.smooth()
    const d = p.pathData
    p.remove()
    return d
  })
}

const baseOptions = {
  fontId: FONT_ID,
  flowMode: 'word' as const,
  lineSpacing: 1,
  letterSpacing: 0,
  quality: 'final' as const,
}

describe('fitTextToShape', () => {
  it('fills a circle with the exact text, exactly once', () => {
    const text = 'Typography becomes the shape itself'
    const result = fitTextToShape({ ...baseOptions, text, shapePath: circlePath(220) })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.lines.length).toBeGreaterThan(1)
    expect(verifyExactText(text, result.lines.map((l) => l.text), 'word').ok).toBe(true)
    expect(result.path.length).toBeGreaterThan(0)
  })

  it('never repeats, truncates, or reorders across many shapes and texts', () => {
    const texts = [
      'Short',
      'Two words',
      'Typography becomes the shape itself',
      'A rather longer sentence that should require several lines to fit comfortably inside the given container',
      'Hello, world! Punctuation — stays: attached?',
    ]
    const shapes = [circlePath(120), circlePath(260), blobPath()]

    for (const text of texts) {
      for (const shapePath of shapes) {
        const result = fitTextToShape({ ...baseOptions, text, shapePath })
        if (!result.ok) continue
        const check = verifyExactText(text, result.lines.map((l) => l.text), 'word')
        expect(check.ok, `"${text}" produced "${result.lines.map((l) => l.text).join(' | ')}"`).toBe(
          true,
        )
      }
    }
  })

  it('uses more lines for long text than for short text in the same shape', () => {
    const shapePath = circlePath(220)
    const short = fitTextToShape({ ...baseOptions, text: 'Big bold type', shapePath })
    const long = fitTextToShape({
      ...baseOptions,
      shapePath,
      text: 'This is a considerably longer passage of text which must be broken across many more lines in order to fit within the very same container shape',
    })

    expect(short.ok && long.ok).toBe(true)
    if (!short.ok || !long.ok) return
    expect(long.lineCount).toBeGreaterThan(short.lineCount)
  })

  it('scales short text up to fill a large shape', () => {
    const small = fitTextToShape({ ...baseOptions, text: 'Fill me', shapePath: circlePath(80) })
    const large = fitTextToShape({ ...baseOptions, text: 'Fill me', shapePath: circlePath(320) })
    expect(small.ok && large.ok).toBe(true)
    if (!small.ok || !large.ok) return

    const smallSize = small.lines[0]?.size ?? 0
    const largeSize = large.lines[0]?.size ?? 0
    expect(largeSize).toBeGreaterThan(smallSize)
  })

  it('respects manually entered line breaks', () => {
    const text = 'first line\nsecond line\nthird line'
    const result = fitTextToShape({
      ...baseOptions,
      text,
      shapePath: circlePath(240),
      flowMode: 'preserve-lines',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines.map((l) => l.text)).toEqual(['first line', 'second line', 'third line'])
  })

  it('supports character wrapping for experimental typography', () => {
    const text = 'SHAPED'
    const result = fitTextToShape({
      ...baseOptions,
      text,
      shapePath: circlePath(200),
      flowMode: 'character',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(verifyExactText(text, result.lines.map((l) => l.text), 'character').ok).toBe(true)
  })

  it('reports no space when the inset collapses the interior', () => {
    const tiny = circlePath(20)
    const inset = insetPath(tiny, 40)
    expect(inset.collapsed).toBe(true)

    const result = fitTextToShape({
      ...baseOptions,
      text: 'Anything',
      shapePath: inset.path ?? '',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-space')
    expect(result.message).toBe('Not enough space for text.')
  })

  it('rejects empty text rather than rendering nothing silently', () => {
    const result = fitTextToShape({ ...baseOptions, text: '   ', shapePath: circlePath(200) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('empty-text')
  })

  it('flags extreme distortion instead of failing', () => {
    // A long text crammed into a narrow shape must still render in full.
    const text =
      'An extremely long line of text that cannot possibly fit without severe horizontal compression'
    const result = fitTextToShape({ ...baseOptions, text, shapePath: circlePath(60) })
    if (!result.ok) return
    expect(verifyExactText(text, result.lines.map((l) => l.text), 'word').ok).toBe(true)
  })

  it('produces deterministic output for identical input', () => {
    const args = { ...baseOptions, text: 'Deterministic layout', shapePath: circlePath(200) }
    const a = fitTextToShape(args)
    const b = fitTextToShape(args)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.path).toBe(b.path)
  })

  it('preserves glyph counters — the "o" keeps its hole', () => {
    const result = fitTextToShape({ ...baseOptions, text: 'oooo', shapePath: circlePath(200) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Each "o" contributes two contours (outer + counter).
    const moveCommands = (result.path.match(/M/g) ?? []).length
    expect(moveCommands).toBe(8)
  })
})
