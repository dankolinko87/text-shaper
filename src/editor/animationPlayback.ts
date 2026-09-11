import { isMoving } from '../typography/objectFit'
import { fitKey } from './fitKey'
import { sameArrangement } from '../frame/frame'
import { sameGeometry } from '../mosaic/dissection'
import type {
  DocumentObject,
  FrameObject,
  LetterMosaicObject,
  TextShaperDocument,
  TypographyObject,
} from '../types/document'
import { isFrame, isMosaic, isTypography } from '../types/document'

/**
 * Every decision the animation loop makes, with no canvas and no clock in it.
 *
 * Split out for the reason `gridModel` and `penModel` are: a hook driving
 * `requestAnimationFrame` cannot be tested, but nothing that MATTERS about it is
 * about frames. Which objects should be moving, where each one is in its loop,
 * and which of them need rebuilding after an edit are all plain questions with
 * plain answers, and they are the parts that were previously buried in an effect
 * body sixty times a second.
 */

/** Shortest loop that is not an accident, in seconds. */
const MIN_LOOP = 0.1

export interface PlaybackState {
  /** The global play button: everything that moves, moves. */
  playing: boolean
  /**
   * Whether a panel that wants to see motion is open.
   *
   * Animate for obvious reasons, and Colour because a colour effect can only be
   * judged while it is playing.
   */
  watching: boolean
  selection: readonly string[]
  /**
   * The object under direct manipulation, if any.
   *
   * Held out of the animation entirely rather than merely skipped, so that what
   * gets dragged is the shape's RESTING geometry. Dragging a deformed frame
   * means the handles sit somewhere the shape is not, and the drag ends by
   * measuring a transform against a picture that was never the object.
   */
  interacting: string | null
  /**
   * One object asked to play on its own, by the control under it.
   *
   * Above the panel rule below and below the global one: it names a single
   * object, so it cannot be what somebody meant when they pressed play for
   * everything, and it should not be overridden by which tab happens to be open.
   */
  previewing: string | null
}

/**
 * Which objects should be animating, in z-order.
 *
 * Two rules rather than one, and the second is exactly what the editor did
 * before there was a play button: with play off, the sole selection previews
 * itself while a panel that cares is open. Pressing play is an addition — it
 * says "show me the whole thing" — and turning it off leaves the old behaviour
 * where it was rather than trading one for the other.
 *
 * An invisible object is left out: it has no group on the canvas to paint into,
 * and an animation nobody can see is frames spent on nothing.
 */
export function animatingIds(doc: TextShaperDocument, state: PlaybackState): string[] {
  /*
   * Typography only. A mosaic animates too, but between authored states rather
   * than through a preset, on a timeline of its own — so it is driven by its own
   * evaluator and its own loop. `animatingMosaicIds` below is that list.
   */
  const moves = (id: string): boolean => {
    const object = doc.objects[id]
    return Boolean(object && object.visible && isTypography(object) && isMoving(object))
  }

  if (state.playing) return doc.objectOrder.filter(moves)

  if (state.previewing) return moves(state.previewing) ? [state.previewing] : []

  if (!state.watching || state.selection.length !== 1) return []
  const id = state.selection[0] as string
  return moves(id) ? [id] : []
}

/**
 * Where an object is in its loop, from a clock shared by every object.
 *
 * A SHARED clock, which is the whole reason this is a function of elapsed time
 * rather than of a start time held per object. The loop rebuilds an object's
 * frames whenever that object is edited, and with a per-object start time each
 * rebuild would drop it back to the beginning of its loop — so nudging one
 * slider would jerk every other object on the artboard back to phase zero.
 * Elapsed time cannot be disturbed by an edit.
 *
 * Objects sharing a loop length therefore run in step, which is what "play them
 * together" means. `seededPhase` exists for the opposite effect, and is
 * deliberately not used here.
 */
export function phaseAt(elapsedMs: number, loopSeconds: number): number {
  // A loop of zero would divide by nothing, and a negative one comes from a
  // document written by a version that allowed it.
  const seconds = Math.max(MIN_LOOP, loopSeconds)
  const phase = elapsedMs / 1000 / seconds
  return ((phase % 1) + 1) % 1
}

/**
 * Everything about an object that changes what its frames look like.
 *
 * `fitKey` and nothing hand-written, because the frames are built on top of the
 * FIT and every input to a fit is already enumerated there — once, in the one
 * place that gets updated when the model grows. A second list beside it is a
 * list that will fall behind, and this one did within a day of being written: it
 * left out `fittingMode`, so switching a shape between Fill and Ring while the
 * animation played changed the document, redrew the canvas, and was then painted
 * straight back over by a loop still holding the old fit. The control looked
 * dead.
 *
 * Two things are added to it, and only two — the pair the fit deliberately
 * ignores because it does not have to re-solve a path for them, and a FRAME
 * does read: the animation settings, and the paint that a colour effect drives.
 */
export function signatureOf(object: TypographyObject, fontReady: boolean): string {
  return [
    fitKey(object, fontReady),
    JSON.stringify(object.animation),
    JSON.stringify(object.appearance),
  ].join('|')
}

/**
 * What the loop must do to its cache before it can paint this frame.
 *
 * `build` is what has no entry or a stale one; `drop` is what has an entry and
 * no longer belongs — an object deselected, hidden, deleted, or set to hold
 * still. The caller paints a dropped object's resting frame once and forgets it,
 * which is what stops a shape being stranded mid-loop.
 */
export function playbackDiff(
  cached: ReadonlyMap<string, { signature: string }>,
  doc: TextShaperDocument,
  wanted: readonly string[],
  /** Whether this object's font has arrived — the fit says nothing without it. */
  fontReady: (object: TypographyObject) => boolean,
): { build: string[]; drop: string[] } {
  const build: string[] = []
  for (const id of wanted) {
    const object = doc.objects[id]
    if (!object || !isTypography(object)) continue
    const entry = cached.get(id)
    if (!entry || entry.signature !== signatureOf(object, fontReady(object))) build.push(id)
  }

  const keep = new Set(wanted)
  const drop: string[] = []
  for (const id of cached.keys()) if (!keep.has(id)) drop.push(id)

  return { build, drop }
}

/**
 * Whether a mosaic has anything to animate.
 *
 * Two states holding the same composition is not an animation — it is what a new
 * mosaic has before anybody has moved anything, and playing it would spend
 * frames redrawing a still picture. Geometry only: timing and easing describe
 * how a change is reached, and there is nothing to reach if nothing differs.
 */
export function mosaicMoves(object: LetterMosaicObject): boolean {
  for (let at = 1; at < object.states.length; at++) {
    const previous = object.states[at - 1]
    const current = object.states[at]
    if (previous && current && !sameGeometry(previous, current)) return true
  }
  return false
}

/**
 * The mosaics that should be moving, and on which clock.
 *
 * Two ways in, and they mean different things. The PANEL's transport previews
 * one mosaic — the one being worked on — and keeps its own position, so pausing
 * and playing again picks up where it left off. The global play button means
 * "show me the whole thing", so every mosaic that has an animation runs, and
 * they run on one shared clock: mosaics of the same length stay in step, which
 * is what playing them together is for.
 *
 * The global button wins while it is on. Its list already contains whatever the
 * panel was previewing, and two clocks driving one mosaic would fight.
 */
/**
 * Whether a frame has anything to animate.
 *
 * Two identical states are what a frame STARTS with, and a frame nobody has
 * arranged differently is a still picture — running a clock on it would burn
 * frames redrawing the same thing.
 */
export function frameMoves(object: FrameObject): boolean {
  for (let at = 1; at < object.states.length; at++) {
    const previous = object.states[at - 1]
    const current = object.states[at]
    if (previous && current && !sameArrangement(previous, current, object.members)) return true
  }
  return false
}

/**
 * Whether anything about a frame is in motion — its own states, or a member's
 * own preset.
 *
 * Two clocks, and either one is reason enough to run the loop. A frame whose
 * states are identical still has to be painted every frame if something inside
 * it is waving, and `frameMoves` alone answers only the first half: a shape
 * carrying a preset stopped moving the moment it was dropped into a frame,
 * because nothing else drives a member — `animatingIds` walks `doc.objectOrder`,
 * and a member is not in it.
 */
export function frameRuns(object: FrameObject): boolean {
  if (frameMoves(object)) return true
  return object.members.some(
    (member) => isTypography(member.object) && isMoving(member.object),
  )
}

/** What the loop is told about where the cursor is standing. */
export interface StatedPlaybackState {
  /** The global play button: everything that moves, moves. */
  playing: boolean
  /** The one object the panel's transport is previewing, if any. */
  previewing: string | null
  /** The object under direct manipulation, which holds still for the gesture. */
  interacting?: string | null
  /**
   * The object spread into a row of windows, which cannot animate: it shows
   * every keyframe at once, so a play head has nowhere to be.
   */
  spread?: string | null
}

/**
 * The stated objects of one kind that should be moving, and on which clock.
 *
 * One rule for every kind: the global play button runs every object of the
 * kind together on one shared clock — objects of the same length stay in step,
 * which is what playing them together is for — and a preview runs the one
 * being worked on, keeping its own position so pausing and playing picks up
 * where it left off. The global button wins while it is on: its list already
 * contains whatever the panel was previewing, and two clocks driving one
 * object would fight.
 *
 * An object under the pointer holds still, exactly as a shape under direct
 * manipulation does — otherwise the clock repaints it from a moment that
 * belongs to no state while it is being dragged, and the gesture ends by
 * measuring against a picture that was never the arrangement. A spread object
 * holds still for the length of the spread.
 */
function animatingStatedIds<T extends DocumentObject>(
  doc: TextShaperDocument,
  state: StatedPlaybackState,
  is: (object: DocumentObject) => object is T,
  runs: (object: T) => boolean,
): { ids: string[]; shared: boolean } {
  const held = state.interacting ?? null
  const spread = state.spread ?? null
  const still = (id: string): boolean => id === held || id === spread
  if (state.playing) {
    const ids = doc.objectOrder.filter((id) => {
      const object = doc.objects[id]
      return Boolean(object && object.visible && is(object) && runs(object) && !still(id))
    })
    return { ids, shared: true }
  }

  if (!state.previewing || still(state.previewing)) return { ids: [], shared: false }
  const object = doc.objects[state.previewing]
  if (!object || !is(object) || !object.visible) return { ids: [], shared: false }
  return { ids: [state.previewing], shared: false }
}

export function animatingFrameIds(
  doc: TextShaperDocument,
  state: StatedPlaybackState,
): { ids: string[]; shared: boolean } {
  return animatingStatedIds(doc, state, isFrame, frameRuns)
}

export function animatingMosaicIds(
  doc: TextShaperDocument,
  state: StatedPlaybackState,
): { ids: string[]; shared: boolean } {
  return animatingStatedIds(doc, state, isMosaic, mosaicMoves)
}
