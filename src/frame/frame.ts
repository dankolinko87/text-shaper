import {
  authoredDuration as totalDuration,
  authoredTimeFor as authoredTimeAt,
  momentAt,
  playbackDuration as watchedDuration,
} from '../anim/timeline'
import { ease } from '../anim/easing'
import { blendColour } from '../typography/colour'
import { createId } from '../utils/id'
import { blendStroke, sameStroke } from '../geometry/stroke'
import { blendOutline, outlineToPath, sameOutline } from '../geometry/outline'
import type {
  AppearanceSettings,
  ColorValue,
  DocumentObject,
  FrameObject,
  Transform2D,
} from '../types/document'
import type { FrameMember, FrameState, MemberTypeSettings, MemberValues } from '../types/frame'
import {
  FRAME_DEFAULT_EASING,
  FRAME_DEFAULT_HOLD_MS,
  FRAME_DEFAULT_TRANSITION_MS,
} from '../types/frame'

/**
 * What a frame looks like at a moment, and the rules for getting there.
 *
 * The mosaic's `timeline.ts` with a different blend table — deliberately so.
 * The SHAPE of the timeline is shared (`anim/timeline`); what a state MEANS is
 * not, because a mosaic state says where lines sit and a frame state says where
 * objects are.
 */

/* ------------------------------------------------------------------ timing */

export const frameDuration = (frame: FrameObject): number => totalDuration(frame.states)
export const framePlaybackDuration = (frame: FrameObject): number =>
  watchedDuration(frame.states, frame.speed)
export const frameAuthoredTimeFor = (frame: FrameObject, elapsedWallMs: number): number =>
  authoredTimeAt(frame.speed, elapsedWallMs)

/* ------------------------------------------------------------- the blending */

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * One transform on the way to another.
 *
 * Rotation is blended the short way round: 350° to 10° is twenty degrees, not
 * three hundred and forty. Without this a member set a hair either side of zero
 * spins most of a turn to get nowhere, which reads as a bug rather than a
 * choice.
 *
 * The flips are a CUT — there is nothing between mirrored and not, and easing
 * through it would pass through a shape of zero width.
 */
export function blendTransform(a: Transform2D, b: Transform2D, t: number): Transform2D {
  let delta = ((b.rotation - a.rotation) % 360 + 540) % 360 - 180
  if (delta === -180) delta = 180
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    scaleX: mix(a.scaleX, b.scaleX, t),
    scaleY: mix(a.scaleY, b.scaleY, t),
    rotation: a.rotation + delta * t,
    flipX: t < 0.5 ? a.flipX : b.flipX,
    flipY: t < 0.5 ? a.flipY : b.flipY,
  }
}

/**
 * What a state says about a member, filled in from the member itself.
 *
 * A state holds a PATCH. Anything it does not mention is the member's own
 * resting value — which is what lets a new animatable property arrive without
 * migrating a single state that was written before it existed.
 *
 * Resolved field by field at both levels. A state that recolours one fill is
 * silent about the other four, and they come from the member; a state that
 * changes the text is silent about the font, and so on. The one derived value,
 * `padding`, is read off the MERGED type settings, so a state that says
 * nothing about typography keeps the member's inset rather than falling to 0.
 *
 * Returns the member's own objects by reference when the state is silent about
 * them, so "has this state said anything here" can also be asked cheaply.
 */
export function valuesFor(
  member: FrameMember,
  state: FrameState | undefined,
): EvaluatedValues {
  const patch = state?.values[member.id] ?? {}
  const own = member.object.kind === 'typography' ? member.object : null
  const typeSettings = mergeTypeSettings(restingTypeSettings(member), patch.typeSettings)
  return {
    transform: patch.transform ?? member.object.transform,
    opacity: patch.opacity ?? 1,
    appearance: own
      ? patch.appearance
        ? { ...own.appearance, ...patch.appearance }
        : own.appearance
      : undefined,
    nodes: patch.nodes ?? (own ? (own.outline ?? undefined) : undefined),
    typeSettings,
    padding: typeSettings?.typography?.padding ?? 0,
  }
}

/**
 * What a member is at a moment: its stored patch, filled in, plus the values
 * that are DERIVED rather than stored.
 *
 * Every group is whole here — the resolution has already happened — which is
 * why this is spelled out rather than derived from `MemberValues`, whose
 * `appearance` is a partial.
 *
 * `padding` is derived. It is stored inside the type settings, where it belongs
 * with the rest of the typography, but it is the one field of that group which
 * interpolates — so the evaluated form carries it separately, and the two never
 * have to mean the same thing at the same time.
 */
export interface EvaluatedValues {
  transform: Transform2D
  opacity: number
  appearance?: AppearanceSettings
  nodes?: MemberValues['nodes']
  typeSettings?: MemberTypeSettings
  padding: number
}

/** A member's own type settings, as a state would express them. */
export function restingTypeSettings(member: FrameMember): MemberTypeSettings | undefined {
  const object = member.object
  if (object.kind !== 'typography') return undefined
  return {
    text: object.text,
    font: object.font,
    fittingMode: object.fittingMode,
    textFlowMode: object.textFlowMode,
    typography: object.typography,
    run: object.run,
  }
}

/**
 * One set of type settings laid over another, field by field.
 *
 * The single definition of "what a state's type settings mean on top of the
 * member's". `valuesFor` uses it to resolve, `withTypeSettings` uses it to
 * dress an object for drawing and fitting — so the panel, the renderer and the
 * text fitter cannot disagree about which sentence is being set in which font.
 * Returns `base` itself when there is nothing to lay over it.
 */
export function mergeTypeSettings(
  base: MemberTypeSettings | undefined,
  patch: MemberTypeSettings | undefined,
): MemberTypeSettings | undefined {
  if (!patch) return base
  if (!base) return patch
  return {
    text: patch.text ?? base.text,
    font: patch.font ?? base.font,
    fittingMode: patch.fittingMode ?? base.fittingMode,
    textFlowMode: patch.textFlowMode ?? base.textFlowMode,
    typography: patch.typography ?? base.typography,
    run: patch.run ?? base.run,
  }
}

/**
 * A typography object wearing a state's cut-tier settings.
 *
 * One place, because two things need it and they need it for different halves
 * of the job: the renderer, to draw and to key on what a state says; and the
 * text fitter, to solve the right layout. A second copy would let the drawing
 * and the fit disagree about which sentence is being set.
 *
 * The SHAPE is deliberately not part of this. A reshaped state pours the same
 * layout through a different container; re-fitting to it would move the line
 * breaks, which is the one thing a morph must not do.
 */
export function withTypeSettings<T extends { kind: string }>(
  object: T,
  type: MemberTypeSettings | undefined,
): T {
  if (!type || object.kind !== 'typography') return object
  const merged = mergeTypeSettings(object as unknown as MemberTypeSettings, type)
  return { ...object, ...merged }
}

/**
 * The shape a state gives a member, if it gives one of its own.
 *
 * Compared by VALUE against the member's resting outline, as every other
 * per-state comparison is. A reference check answered "reshaped" for any
 * state holding nodes at all — right while nodes were only ever written by a
 * reshape, and wrong the moment anything else copied them in — and it is the
 * wrong kind of question either way: two lists of the same points are the
 * same shape. Null when the state draws the member as it rests.
 */
export function stateShape(
  member: FrameMember,
  values: EvaluatedValues,
): { outline: NonNullable<MemberValues['nodes']>; currentSourcePath: ReturnType<typeof outlineToPath> } | null {
  if (member.object.kind !== 'typography' || !values.nodes) return null
  const own = member.object.outline ?? undefined
  if (own && sameOutline(values.nodes, own)) return null
  return { outline: values.nodes, currentSourcePath: outlineToPath(values.nodes) }
}

/**
 * The member as one state has it.
 *
 * The object the renderer draws, the fitter fits, and the thing a member IS
 * when it leaves the frame from that state: the state's colours, its shape if
 * it gave one, where it stands, its cut-tier settings, and the padding as it is
 * this instant. `appearance` can be handed in separately for the one caller
 * that dresses it first — the renderer, which draws a border a state does not
 * have at zero alpha so that one arriving later has something to fade in.
 */
export function memberAtState(
  member: FrameMember,
  values: EvaluatedValues,
  appearance: AppearanceSettings | undefined = values.appearance,
): DocumentObject {
  if (member.object.kind !== 'typography' || !appearance) return member.object
  const drawn = withTypeSettings(
    {
      ...member.object,
      appearance,
      ...(stateShape(member, values) ?? {}),
      transform: values.transform,
    },
    values.typeSettings,
  )
  return drawn.kind === 'typography'
    ? { ...drawn, typography: { ...drawn.typography, padding: values.padding } }
    : drawn
}

/**
 * A member as it would stand on the artboard if it left the frame from `state`.
 *
 * As the state draws it — look, shape, cut-tier settings and all — rebased out
 * of the frame's space. The one rule for "what is this member, outside", used
 * by taking it out and by copying it, so the two cannot hand back different
 * objects. The caller gives it an id.
 */
export function memberAsFreed(
  member: FrameMember,
  state: FrameState | undefined,
  frame: Transform2D,
): DocumentObject {
  const drawn = memberAtState(member, valuesFor(member, state))
  return {
    ...drawn,
    transform: {
      ...drawn.transform,
      x: drawn.transform.x + frame.x,
      y: drawn.transform.y + frame.y,
    },
  }
}

/**
 * How one member LOOKS on the way from one state to another.
 *
 * Every field that can be interpolated is, and the ones that cannot are handed
 * to helpers that already know how to cut them: `blendColour` for a fill that
 * may be nothing at either end, `blendStroke` for a border whose dash rhythm and
 * position have no in-between. Nothing here decides those rules — it only says
 * which field is which kind of thing.
 */
export function blendAppearance(
  a: AppearanceSettings,
  b: AppearanceSettings,
  t: number,
): AppearanceSettings {
  return {
    textFill: blendColour(a.textFill, b.textFill, t) ?? a.textFill,
    containerFill: blendColour(a.containerFill, b.containerFill, t),
    lineFill: blendColour(a.lineFill, b.lineFill, t),
    containerStroke: blendStroke(a.containerStroke, b.containerStroke, t),
    opacity: mix(a.opacity, b.opacity, t),
  }
}

/** One member's values on the way to another state's. */
export function blendValues(
  member: FrameMember,
  from: FrameState | undefined,
  to: FrameState | undefined,
  t: number,
): ReturnType<typeof valuesFor> {
  const a = valuesFor(member, from)
  const b = valuesFor(member, to)
  return {
    ...a,
    transform: blendTransform(a.transform, b.transform, t),
    opacity: mix(a.opacity, b.opacity, t),
    appearance:
      a.appearance && b.appearance
        ? blendAppearance(a.appearance, b.appearance, t)
        : (a.appearance ?? b.appearance),
    /*
     * A morph, or the nearer end. `blendOutline` refuses a pair whose topology
     * differs rather than pairing points that have nothing to do with each
     * other — and a refusal has to draw SOMETHING, so it draws the state the
     * frame is nearer to, which cuts once instead of showing a shape neither
     * state asked for.
     */
    nodes:
      a.nodes && b.nodes
        ? (blendOutline(a.nodes, b.nodes, t) ?? (t < 0.5 ? a.nodes : b.nodes))
        : (a.nodes ?? b.nodes),
    /*
     * A CUT, and one that happens on ARRIVAL rather than half way.
     *
     * Every field of this tier changes the layout, and a layout has no
     * in-between: blend a font size and the line breaks move while the
     * transition runs, so words hop between rows mid-morph. Holding the
     * departing state's value for the whole transition means the type is
     * readable throughout and changes once, at the moment it arrives — which is
     * what a cut is for.
     *
     * Halfway, like the flips, would be the other defensible choice and is
     * worse here: the flips cut at the middle because either end is equally
     * right, whereas a page of type re-flowing in the middle of a move looks
     * like a glitch rather than a decision.
     */
    typeSettings: t < 1 ? a.typeSettings : b.typeSettings,
    /*
     * The one field of that group that does NOT cut. It is a region, so it
     * interpolates — the type shrinks into the shape smoothly while the layout
     * it was solved with holds still.
     */
    padding: mix(a.padding, b.padding, t),
  }
}

/* ----------------------------------------------------------- the evaluator */

export interface EvaluatedFrame {
  /** The colour behind everything, blended. Null where neither end has one. */
  background: ColorValue | null
  stateIndex: number
  nextStateIndex: number
  segment: 'hold' | 'transition'
  progress: number
  easedProgress: number
  /** Each member's values at this moment, by member id. */
  members: Record<string, ReturnType<typeof valuesFor>>
}

/**
 * Where a frame is at a given moment, worked out and never written down.
 *
 * Pure, like the mosaic's: it reads the object and returns a picture of it, and
 * touches neither the document nor the canvas. The time it takes is AUTHORED
 * time — speed belongs to whatever drives the clock.
 */
export function evaluateFrameAtTime(frame: FrameObject, authoredTimeMs: number): EvaluatedFrame {
  const resting = (index: number, next: number): EvaluatedFrame => ({
    background: frame.states[index]?.background ?? null,
    stateIndex: index,
    nextStateIndex: next,
    segment: 'hold',
    progress: 0,
    easedProgress: 0,
    members: Object.fromEntries(
      frame.members.map((member) => [member.id, valuesFor(member, frame.states[index])]),
    ),
  })

  const moment = momentAt(frame.states, authoredTimeMs)
  if (!moment) return resting(0, 0)
  if (moment.kind === 'hold') return resting(moment.from, moment.to)

  const from = frame.states[moment.from]
  const to = frame.states[moment.to]
  const e = ease(from?.easing ?? FRAME_DEFAULT_EASING, moment.progress)

  return {
    /*
     * Blended through the same rule a member's fills use, so a background that
     * arrives fades up from a transparent version of ITSELF rather than out of
     * black — and a hold shows exactly what was chosen, null included.
     */
    background: blendColour(from?.background ?? null, to?.background ?? null, e),
    stateIndex: moment.from,
    nextStateIndex: moment.to,
    segment: 'transition',
    progress: moment.progress,
    easedProgress: e,
    members: Object.fromEntries(
      frame.members.map((member) => [member.id, blendValues(member, from, to, e)]),
    ),
  }
}

/* ------------------------------------------------------------- making them */

/**
 * A state that says nothing yet.
 *
 * Born EMPTY, not as a copy of where the members rest. A state used to be
 * written with every member's position and opacity in it from the start, which
 * `valuesFor` would have answered identically anyway — and it meant every state
 * looked authored from birth, so the document could not say which states a
 * gesture had actually touched. Now a patch's keys are exactly that answer.
 */
export function emptyState(): FrameState {
  return {
    id: createId(),
    values: {},
    holdMs: FRAME_DEFAULT_HOLD_MS,
    transitionMs: FRAME_DEFAULT_TRANSITION_MS,
    easing: FRAME_DEFAULT_EASING,
  }
}

/**
 * Fresh member ids for a copied frame, rewriting every state that names them.
 *
 * The mosaic's `copyMosaicIdentity` for the same reason: ids are unique across
 * the document and every state keys its values by them, so two frames sharing
 * ids would read each other's arrangements.
 */
export function copyFrameIdentity(
  members: readonly FrameMember[],
  states: readonly FrameState[],
): { members: FrameMember[]; states: FrameState[] } {
  const remapped = new Map(members.map((member) => [member.id, createId()]))
  return {
    members: members.map((member) => ({
      ...member,
      id: remapped.get(member.id) as string,
      object: { ...member.object, id: createId() },
    })),
    states: states.map((state) => ({
      ...state,
      id: createId(),
      values: Object.fromEntries(
        Object.entries(state.values).map(([id, values]) => [remapped.get(id) ?? id, values]),
      ),
    })),
  }
}

/**
 * Whether two members look the same.
 *
 * Every field `blendAppearance` interpolates, and nothing else — the two have to
 * agree, or a frame could animate something this cannot see. That is not a
 * theoretical worry: this equality is what decides whether a frame has anything
 * to play at all, so a property it ignored would blend correctly and never run.
 */
export function sameAppearance(
  a: AppearanceSettings | undefined,
  b: AppearanceSettings | undefined,
  tolerance = 1e-9,
): boolean {
  if (!a || !b) return a === b
  return (
    a.textFill === b.textFill &&
    a.containerFill === b.containerFill &&
    a.lineFill === b.lineFill &&
    sameStroke(a.containerStroke, b.containerStroke, tolerance) &&
    Math.abs(a.opacity - b.opacity) <= tolerance
  )
}

/**
 * Whether two states say the same thing about a member's type.
 *
 * Compared by value rather than by reference: a state's patch is a fresh object
 * every time one is written, so identity would call every state different and
 * a frame would think it had something to play when it did not.
 */
export function sameTypeSettings(
  a: MemberTypeSettings | undefined,
  b: MemberTypeSettings | undefined,
): boolean {
  if (!a || !b) return a === b
  return (
    a.text === b.text &&
    a.fittingMode === b.fittingMode &&
    a.textFlowMode === b.textFlowMode &&
    sameFlat(a.font, b.font) &&
    sameFlat(a.typography, b.typography) &&
    sameFlat(a.run, b.run)
  )
}

/**
 * Two flat settings objects, compared over every key either of them has.
 *
 * Key-wise rather than field by field, and deliberately. A hand-written list is
 * a second place that has to learn about a new setting, and the failure when it
 * does not is silent: an edit carries forward past a state somebody authored, or
 * a frame refuses to play something it can plainly show. Every object here is
 * flat and holds only primitives, so this is exact rather than approximate.
 */
function sameFlat(a: object | undefined, b: object | undefined): boolean {
  if (!a || !b) return a === b
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (x[key] !== y[key]) return false
  }
  return true
}

/** Whether one member's values are the same values. */
export function sameValues(
  a: ReturnType<typeof valuesFor>,
  b: ReturnType<typeof valuesFor>,
  tolerance = 1e-9,
): boolean {
  if (Math.abs(a.opacity - b.opacity) > tolerance) return false
  for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const) {
    if (Math.abs(a.transform[key] - b.transform[key]) > tolerance) return false
  }
  if (!sameAppearance(a.appearance, b.appearance, tolerance)) return false
  if (!sameOutline(a.nodes, b.nodes, tolerance)) return false
  if (!sameTypeSettings(a.typeSettings, b.typeSettings)) return false
  return a.transform.flipX === b.transform.flipX && a.transform.flipY === b.transform.flipY
}

/**
 * Whether two states say the same thing about every member.
 *
 * The frame's answer to `sameGeometry`, and it answers one question: is there
 * anything to animate between these two? It no longer decides where an edit
 * reaches — an edit lands on the state it was made in and nowhere else.
 */
export function sameArrangement(
  a: FrameState,
  b: FrameState,
  members: readonly FrameMember[],
  tolerance = 1e-9,
): boolean {
  // The background belongs to no member, so no member's values can carry it.
  if ((a.background ?? null) !== (b.background ?? null)) return false
  /*
   * Through `sameValues` rather than repeating its field list. The two had
   * separate copies of the same comparison, which is a standing invitation for
   * one of them to learn about a new property and the other not to — and the
   * consequence is silent either way: an edit that carries forward when it
   * should stop, or a frame that will not play something it can plainly blend.
   */
  return members.every((member) =>
    sameValues(valuesFor(member, a), valuesFor(member, b), tolerance),
  )
}
