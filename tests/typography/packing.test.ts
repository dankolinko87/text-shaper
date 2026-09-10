import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { beforeAll, describe, expect, it } from 'vitest'

import { defaultDistortionSettings } from '../../src/state/defaults'
import { measureInkExtent, registerFont } from '../../src/typography/fontRegistry'
import { packLine } from '../../src/typography/packLine'

const FONT_ID = 'anton'

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const buffer = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  )
})

/** Drawn ink box of each packed character, in object units. */
function drawnBoxes(text: string, x0: number, x1: number, bandTop: number, bandBottom: number) {
  const characters = Array.from(text)
  const slots = packLine(characters, {
    fontId: FONT_ID,
    x0,
    x1,
    bandTop,
    bandBottom,
    gap: defaultDistortionSettings.horizontal,
    letterSpacing: 0,
    variation: defaultDistortionSettings.glyphScaleVariation,
    verticalFill: defaultDistortionSettings.glyphRotation,
    seed: 7,
  })

  return slots
    .filter((s) => !s.blank)
    .map((s) => {
      const char = characters[s.index] as string
      const ink = measureInkExtent(FONT_ID, char)
      return {
        char,
        left: s.x + ink.left * s.scaleX,
        right: s.x + ink.right * s.scaleX,
        top: s.baselineY + ink.top * s.scaleY,
        bottom: s.baselineY + ink.bottom * s.scaleY,
      }
    })
}

describe('per-character packing', () => {
  const cases = ['the', 'becomes', 'Typography', 'shape', 'AV', 'illiw', 'MAKE DOPE']

  it('never lets two characters touch', () => {
    for (const text of cases) {
      const boxes = drawnBoxes(text, 0, 600, 0, 200)
      for (let i = 1; i < boxes.length; i++) {
        const prev = boxes[i - 1]
        const box = boxes[i]
        if (!prev || !box) continue
        // Strictly separated: the next character starts after the previous ends.
        expect(
          box.left,
          `"${text}": '${box.char}' starts at ${box.left.toFixed(1)} but '${prev.char}' ends at ${prev.right.toFixed(1)}`,
        ).toBeGreaterThan(prev.right)
      }
    }
  })

  it('fills the line from edge to edge', () => {
    for (const text of cases) {
      const boxes = drawnBoxes(text, 0, 600, 0, 200)
      const first = boxes[0]
      const last = boxes[boxes.length - 1]
      if (!first || !last) continue
      // The first character starts at the left edge and the last ends near the
      // right one: the line occupies its whole span rather than sitting in it.
      expect(first.left, text).toBeLessThan(6)
      expect(last.right, text).toBeGreaterThan(540)
    }
  })

  it('fills the band vertically', () => {
    const boxes = drawnBoxes('the', 0, 600, 0, 200)
    for (const box of boxes) {
      const height = box.bottom - box.top
      // Each character reaches most of the band's height on its own.
      expect(height, box.char).toBeGreaterThan(200 * 0.75)
      expect(box.top, box.char).toBeGreaterThan(-2)
      expect(box.bottom, box.char).toBeLessThan(202)
    }
  })

  it('sizes every character independently', () => {
    const boxes = drawnBoxes('illiw', 0, 600, 0, 200)
    const widths = boxes.map((b) => b.right - b.left)
    const min = Math.min(...widths)
    const max = Math.max(...widths)
    // An "i" and a "w" must not come out the same width — that would mean the
    // characters were being scaled as a group rather than individually.
    expect(max / min).toBeGreaterThan(1.2)
  })

  it('handles a single character and an empty line', () => {
    expect(drawnBoxes('X', 0, 600, 0, 200)).toHaveLength(1)
    expect(packLine([], { fontId: FONT_ID, x0: 0, x1: 600, bandTop: 0, bandBottom: 200, gap: 0.1, letterSpacing: 0, variation: 0, verticalFill: 1, seed: 1 })).toEqual([])
  })

  it('produces no non-finite geometry at extreme settings', () => {
    for (const gap of [0, 0.5]) {
      for (const variation of [0, 1]) {
        for (const verticalFill of [0, 1]) {
          const slots = packLine(Array.from('Typography'), {
            fontId: FONT_ID,
            x0: 0,
            x1: 600,
            bandTop: 0,
            bandBottom: 200,
            gap,
            letterSpacing: 0,
            variation,
            verticalFill,
            seed: 3,
          })
          for (const slot of slots) {
            expect(Number.isFinite(slot.x)).toBe(true)
            expect(Number.isFinite(slot.scaleX)).toBe(true)
            expect(Number.isFinite(slot.scaleY)).toBe(true)
            expect(Number.isFinite(slot.baselineY)).toBe(true)
          }
        }
      }
    }
  })
})
