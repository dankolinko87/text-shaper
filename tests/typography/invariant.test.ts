import { describe, expect, it } from 'vitest'

import { assertExactText, verifyExactText } from '../../src/typography/invariant'
import { distributeUnits, splitIntoUnits } from '../../src/typography/wrap'

describe('verifyExactText', () => {
  const source = 'Typography becomes the shape itself'

  it('accepts a correct word-mode split', () => {
    const lines = ['Typography becomes', 'the shape itself']
    expect(verifyExactText(source, lines, 'word').ok).toBe(true)
  })

  it('rejects duplicated text', () => {
    const lines = ['Typography becomes', 'the shape itself', 'the shape itself']
    const result = verifyExactText(source, lines, 'word')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/duplicated|difference/i)
  })

  it('rejects truncated text', () => {
    const lines = ['Typography becomes', 'the shape']
    const result = verifyExactText(source, lines, 'word')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/truncated|difference/i)
  })

  it('rejects reordered text', () => {
    const lines = ['the shape itself', 'Typography becomes']
    expect(verifyExactText(source, lines, 'word').ok).toBe(false)
  })

  it('rejects invented content', () => {
    const lines = ['Typography becomes', 'the beautiful shape itself']
    expect(verifyExactText(source, lines, 'word').ok).toBe(false)
  })

  it('rejects a changed character', () => {
    const lines = ['Typografy becomes', 'the shape itself']
    expect(verifyExactText(source, lines, 'word').ok).toBe(false)
  })

  it('handles character mode without inserting separators', () => {
    const text = 'SHAPE'
    expect(verifyExactText(text, ['SH', 'APE'], 'character').ok).toBe(true)
    expect(verifyExactText(text, ['SH', 'PE'], 'character').ok).toBe(false)
  })

  it('preserves the user’s own line breaks', () => {
    const text = 'first line\nsecond line'
    expect(verifyExactText(text, ['first line', 'second line'], 'preserve-lines').ok).toBe(true)
    expect(verifyExactText(text, ['first line second line'], 'preserve-lines').ok).toBe(false)
  })

  it('treats collapsed whitespace as layout, not content', () => {
    const text = 'spaced    out   words'
    expect(verifyExactText(text, ['spaced out', 'words'], 'word').ok).toBe(true)
  })

  it('preserves punctuation attached to its word', () => {
    const text = 'Hello, world! Is this — right?'
    const { units, separator } = splitIntoUnits(text, 'word')
    const distributed = distributeUnits(units, [100, 100], 2)
    const lines = distributed.map((u) => u.join(separator))
    expect(verifyExactText(text, lines, 'word').ok).toBe(true)
    expect(lines.join(' ')).toContain('Hello,')
    expect(lines.join(' ')).toContain('world!')
  })

  it('assertExactText throws on violation', () => {
    expect(() => assertExactText(source, ['wrong'], 'word')).toThrow(/invariant/i)
    expect(() => assertExactText(source, [source], 'word')).not.toThrow()
  })
})

describe('distributeUnits', () => {
  it('places every unit exactly once, in order', () => {
    const units = 'one two three four five six seven eight nine ten'.split(' ')
    for (let n = 1; n <= units.length; n++) {
      const lines = distributeUnits(units, units.map(() => 100), n)
      const flat = lines.flat()
      expect(flat).toEqual(units)
    }
  })

  it('never produces an empty line', () => {
    const units = 'a b c'.split(' ')
    const lines = distributeUnits(units, [500, 10, 10, 10, 10], 5)
    for (const line of lines) expect(line.length).toBeGreaterThan(0)
  })

  it('gives wider rows more units', () => {
    const units = 'a b c d e f g h'.split(' ')
    const lines = distributeUnits(units, [10, 300], 2)
    const first = lines[0]
    const second = lines[1]
    expect(first && second).toBeTruthy()
    if (!first || !second) return
    expect(second.length).toBeGreaterThan(first.length)
  })

  it('handles more lines requested than units available', () => {
    const units = ['only', 'two']
    const lines = distributeUnits(units, [100, 100, 100, 100], 4)
    expect(lines.flat()).toEqual(units)
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('handles a single unit', () => {
    const lines = distributeUnits(['word'], [100], 3)
    expect(lines.flat()).toEqual(['word'])
  })
})

describe('splitIntoUnits', () => {
  it('splits words without losing punctuation', () => {
    const { units } = splitIntoUnits('Hello, world! Yes.', 'word')
    expect(units).toEqual(['Hello,', 'world!', 'Yes.'])
  })

  it('splits characters including spaces', () => {
    const { units } = splitIntoUnits('ab c', 'character')
    expect(units).toEqual(['a', 'b', ' ', 'c'])
  })

  it('keeps manual lines intact', () => {
    const { units } = splitIntoUnits('one\ntwo\nthree', 'preserve-lines')
    expect(units).toEqual(['one', 'two', 'three'])
  })
})
