/**
 * A timeline of authored states, with nothing in it that knows what a state is.
 *
 * Lifted out of `mosaic/timeline.ts` unchanged in behaviour. It only ever asked
 * four things of a state — how long it holds, how long it takes to leave, where
 * it sits in the list, and how many there are — so it was never a mosaic's, and
 * the second thing to grow states should not have to write it again.
 *
 * What is NOT here is what a state MEANS. Blending is the caller's, because a
 * mosaic state and a frame state genuinely differ: one says where these lines
 * sit and what these tiles are worth, the other says where these objects are.
 * Pushing both through one shape would buy nothing and cost a rewrite of the
 * most carefully tested part of the app.
 *
 * ## Time here is AUTHORED time
 *
 * The timeline as written, before playback speed. Speed belongs to whatever is
 * driving the clock, which converts `authored = elapsed * speed` before asking.
 * That gives this module one unambiguous time domain: a test asking for the
 * midpoint of a transition asks for the same number whatever the speed is, and
 * an export sampling authored time gets the artwork rather than the rate
 * somebody last left the preview at.
 */

/** The only thing a timeline needs to know about a state. */
export interface Timed {
  /** Milliseconds this state rests before it starts moving. */
  holdMs: number
  /** Milliseconds the transition OUT of this state takes. */
  transitionMs: number
}

/** One stretch of the timeline: a state resting, or a state on its way out. */
export interface Segment {
  kind: 'hold' | 'transition'
  from: number
  /**
   * Never null: every timeline loops, so the last state's transition returns to
   * the first and is part of the length — which is what makes the end of the
   * loop and time zero the same picture.
   */
  to: number
  durationMs: number
}

/** Where a timeline is at one moment, before anything is blended. */
export interface Moment {
  kind: 'hold' | 'transition'
  from: number
  to: number
  /** Milliseconds into this segment. */
  localTime: number
  /**
   * Position through the segment, 0 to 1, UNEASED.
   *
   * Easing is applied by the caller, because the curve is a property of the
   * state being left and only the caller knows where that is written down.
   */
  progress: number
}

/** A transition below this is a cut, and a cut is not a transition. One frame. */
export const MIN_TRANSITION_MS = 16

const holdOf = (state: Timed): number =>
  Number.isFinite(state.holdMs) ? Math.max(0, state.holdMs) : 0

const transitionOf = (state: Timed, minimum: number): number =>
  Number.isFinite(state.transitionMs) ? Math.max(minimum, state.transitionMs) : minimum

/**
 * The timeline, as a run of segments.
 *
 * Every state holds and then moves on, the last one back to the first.
 *
 * Looping is not a choice, and removing the choice is what let this be shared.
 * It used to be one: with looping off the final state's transition was authored,
 * stored, and never used, so the panel grew a disabled slider, a disabled easing
 * menu and a paragraph explaining why. Nobody was choosing "stop at the end" — a
 * thing that stops is a picture, and a picture is one state.
 */
export function segmentsOf(
  states: readonly Timed[],
  minTransitionMs: number = MIN_TRANSITION_MS,
): Segment[] {
  const out: Segment[] = []
  if (states.length === 0) return out

  for (let i = 0; i < states.length; i++) {
    const state = states[i] as Timed
    const to = i === states.length - 1 ? 0 : i + 1
    out.push({ kind: 'hold', from: i, to, durationMs: holdOf(state) })
    out.push({ kind: 'transition', from: i, to, durationMs: transitionOf(state, minTransitionMs) })
  }
  return out
}

/** The timeline's length in authored milliseconds, before playback speed. */
export function authoredDuration(
  states: readonly Timed[],
  minTransitionMs: number = MIN_TRANSITION_MS,
): number {
  return segmentsOf(states, minTransitionMs).reduce(
    (total, segment) => total + segment.durationMs,
    0,
  )
}

/** A rate that cannot stop or reverse time, whatever it was handed. */
export const rateOf = (speed: number): number =>
  Number.isFinite(speed) && speed > 0 ? speed : 1

/** How long it actually takes to watch, which is where speed comes in. */
export function playbackDuration(
  states: readonly Timed[],
  speed: number,
  minTransitionMs: number = MIN_TRANSITION_MS,
): number {
  return authoredDuration(states, minTransitionMs) / rateOf(speed)
}

/** Authored milliseconds for a moment of wall-clock playback. */
export const authoredTimeFor = (speed: number, elapsedWallMs: number): number =>
  elapsedWallMs * rateOf(speed)

/**
 * Where the timeline is at one authored moment.
 *
 * Null only for a timeline with no states, which nothing should produce — the
 * caller answers for that case, because only it knows what "nothing" looks like.
 */
export function momentAt(
  states: readonly Timed[],
  timeMs: number,
  minTransitionMs: number = MIN_TRANSITION_MS,
): Moment | null {
  const segments = segmentsOf(states, minTransitionMs)
  if (segments.length === 0) return null

  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0)
  const time = Number.isFinite(timeMs) ? timeMs : 0

  // Time is cyclic, so the end of the loop IS time zero rather than merely
  // close to it.
  let t = time
  if (total > 0) t = ((time % total) + total) % total
  if (t < 0) t = 0

  let acc = 0
  for (const segment of segments) {
    const end = acc + segment.durationMs
    // Strictly less, so a zero-length hold is stepped over rather than landed on.
    if (t < end) {
      const local = t - acc
      return {
        kind: segment.kind,
        from: segment.from,
        to: segment.to,
        localTime: local,
        progress: segment.durationMs > 0 ? local / segment.durationMs : 0,
      }
    }
    acc = end
  }

  /*
   * Every segment was zero-length, so there is nowhere else for the time to
   * land. The first state, resting, is the honest answer.
   */
  const first = segments[0] as Segment
  return { kind: 'hold', from: 0, to: first.to, localTime: 0, progress: 0 }
}

/**
 * A duration as somebody would say it.
 *
 * Milliseconds below a second and seconds above, because "600 ms" and "1.2 s"
 * are both how the number is spoken and "0.6 s" and "1200 ms" are not.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0 ms'
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = value / 1000
  const shown = seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)
  return `${shown.replace(/\.0$/, '')} s`
}

/** Where a running film is: the state playing now, and how far through it, 0 to 1. */
export interface FilmPosition {
  index: number
  within: number
}

/**
 * The state on screen at a moment, and how much of its turn — its hold and
 * the transition out of it, as one stretch — has gone by. What a strip of
 * state cards needs to run like film: one card lit, its bar filling, then the
 * next. Built on `momentAt`, so it cannot disagree with the evaluators about
 * where the clock is.
 */
export function filmPosition(
  states: readonly Timed[],
  timeMs: number,
  minTransitionMs: number = MIN_TRANSITION_MS,
): FilmPosition | null {
  const moment = momentAt(states, timeMs, minTransitionMs)
  const state = moment ? states[moment.from] : undefined
  if (!moment || !state) return null
  const hold = holdOf(state)
  const turn = hold + transitionOf(state, minTransitionMs)
  const elapsed = moment.kind === 'hold' ? moment.localTime : hold + moment.localTime
  return { index: moment.from, within: turn > 0 ? Math.min(1, Math.max(0, elapsed / turn)) : 0 }
}
