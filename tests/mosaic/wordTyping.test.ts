import { describe, expect, it } from 'vitest'

import { appendCharacter, backspaceLetter, pasteWords } from '../../src/mosaic/typing'

/**
 * A cell that holds a word: letters go on the end and the caret stays; only
 * a deliberate step moves on.
 */

const order = ['a', 'b', 'c']

describe('typing into a word cell', () => {
  it('appends and stays put', () => {
    const one = appendCharacter({}, 'b', 'm')
    expect(one).toEqual({ chars: { b: 'm' }, focus: 'b' })
    const two = appendCharacter(one.chars, 'b', 'e')
    expect(two.chars['b']).toBe('me')
    expect(two.focus).toBe('b')
  })

  it('takes one letter back at a time, then steps back without eating the word before', () => {
    const start = { a: 'hi', b: 'me' }
    const one = backspaceLetter(start, order, 'b')
    expect(one).toEqual({ chars: { a: 'hi', b: 'm' }, focus: 'b' })
    const empty = backspaceLetter(one.chars, order, 'b')
    expect(empty).toEqual({ chars: { a: 'hi' }, focus: 'b' })
    const back = backspaceLetter(empty.chars, order, 'b')
    expect(back).toEqual({ chars: { a: 'hi' }, focus: 'a' })
    // At the first cell there is nowhere to go.
    expect(backspaceLetter({}, order, 'a').focus).toBe('a')
    // A grapheme is one letter, whatever it is made of.
    expect(backspaceLetter({ a: 'xé' }, order, 'a').chars['a']).toBe('x')
  })

  it('pastes a word per cell from the caret, the first joining what is there', () => {
    const result = pasteWords({ a: 'go' }, order, 'a', 'od  morning world')
    expect(result.chars).toEqual({ a: 'good', b: 'morning', c: 'world' })
    expect(result.focus, 'on the last cell filled').toBe('c')
    expect(result.dropped).toBe(0)
    const overflow = pasteWords({}, order, 'b', 'one two three')
    expect(overflow.chars).toEqual({ b: 'one', c: 'two' })
    expect(overflow.dropped).toBe(1)
    expect(pasteWords({ a: 'x' }, order, 'a', '   ')).toEqual({ chars: { a: 'x' }, focus: 'a', dropped: 0 })
  })
})
