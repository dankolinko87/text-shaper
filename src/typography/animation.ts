import type { AnimationPreset, DistortionSettings, Vec2 } from '../types/document'

export type { AnimationPreset }
import { seededValue } from '../utils/rng'

/**
 * Loop presets: what the type is doing at a given moment.
 *
 * There is no timeline and no keyframes. A preset is a pure function from a
 * PHASE — a number running 0 to 1 once per loop — to a description of how this
 * frame differs from the still artwork. That is what makes every loop seamless
 * by construction rather than by careful authoring: phase 0 and phase 1 are the
 * same point on the same circle, so the first frame and the last are identical.
 *
 * Presets are data, in the manner of `PRIMITIVES` in `geometry/primitives.ts`:
 * each declares the controls it wants and the panel renders them, so adding one
 * needs no interface code at all.
 *
 * Nothing here decides what the text SAYS or where it breaks. A frame only
 * modulates the deformation, and the layout it is applied to was solved once
 * and frozen — otherwise line breaks would shift mid-loop and words would jump
 * between rows.
 */

/**
 * What every control shares.
 *
 * `when` shows a control only while it holds — for a value that is real and
 * kept but has nothing to act on until another control is set: a travel with
 * no motion. Absent, not disabled, as the border's rows are absent until there
 * is a border.
 */
export interface ControlBase {
  key: string
  label: string
  when?: (config: Readonly<Record<string, unknown>>) => boolean
}

export type AnimationControl =
  | (ControlBase & {
      kind: 'number'
      min: number
      max: number
      step: number
      /** Where the control sits when the preset is first chosen. */
      value: number
      /** How the number is shown. Defaults to a percentage. */
      format?: (value: number) => string
    })
  | (ControlBase & {
      kind: 'colour'
      /** A hex colour. */
      value: string
    })
  | (ControlBase & {
      kind: 'choice'
      options: readonly { value: string; label: string }[]
      value: string
    })

/** A preset's settings: numbers for sliders, hex strings for swatches. */
export type AnimationConfig = Readonly<Record<string, number | string>>

export interface AnimationFrame {
  /** Merged over the object's own settings for this frame. */
  distortion: Partial<DistortionSettings>
  /**
   * Where we are in the loop, 0 to 1.
   *
   * Passed through to the warp, whose wave and noise terms use it directly —
   * the wave advances by a whole cycle and the noise is sampled once around a
   * circle, so both return exactly to their starting state.
   */
  phase: number
  /**
   * Added to every vertical deformer's position.
   *
   * One number, because a frame is now worked out per LINE — the shared line
   * offset delays each line's whole phase, which staggers this along with
   * everything else rather than needing its own separate stagger.
   */
  deformerShift: number
  /**
   * Per-character displacement, as a fraction of the line's own band — so a
   * setting means the same thing whether the type is 12px or 400px.
   */
  letterOffset?: (index: number) => Vec2
  /** Per-character size, about the character's own centre. 1 leaves it alone. */
  letterScale?: (index: number) => number
  /**
   * How far the words have moved ALONG their run, as a share of its length.
   *
   * Only a closed run can carry it. The words travel bodily round the lap and
   * come back to where they began after one loop, so the loop closes without a
   * seam — the first time anything in this tool could move in one direction and
   * still repeat. A run with two ends cannot: the words would walk off it, and
   * everything past the end lands on the same point.
   *
   * Not a strip-space term like the others. It is applied where the run is READ,
   * not where the strip is bent, which is why the banner behind the words stays
   * exactly where it is while they move through it.
   */
  travel?: number
}

export interface AnimationPresetDef {
  id: AnimationPreset
  label: string
  /** One-line description, shown under the picker. */
  hint: string
  /**
   * What this preset takes hold of.
   *
   * `strip` deforms the whole band of type, so it means something to anything
   * living in that band — the banner included.
   *
   * `letters` moves each character in its own right, and a banner has no
   * characters.
   *
   * `run` carries the line bodily ALONG its run rather than deforming it. Only
   * the type is offered it: a banner carried away from the words it belongs to
   * leaves them standing on bare shape, which is not a banner any more.
   *
   * Offering a preset something it cannot take hold of is a control that does
   * nothing, and that reads as broken rather than as inapplicable — so the menus
   * are built from this rather than from lists of names.
   */
  carries: 'strip' | 'letters' | 'run'
  /**
   * How long a loop of this preset should be when it is first picked, in
   * seconds. Falls back to the document's own default.
   *
   * On the preset because only the preset knows what its loop is FOR. A boil or
   * a jitter is a texture — a couple of seconds is a shimmer, and ten is a
   * shape slowly breathing. Travel is not a texture: it carries the words the
   * whole way round, so the same two seconds is a sprint nobody can read. One
   * default cannot serve both, and the one that was shared served the wobbles.
   */
  loop?: number
  controls: AnimationControl[]
  frame(config: AnimationConfig, phase: number, seed: number): AnimationFrame
}

const percent = (v: number): string => `${Math.round(v * 100)}%`

/** The still frame: everything as the artwork already is. */
export const STATIC_FRAME: AnimationFrame = {
  distortion: {},
  phase: 0,
  deformerShift: 0,
  travel: 0,
}

function read(config: AnimationConfig, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A smooth there-and-back over one loop, peaking at the halfway point. */
function swing(phase: number): number {
  return Math.sin(phase * Math.PI * 2)
}

const MOTIONS: readonly AnimationPresetDef[] = [
  {
    id: 'none',
    carries: 'strip' as const,
    label: 'None',
    hint: 'Still.',
    controls: [],
    frame: () => STATIC_FRAME,
  },
  {
    id: 'wave',
    carries: 'strip' as const,
    label: 'Wave',
    hint: 'A ripple travelling along the rows.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 0.3, format: percent },
      {
        kind: 'number' as const,
        key: 'frequency',
        label: 'Frequency',
        min: 0.5,
        max: 6,
        step: 0.1,
        value: 2,
        format: (v) => v.toFixed(1),
      },
    ],
    frame: (config, phase) => ({
      // The warp already carries a wave term; the phase simply advances it.
      distortion: {
        waveAmount: read(config, 'amount', 0.3),
        waveFrequency: read(config, 'frequency', 2),
      },
      phase,
      deformerShift: 0,
    }),
  },
  {
    id: 'boil',
    carries: 'strip' as const,
    label: 'Boil',
    hint: 'A seeded shimmer, like hand-drawn animation.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 0.25, format: percent },
      {
        kind: 'number' as const,
        key: 'scale',
        label: 'Scale',
        min: 0.2,
        max: 8,
        step: 0.1,
        value: 2,
        format: (v) => v.toFixed(1),
      },
    ],
    frame: (config, phase) => ({
      distortion: {
        noiseAmount: read(config, 'amount', 0.25),
        noiseScale: read(config, 'scale', 2),
      },
      phase,
      deformerShift: 0,
    }),
  },
  {
    id: 'bounce',
    carries: 'letters' as const,
    label: 'Bounce',
    hint: 'A wave running through the letters, one after another.',
    controls: [
      { kind: 'number' as const, key: 'height', label: 'Height', min: 0, max: 1, step: 0.01, value: 0.25, format: percent },
      { kind: 'number' as const, key: 'stagger', label: 'Stagger', min: 0, max: 1, step: 0.01, value: 0.4, format: percent },
    ],
    frame: (config, phase) => {
      const height = read(config, 'height', 0.25)
      const stagger = read(config, 'stagger', 0.4)
      return {
        distortion: {},
        phase,
        deformerShift: 0,
        // Each letter is the same bounce, started a little later than the one
        // before. The offset is a fraction of the band, so it scales with the
        // type rather than being a fixed number of units.
        letterOffset: (index: number) => ({
          x: 0,
          y: -height * 0.5 * swing(phase - index * stagger * 0.08),
        }),
      }
    },
  },
  {
    id: 'sweep',
    carries: 'strip' as const,
    label: 'Sweep',
    hint: 'A squeeze travelling across the shape, and back.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Travel', min: 0, max: 0.5, step: 0.01, value: 0.2, format: percent },
    ],
    // There and back rather than across and wrapping: a wrap would jump at the
    // seam, and the loop has to close without one. Running the squeeze DOWN the
    // rows instead of across them in one piece is the shared line offset's job.
    frame: (config, phase) => ({
      distortion: {},
      phase,
      deformerShift: read(config, 'amount', 0.2) * swing(phase),
    }),
  },
  {
    id: 'travel',
    carries: 'run' as const,
    label: 'Travel',
    hint: 'The words run round the shape, in one direction, forever.',
    /*
     * Long, because this one is READ while it moves.
     *
     * Every other preset wobbles letters that stay where they are, and the eye
     * can follow that at a couple of seconds a loop. Travel takes the words the
     * whole way round the shape, so the loop length IS the reading speed — at
     * two seconds a sentence goes past faster than anyone can take it in, which
     * is the first thing anyone saw on picking it.
     */
    loop: 14,
    controls: [
      {
        kind: 'number' as const,
        key: 'laps',
        label: 'Laps',
        // One lap per loop either way. Two was offered and was never the answer:
        // combined with a short loop it put the words round the shape faster than
        // anyone could read them, and the whole useful range sat below 1.
        min: -1,
        max: 1,
        step: 0.25,
        value: 1,
        format: (v: number) => (v === 0 ? 'still' : `${v > 0 ? '' : '-'}${Math.abs(v)}×`),
      },
    ],
    /*
     * A whole number of laps per loop, so the words are back where they started
     * when the loop closes. Fractions are allowed and are honest about what they
     * do: the loop still repeats, but the words jump at the seam.
     *
     * Negative runs it the other way. There is no easing and no there-and-back:
     * this is the one preset that goes one way, which is only possible because
     * the run it goes round has no ends.
     */
    frame: (config, phase) => ({
      distortion: {},
      phase,
      deformerShift: 0,
      travel: read(config, 'laps', 1) * phase,
    }),
  },
  {
    id: 'sway',
    carries: 'strip' as const,
    label: 'Sway',
    hint: 'The block leans one way and then the other.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Lean', min: 0, max: 1, step: 0.01, value: 0.3, format: percent },
    ],
    frame: (config, phase) => {
      const amount = read(config, 'amount', 0.3)
      return {
        // Shear is already a warp term; it only needed a phase.
        distortion: { shear: amount * 0.35 * swing(phase) },
        phase,
        deformerShift: 0,
      }
    },
  },
  {
    id: 'pop',
    carries: 'letters' as const,
    label: 'Pop',
    hint: 'Letters swell and shrink in turn.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 0.3, format: percent },
      { kind: 'number' as const, key: 'stagger', label: 'Stagger', min: 0, max: 1, step: 0.01, value: 0.4, format: percent },
    ],
    frame: (config, phase) => {
      const amount = read(config, 'amount', 0.3)
      const stagger = read(config, 'stagger', 0.4)
      return {
        distortion: {},
        phase,
        deformerShift: 0,
        letterScale: (index: number) => 1 + amount * 0.4 * swing(phase - index * stagger * 0.08),
      }
    },
  },
  {
    id: 'jitter',
    carries: 'letters' as const,
    label: 'Jitter',
    hint: 'Every letter shakes on its own.',
    controls: [
      { kind: 'number' as const, key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 0.2, format: percent },
    ],
    frame: (config, phase, seed) => {
      const amount = read(config, 'amount', 0.2)
      return {
        distortion: {},
        phase,
        deformerShift: 0,
        // Each letter walks its own little circle, at its own starting angle.
        // A circle rather than fresh randomness per frame: the loop has to come
        // back to where it began, and random values never would.
        letterOffset: (index: number) => {
          const angle = (seededValue(seed, index * 31 + 7) + phase) * Math.PI * 2
          const radius = amount * 0.12 * (0.5 + seededValue(seed, index * 31 + 8) * 0.5)
          return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
        },
      }
    },
  },
]

/**
 * The one control every moving preset gets, whatever it is.
 *
 * Without it the whole block moves in lockstep, which reads as one rigid object
 * being waved about rather than as type that is alive. Sharing the control means
 * no preset can be forgotten and every one names it the same thing.
 */
const LINE_OFFSET: AnimationControl = {
  kind: 'number',
  key: 'lineOffset',
  label: 'Line offset',
  min: 0,
  max: 1,
  step: 0.01,
  value: 0,
  format: percent,
}

/**
 * The presets a BANNER can take.
 *
 * A banner has a strip and a run and no letters, so it is offered exactly the
 * presets that act on those. Filtered from the one list rather than written out
 * again, so a preset added later lands in the right menus by declaring what it
 * carries and nothing else.
 */
export function bannerAnimations(): readonly AnimationPresetDef[] {
  return ANIMATIONS.filter((preset) => preset.carries === 'strip')
}

export const ANIMATIONS: readonly AnimationPresetDef[] = MOTIONS.map((preset) =>
  preset.id === 'none' ? preset : { ...preset, controls: [...preset.controls, LINE_OFFSET] },
)

/**
 * How far behind the line above each line runs, as a share of the loop.
 *
 * Divided by the line count so that at 100% the lines spread evenly around the
 * whole loop — one full travelling wave down the block, whether there are two
 * lines or nine. A fixed delay per line would do nothing at all on a two-line
 * shape and blur into noise on a tall one.
 */
export function linePhase(
  config: AnimationConfig,
  phase: number,
  line: number,
  lineCount: number,
): number {
  const spread = read(config, 'lineOffset', 0)
  if (!(spread > 0) || lineCount < 2) return phase
  return phase - (spread * line) / lineCount
}

export function animationById(id: AnimationPreset): AnimationPresetDef {
  return ANIMATIONS.find((preset) => preset.id === id) ?? (ANIMATIONS[0] as AnimationPresetDef)
}

/** The values a preset starts with, ready to store on an object. */
export function defaultConfig(id: AnimationPreset): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const control of animationById(id).controls) out[control.key] = control.value
  return out
}

/**
 * The loop a preset wants when it is picked, or the document's own default.
 *
 * Applied on SELECTION and not on every frame, so it is a starting point rather
 * than a rule: the loop slider still says what it says, and a length chosen by
 * hand survives everything except picking a different preset.
 */
export function defaultLoop(id: AnimationPreset, fallback: number): number {
  return animationById(id).loop ?? fallback
}

/** A per-object phase offset, so several stickers do not pulse in lockstep. */
export function seededPhase(seed: number): number {
  return seededValue(seed, 991)
}
