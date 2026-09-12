import { describe, expect, it } from 'vitest'

import { createWheelGesture, WHEEL_GESTURE_GAP_MS } from '../../src/editor/wheelGesture'

/**
 * A stream of wheel events is one gesture until the fingers pause.
 */
describe('a wheel gesture', () => {
  it('holds nothing before the canvas has taken a wheel', () => {
    const gesture = createWheelGesture()
    expect(gesture.holds(1000)).toBe(false)
  })

  it('holds the events that follow closely, and lets go after a pause', () => {
    const gesture = createWheelGesture()
    gesture.touch(1000)
    expect(gesture.holds(1000 + 16)).toBe(true)
    expect(gesture.holds(1000 + WHEEL_GESTURE_GAP_MS)).toBe(true)
    expect(gesture.holds(1000 + WHEEL_GESTURE_GAP_MS + 1)).toBe(false)
  })

  it('is kept alive by every event it takes', () => {
    const gesture = createWheelGesture(100)
    gesture.touch(0)
    for (let t = 80; t < 1000; t += 80) {
      expect(gesture.holds(t)).toBe(true)
      gesture.touch(t)
    }
    expect(gesture.holds(1200)).toBe(false)
  })
})
