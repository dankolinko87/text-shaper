import { describe, expect, it } from 'vitest'

import { hexToHsl, hexToHsv, hslToHex, hsvToHex } from '../../src/typography/hsv'

/**
 * The picker's view of a colour must go out and come back without moving it:
 * a colour that merely had its picker opened must not change in the document.
 */
const NAMED: Record<string, string> = {
  red: '#ff0000',
  yellow: '#ffff00',
  lime: '#00ff00',
  cyan: '#00ffff',
  blue: '#0000ff',
  magenta: '#ff00ff',
  white: '#ffffff',
  black: '#000000',
  grey: '#808080',
  orange: '#ff8000',
  teal: '#008080',
  navy: '#000080',
}

describe('hex through hsv and back', () => {
  it('is byte-identical for the named colours', () => {
    for (const [name, hex] of Object.entries(NAMED)) {
      const hsv = hexToHsv(hex)
      expect(hsv, name).not.toBeNull()
      expect(hsvToHex(hsv!), name).toBe(hex)
    }
  })

  it('carries opacity', () => {
    const hsv = hexToHsv('#e0552f80')
    expect(hsv?.a).toBeCloseTo(0x80 / 255, 6)
    expect(hsvToHex(hsv!)).toBe('#e0552f80')
    expect(hsvToHex({ ...hsv!, a: 1 }), 'opaque drops the alpha digits').toBe('#e0552f')
  })

  it('round-trips a sweep of hues within what eight bits can say, and is then stable', () => {
    /*
     * A dark, dull colour has few distinct hues at all — at a quarter of the
     * value and a quarter of the saturation, the whole wheel is sixteen steps
     * of one channel — so the hue can come back a couple of degrees off. What
     * must NOT happen is drift: the hex a picker writes, read back and
     * written again, is the same hex.
     */
    for (let h = 0; h < 360; h += 7) {
      for (const s of [0.25, 0.5, 1]) {
        for (const v of [0.25, 0.5, 1]) {
          const hex = hsvToHex({ h, s, v, a: 1 })
          const back = hexToHsv(hex)!
          const dh = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h))
          expect(dh, `hue ${h} s ${s} v ${v}`).toBeLessThan(3)
          expect(Math.abs(back.s - s), `saturation at ${h}`).toBeLessThan(0.02)
          expect(Math.abs(back.v - v), `value at ${h}`).toBeLessThan(0.003)
          expect(hsvToHex(back), `stable at ${h}/${s}/${v}`).toBe(hex)
        }
      }
    }
  })

  it('treats greys as having no hue, and paints them from any hue', () => {
    expect(hexToHsv('#808080')?.s).toBe(0)
    expect(hexToHsv('#808080')?.h).toBe(0)
    expect(hsvToHex({ h: 200, s: 0, v: 0.5, a: 1 })).toBe('#808080')
    expect(hsvToHex({ h: 0, s: 1, v: 0, a: 1 }), 'no value is black whatever the hue').toBe('#000000')
  })

  it('refuses what is not a colour', () => {
    expect(hexToHsv('tomato')).toBeNull()
    expect(hexToHsv('#12')).toBeNull()
  })
})

describe('hex through hsl and back', () => {
  it('is byte-identical for the named colours', () => {
    for (const [name, hex] of Object.entries(NAMED)) {
      expect(hslToHex(hexToHsl(hex)!), name).toBe(hex)
    }
  })

  it('reads the textbook values', () => {
    const red = hexToHsl('#ff0000')!
    expect(red.h).toBe(0)
    expect(red.s).toBeCloseTo(1, 6)
    expect(red.l).toBeCloseTo(0.5, 6)
    const grey = hexToHsl('#808080')!
    expect(grey.s).toBe(0)
    expect(grey.l).toBeCloseTo(0x80 / 255, 6)
    // hsl(141 41% 29%) by the book: chroma .2378, second .0832, lift .1711 → (44, 104, 65).
    expect(hslToHex({ h: 141, s: 0.41, l: 0.29, a: 1 })).toBe('#2c6841')
  })
})
