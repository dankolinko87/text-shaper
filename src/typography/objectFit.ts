import { insetPath } from '../geometry/clipper'
import { buildPatch } from '../geometry/patch'
import { mapPathPoints, pathBounds, subdividePath } from '../geometry/path'
import type { AnimationPreset, PathData, TypographyObject } from '../types/document'
import {
  animationById,
  linePhase,
  STATIC_FRAME,
  type AnimationConfig,
  type AnimationFrame,
} from './animation'
import { paintAt, type FillPaint } from './colour'
import { defaultShapeConfig, mapPatch, shapeAnimationById, type ShapePreset } from './shapeAnimation'
import { fitTextToShape, type FitOutcome } from './fit'
import type { FittedLayout } from './frame'
import {
  renderBandFrame,
  renderFrame,
  renderRibbon,
  type FrameFor,
  type RibbonSlice,
} from './frame'

/**
 * Fitting a DOCUMENT OBJECT, as opposed to fitting bare text to a bare path.
 *
 * The engine deliberately knows nothing about documents. This is the one place
 * that bridges the two, so the editor and the exporter fit an object the same
 * way — a second copy of the padding handling would drift, and the two would
 * quietly disagree about what the artwork looks like.
 */

export function fitObject(object: TypographyObject): FitOutcome {
  if (object.text.trim().length === 0) {
    return { ok: false, reason: 'empty-text', message: 'Enter text to fill this shape.' }
  }

  /*
   * A run mode does its own padding.
   *
   * The builder places the run from the ORIGINAL outline: insetting first would
   * hand it a rounded copy to offset, and the outermost turn would stop being
   * the shape the user drew. A lap has a second reason — its band can sit
   * OUTSIDE the drawn edge, which insetting first would make impossible.
   */
  /*
   * A drawn line is the run itself. Nothing is offset from it, so padding has
   * nothing to inset and the band position has nothing to sit across.
   */
  if (object.fittingMode === 'path') {
    const run = object.run
    return fitTextToShape({
      text: object.text,
      shapePath: object.currentSourcePath,
      fontId: object.font.fontId,
      flowMode: object.textFlowMode,
      lineSpacing: object.typography.lineSpacing,
      letterSpacing: object.typography.letterSpacing,
      quality: 'final',
      fittingMode: 'path',
      distortion: object.distortion,
      seed: object.seed,
      upright: run.upright,
      rigid: run.rigid,
      lineHeight: run.lineHeight,
      baselineShift: run.baselineShift,
      fontSize: run.fontSize,
      band: object.appearance.lineFill !== null,
    } as Parameters<typeof fitTextToShape>[0])
  }

  if (object.fittingMode === 'ring') {
    const run = object.run
    return fitTextToShape({
      text: object.text,
      shapePath: object.currentSourcePath,
      fontId: object.font.fontId,
      flowMode: object.textFlowMode,
      lineSpacing: object.typography.lineSpacing,
      letterSpacing: object.typography.letterSpacing,
      quality: 'final',
      fittingMode: 'ring',
      turns: run.turns,
      fontSize: run.fontSize,
      distortion: object.distortion,
      seed: object.seed,
      padding: object.typography.padding,
      side: run.side,
      outward: run.outward,
      centreHole: run.centreHole,
      split: run.split,
      splitAngle: run.splitAngle,
      gap: run.gap,
      upright: run.upright,
      rigid: run.rigid,
      lineHeight: run.lineHeight,
      baselineShift: run.baselineShift,
      band: object.appearance.lineFill !== null,
    } as Parameters<typeof fitTextToShape>[0])
  }

  let region = object.currentSourcePath
  if (object.typography.padding > 0) {
    const inset = insetPath(object.currentSourcePath, object.typography.padding)
    if (inset.collapsed || !inset.path) {
      return { ok: false, reason: 'no-space', message: 'Not enough space for text.' }
    }
    region = inset.path
  }

  return fitTextToShape({
    text: object.text,
    shapePath: region,
    fontId: object.font.fontId,
    flowMode: object.textFlowMode,
    lineSpacing: object.typography.lineSpacing,
    letterSpacing: object.typography.letterSpacing,
    quality: 'final',
    fittingMode: object.fittingMode,
    distortion: object.distortion,
    seed: object.seed,
    dividers: object.dividers,
  })
}

export interface SequenceFrame {
  path: PathData
  textFill: FillPaint
  /** The banner this frame, or null when the object has none. */
  bandPath: PathData | null
  bandFill: FillPaint | null
  /**
   * The banner and the words in slices, in the order they are laid down.
   *
   * Empty when there is no banner. The still artwork is drawn from these too, so
   * a frame has to carry them or an animating ribbon would fall back to two flat
   * layers the moment it started moving.
   */
  ribbon: RibbonSlice[]
  /** The container's outline this frame, or null when it is holding still. */
  shapePath: PathData | null
  /** The container's fill this frame, or null when there is no container. */
  shapeFill: FillPaint | null
}

/**
 * Everything a frame needs that does NOT change between frames.
 *
 * Prepared once and handed to every frame. Both the fit and the outline
 * subdivision are far too slow to repeat at frame rate, and re-solving the fit
 * would be worse than slow: the line breaks could move part-way through a loop
 * and words would visibly jump between rows.
 */
export interface FrameSource {
  layout: FittedLayout
  /**
   * The container's outline as a PATH, with enough points on it to deform
   * smoothly.
   *
   * Named for the path rather than for the outline, because an object now
   * carries an `outline` of its own — the editable nodes — and one word meaning
   * two things in one codebase is a bug waiting for a careless autocomplete.
   */
  outlinePath: PathData
}

/** How finely the outline is cut up, as a share of the shape's own size. */
const OUTLINE_DETAIL = 40

export function prepareFrames(
  object: TypographyObject,
  /** A different container to pour the same layout through. See `pourThrough`. */
  shapePath?: PathData,
): FrameSource | null {
  return pourThrough(object, fitObject(object), shapePath)
}

/**
 * A fitted layout, ready to emit, through a container that may not be its own.
 *
 * The layout — where the line breaks fall, how big the type is, which word goes
 * on which row — is solved against the object's own shape and KEPT. The patch is
 * the space that layout is poured into, so building one at another outline moves
 * every glyph to follow that outline without re-fitting anything. It is exactly
 * what a shape preset does, with the deformation coming from a frame state's
 * points instead of from a wave.
 *
 * Re-fitting would be the obvious alternative and is the wrong one: the line
 * breaks would move, and words would hop between rows part-way through a morph.
 * A row that has been assigned stays assigned; only the space it sits in bends.
 *
 * Takes the fit rather than running one, because the caller usually has it
 * already — asking for it again doubled the work on every state change.
 */
export function pourThrough(
  object: TypographyObject,
  fitted: FitOutcome,
  shapePath?: PathData,
  /**
   * How finely the new container is sampled.
   *
   * Full detail for a still, which is solved once when a state is opened.
   * Playback passes fewer: it rebuilds this every frame, and the patch is read
   * through a resampled table either way, so the extra points buy accuracy
   * nobody can see at sixty frames a second.
   */
  samples = PATCH_SAMPLES,
): FrameSource | null {
  if (!fitted.ok || !fitted.layout) return null

  const path = shapePath ?? object.currentSourcePath
  const bounds = pathBounds(path)
  const step = Math.max(bounds.width, bounds.height) / OUTLINE_DETAIL

  /*
   * Rebuilt only where there was one to begin with. A drawn line has no patch
   * and nothing to pour, and a shape whose type is set flat is not laid out
   * through one either — handing those a patch would change how they are drawn,
   * not merely where.
   *
   * Built on the PADDED region, exactly as the fit builds its own. The layout
   * was poured into the shape inset by the padding, so a patch built on the raw
   * outline maps padded space onto unpadded and stretches the type back out to
   * the full shape — measured, a 40-unit pad on a 300x200 shape came back as
   * 300x200 instead of 220x120, which is padding appearing to do nothing at all.
   *
   * Exact rather than tolerance-fitted: this patch is never given editable
   * handles, and every glyph is emitted through a resampled table anyway, so
   * keeping every sample costs the build and nothing after it.
   */
  const patch =
    shapePath && fitted.layout.patch
      ? buildPatch(paddedRegion(object, shapePath) ?? shapePath, { samples, tolerance: 0 })
      : fitted.layout.patch

  return {
    layout: patch === fitted.layout.patch ? fitted.layout : { ...fitted.layout, patch },
    outlinePath: subdividePath(path, step),
  }
}

/**
 * A shape inset by the object's padding, or null when there is none to apply.
 *
 * The same inset the fit performs before it lays anything out, so the space the
 * type is poured INTO matches the space it was measured FOR. A padding that
 * collapses the interior gives null and the caller pours through the outline
 * itself, which is the same fallback the fit takes when it refuses.
 */
function paddedRegion(object: TypographyObject, shapePath: PathData): PathData | null {
  const padding = object.typography.padding
  if (!(padding > 0)) return null
  const inset = insetPath(shapePath, padding)
  return inset.collapsed || !inset.path ? null : inset.path
}

/** Points taken round a re-poured outline. The fit's own final quality. */
const PATCH_SAMPLES = 240
/** And the draft the playback loop uses, matching the fit's own draft quality. */
export const PATCH_SAMPLES_DRAFT = 96

/**
 * Every frame of one loop.
 *
 * Phases run `i / count`, so the frame after the last is phase 1 — the same
 * point on the circle as phase 0 — and the loop closes without a repeated frame.
 */
export function animationFrames(object: TypographyObject, count: number): SequenceFrame[] {
  const fitted = fitObject(object)
  const frames = Math.max(1, Math.round(count))
  if (!fitted.ok) return []

  const still = stillFrame(object, fitted)
  if (!still) return []

  // Nothing moving at all, or nothing to move WITH: a single still frame.
  if (!isMoving(object) || !fitted.layout) return [still]


  const bounds = pathBounds(object.currentSourcePath)
  const source: FrameSource = {
    layout: fitted.layout,
    outlinePath: subdividePath(
      object.currentSourcePath,
      Math.max(bounds.width, bounds.height) / OUTLINE_DETAIL,
    ),
  }

  const out: SequenceFrame[] = []
  for (let i = 0; i < frames; i++) out.push(composeFrame(object, source, i / frames))
  return out
}

/**
 * The artwork at rest, in the same shape a moving frame comes in.
 *
 * Exported because stopping a loop is not "undo the last frame", it is "draw the
 * still one" — and the only way to be sure the two agree is for both to travel
 * the same path onto the canvas. The editor used to put things back by hand and
 * only remembered the pieces it was thinking about at the time, so a banner or a
 * sliced ribbon stayed wherever the loop happened to stop.
 */
export function stillFrame(
  object: TypographyObject,
  fitted: FitOutcome = fitObject(object),
): SequenceFrame | null {
  if (!fitted.ok) return null
  return {
    path: fitted.path,
    textFill: paintAt(object.animation.textColour, 0, object.appearance.textFill),
    bandPath: fitted.band ?? null,
    ribbon: fitted.ribbon ?? [],
    bandFill: object.appearance.lineFill
      ? { kind: 'solid', colour: object.appearance.lineFill }
      : null,
    shapePath: null,
    shapeFill: object.appearance.containerFill
      ? paintAt(object.animation.shapeColour, 0, object.appearance.containerFill)
      : null,
  }
}

/**
 * One frame: the shape's form first, then the type drawn through it.
 *
 * The order matters, and so does the sharing. The shape preset produces ONE
 * bending of the plane, which is applied both to the container's outline and to
 * the patch the type is laid out through — so the type follows the shape rather
 * than the two moving past each other.
 */
function composeFrame(
  object: TypographyObject,
  source: FrameSource,
  phase: number,
): SequenceFrame {
  const preset = animationById(object.animation.preset)
  const shape = shapeAnimationById(object.animation.shapePreset as ShapePreset)
  const shapeConfig = object.animation.shapeConfig ?? defaultShapeConfig(shape.id)
  const config = object.animation.config

  /** The moment for the type, and the moment for its banner. */
  const momentFor = (
    id: AnimationPreset,
    values: AnimationConfig,
  ): AnimationFrame | FrameFor =>
    id === 'none'
      ? STATIC_FRAME
      : (line, count) =>
          animationById(id).frame(values, linePhase(values, phase, line, count), object.seed)

  const typeMoment = momentFor(preset.id, config)
  /*
   * The banner is a shape in its own right, so it takes its own preset — and
   * `follow` means literally the type's moment, not a copy of its settings, so
   * the two cannot drift apart by a rounding.
   */
  const bannerChoice = object.animation.bannerPreset ?? 'follow'
  const bannerMoment =
    bannerChoice === 'follow'
      ? typeMoment
      : momentFor(bannerChoice, object.animation.bannerConfig ?? {})

  /*
   * The shape presets deform the CONTAINER, and a drawn line has none — no
   * inside to squeeze, no corners to pull. So they are simply off for one, and
   * the type animates on its own.
   */
  const patch = hasContainer(object) ? source.layout.patch : null
  const move = patch ? shape.map(patch, shapeConfig, phase, object.seed) : null
  const deformed = patch && move ? mapPatch(patch, move) : patch

  /*
   * The shape's bending, handed to the RUN modes directly.
   *
   * A row of block text is laid out THROUGH the patch, so deforming the patch
   * carries the type with it. A lap, a spiral and a line are not — they are bent
   * onto a run, and the run knows nothing about the patch. So the bending itself
   * has to be passed down, or a shape preset moves the container and leaves the
   * type sitting exactly where it was. It did: every shape preset pulled the
   * outline about while the ring of text around it stayed put.
   *
   * Nothing to guard against double-deforming block text — `renderFrame` uses
   * this only for run lines, and rows go through the patch instead.
   */
  const carry =
    object.animation.shapeAffectsText === false || !move ? undefined : move

  return {
    // The type is drawn through the deformed container only when it has been
    // asked to follow it. Off, the container moves alone and the words hold
    // their place, which suits a shape that frames the type rather than holding
    // it.
    path: renderFrame(
      source.layout,
      typeMoment,
      object.animation.shapeAffectsText === false ? source.layout.patch : deformed,
      carry,
    ),
    textFill: paintAt(object.animation.textColour, phase, object.appearance.textFill),
    // Redrawn each frame from the same layout the type is, so a preset that
    // moves the run carries the banner with it rather than leaving the letters
    // to walk out of it.
    bandPath: object.appearance.lineFill
      ? renderBandFrame(source.layout, bannerMoment, carry)
      : null,
    ribbon: object.appearance.lineFill
      ? renderRibbon(source.layout, typeMoment, bannerMoment, carry)
      : [],
    bandFill: object.appearance.lineFill ? { kind: 'solid', colour: object.appearance.lineFill } : null,
    shapePath: move ? mapPathPoints(source.outlinePath, move) : null,
    shapeFill: object.appearance.containerFill
      ? paintAt(object.animation.shapeColour, phase, object.appearance.containerFill)
      : null,
  }
}

/**
 * Whether this object has a CONTAINER whose form can be animated.
 *
 * A drawn line does not. It is a run and nothing else — no inside to squeeze, no
 * corners to pull — and what is drawn along it in the editor is a guide rather
 * than artwork. So the shape presets have nothing to take hold of, and offering
 * them wobbles a grey line nobody is looking at while the type stands still.
 */
export function hasContainer(object: TypographyObject): boolean {
  /*
   * The MODE, not the shape of the geometry.
   *
   * Openness decides the mode once, at creation, and nothing after that. Asking
   * the path instead would mean a closed pen path reported "has a container"
   * while its mode said otherwise — a combination nothing downstream has ever
   * had to handle — and closing a path by dragging one node onto another would
   * silently change what the object IS, halfway through a drag.
   *
   * 'path' is reachable only by drawing a line: the mode selector is hidden for
   * it and offers nothing else to a shape, so the two questions have the same
   * answer and this one has a stable definition.
   */
  return object.fittingMode !== 'path'
}

/**
 * Whether anything at all changes through the loop.
 *
 * The gate on the whole thing: false here and the editor never starts a loop and
 * the exporter writes a single still frame. So every part that can move has to
 * be named, and each is asked whether it EXISTS as well as whether it moves — a
 * shape colour cycling on an object with no container is not motion.
 */
export function isMoving(object: TypographyObject): boolean {
  const animation = object.animation
  const banner = animation.bannerPreset ?? 'follow'
  return (
    animation.preset !== 'none' ||
    (hasContainer(object) && animation.shapePreset !== 'none') ||
    (object.appearance.lineFill !== null && banner !== 'follow' && banner !== 'none') ||
    (animation.textColour?.effect ?? 'none') !== 'none' ||
    (object.appearance.containerFill !== null &&
      (animation.shapeColour?.effect ?? 'none') !== 'none')
  )
}

/** One frame at an arbitrary point in the loop, for live playback. */
export function frameAt(
  object: TypographyObject,
  source: FrameSource,
  phase: number,
): SequenceFrame {
  return composeFrame(object, source, ((phase % 1) + 1) % 1)
}
