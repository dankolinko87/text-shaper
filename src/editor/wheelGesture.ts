/**
 * Whether a run of wheel events is one gesture.
 *
 * A two-finger pan on a trackpad is not one event but a stream of them, and
 * each goes to whatever is under the cursor. Cross a panel mid-pan and the
 * panel takes the rest of the stream: the canvas stops dead and the fingers
 * have to start again. So the canvas remembers when it last took a wheel;
 * while the stream is still coming, the next event belongs to it whatever
 * the cursor is over. A pause longer than the gap is a new gesture, and a
 * new gesture goes wherever it starts.
 */

/** Longer than this between two events, and the fingers have lifted. */
export const WHEEL_GESTURE_GAP_MS = 250

export interface WheelGesture {
  /** The canvas took a wheel event now. */
  touch: (now: number) => void
  /** Whether a wheel event now is part of the canvas's gesture. */
  holds: (now: number) => boolean
}

export function createWheelGesture(gapMs = WHEEL_GESTURE_GAP_MS): WheelGesture {
  let last = -Infinity
  return {
    touch: (now) => {
      last = now
    },
    holds: (now) => now - last <= gapMs,
  }
}
