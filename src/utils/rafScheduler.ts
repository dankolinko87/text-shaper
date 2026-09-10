/**
 * Coalescing frame scheduler: many `schedule()` calls within one frame run the
 * callback exactly once, on the next animation frame.
 *
 * This is what throttles interactive preview updates to ~1 per frame during a
 * brush gesture, instead of once per pointer sample (which can arrive at 240Hz).
 */
export function createFrameScheduler(callback: () => void): {
  schedule: () => void
  cancel: () => void
} {
  let handle: number | null = null

  const run = (): void => {
    handle = null
    callback()
  }

  return {
    schedule(): void {
      if (handle !== null) return
      handle = requestAnimationFrame(run)
    },
    cancel(): void {
      if (handle === null) return
      cancelAnimationFrame(handle)
      handle = null
    },
  }
}
