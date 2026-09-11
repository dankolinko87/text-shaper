import { DEFAULT_FONT_ID } from '../fonts/manifest'
import type {
  AnimationSettings,
  AppearanceSettings,
  DistortionSettings,
  DocumentDefaults,
  FontSettings,
  RunSettings,
  TextShaperDocument,
  TypographySettings,
} from '../types/document'
import { DOCUMENT_SCHEMA_VERSION } from '../types/document'
import { createId } from '../utils/id'

/**
 * The canvas is endless, so these are not page bounds — nothing is clipped to
 * them. They only describe the region the view frames when a document is empty,
 * and they will define the export crop in a later phase.
 */
export const ARTBOARD_WIDTH = 1200
export const ARTBOARD_HEIGHT = 800
/*
 * The page's colour until somebody chooses one: a light grey, as Figma's
 * canvas is, so white artwork has an edge to be seen against and black type
 * is not shouting off a white sheet. One constant, read by the document and
 * by the exports' fallback alike.
 */
export const ARTBOARD_BACKGROUND = '#e5e5e5'

export const defaultFontSettings: FontSettings = {
  fontId: DEFAULT_FONT_ID,
  weight: 400,
  italic: false,
}

export const defaultTypographySettings: TypographySettings = {
  // Above 1 so the bands leave a little air between lines. At exactly 1 the
  // bands tile the shape edge to edge and adjacent lines' ink touches. The
  // spacing is taken BETWEEN rows only, so it never holds the type back from
  // the outline.
  lineSpacing: 1.14,
  letterSpacing: 0,
  // The type is meant to reach the outline, so nothing is held back by default.
  // A margin here is a uniform ring the warp cannot fill: at 16 it cost 5% of
  // the width on each side and about 3% top and bottom, which read exactly as
  // the type failing to stretch all the way. Measured boolean subtraction puts
  // ink escaping the outline at 0.00% with no padding at all, so the margin was
  // buying nothing. It remains a control for anyone who wants the inset.
  padding: 0,
}

export const defaultDistortionSettings: DistortionSettings = {
  // Character gap, as a fraction of the line width. Keeps letters from touching.
  horizontal: 0.14,
  // Line height variation. Low by default: lines should read as a considered
  // stack, not as random sizes.
  vertical: 0.15,
  // Full strength by default. The point of the tool is that the type meets the
  // outline exactly; anything less leaves it approximating the shape.
  boundaryInfluence: 1,
  // Character width variation, and per-character vertical fill.
  //
  // Vertical fill is 1 on purpose: the warp maps a character's BAND onto the
  // shape's local extent, so a character that only fills 80% of its band keeps
  // that 20% as a gap against the outline however precise the warp is.
  glyphScaleVariation: 0.35,
  glyphRotation: 1,
  waveAmount: 0,
  waveFrequency: 1,
  shear: 0,
  noiseAmount: 0,
  noiseScale: 1,
}

export const defaultAppearanceSettings: AppearanceSettings = {
  textFill: '#101014',
  // Shapes are given a visible body by default. A brand new shape has no text
  // yet, and an invisible container would mean drawing produced nothing on
  // screen. Set this to null for typography with no container behind it.
  containerFill: '#dcdcd8',
  // No banner until one is asked for: the run modes are not the only modes.
  lineFill: null,
  // And no border until one is added. A shape drawn today looks exactly as it
  // did before this existed, which is what makes the feature additive.
  containerStroke: null,
  opacity: 1,
}

export const defaultRunSettings: RunSettings = {
  // As large as fits, which is what this mode did before there was a control.
  fontSize: 0,
  // One lap, which is the gentler of the two to meet first: a spiral is what you
  // get by asking for more.
  turns: 'one',
  // Just inside the outline, which is where a run belongs unless it is asked to
  // sit anywhere else: the shape still reads as the shape.
  side: 1,
  outward: false,
  centreHole: 0,
  split: false,
  // Nine o'clock, where the break was fixed before it was a control: the lap
  // winds clockwise from there, so the words go up over the top first.
  splitAngle: 270,
  gap: 0.06,
  // The letters' own height: no banner until one is asked for.
  lineHeight: 1,
  // Set, not packed. A lap is the type-on-path case; switching to many turns
  // does not change it, because the letters are the user's choice either way.
  rigid: true,
  upright: false,
  baselineShift: 0,
}

export const defaultAnimationSettings: AnimationSettings = {
  preset: 'none',
  // Short enough to read as a loop at a glance, which is what a sticker has to do.
  loopDuration: 2,
  config: {},
  shapePreset: 'none',
  shapeConfig: {},
  // The banner takes the type's own motion until it is asked for something of
  // its own: the two share a strip, and a banner left behind by a ripple that
  // moved the words would tear away from them.
  bannerPreset: 'follow',
  bannerConfig: {},
  // The type follows the shape by default: that composition is the point of
  // animating a container at all, rather than sliding a picture about.
  shapeAffectsText: true,
  textColour: { effect: 'none', config: {} },
  shapeColour: { effect: 'none', config: {} },
}

export const documentDefaults: DocumentDefaults = {
  font: defaultFontSettings,
  typography: defaultTypographySettings,
  run: defaultRunSettings,
  distortion: defaultDistortionSettings,
  appearance: defaultAppearanceSettings,
  animation: defaultAnimationSettings,
}

export function createEmptyDocument(name = 'Untitled'): TextShaperDocument {
  const now = new Date().toISOString()
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: createId('doc'),
    name,
    createdAt: now,
    updatedAt: now,
    artboard: {
      width: ARTBOARD_WIDTH,
      height: ARTBOARD_HEIGHT,
      background: ARTBOARD_BACKGROUND,
    },
    objects: {},
    objectOrder: [],
    defaults: documentDefaults,
  }
}
