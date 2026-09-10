import { describe, expect, it } from 'vitest'

import { placeControl } from '../../src/editor/canvasAnchor'

/**
 * A control under an object never enters the tool pill's band: when it would,
 * it sits above the object instead. Tested at the exact pixel, because "about
 * there" is how a bar comes to sit half under the pill.
 */
describe('placing a control around its object', () => {
  const foot = 400
  const head = 300
  const height = 32

  it('sits under the object when there is room', () => {
    expect(placeControl(foot, head, height, Number.POSITIVE_INFINITY)).toBe(foot + 9)
  })

  it('still sits under it when its bottom edge exactly meets the limit', () => {
    expect(placeControl(foot, head, height, foot + 9 + height)).toBe(foot + 9)
  })

  it('flips above the object one pixel later', () => {
    expect(placeControl(foot, head, height, foot + 9 + height - 1)).toBe(head - 9 - height)
  })
})
