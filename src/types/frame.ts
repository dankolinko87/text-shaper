import type { Easing } from '../anim/easing'
import type {
  AppearanceSettings,
  ColorValue,
  DocumentObject,
  FittingMode,
  FontSettings,
  PathOutline,
  RunSettings,
  TextFlowMode,
  Transform2D,
  TypographySettings,
} from './document'

/**
 * A frame: objects you drew, arranged differently in each of several states.
 *
 * The mosaic's model, one level out. A mosaic stores `tiles` — which cells exist,
 * shared by every state — and `states`, what each cell is worth. A frame stores
 * `members` — which objects are in it — and `states`, what each object is worth.
 * That is not an analogy; it is the same shape, which is why the timeline, the
 * carry-forward rule and the state list are all shared with it.
 *
 * ## Membership is structural
 *
 * Which members exist is what every state shares, exactly as
 * `resizeMosaicGrid` says of tiles: "a state with its own tile set could not be
 * interpolated with its neighbours." Drop an object in and every state gets it,
 * in the same place. There is no add-in-state-2 — to make a member arrive, fade
 * it in, which is what every keyframe tool does underneath.
 */

/**
 * One member: the object itself, stored once.
 *
 * The object carries its own STRUCTURE — its path topology, its text, its
 * fitting mode, and for a mosaic member its own tiles and states. The frame's
 * states carry only values on top. That split is what lets a member keep
 * animating on its own clock while the frame moves it: the frame says where a
 * member IS this instant, the member says what it is DOING there.
 */
export interface FrameMember {
  id: string
  object: DocumentObject
}

/**
 * What one state says about one member — a patch, not a copy.
 *
 * A field a state does not mention falls back to the member's own value. That
 * is deliberate and it is what makes this cheap to extend: a new animatable
 * property needs no migration and no rewrite of the states already written, the
 * same property that made the border's `null` default free.
 *
 * Two levels deep, and the second level is a patch too. `appearance` and
 * `typeSettings` are groups of fields, and a state that recolours one fill has
 * said nothing about the other four — so it records one fill, and the rest keep
 * following the member. Inside `typeSettings`, `font`, `typography` and `run`
 * are whole values: each is one layout setting that cuts as a unit.
 *
 * A state therefore holds exactly what somebody authored in it, and
 * `Object.keys` of its patch is the list of what that was. Nothing else may be
 * written here — not a resolved value, not a derived one.
 */
export interface MemberValues {
  transform?: Transform2D
  /** 0..1. Also how a member arrives: 0 in one state, 1 in the next. */
  opacity?: number
  /** Typography members only. Partial: the fields this state changed. */
  appearance?: Partial<AppearanceSettings>
  /**
   * Node positions only — the topology comes from the member.
   *
   * Two states blend node `i` against node `i`, which is well defined because
   * subpath count, node counts and `closed` are structural and therefore equal.
   * A pair that disagrees is refused rather than blended part-way.
   */
  nodes?: PathOutline
  /**
   * The settings that CUT rather than tween.
   *
   * Grouped, because what they have in common is the whole point: every one of
   * them changes the LAYOUT — which word lands on which row, how big it is, how
   * far apart the letters sit — and a layout cannot be interpolated. Blend a
   * font size and the line breaks move part-way through a transition, so words
   * hop between rows while the reader is trying to read them. Blend the text
   * itself and there is nothing in between two sentences to show.
   *
   * So they snap on arrival, and the state being LEFT keeps its value for the
   * whole of the transition. Anything that should grow smoothly is a transform:
   * scale the member, which tweens perfectly and is what people mean when they
   * ask for bigger type.
   *
   * A patch, like every other field here — what a state does not mention is the
   * member's own.
   */
  typeSettings?: MemberTypeSettings
}

/** What a state may say about a member's type. Every field of it cuts. */
export interface MemberTypeSettings {
  text?: string
  font?: FontSettings
  fittingMode?: FittingMode
  textFlowMode?: TextFlowMode
  typography?: TypographySettings
  run?: RunSettings
}

/** One arrangement, and how long it rests and takes to leave. */
export interface FrameState {
  id: string
  /**
   * A colour behind everything in the frame, or null for none.
   *
   * A property of the STATE rather than of the frame, so it animates like any
   * other colour — and it is the one thing in a frame that belongs to no member,
   * which is why it lives here beside the values rather than inside them.
   */
  background?: ColorValue | null
  /** By member id. A member with no entry sits at its own resting values. */
  values: Record<string, MemberValues>
  holdMs: number
  transitionMs: number
  easing: Easing
}

/** A frame holds at least this many states, or it is a picture, not a sequence. */
export const FRAME_MIN_STATES = 2
/** And at most this many, which is the mosaic's limit for the same reasons. */
export const FRAME_MAX_STATES = 12

export const FRAME_DEFAULT_HOLD_MS = 0
export const FRAME_DEFAULT_TRANSITION_MS = 600
export const FRAME_DEFAULT_EASING: Easing = 'ease-in-out'
