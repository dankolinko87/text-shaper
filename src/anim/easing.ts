/**
 * The curves a transition can run on — a mosaic's, a frame's, anyone's.
 *
 * The names are the vocabulary, so they live here beside the curves that give
 * them meaning rather than in a types module that cannot check them.
 */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'smooth' | 'snappy'

/**
 * Why these six, and no springs.
 *
 * Every one of them is monotone, starts at exactly 0, ends at exactly 1, and
 * never leaves that range in between. That is not a matter of taste.
 *
 * A layout is legal when a set of linear inequalities between its coordinates
 * hold, and any blend of two points satisfying linear inequalities satisfies
 * them too. So if both authored states are legal, every frame between them is —
 * PROVIDED the blend is a genuine convex combination. An overshooting curve
 * (elastic, back, bounce) produces a factor below 0 or above 1, which is no
 * longer a blend of the two states but an extrapolation past one of them, and
 * the first thing that breaks is a tile inverted through its own edge.
 *
 * This is also why the easing belongs to the transition rather than to a line.
 * One curve drives the whole coordinate vector; per-line easing would move
 * different coordinates by different factors, and the result is not a blend of
 * the two layouts at all. Every caller of `ease` depends on this, and none of
 * them can defend itself against a curve that misbehaves.
 */

type Curve = (t: number) => number

const CURVES: Record<Easing, Curve> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  // Smootherstep: flat at both ends, so a long transition has no visible start
  // or stop. Its derivative is 30t²(1−t)², which is zero only at the ends.
  smooth: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  // Away quickly, settling into place. A strong ease-out rather than anything
  // that springs, because springing means overshooting.
  snappy: (t) => 1 - (1 - t) ** 4,
}

export const EASING_PRESETS: readonly Easing[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'smooth',
  'snappy',
]

/** What each one is called in the panel. */
export const EASING_LABELS: Record<Easing, string> = {
  linear: 'Linear',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in–out',
  smooth: 'Smooth',
  snappy: 'Snappy',
}

/**
 * The eased position for a raw progress.
 *
 * Clamped at both ends before the curve sees it, so a caller that hands over a
 * progress slightly outside [0,1] — a frame arriving a hair late, a duration
 * that rounded down — gets the endpoint rather than an extrapolated layout.
 */
export function ease(easing: Easing, t: number): number {
  if (!Number.isFinite(t)) return 0
  if (t <= 0) return 0
  if (t >= 1) return 1
  const curve = CURVES[easing] ?? CURVES.linear
  return curve(t)
}
