import { pathToOutline } from '../geometry/outline'
import type { TextShaperDocument } from '../types/document'
import { DOCUMENT_SCHEMA_VERSION } from '../types/document'
import { MOSAIC_DEFAULT_SNAP } from '../mosaic/snap'
import type { Vec2 } from '../types/document'
import {
  MOSAIC_CELL,
  MOSAIC_DEFAULT_EASING,
  DEFAULT_GLYPH_COLOUR,
  MOSAIC_DEFAULT_CORNERS,
  MOSAIC_DEFAULT_SPACING,
  MOSAIC_DEFAULT_HOLD_MS,
  MOSAIC_DEFAULT_TRANSITION_MS,
  isRim,
} from '../types/mosaic'
import { EASING_PRESETS } from '../anim/easing'
import { gradientStops, MIN_STOPS, parseHex } from '../typography/colour'
import type { ColourConfigValue, GradientStop } from '../types/document'

/** The easing names a file is allowed to carry. */
const EASING_NAMES = new Set<string>(EASING_PRESETS)
import { documentDefaults } from './defaults'

const STORAGE_KEY = 'text-shaper:document:v1'
/**
 * Where work in progress is kept between page loads.
 *
 * Deliberately a DIFFERENT key from the one Save writes. Autosave is a safety
 * net for the refresh you did not mean to do; Save is a checkpoint you chose to
 * make and can come back to. Sharing one key would quietly destroy the second:
 * the next keystroke after opening a save would overwrite it.
 */
const AUTOSAVE_KEY = 'text-shaper:autosave:v1'
/**
 * The snapshot as it stood when this session began.
 *
 * A second slot, because one is not a safety net — it is a single point of
 * failure that the app itself overwrites several times a minute. Anything that
 * makes a session start badly (a snapshot written by a newer build, a corrupt
 * write, a load that throws) leaves the document empty, and the first change
 * after that used to put the empty document straight over the only copy.
 *
 * Written once per session, before the first overwrite, so it always holds what
 * was there BEFORE this session could damage it.
 */
const AUTOSAVE_PREVIOUS_KEY = 'text-shaper:autosave:previous:v1'

export type MigrationFn = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * Version migrations, applied in ascending order.
 *
 * Adding a field is a migration rather than a breaking change for anyone who
 * already has a saved project.
 */
/** Every frame in a raw document, whatever shape the rest of it is in. */
function forEachFrame(raw: Record<string, unknown>, fn: (o: Record<string, unknown>) => void): void {
  const objects = raw['objects']
  if (!objects || typeof objects !== 'object') return
  for (const value of Object.values(objects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const object = value as Record<string, unknown>
    if (object['kind'] !== 'frame') continue
    fn(object)
  }
}

/**
 * Every typography object in a raw document: the ones on the page, and the
 * ones a frame holds as members — which live inside the frame, not in
 * `objects`, and are missed by anything that only walks the page.
 */
function forEachTypography(
  raw: Record<string, unknown>,
  fn: (o: Record<string, unknown>) => void,
): void {
  const objects = raw['objects']
  if (!objects || typeof objects !== 'object') return
  for (const value of Object.values(objects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const object = value as Record<string, unknown>
    if (object['kind'] === 'typography') fn(object)
    if (object['kind'] !== 'frame' || !Array.isArray(object['members'])) continue
    for (const member of object['members'] as unknown[]) {
      const own = (member as { object?: unknown } | null)?.object
      if (own && typeof own === 'object' && (own as Record<string, unknown>)['kind'] === 'typography') {
        fn(own as Record<string, unknown>)
      }
    }
  }
}

/**
 * A gradient that predates stops: the part's own colour blending to one other.
 *
 * Written as the two stops that draw the same picture. `to` is read exactly
 * as the painter read it — six digits or the default — so nothing changes on
 * screen; the base is the part's resting colour, which is what stop 0 was.
 */
function stopsFromTwoColours(object: Record<string, unknown>): void {
  const animation = object['animation']
  const appearance = object['appearance']
  if (!animation || typeof animation !== 'object' || !appearance || typeof appearance !== 'object') return
  const paints = appearance as Record<string, unknown>
  const textBase = typeof paints['textFill'] === 'string' ? paints['textFill'] : '#101014'
  const shapeBase = typeof paints['containerFill'] === 'string' ? paints['containerFill'] : textBase
  for (const [key, base] of [
    ['textColour', textBase],
    ['shapeColour', shapeBase],
  ] as const) {
    const settings = (animation as Record<string, unknown>)[key]
    if (!settings || typeof settings !== 'object') continue
    const colour = settings as Record<string, unknown>
    if (colour['effect'] !== 'gradient') continue
    const config = (colour['config'] ?? {}) as Record<string, unknown>
    if (Array.isArray(config['stops'])) continue
    const to =
      typeof config['to'] === 'string' && /^#[0-9a-f]{6}$/i.test(config['to'].trim())
        ? config['to'].trim()
        : '#e0552f'
    config['stops'] = [
      { at: 0, colour: base },
      { at: 1, colour: to },
    ]
    delete config['to']
    colour['config'] = config
  }
}

/** The gradient a shape's colour effect described, as a paint; null for any other effect. */
function gradientPaintOf(settings: unknown, base: string): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null
  const colour = settings as Record<string, unknown>
  if (colour['effect'] !== 'gradient') return null
  const config = (colour['config'] ?? {}) as Record<string, unknown>
  const motion = typeof config['motion'] === 'string' ? config['motion'] : 'still'
  const paint: Record<string, unknown> = {
    kind: 'gradient',
    shape: config['shape'] === 'radial' ? 'radial' : 'linear',
    stops: gradientStops(config as Record<string, ColourConfigValue>, base),
    angle: typeof config['angle'] === 'number' && Number.isFinite(config['angle']) ? config['angle'] : 0,
  }
  if (motion !== 'still') {
    paint['motion'] = motion
    paint['travel'] =
      typeof config['travel'] === 'number' && Number.isFinite(config['travel'])
        ? Math.min(1, Math.max(0, config['travel']))
        : 0.5
  }
  return paint
}

/**
 * A shape's gradient effects become the paints of the parts they coloured.
 *
 * The type's onto `textFill`; the body's onto `containerFill`, unless the
 * shape had no body — a gradient over nothing drew nothing, and stays
 * nothing. The effect goes back to none either way.
 */
function foldGradientEffects(object: Record<string, unknown>): void {
  const animation = object['animation']
  const appearance = object['appearance']
  if (!animation || typeof animation !== 'object' || !appearance || typeof appearance !== 'object') return
  const paints = appearance as Record<string, unknown>
  const effects = animation as Record<string, unknown>
  const textBase = typeof paints['textFill'] === 'string' ? paints['textFill'] : '#101014'
  const shapeBase = typeof paints['containerFill'] === 'string' ? paints['containerFill'] : textBase

  const text = gradientPaintOf(effects['textColour'], textBase)
  if (text) {
    paints['textFill'] = text
    effects['textColour'] = { effect: 'none', config: {} }
  }
  const shape = gradientPaintOf(effects['shapeColour'], shapeBase)
  if (shape) {
    if (paints['containerFill'] !== null && paints['containerFill'] !== undefined) paints['containerFill'] = shape
    effects['shapeColour'] = { effect: 'none', config: {} }
  }
}

/**
 * A frame's states, where a member had a gradient effect.
 *
 * A state's colour patch for such a member never showed: the effect painted
 * its stops over whatever base the state gave, so the picture in every state
 * WAS the gradient. The patch becomes that gradient, and the picture holds.
 * Done before the member itself is folded, since folding clears the effect
 * this reads.
 */
function foldMemberGradients(frame: Record<string, unknown>): void {
  const members = Array.isArray(frame['members']) ? (frame['members'] as unknown[]) : []
  const states = Array.isArray(frame['states']) ? (frame['states'] as unknown[]) : []
  for (const member of members) {
    if (!member || typeof member !== 'object') continue
    const m = member as Record<string, unknown>
    const own = m['object'] as Record<string, unknown> | undefined
    if (!own || own['kind'] !== 'typography' || typeof m['id'] !== 'string') continue
    const animation = (own['animation'] ?? {}) as Record<string, unknown>
    const appearance = (own['appearance'] ?? {}) as Record<string, unknown>
    const textBase = typeof appearance['textFill'] === 'string' ? appearance['textFill'] : '#101014'
    const shapeBase = typeof appearance['containerFill'] === 'string' ? appearance['containerFill'] : textBase
    const text = gradientPaintOf(animation['textColour'], textBase)
    const shape = gradientPaintOf(animation['shapeColour'], shapeBase)
    if (!text && !shape) continue
    for (const state of states) {
      const values = (state as Record<string, unknown> | null)?.['values'] as Record<string, unknown> | undefined
      const patch = values?.[m['id']] as Record<string, unknown> | undefined
      const patched = patch?.['appearance'] as Record<string, unknown> | undefined
      if (!patched) continue
      if (text && typeof patched['textFill'] === 'string') patched['textFill'] = text
      if (shape && typeof patched['containerFill'] === 'string') patched['containerFill'] = shape
    }
  }
}

/**
 * A stored paint, or `fallback` when the value is not one.
 *
 * A hex string as ever; a gradient with at least two real stops, a known
 * shape, a finite angle and a motion from the list; a picture whose asset
 * the document actually holds and whose crop is numbers. Anything else is
 * not something a renderer could draw, and the fallback is what a document
 * that never said otherwise would show.
 */
function completePaint(
  value: unknown,
  fallback: string | null,
  assets: Set<string>,
  strokes = false,
): string | Record<string, unknown> | null {
  if (typeof value === 'string') return parseHex(value) ? value : fallback
  if (!value || typeof value !== 'object') return fallback
  const paint = value as Record<string, unknown>
  if (paint['kind'] === 'gradient') {
    const stops = Array.isArray(paint['stops'])
      ? (paint['stops'] as unknown[]).filter(
          (stop) =>
            !!stop &&
            typeof stop === 'object' &&
            typeof (stop as GradientStop).at === 'number' &&
            Number.isFinite((stop as GradientStop).at) &&
            typeof (stop as GradientStop).colour === 'string' &&
            parseHex((stop as GradientStop).colour) !== null,
        )
      : []
    if (stops.length < MIN_STOPS) return fallback
    const out: Record<string, unknown> = {
      kind: 'gradient',
      shape: paint['shape'] === 'radial' ? 'radial' : 'linear',
      stops: stops.map((stop) => ({
        at: Math.min(1, Math.max(0, (stop as GradientStop).at)),
        colour: (stop as GradientStop).colour,
      })),
      angle: typeof paint['angle'] === 'number' && Number.isFinite(paint['angle']) ? paint['angle'] : 0,
    }
    if (!strokes && GRADIENT_MOTIONS.includes(paint['motion'] as never) && paint['motion'] !== 'still') {
      out['motion'] = paint['motion']
      out['travel'] =
        typeof paint['travel'] === 'number' && Number.isFinite(paint['travel'])
          ? Math.min(1, Math.max(0, paint['travel']))
          : 0.5
    }
    return out
  }
  if (paint['kind'] === 'image' && !strokes) {
    const crop = paint['crop'] as Record<string, unknown> | undefined
    if (typeof paint['asset'] !== 'string' || !assets.has(paint['asset'])) return fallback
    const number = (v: unknown, or: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : or)
    const out: Record<string, unknown> = {
      kind: 'image',
      asset: paint['asset'],
      crop: {
        scale: Math.max(1, number(crop?.['scale'], 1)),
        x: number(crop?.['x'], 0),
        y: number(crop?.['y'], 0),
      },
    }
    if (typeof paint['opacity'] === 'number' && Number.isFinite(paint['opacity']) && paint['opacity'] < 1) {
      out['opacity'] = Math.max(0, paint['opacity'])
    }
    return out
  }
  return fallback
}

const GRADIENT_MOTIONS = ['still', 'sweep', 'hover', 'pulse'] as const

/** A stroke's colour put right in place, or the stroke dropped when it has none. */
function completeStrokePaint(stroke: unknown, assets: Set<string>): void {
  if (!stroke || typeof stroke !== 'object') return
  const s = stroke as Record<string, unknown>
  s['colour'] = completePaint(s['colour'], '#101014', assets, true)
}

/** The ids of the pictures a raw document holds — the only ones a paint may name. */
function assetIdsOf(raw: Record<string, unknown>): Set<string> {
  const assets = raw['assets']
  if (!assets || typeof assets !== 'object') return new Set()
  return new Set(Object.keys(assets as Record<string, unknown>))
}

/**
 * A shape's own paints put right: every fill a paint or its default, the
 * border's colour a stroke paint. Never completed before this version, when
 * a fill could only be a string and a string could not be wrong in a way
 * that drew nothing.
 */
function completeTypographyPaints(object: Record<string, unknown>, assets: Set<string>): void {
  const appearance = object['appearance']
  if (!appearance || typeof appearance !== 'object') return
  const paints = appearance as Record<string, unknown>
  paints['textFill'] = completePaint(paints['textFill'], '#101014', assets) ?? '#101014'
  paints['containerFill'] = completePaint(paints['containerFill'], null, assets)
  paints['lineFill'] = completePaint(paints['lineFill'], null, assets)
  completeStrokePaint(paints['containerStroke'], assets)
}

/**
 * A frame that arrives missing something it needs.
 *
 * Idempotent and gap-filling only, like `completeMosaic` — which is also what
 * lets a later animatable property need no migration of its own: absent and
 * default are the same thing, and this makes them so on the way in.
 */
function completeFrame(object: Record<string, unknown>, assets: Set<string> = new Set()): void {
  if (!Array.isArray(object['members'])) object['members'] = []
  if (typeof object['clip'] !== 'boolean') object['clip'] = false
  if (typeof object['speed'] !== 'number' || !(object['speed'] > 0)) object['speed'] = 1
  if (typeof object['opacity'] !== 'number') object['opacity'] = 1

  /*
   * A frame is its states. One that arrives with fewer than two has no timeline
   * to animate, so it is given enough to be one rather than crashing whatever
   * reads `states[1]`.
   */
  const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
  const usable = states.filter((each) => each && typeof each === 'object')
  while (usable.length < 2) usable.push({ values: {} })
  usable.forEach((each, at) => {
    const state = each as Record<string, unknown>
    if (typeof state['id'] !== 'string' || !state['id']) state['id'] = `fs_recovered_${at}`
    if (!state['values'] || typeof state['values'] !== 'object') state['values'] = {}
    if (typeof state['holdMs'] !== 'number') state['holdMs'] = 0
    if (typeof state['transitionMs'] !== 'number') state['transitionMs'] = 600
    if (!EASING_PRESETS.includes(state['easing'] as never)) state['easing'] = 'ease-in-out'
    // The background a paint or nothing; a member's patched fills paints too.
    if (state['background'] !== undefined) state['background'] = completePaint(state['background'], null, assets)
  })
  object['states'] = usable

  /*
   * A state's patch holds only what the model has fields for. Anything else —
   * the derived `padding` an old build wrote, or a key from a future build — is
   * dropped, so what a state records is always something a state can say.
   */
  for (const each of usable) {
    const values = (each as Record<string, unknown>)['values'] as Record<string, unknown>
    for (const [memberId, patch] of Object.entries(values)) {
      if (!patch || typeof patch !== 'object') {
        delete values[memberId]
        continue
      }
      for (const key of Object.keys(patch as object)) {
        if (!MEMBER_VALUE_KEYS.includes(key as never)) delete (patch as Record<string, unknown>)[key]
      }
      const appearance = (patch as Record<string, unknown>)['appearance']
      if (appearance && typeof appearance === 'object') {
        const paints = appearance as Record<string, unknown>
        if ('textFill' in paints) paints['textFill'] = completePaint(paints['textFill'], '#101014', assets) ?? '#101014'
        if ('containerFill' in paints) paints['containerFill'] = completePaint(paints['containerFill'], null, assets)
        if ('lineFill' in paints) paints['lineFill'] = completePaint(paints['lineFill'], null, assets)
        if ('containerStroke' in paints) completeStrokePaint(paints['containerStroke'], assets)
      }
    }
  }
}

/** The fields a state may record about a member. */
const MEMBER_VALUE_KEYS = ['transform', 'opacity', 'appearance', 'nodes', 'typeSettings'] as const

/**
 * Drop everything a frame's states record that the member would give anyway.
 *
 * Raw JSON on both sides, so equality is structural equality of the written
 * form: numbers, strings and null compare directly, and the few nested values
 * (a border, a font, a typography block, an outline) compare serialised. That
 * is exact for anything that went through a save.
 */
function unfreezeFrame(object: Record<string, unknown>): void {
  const members = Array.isArray(object['members']) ? (object['members'] as unknown[]) : []
  const own = new Map<string, Record<string, unknown>>()
  for (const member of members) {
    if (!member || typeof member !== 'object') continue
    const m = member as Record<string, unknown>
    const id = m['id']
    const target = m['object']
    if (typeof id === 'string' && target && typeof target === 'object') {
      own.set(id, target as Record<string, unknown>)
    }
  }

  const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
  for (const state of states) {
    if (!state || typeof state !== 'object') continue
    const values = (state as Record<string, unknown>)['values']
    if (!values || typeof values !== 'object') continue
    const map = values as Record<string, unknown>
    for (const [memberId, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue
      const patch = entry as Record<string, unknown>
      const rest = own.get(memberId)
      unfreezePatch(patch, rest)
      if (Object.keys(patch).length === 0) delete map[memberId]
    }
  }
}

function unfreezePatch(patch: Record<string, unknown>, own: Record<string, unknown> | undefined): void {
  // Never a field. Written by the old merge; derived by the resolver.
  delete patch['padding']
  if (!own) return

  const same = (a: unknown, b: unknown): boolean =>
    a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b))

  if (patch['transform'] !== undefined && same(patch['transform'], own['transform'])) delete patch['transform']
  if (patch['opacity'] === 1) delete patch['opacity']
  if (patch['nodes'] !== undefined && same(patch['nodes'], own['outline'])) delete patch['nodes']

  const restingAppearance = own['appearance']
  const appearance = patch['appearance']
  if (appearance && typeof appearance === 'object') {
    if (restingAppearance && typeof restingAppearance === 'object') {
      const a = appearance as Record<string, unknown>
      const r = restingAppearance as Record<string, unknown>
      for (const key of Object.keys(a)) if (same(a[key], r[key])) delete a[key]
    }
    if (Object.keys(appearance as object).length === 0) delete patch['appearance']
  }

  const type = patch['typeSettings']
  if (type && typeof type === 'object') {
    const t = type as Record<string, unknown>
    for (const key of Object.keys(t)) if (same(t[key], own[key])) delete t[key]
    if (Object.keys(t).length === 0) delete patch['typeSettings']
  }
}

/**
 * Every mesh in a raw document — top-level, or a member of a frame, which
 * `forEachMosaic` never reached and which cost a mosaic in a frame every
 * repair. A mesh member goes through the same completion as one on the page.
 */
function forEachMesh(raw: Record<string, unknown>, fn: (o: Record<string, unknown>) => void): void {
  const objects = raw['objects']
  if (!objects || typeof objects !== 'object') return
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (object['kind'] === 'mesh') fn(object)
    if (object['kind'] === 'frame' && Array.isArray(object['members'])) {
      for (const member of object['members'] as unknown[]) {
        if (member && typeof member === 'object') visit((member as Record<string, unknown>)['object'])
      }
    }
  }
  for (const value of Object.values(objects as Record<string, unknown>)) visit(value)
}

/**
 * Everything a mesh must hold, filled in wherever it is missing — the mesh's
 * `completeMosaic`, for the same reason: a version number is not proof of
 * shape. Positions a state lacks are taken from the first state that has
 * them, so every state names every node.
 */
function completeMesh(object: Record<string, unknown>, assets: Set<string> = new Set()): void {
  if (typeof object['snapStep'] !== 'number') object['snapStep'] = MOSAIC_DEFAULT_SNAP
  if (!Array.isArray(object['nodes'])) object['nodes'] = []
  if (!Array.isArray(object['tiles'])) object['tiles'] = []
  const nodeIds = (object['nodes'] as unknown[])
    .map((node) => (node && typeof node === 'object' ? (node as Record<string, unknown>)['id'] : null))
    .filter((id): id is string => typeof id === 'string')
  const tileIds = new Set(
    (object['tiles'] as unknown[])
      .map((tile) => (tile && typeof tile === 'object' ? (tile as Record<string, unknown>)['id'] : null))
      .filter((id): id is string => typeof id === 'string'),
  )

  const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
  const usable = states.filter((each) => each && typeof each === 'object') as Record<string, unknown>[]
  if (usable.length === 0) usable.push({ nodes: {}, glyphColour: {}, tileColour: {}, background: null })

  usable.forEach((state, at) => {
    completeState(state, at, tileIds, assets)
    delete state['x']
    delete state['y']
    if (typeof state['outerPadding'] !== 'number') state['outerPadding'] = 0
    if (state['lines'] === undefined) state['lines'] = null
    const nodes = state['nodes']
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) state['nodes'] = {}
  })
  // Every state names every node: a missing position is borrowed from the
  // first state that has one, else the origin.
  for (const id of nodeIds) {
    const known = usable
      .map((state) => (state['nodes'] as Record<string, unknown>)[id])
      .find((p) => p && typeof p === 'object' && Number.isFinite((p as Vec2).x) && Number.isFinite((p as Vec2).y)) as
      | Vec2
      | undefined
    for (const state of usable) {
      const map = state['nodes'] as Record<string, unknown>
      const p = map[id]
      if (!p || typeof p !== 'object' || !Number.isFinite((p as Vec2).x) || !Number.isFinite((p as Vec2).y)) {
        map[id] = known ? { x: known.x, y: known.y } : { x: 0, y: 0 }
      }
    }
  }
  object['states'] = usable

  const seed = object['seed'] as Record<string, unknown> | undefined
  if (!seed || typeof seed !== 'object' || typeof seed['columns'] !== 'number' || typeof seed['rows'] !== 'number') {
    object['seed'] = { columns: 1, rows: 1 }
  }
  // A mesh saved before it had a choice followed its rim; it still does.
  if (object['backdrop'] !== 'box' && object['backdrop'] !== 'silhouette') object['backdrop'] = 'silhouette'
}

/** Every mosaic in a raw document, whatever shape the rest of it is in. */
function forEachMosaic(raw: Record<string, unknown>, fn: (o: Record<string, unknown>) => void): void {
  const objects = raw['objects']
  if (!objects || typeof objects !== 'object') return
  for (const value of Object.values(objects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const object = value as Record<string, unknown>
    if (object['kind'] !== 'mosaic') continue
    fn(object)
  }
}

/**
 * The grid a mosaic was made as, recovered from a file that never recorded it.
 *
 * Its BOUNDS are the good evidence. A mosaic is created `columns × rows` cells
 * of `MOSAIC_CELL`, and `localBounds` never changes afterwards — the object is
 * scaled through its transform — so the bounds still describe the original grid
 * however badly the lines inside it have been dragged about. Checked against a
 * real document of twelve reshaped mosaics, this recovered every one exactly.
 *
 * Counting the lines is the fallback, and a poor one: dragging FORKS lines, so a
 * reshaped mosaic carries coordinates its seed never had. On that same document
 * it read a 5 × 5 as 15 × 2. It is kept only for mosaics whose bounds are not a
 * whole number of cells, which nothing in the app produces today.
 */
function inferSeed(object: Record<string, unknown>): { columns: number; rows: number } {
  const bounds = object['localBounds'] as Record<string, unknown> | undefined
  const width = bounds && typeof bounds['width'] === 'number' ? bounds['width'] : Number.NaN
  const height = bounds && typeof bounds['height'] === 'number' ? bounds['height'] : Number.NaN
  const across = width / MOSAIC_CELL
  const down = height / MOSAIC_CELL
  const whole = (n: number): boolean => Number.isFinite(n) && n >= 1 && Math.abs(n - Math.round(n)) < 1e-6
  if (whole(across) && whole(down)) {
    return { columns: Math.round(across), rows: Math.round(down) }
  }

  const tiles = Array.isArray(object['tiles']) ? (object['tiles'] as MosaicRecord[]) : []
  const xs = new Set<string>()
  const ys = new Set<string>()
  for (const tile of tiles) {
    for (const key of ['left', 'right'] as const) {
      const id = tile[key]
      if (typeof id === 'string' && !isRim(id)) xs.add(id)
    }
    for (const key of ['top', 'bottom'] as const) {
      const id = tile[key]
      if (typeof id === 'string' && !isRim(id)) ys.add(id)
    }
  }
  const columns = Math.max(1, xs.size + 1)
  const lattice = Math.max(1, ys.size + 1)
  const rows =
    columns * lattice === tiles.length
      ? lattice
      : Math.max(1, Math.ceil(Math.max(1, tiles.length) / columns))
  return { columns, rows }
}

/**
 * Everything a mosaic must hold, filled in wherever it is missing.
 *
 * Run by the migrations that introduced these fields, and then once more after
 * the whole chain, because A VERSION NUMBER IS NOT PROOF OF SHAPE. A file can
 * claim the current version and still be missing a field the migration to that
 * version would have added: a tab left open across a schema change writes the
 * new number onto objects that never went through the migration, and on the next
 * load the chain is skipped entirely because the number already matches. That is
 * not hypothetical — it happened, and it left mosaics whose properties panel
 * threw the moment they were selected. Hand-edited and half-written files land
 * in the same place.
 */
function completeState(
  state: Record<string, unknown>,
  at: number,
  tiles: ReadonlySet<string>,
  assets: Set<string>,
): void {
  if (typeof state['id'] !== 'string' || !state['id']) state['id'] = `ms_recovered_${at}`
  /*
   * No border unless one was written down. Absent and null mean the same thing
   * — nobody has added one — so this only ever fills a gap, and a state that
   * already has one goes through untouched.
   *
   * `stroke` rather than `outline`: a typography object already carries an
   * `outline`, and it means something else entirely — the editable nodes a pen
   * path is made of (see migration 16). Two meanings for one word in one
   * document format is a trap.
   */
  if (state['stroke'] === undefined) state['stroke'] = null
  /*
   * Seconds became milliseconds at v22. A file that still carries the old names
   * is converted here as well as in the migration, because a value can arrive
   * from a version stamp that lied — see the note on `completeMosaic`.
   */
  if (typeof state['holdMs'] !== 'number') {
    const old = state['hold']
    state['holdMs'] = typeof old === 'number' ? Math.max(0, old * 1000) : MOSAIC_DEFAULT_HOLD_MS
  }
  if (typeof state['transitionMs'] !== 'number') {
    const old = state['transition']
    state['transitionMs'] =
      typeof old === 'number' ? Math.max(0, old * 1000) : MOSAIC_DEFAULT_TRANSITION_MS
  }
  delete state['hold']
  delete state['transition']

  if (typeof state['easing'] !== 'string' || !EASING_NAMES.has(state['easing'] as string)) {
    state['easing'] = MOSAIC_DEFAULT_EASING
  }
  for (const key of ['x', 'y', 'glyphColour', 'tileColour'] as const) {
    const map = state[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) state[key] = {}
  }

  /*
   * Colours, checked against the tiles that actually exist.
   *
   * Entries for tiles that were removed would otherwise accumulate forever, and
   * a colour string that is not a colour would reach the canvas and paint
   * nothing at all.
   *
   * A null is DROPPED rather than kept. No background is a real answer, but it
   * is the answer a missing entry already gives, and two ways of writing one
   * thing is how a state that was cleared and a state that was never coloured
   * come to hold the same picture and compare as different — which stops edits
   * carrying forward. Earlier builds wrote those nulls, so this is where
   * documents holding them are put right.
   */
  for (const [key, fallback] of [
    ['glyphColour', DEFAULT_GLYPH_COLOUR],
    ['tileColour', null],
  ] as const) {
    const map = state[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      state[key] = {}
      continue
    }
    const kept: Record<string, string | Record<string, unknown>> = {}
    for (const [leaf, value] of Object.entries(map as Record<string, unknown>)) {
      if (!tiles.has(leaf)) continue
      if (value === null) continue
      // Not a paint at all: a letter falls back to the default so it still
      // draws; a background has no default to fall back to, so it goes.
      const paint = completePaint(value, fallback, assets)
      if (paint !== null) kept[leaf] = paint
    }
    state[key] = kept
  }

  /*
   * The backdrop: one colour, or nothing at all.
   *
   * Anything that is not a colour becomes null rather than a default, for the
   * same reason a tile background does — there is no colour to fall back to that
   * anybody chose, and painting one would invent a backdrop the document never
   * described. Documents written before v26 have no field here at all, and that
   * is exactly the "no backdrop" answer.
   */
  state['background'] = completePaint(state['background'], null, assets)
  completeStrokePaint(state['stroke'], assets)
  if (state['lines']) completeStrokePaint(state['lines'], assets)

  // Font and spacing are per state from v23. A state without them is one the
  // migration never reached, which the version number alone cannot rule out.
  const font = state['font'] as Record<string, unknown> | undefined
  if (!font || typeof font !== 'object' || typeof font['fontId'] !== 'string') {
    state['font'] = { ...fallbackFont }
  }
  for (const [key, value] of Object.entries(MOSAIC_DEFAULT_SPACING)) {
    if (typeof state[key] !== 'number') state[key] = value
  }
  /*
   * Corners, which unlike spacing have a floor worth enforcing here.
   *
   * A negative radius is not a small one, it is not a shape at all — and the
   * value reaches Fabric directly. The upper end is left alone: a radius larger
   * than the tile is fitted when it is drawn, so a document that describes a
   * bigger rounding than its current tiles can show keeps it for when they grow.
   */
  /*
   * The letters, checked against the tiles that actually exist.
   *
   * Entries for removed tiles would otherwise accumulate forever, and a value
   * that is not a string would reach the outline cutter. Empty is written as an
   * ABSENT key, never as an empty string, so "nothing here" has one form — the
   * same rule the tile colours follow.
   */
  const written = state['chars']
  if (!written || typeof written !== 'object' || Array.isArray(written)) {
    state['chars'] = {}
  } else {
    const kept: Record<string, string> = {}
    for (const [leaf, value] of Object.entries(written as Record<string, unknown>)) {
      if (!tiles.has(leaf)) continue
      if (typeof value === 'string' && value !== '') kept[leaf] = value
    }
    state['chars'] = kept
  }

  for (const [key, value] of Object.entries(MOSAIC_DEFAULT_CORNERS)) {
    const held = state[key]
    state[key] = typeof held === 'number' && Number.isFinite(held) ? Math.max(0, held) : value
  }
}

/** What a state with no font of its own is given. */
let fallbackFont: Record<string, unknown> = { fontId: 'anton', weight: 400, italic: false }

/** The document's own default, once it is known — better than a guess. */
function noteFallbackFont(raw: Record<string, unknown>): void {
  const defaults = raw['defaults'] as Record<string, unknown> | undefined
  const font = defaults?.['font'] as Record<string, unknown> | undefined
  if (font && typeof font['fontId'] === 'string') fallbackFont = { ...font }
}

function completeMosaic(object: Record<string, unknown>, assets: Set<string> = new Set()): void {
  if (typeof object['snapStep'] !== 'number') object['snapStep'] = MOSAIC_DEFAULT_SNAP

  /*
   * A mosaic is its states. One that arrives with none has no geometry at all,
   * so it gets a single empty state rather than crashing the first thing that
   * reads `states[0]`; one whose states are missing timing gets the defaults.
   */
  const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
  const usable = states.filter((each) => each && typeof each === 'object')
  if (usable.length === 0) {
    usable.push({ x: {}, y: {}, glyphColour: {}, tileColour: {}, background: null })
  }
  const tileIds = new Set(
    (Array.isArray(object['tiles']) ? (object['tiles'] as MosaicRecord[]) : [])
      .map((tile) => tile['id'])
      .filter((id): id is string => typeof id === 'string'),
  )
  usable.forEach((each, at) => completeState(each as Record<string, unknown>, at, tileIds, assets))
  object['states'] = usable
  delete object['activeState']
  const seed = object['seed'] as Record<string, unknown> | undefined
  if (
    !seed ||
    typeof seed !== 'object' ||
    typeof seed['columns'] !== 'number' ||
    typeof seed['rows'] !== 'number'
  ) {
    object['seed'] = inferSeed(object)
  }
}

export const migrations: Record<number, MigrationFn> = {
  /*
   * v31 -> v32: one paint everywhere, and the gradient is a paint.
   *
   * A gradient used to be a colour EFFECT on a shape's type or body — a
   * setting beside the resting colour, resolved over it. Now it is the fill
   * itself, with its motion carried along, and every other fill in the
   * document may be one too. Each shape's gradient effect becomes the paint
   * of the part it coloured, and the effect goes back to none; the picture
   * is the same at rest and in motion. Pictures arrive with this version as
   * well, so the document gains a place to keep them.
   */
  31: (raw) => {
    if (!raw['assets'] || typeof raw['assets'] !== 'object') raw['assets'] = {}
    forEachFrame(raw, (frame) => foldMemberGradients(frame))
    forEachTypography(raw, (object) => foldGradientEffects(object))
    return raw
  },

  /*
   * v29 -> v30: a gradient is its own list of stops.
   *
   * It used to be the part's colour blending to one other, with the first
   * colour never shown as a stop. Every saved gradient becomes the two stops
   * that draw the same picture; cycle and flicker keep their one second colour.
   */
  29: (raw) => {
    forEachTypography(raw, (object) => stopsFromTwoColours(object))
    return raw
  },

  /*
   * v28 -> v29: a frame's states say only what was authored in them.
   *
   * Until this version, writing one thing into a state wrote the member's whole
   * current self into it — its colours, its shape, its type settings, and a
   * derived `padding` that is not a field at all. A state that had merely been
   * dragged an inch stopped following its member for good.
   *
   * Repaired without loss. Field by field, a recorded value that EQUALS what
   * the member would give anyway is dropped: it changes nothing on screen and
   * it was almost certainly frozen rather than chosen. A recorded value that
   * differs is kept, because this cannot tell a frozen-then-outdated value from
   * an authored one, and the authored one is the user's. Every picture is the
   * same before and after; what changes is which states follow the member from
   * now on.
   */
  28: (raw) => {
    forEachFrame(raw, (object) => unfreezeFrame(object))
    return raw
  },

  /*
   * v27 -> v28: frames exist.
   *
   * Nothing to migrate — no document written before this has one, and no
   * existing object changes shape. The version moves so that an OLDER build
   * refuses a document containing a frame outright, rather than reading it and
   * silently dropping an object the user made. That refusal is the only thing
   * this bump buys, and it is the reason bumps exist.
   */
  27: (raw) => raw,

  /*
   * v26 -> v27: things gain an edge.
   *
   * Null everywhere, so a document loads drawing exactly what it drew before —
   * a border nobody added is not a border of zero width, and the panel shows no
   * controls for one at all until it exists.
   *
   * Written for the two parts that have one today. The rest (the banner, the
   * type, a tile, a drawn line) need no migration when their turn comes: the
   * default is null, and the gap-filling pass that runs after every load is
   * idempotent, so an absent field and a null one are already the same thing.
   */
  26: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>

      const appearance = object['appearance']
      if (appearance && typeof appearance === 'object') {
        ;(appearance as Record<string, unknown>)['containerStroke'] = null
      }

      const states = object['states']
      if (!Array.isArray(states)) continue
      for (const each of states) {
        if (each && typeof each === 'object') {
          ;(each as Record<string, unknown>)['stroke'] = null
        }
      }
    }
    return raw
  },

  /*
   * Font and spacing move onto the states.
   *
   * They describe a composition as much as the lines do — a mosaic set tighter,
   * or in another face, is a different picture — so they belong with the states
   * that animate. Every state takes the object's values, which means a document
   * loads looking exactly as it did and nothing moves until one is edited.
   */
  22: (raw) => {
    forEachMosaic(raw, (object) => {
      const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
      const font = object['font']
      for (const each of states) {
        if (!each || typeof each !== 'object') continue
        const state = each as Record<string, unknown>
        if (font && typeof font === 'object' && !state['font']) {
          state['font'] = { ...(font as Record<string, unknown>) }
        }
        for (const key of ['gap', 'outerPadding', 'glyphInset'] as const) {
          if (typeof state[key] !== 'number' && typeof object[key] === 'number') {
            state[key] = object[key]
          }
        }
      }
      delete object['font']
      delete object['gap']
      delete object['outerPadding']
      delete object['glyphInset']
    })
    return raw
  },

  /*
   * The letters move from the tiles onto the states.
   *
   * A tile is a place in the partition; what is written there is part of the
   * composition, and compositions are what states hold. Every state takes the
   * letters the tiles were carrying, so a document loads saying exactly what it
   * said and nothing differs until one state is edited on its own.
   */
  24: (raw) => {
    forEachMosaic(raw, (object) => {
      const tiles = Array.isArray(object['tiles']) ? (object['tiles'] as unknown[]) : []
      const written: Record<string, string> = {}
      for (const each of tiles) {
        if (!each || typeof each !== 'object') continue
        const tile = each as Record<string, unknown>
        const id = tile['id']
        const char = tile['char']
        if (typeof id === 'string' && typeof char === 'string' && char !== '') {
          written[id] = char
        }
        delete tile['char']
      }
      const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
      for (const each of states) {
        if (!each || typeof each !== 'object') continue
        const state = each as Record<string, unknown>
        if (!state['chars']) state['chars'] = { ...written }
      }
    })
    return raw
  },

  /*
   * States gain corner radii.
   *
   * Square everywhere, which is what every existing document already looks like
   * — the migration only writes down a shape that was previously implied. New
   * fields rather than a new object-level setting, because rounding belongs to a
   * composition and animates with it, exactly as spacing and font do.
   */
  23: (raw) => {
    forEachMosaic(raw, (object) => {
      const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
      for (const each of states) {
        if (!each || typeof each !== 'object') continue
        const state = each as Record<string, unknown>
        for (const key of ['tileRadius', 'outerRadius'] as const) {
          if (typeof state[key] !== 'number') state[key] = MOSAIC_DEFAULT_CORNERS[key]
        }
      }
    })
    return raw
  },

  /*
   * State timings become milliseconds.
   *
   * They were authored in seconds and never read — nothing consumed `easing` or
   * either duration before animation existed — so this converts the numbers and
   * renames them rather than guessing at intent.
   */
  21: (raw) => {
    forEachMosaic(raw, (object) => {
      const states = Array.isArray(object['states']) ? (object['states'] as unknown[]) : []
      for (const each of states) {
        if (!each || typeof each !== 'object') continue
        const state = each as Record<string, unknown>
        if (typeof state['hold'] === 'number' && typeof state['holdMs'] !== 'number') {
          state['holdMs'] = Math.max(0, (state['hold'] as number) * 1000)
        }
        if (typeof state['transition'] === 'number' && typeof state['transitionMs'] !== 'number') {
          state['transitionMs'] = Math.max(0, (state['transition'] as number) * 1000)
        }
        delete state['hold']
        delete state['transition']
      }
      /*
       * Which state was on show is not artwork — it is where somebody's cursor
       * was standing — so it leaves the document and lives in the UI store. A
       * file that still carries it is simply relieved of it.
       */
      delete object['activeState']
    })
    return raw
  },

  /*
   * Mosaics remember the grid they were made as, so Reset has something to go
   * back to.
   *
   * Documents written before this never recorded it, so it is inferred — and
   * inference is exactly why the property exists going forward. Counting the
   * lines a mosaic holds recovers its seed only while it is still a lattice;
   * once a drag has forked a line, the count is too high and the original is
   * gone for good. So: use the lattice dimensions when the tile count confirms
   * them, and otherwise pick the smallest grid of that many columns that still
   * holds every tile, which at least loses nobody's letters on the first reset.
   */
  20: (raw) => {
    forEachMosaic(raw, (object) => {
      const seed = object['seed']
      if (!seed || typeof seed !== 'object') object['seed'] = inferSeed(object)
    })
    return raw
  },

  /*
   * Mosaics gain a snap grid.
   *
   * Existing documents get the same default a new mosaic is born with, because
   * the property only governs where a future drag comes to rest — no line moves
   * on load, and a mosaic whose lines are off the grid keeps drawing exactly as
   * it did until someone drags one.
   */
  19: (raw) => {
    forEachMosaic(raw, (object) => {
      if (typeof object['snapStep'] !== 'number') object['snapStep'] = MOSAIC_DEFAULT_SNAP
    })
    return raw
  },

  /**
   * v1 → v2: row dividers moved into patch space.
   *
   * A divider used to be `y = f(x)` in object units; it is now `v = f(u)` on
   * the unit square. The same numbers mean something entirely different, and a
   * v1 divider read as v2 would put a row wildly out of place — so the grid is
   * cleared rather than reinterpreted. The shape and its text are untouched,
   * and the automatic rows regenerate the moment the document loads.
   */
  1: (raw) => {
    const objects = raw['objects']
    if (objects && typeof objects === 'object') {
      for (const value of Object.values(objects as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          ;(value as Record<string, unknown>)['dividers'] = []
        }
      }
    }
    return raw
  },

  /**
   * v2 -> v3: animation settings replaced.
   *
   * The old shape carried a single `intensity` plus `speed`, `phaseOffset` and
   * `playing`. Nothing ever read any of them — animation was not implemented —
   * and one shared intensity cannot serve presets that each want their own
   * controls, so they are reset rather than mapped.
   */
  2: (raw) => {
    const objects = raw['objects']
    if (objects && typeof objects === 'object') {
      for (const value of Object.values(objects as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          ;(value as Record<string, unknown>)['animation'] = {
            preset: 'none',
            loopDuration: 2,
            config: {},
            animateShape: false,
          }
        }
      }
    }
    return raw
  },

  /**
   * v3 -> v4: the container got its own loop.
   *
   * `animateShape` was a yes/no that borrowed whatever the type's preset
   * happened to imply. Shapes now choose their own preset, so the flag has
   * nothing to map onto and is replaced by a preset of its own, off by default.
   */
  3: (raw) => {
    const objects = raw['objects']
    if (objects && typeof objects === 'object') {
      for (const value of Object.values(objects as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const object = value as Record<string, unknown>
        const animation = (object['animation'] ?? {}) as Record<string, unknown>
        delete animation['animateShape']
        animation['shapePreset'] = 'none'
        animation['shapeConfig'] = {}
        object['animation'] = animation
      }
    }
    return raw
  },

  /**
   * v4 -> v5: colour left the motion menus, and the shape's reach became a choice.
   *
   * `colour` and `flicker` were motion presets, so a sticker could shimmer or
   * bounce but never both, and `throb` was the same idea bolted onto the shape.
   * All three become colour EFFECTS, chosen alongside the resting colour they
   * act on. Their settings carry across unchanged — the controls kept their
   * names — so a saved flicker still blinks to the same shade on the same beat.
   */
  4: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw

    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      const animation = (object['animation'] ?? {}) as Record<string, unknown>

      const preset = animation['preset']
      const config = (animation['config'] ?? {}) as Record<string, unknown>
      if (preset === 'colour' || preset === 'flicker') {
        animation['textColour'] = {
          effect: preset === 'colour' ? 'cycle' : 'flicker',
          config,
        }
        animation['preset'] = 'none'
        animation['config'] = {}
      } else {
        animation['textColour'] = { effect: 'none', config: {} }
      }

      if (animation['shapePreset'] === 'throb') {
        animation['shapeColour'] = { effect: 'cycle', config: animation['shapeConfig'] ?? {} }
        animation['shapePreset'] = 'none'
        animation['shapeConfig'] = {}
      } else {
        animation['shapeColour'] = { effect: 'none', config: {} }
      }

      // Sweep's own row stagger became the line offset every preset now shares.
      if (typeof config['stagger'] === 'number' && preset === 'sweep') {
        const stagger = config['stagger']
        delete config['stagger']
        config['lineOffset'] = stagger
      }

      animation['shapeAffectsText'] = true
      object['animation'] = animation
    }
    return raw
  },

  /**
   * v5 -> v6: spiral text arrived with settings of its own.
   *
   * Nothing to map: every existing object is in a row-based mode, where these
   * are not read at all. They are added so the panel has something to bind to
   * the moment someone switches a shape over.
   */
  5: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      object['spiral'] = { outward: false, centreHole: 0, upright: false, baselineShift: 0 }
    }
    return raw
  },

  /*
   * v6 -> v7: ring settings.
   *
   * Nothing to map, exactly as the spiral's were: no existing object is in ring
   * mode, where these are the only things read. They are added so the panel has
   * something to bind to the moment someone switches a shape over.
   */
  6: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      object['ring'] = { side: 1, split: false, gap: 0.06, upright: false, baselineShift: 0 }
    }
    return raw
  },

  /*
   * v7 -> v8: whether letters are packed into the run or set along it.
   *
   * Each mode keeps what it already did, which is why the two defaults differ:
   * a spiral has always packed its letters and a ring has always set them. The
   * choice is now the user's in both, so the setting has to exist in both, and
   * an existing document has to come back looking exactly as it was saved.
   */
  7: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      const spiral = object['spiral']
      if (spiral && typeof spiral === 'object') {
        ;(spiral as Record<string, unknown>)['rigid'] = false
      }
      const ring = object['ring']
      if (ring && typeof ring === 'object') {
        ;(ring as Record<string, unknown>)['rigid'] = true
      }
    }
    return raw
  },

  /*
   * v8 -> v9: the banner behind run-mode type, and the line height that sets it.
   *
   * `lineHeight` 1 is the letters' own height, which is the pitch every existing
   * spiral was drawn at, so this changes nothing already on the page. The banner
   * itself is off — a fill nobody asked for should not appear under their type
   * when they open an old file.
   */
  8: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      for (const key of ['spiral', 'ring']) {
        const settings = object[key]
        if (settings && typeof settings === 'object') {
          ;(settings as Record<string, unknown>)['lineHeight'] = 1
        }
      }
      const appearance = object['appearance']
      if (appearance && typeof appearance === 'object') {
        ;(appearance as Record<string, unknown>)['lineFill'] = null
      }
    }
    return raw
  },

  /*
   * v9 -> v10: a lap and a spiral become one mode with a turn count.
   *
   * They were always the same fit — the same ink measurements, the same band
   * arithmetic, the same size search — written twice, and the two copies had
   * drifted: a spiral could not put its band outside the outline and a lap could
   * not travel the other way round, for no reason anyone had chosen.
   *
   * Both settings objects fold into one. Which mode an object was in becomes its
   * `turns`, and the settings that mode did not have take the defaults, so
   * nothing anyone has already made changes: a spiral keeps its hole and its
   * direction, a lap keeps its band position, split and gap.
   */
  9: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      const wound = object['fittingMode'] === 'spiral'
      const from = (object[wound ? 'spiral' : 'ring'] ?? {}) as Record<string, unknown>

      object['run'] = {
        turns: wound ? 'many' : 'one',
        // The settings each mode did not have, at their defaults.
        side: wound ? 1 : (from['side'] ?? 1),
        outward: wound ? (from['outward'] ?? false) : false,
        centreHole: wound ? (from['centreHole'] ?? 0) : 0,
        split: wound ? false : (from['split'] ?? false),
        gap: wound ? 0.06 : (from['gap'] ?? 0.06),
        // These two both had, and they differed by mode: a lap set its letters
        // and a spiral packed them.
        lineHeight: from['lineHeight'] ?? 1,
        rigid: from['rigid'] ?? !wound,
        upright: from['upright'] ?? false,
        baselineShift: from['baselineShift'] ?? 0,
      }
      delete object['spiral']
      delete object['ring']
      if (wound) object['fittingMode'] = 'ring'
    }
    return raw
  },

  /*
   * v11 -> v12: the size control becomes a real font size.
   *
   * It was a share of the largest that fits, which reads as a percentage of
   * something the user cannot see. A number in the object's own units says what
   * it is, and its ceiling — still the largest that fits — is a real limit
   * rather than an arbitrary 100%.
   *
   * 0 carries the old default through: as big as fits, which is what every
   * object saved at v11 had, since the control had only just appeared.
   */
  11: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const run = (value as Record<string, unknown>)['run']
      if (!run || typeof run !== 'object') continue
      const settings = run as Record<string, unknown>
      delete settings['textSize']
      settings['fontSize'] = 0
    }
    return raw
  },

  /*
   * v10 -> v11: the type size becomes a control.
   *
   * It was always derived — the size at which the words fill the run they make —
   * and 1 is that size, so nothing already drawn moves. The control only lets it
   * be taken DOWN from there.
   */
  10: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const run = (value as Record<string, unknown>)['run']
      if (run && typeof run === 'object') {
        ;(run as Record<string, unknown>)['textSize'] = 1
      }
    }
    return raw
  },

  /*
   * v12 -> v13: where a split lap breaks becomes a control.
   *
   * Nine o'clock is where it was nailed down, so every lap already drawn keeps
   * the break exactly where it has it.
   */
  12: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const run = (value as Record<string, unknown>)['run']
      if (run && typeof run === 'object') {
        ;(run as Record<string, unknown>)['splitAngle'] = 270
      }
    }
    return raw
  },

  /*
   * v13 -> v14: the banner gets a loop of its own.
   *
   * Following the type is what it did when it had no choice, so every banner
   * already drawn keeps moving exactly as it moves.
   */
  13: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const animation = (value as Record<string, unknown>)['animation']
      if (animation && typeof animation === 'object') {
        ;(animation as Record<string, unknown>)['bannerPreset'] = 'follow'
        ;(animation as Record<string, unknown>)['bannerConfig'] = {}
      }
    }
    return raw
  },

  /*
   * v14 -> v15: `line` is spelled out on the shapes that never had one.
   *
   * The field arrived with the line tool and was only ever WRITTEN on a line, so
   * every object made before it has no such key — while the type has always said
   * `LineSettings | null`. Nothing read it strictly enough to notice until
   * something did, and then it read every one of those shapes as a line.
   *
   * Filling it in is cheap and it makes the type true again, which is the point:
   * a shape of data that only nearly matches its type is a trap that goes off
   * later, at whichever call site happens to be the strict one.
   */
  14: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      if (object['line'] === undefined) object['line'] = null
    }
    return raw
  },

  /*
   * v15 -> v16: a banner no longer travels its run.
   *
   * It was offered for a while and taken away again: a banner carried away from
   * the words it belongs to leaves them standing on bare shape, which is not a
   * banner any more. Anything set to it goes back to following the type, which
   * is the default and what the control was before it had one.
   *
   * Left alone, those objects would keep travelling with no way to stop them —
   * the menu no longer has the entry that is selected.
   */
  15: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const animation = (value as Record<string, unknown>)['animation']
      if (!animation || typeof animation !== 'object') continue
      const settings = animation as Record<string, unknown>
      if (settings['bannerPreset'] === 'travel') {
        settings['bannerPreset'] = 'follow'
        settings['bannerConfig'] = {}
      }
    }
    return raw
  },

  /*
   * v16 -> v17: geometry gains a second half — the nodes you can take hold of.
   *
   * The key is written on EVERY object, even where the answer is null. Migration
   * 14 exists because `line` was left `undefined` on older documents and a
   * truthiness test read every shape as a line; writing the key means `=== null`
   * is safe here from the start.
   *
   * Nodes are derived only where the provenance is certain: an object with a
   * `line` is the one population that already had a point editor, so nothing
   * regresses. Everything else gets null — there is no way to tell a v16
   * freehand shape from a primitive, and a shape whose edges the grid rewrote is
   * a several-hundred-point polyline that would come back as a wall of markers.
   *
   * Derived from `currentSourcePath`, NOT from `line.anchors`. The anchors carry
   * no handles, so rebuilding from them would re-run the old tangent guess and
   * visibly move every line in the document the moment it loaded.
   */
  16: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      if (object['outline'] !== undefined) continue

      object['outline'] = null
      if (!object['line']) continue
      const path = object['currentSourcePath']
      if (typeof path !== 'string') continue
      try {
        object['outline'] = pathToOutline(path)
      } catch {
        // A migration that throws loses the whole document. A line that cannot
        // be read back simply stops being node-editable, which is recoverable.
      }
    }
    return raw
  },

  /*
   * v17 -> v18: objects say what KIND they are.
   *
   * The document gained a second kind — the letter mosaic — and every reader now
   * narrows on `kind` before touching anything specific to one. Written on every
   * object rather than defaulted at read time, for the reason migration 14
   * exists: a field that is merely usually present acquires a truthiness test
   * somewhere, and the one place it is absent becomes a fault nobody can
   * reproduce.
   */
  17: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw
    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      // Everything that existed before the union is typography. There was
      // nothing else for it to be.
      if (object['kind'] === undefined) object['kind'] = 'typography'
    }
    return raw
  },

  /*
   * v18 -> v19: a mosaic's partition tree becomes a set of tiles and lines.
   *
   * The tree could express every layout the tool needs but could not offer them
   * as one gesture: an edge was not a thing in it — there were fractions on
   * split nodes, and which tiles a line belonged to depended on the order the
   * cuts had been made. Lines now have identity, so dragging one is changing one
   * number and the tiles naming it are exactly the tiles that move.
   *
   * The conversion is geometric and exact. Every leaf's rectangle is computed in
   * fraction space from the tree and the state's ratios, then the distinct edge
   * positions become coordinates. Leaves that shared an edge in the tree get the
   * same coordinate, so a migrated mosaic starts fully aligned and looks
   * identical — which is the whole test: same rectangles, same ids, same
   * characters.
   */
  18: (raw) => {
    const objects = raw['objects']
    if (!objects || typeof objects !== 'object') return raw

    for (const value of Object.values(objects as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const object = value as Record<string, unknown>
      if (object['kind'] !== 'mosaic') continue
      const root = object['root']
      if (!root || typeof root !== 'object') continue

      const states = Array.isArray(object['states']) ? (object['states'] as MosaicRecord[]) : []
      // The state on show decides the geometry every state is converted against,
      // so the tiles all describe the same mosaic. With one state — every
      // document written so far — that is simply the only state there is.
      const shown = Number(object['activeState'])
      const primary = states[Number.isInteger(shown) && states[shown] ? shown : 0] ?? {}

      const converted = convertPartition(root as MosaicRecord, primary['ratios'] as RatioMap)
      if (!converted) continue

      object['tiles'] = converted.tiles
      delete object['root']
      object['states'] = states.map((state) => {
        const own = convertPartition(root as MosaicRecord, state['ratios'] as RatioMap)
        const { ratios: dropped, ...rest } = state
        void dropped
        return { ...rest, x: own?.x ?? converted.x, y: own?.y ?? converted.y }
      })
    }
    return raw
  },
}

type MosaicRecord = Record<string, unknown>
type RatioMap = Record<string, number[]> | undefined

/**
 * One partition tree, as tiles bounded by shared coordinates.
 *
 * Walks the tree in fraction space, collecting each leaf's rectangle, then mints
 * a coordinate per distinct edge position. Two leaves whose edges met in the
 * tree meet on the same number here, so they land on the same coordinate and
 * stay aligned.
 */
function convertPartition(
  root: MosaicRecord,
  ratios: RatioMap,
): { tiles: MosaicRecord[]; x: Record<string, number>; y: Record<string, number> } | null {
  interface Box {
    id: string
    char: string | null
    left: number
    right: number
    top: number
    bottom: number
  }
  const boxes: Box[] = []

  const walk = (node: MosaicRecord, left: number, top: number, right: number, bottom: number): void => {
    if (node['kind'] === 'leaf') {
      const id = typeof node['id'] === 'string' ? node['id'] : null
      if (!id) return
      const char = typeof node['char'] === 'string' ? node['char'] : null
      boxes.push({ id, char, left, top, right, bottom })
      return
    }
    const children = Array.isArray(node['children']) ? (node['children'] as MosaicRecord[]) : []
    if (children.length === 0) return

    const id = typeof node['id'] === 'string' ? node['id'] : ''
    const stored = ratios?.[id]
    const even = children.map(() => 1 / children.length)
    const shares =
      Array.isArray(stored) && stored.length === children.length
        ? normalise(stored, children.length)
        : even

    const across = node['direction'] === 'across'
    const span = across ? right - left : bottom - top
    let offset = 0
    children.forEach((child, at) => {
      // The last child takes the remainder, exactly as the old partition did, so
      // no hairline appears at the far edge.
      const size = at === children.length - 1 ? span - offset : span * (shares[at] as number)
      if (across) walk(child, left + offset, top, left + offset + size, bottom)
      else walk(child, left, top + offset, right, top + offset + size)
      offset += size
    })
  }

  walk(root, 0, 0, 1, 1)
  if (boxes.length === 0) return null

  const x: Record<string, number> = {}
  const y: Record<string, number> = {}
  let next = 0
  /** One coordinate per distinct position, so shared edges stay shared. */
  const mint = (values: Record<string, number>, at: number, axis: 'x' | 'y'): string => {
    if (Math.abs(at) < 1e-9) return axis === 'x' ? 'mx_min' : 'my_min'
    if (Math.abs(at - 1) < 1e-9) return axis === 'x' ? 'mx_max' : 'my_max'
    for (const [id, value] of Object.entries(values)) {
      if (Math.abs(value - at) < 1e-9) return id
    }
    const id = `mc_m${(next++).toString(36)}`
    values[id] = at
    return id
  }

  const tiles = boxes.map((box) => ({
    id: box.id,
    char: box.char,
    left: mint(x, box.left, 'x'),
    right: mint(x, box.right, 'x'),
    top: mint(y, box.top, 'y'),
    bottom: mint(y, box.bottom, 'y'),
  }))

  return { tiles, x, y }
}

function normalise(shares: number[], count: number): number[] {
  const safe = shares.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = safe.reduce((sum, v) => sum + v, 0)
  if (!(total > 0)) return Array.from({ length: count }, () => 1 / count)
  return safe.map((v) => v / total)
}

export function serializeDocument(doc: TextShaperDocument): string {
  return JSON.stringify(doc)
}

export interface DeserializeResult {
  ok: boolean
  doc?: TextShaperDocument
  error?: string
}

export function deserializeDocument(raw: string): DeserializeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Project file is not valid JSON.' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Project file is empty or malformed.' }
  }

  let data = parsed as Record<string, unknown>
  const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0

  // A file written by a NEWER version of the app is a hard error rather than a
  // best-effort parse: silently dropping fields we do not understand would lose
  // the user's work without telling them.
  if (version > DOCUMENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This project was made with a newer version of Text Shaper (v${version}).`,
    }
  }

  for (let v = version; v < DOCUMENT_SCHEMA_VERSION; v++) {
    const migrate = migrations[v]
    if (migrate) data = migrate(data)
  }
  data.schemaVersion = DOCUMENT_SCHEMA_VERSION

  /*
   * Once more, whatever the file claimed. The loop above runs nothing at all for
   * a document already stamped with the current version, so a file that says 21
   * but was written without a field migration 20 adds would sail straight past
   * every migration and reach the app malformed. Cheap, idempotent, and it only
   * ever fills gaps — a complete document goes through untouched.
   */
  noteFallbackFont(data)
  if (!data.assets || typeof data.assets !== 'object') data.assets = {}
  const assets = assetIdsOf(data)
  forEachMosaic(data, (object) => completeMosaic(object, assets))
  forEachMesh(data, (object) => completeMesh(object, assets))
  forEachFrame(data, (object) => completeFrame(object, assets))
  forEachTypography(data, (object) => completeTypographyPaints(object, assets))

  const validation = validateDocument(data)
  if (!validation.ok) return { ok: false, error: validation.error }

  return { ok: true, doc: data as unknown as TextShaperDocument }
}

export interface ValidationOutcome {
  ok: boolean
  error?: string
}

export function validateDocument(data: Record<string, unknown>): ValidationOutcome {
  if (typeof data.id !== 'string') return { ok: false, error: 'Missing document id.' }
  if (typeof data.name !== 'string') return { ok: false, error: 'Missing document name.' }

  const artboard = data.artboard as Record<string, unknown> | undefined
  if (!artboard || typeof artboard.width !== 'number' || typeof artboard.height !== 'number') {
    return { ok: false, error: 'Missing or invalid artboard.' }
  }

  const objects = data.objects as Record<string, unknown> | undefined
  const order = data.objectOrder
  if (!objects || typeof objects !== 'object') {
    return { ok: false, error: 'Missing objects.' }
  }
  if (!Array.isArray(order)) {
    return { ok: false, error: 'Missing object order.' }
  }

  const seen = new Set<string>()
  for (const id of order) {
    if (typeof id !== 'string') return { ok: false, error: 'Object order contains a non-string id.' }
    if (seen.has(id)) return { ok: false, error: `Duplicate id in object order: ${id}` }
    seen.add(id)
    if (!(id in objects)) return { ok: false, error: `Object order references a missing object: ${id}` }
  }
  for (const id of Object.keys(objects)) {
    if (!seen.has(id)) return { ok: false, error: `Object ${id} is missing from the object order.` }
  }

  const assets = data.assets as Record<string, unknown> | undefined
  if (!assets || typeof assets !== 'object') return { ok: false, error: 'Missing assets.' }
  for (const [id, asset] of Object.entries(assets)) {
    const a = asset as Record<string, unknown> | null
    if (
      !a ||
      typeof a !== 'object' ||
      a['id'] !== id ||
      typeof a['src'] !== 'string' ||
      !a['src'].startsWith('data:image/') ||
      typeof a['width'] !== 'number' ||
      !(a['width'] > 0) ||
      typeof a['height'] !== 'number' ||
      !(a['height'] > 0)
    ) {
      return { ok: false, error: `Asset ${id} is not a picture.` }
    }
  }

  if (!data.defaults) data.defaults = documentDefaults
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * Local storage
 * ------------------------------------------------------------------ */

export function saveToLocalStorage(doc: TextShaperDocument): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeDocument(doc))
    return true
  } catch {
    return false
  }
}

export function loadFromLocalStorage(): DeserializeResult {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { ok: false, error: 'Local storage is unavailable.' }
  }
  if (!raw) return { ok: false, error: 'No saved project.' }
  return deserializeDocument(raw)
}

export function saveAutosave(doc: TextShaperDocument): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeDocument(doc))
    return true
  } catch {
    return false
  }
}

export function loadAutosave(): DeserializeResult {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(AUTOSAVE_KEY)
  } catch {
    return { ok: false, error: 'Local storage is unavailable.' }
  }
  if (!raw) return { ok: false, error: 'Nothing autosaved.' }
  return deserializeDocument(raw)
}

/**
 * Keep the current snapshot as this session's "before" copy.
 *
 * A verbatim string copy rather than a re-serialise: the point is to preserve
 * exactly what is on disk, including a document this build may not fully
 * understand. Does nothing when there is nothing to keep.
 */
export function keepAutosaveAsPrevious(): void {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (raw) localStorage.setItem(AUTOSAVE_PREVIOUS_KEY, raw)
  } catch {
    // Storage being unavailable is not worth surfacing: the caller is about to
    // find that out for itself on the write that follows.
  }
}

export function loadPreviousAutosave(): DeserializeResult {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(AUTOSAVE_PREVIOUS_KEY)
  } catch {
    return { ok: false, error: 'Local storage is unavailable.' }
  }
  if (!raw) return { ok: false, error: 'Nothing autosaved.' }
  return deserializeDocument(raw)
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY)
    localStorage.removeItem(AUTOSAVE_PREVIOUS_KEY)
  } catch {
    // Nothing to do — storage being unavailable is not an error worth surfacing.
  }
}

export function clearLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do — storage being unavailable is not an error worth surfacing.
  }
}
