import {
  Canvas,
  FixedLayout,
  Group,
  LayoutManager,
  Path,
  Point,
  Rect as FabricRect,
  type FabricObject,
} from 'fabric'
import {
  DEFAULT_GLYPH_COLOUR,
  MOSAIC_DEFAULT_CORNERS,
  MOSAIC_DEFAULT_SPACING,
} from '../types/mosaic'
import { isFontLoaded } from '../typography/fontRegistry'
import { glyphInRect } from '../mosaic/glyph'
import { inkBoxIn, placeInk } from '../mosaic/glyphFit'
import { fittedRadius, glyphReferenceRects } from './mosaicPlayback'
import { layoutMosaic } from '../mosaic/layout'

import { paintAt, type FillPaint } from '../typography/colour'
import type { RibbonSlice } from '../typography/frame'
import type { SequenceFrame } from '../typography/objectFit'
import { decompose } from '../geometry/transform'
import type { Rect, FontSettings, Stated } from '../types/document'
import type { Mat2D } from '../types/geometry'
import type {
  DocumentObject,
  FrameObject,
  LetterMosaicObject,
  PositionedStroke,
  Stroke,
  TextShaperDocument,
  Transform2D,
  TypographyObject,
} from '../types/document'
import { isStated, opacityOf } from '../types/document'
import { buildMeshGroup, meshContentKey } from './meshRender'
import { selectionColour } from './colours'
import { emptyGround, groundFor, groundRadius } from './invitations'
import { applyPaint, boxOfChild, fabricPaint, fillOf, type FillBox } from './paintFill'
import { imageReady } from './imageCache'
import { collectAssetIds, fadedPaint, paintKey as storedPaintKey, resolvePaint } from '../typography/paint'
import type { Paint, StrokePaint } from '../types/paint'
import { memberAtState, valuesFor } from '../frame/frame'
import { mosaicClip, strokeChild, strokeRect } from './strokePaint'
import { dashArrayFor, strokePaint } from '../geometry/stroke'
import {  } from '../geometry/outline'
import { PATCH_SAMPLES_DRAFT, frameAt, pourThrough } from '../typography/objectFit'
import type { FitOutcome } from '../typography/fit'

/**
 * One-way reconciler: store objects -> Fabric objects.
 *
 * Fabric is a VIEW, never a model. Geometry and typography are computed by the
 * pure engines and arrive here as SVG path strings; this module's only job is
 * to make the canvas match the document.
 *
 * It diffs rather than rebuilding, so editing one shape does not recreate every
 * object on the canvas.
 */

/**
 * Whether every letter stays on the piece of banner that was cut for it.
 *
 * The question the ribbon rests on. A ribbon is drawn as banner, words, banner,
 * words along the run so that where the run crosses itself the later pass covers
 * the earlier — which is what a strip of material does. The slices are cut at
 * the letters' RESTING positions, so the whole arrangement assumes the band
 * under a letter is that letter's own band.
 *
 * Two things break it, and they are the same thing from opposite ends:
 *
 * - a banner with a loop of its own slides out from under the words;
 * - TRAVEL carries the words along the run and out from over their banner.
 *
 * Either way a slice drawn later paints its background across letters that are
 * no longer standing on it, and a travelling sentence disappears a slice at a
 * time until only the last one is left. So a run whose words and banner can move
 * apart is drawn as one banner beneath all the words — a background never covers
 * what stands on it — and gives up self-occlusion of the words in that case,
 * which is the right thing to trade.
 */
export function wordsRideTheirBanner(object: TypographyObject): boolean {
  const banner = object.animation.bannerPreset ?? 'follow'
  return banner === 'follow' && object.animation.preset !== 'travel'
}

export interface RenderedObject {
  group: Group
  /**
   * Every window of a stated object drawn as a row, `windows[0]` being `group`.
   *
   * Present only while the object is spread. The registry is what knows how
   * many pictures of an object are on the canvas; nothing scans the canvas to
   * find out, and only the first carries the object's `shapeId`.
   */
  windows?: Group[]
  /**
   * Everything about the object that changes what is DRAWN, as one string.
   *
   * Compared on every document change to decide whether the group has to be
   * rebuilt. Anything not in here — the transform, most obviously — is applied
   * to the existing group instead, which is what keeps a drag from rebuilding
   * sixty groups a second.
   */
  contentKey: string
}

/**
 * A described fill into a Fabric paint.
 *
 * `percentage` units rather than pixels: the coordinates then span the object's
 * own bounding box, which is exactly what `gradientEnds` describes and what the
 * GIF encoder measures against. Pixel units would need the path's offset, which
 * the animation loop deliberately leaves stale as it swaps path data in place.
 */
export { fabricPaint } from './paintFill'

/**
 * The artwork's fills AT REST.
 *
 * A gradient is an appearance as much as an animation, so it shows on the
 * canvas without having to open a tab and watch it move.
 */
export function restingPaints(object: TypographyObject): {
  text: FillPaint
  container: FillPaint | null
  /** The banner behind the type. Solid: it has no effect of its own yet. */
  line: FillPaint | null
} {
  return {
    text: paintAt(object.animation.textColour, 0, object.appearance.textFill),
    container: object.appearance.containerFill
      ? paintAt(object.animation.shapeColour, 0, object.appearance.containerFill)
      : null,
    line: resolvePaint(object.appearance.lineFill, 0),
  }
}

/** A paint's identity, for deciding whether the canvas needs rebuilding. */
function paintKey(paint: FillPaint | null): string {
  if (!paint) return 'none'
  if (paint.kind === 'solid') return paint.colour
  if (paint.kind === 'image') {
    // Whether the picture has ARRIVED, not just which one it is — a group built
    // while it was still decoding has to be built again once it can draw.
    return `image:${paint.asset}:${imageReady(paint.asset) ? 'ready' : 'pending'}@${round(paint.crop.scale)},${round(paint.crop.x)},${round(paint.crop.y)}/${round(paint.opacity)}`
  }
  const blend = paint.stops.map((stop) => `${round(stop.at)}:${stop.colour}`).join('>')
  return paint.shape === 'radial'
    ? `radial:${blend}@${round(paint.centre.x)},${round(paint.centre.y)}/${round(paint.radius)}`
    : `linear:${blend}@${round(paint.angle)}/${round(paint.offset)}/${round(paint.spread)}`
}

/** Enough places that a slow drift still reads as a change worth redrawing. */
const round = (value: number): number => Math.round(value * 1000) / 1000

const SHAPE_PLACEHOLDER_STROKE = 'rgba(17, 19, 24, 0.28)'

/**
 * The canvas is endless: there is no artboard rectangle, so nothing can be
 * drawn "off the page" and no shape is ever clipped. The document's artboard
 * colour becomes the colour of the whole surface, and it is still carried in the
 * model because export will need explicit bounds later.
 */
export function applyCanvasBackground(canvas: Canvas, doc: TextShaperDocument): void {
  canvas.backgroundColor = doc.artboard.background
  canvas.requestRenderAll()
}

/** Every group drawn for an object: its windows while spread, else the one. */
export function windowsOf(entry: RenderedObject): Group[] {
  return entry.windows ?? [entry.group]
}

/** Take everything drawn for an object off the canvas. */
function removeRendered(canvas: Canvas, entry: RenderedObject): void {
  for (const group of windowsOf(entry)) canvas.remove(group)
}

/** Bounding box of everything on the canvas, for zoom-to-fit. */
export function contentBounds(
  rendered: Map<string, RenderedObject>,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  // Every window of a spread frame, not only its first — otherwise "fit"
  // frames one state of a row that is four states wide.
  for (const entry of rendered.values()) {
    for (const group of windowsOf(entry)) {
      if (!group.visible) continue
      const b = group.getBoundingRect()
      minX = Math.min(minX, b.left)
      minY = Math.min(minY, b.top)
      maxX = Math.max(maxX, b.left + b.width)
      maxY = Math.max(maxY, b.top + b.height)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Build the Fabric representation of one typography object.
 *
 * The container outline and the glyph paths are separate children of one group
 * so that a single Fabric object carries the whole thing — one selection, one
 * transform, and z-order that matches the document exactly.
 *
 * Both children are supplied UP FRONT and never added or removed afterwards.
 * Fabric's group layout manager re-positions every child when the membership
 * changes, so adding the glyph path to an existing group threw the container
 * and the text hundreds of units apart and inflated the group's bounds well
 * past the shape. Changing the text rebuilds the group instead.
 */
function buildGroup(
  object: TypographyObject,
  textPath: string,
  bandPath: string,
  ribbon: readonly RibbonSlice[],
): Group {
  const children: FabricObject[] = []
  const hasText = textPath.length > 0

  // The container is always drawn. Hiding it once text arrived made the shape
  // vanish the moment you typed, which left nothing to judge the fit against.
  // Setting the container colour to null is how you ask for the typography
  // alone; an outline still marks the boundary so the shape stays editable.
  const paints = restingPaints(object)
  const fill = paints.container
  /*
   * The placeholder hairline marks a shape with NOTHING to see.
   *
   * It used to key off the fill alone, which was right when a fill was the only
   * paint a shape had. Now a border is one too — so a bordered shape with no
   * fill draws its border and nothing else, rather than a hairline sitting
   * underneath it saying the same thing twice.
   */
  const border = object.appearance.containerStroke
  const bare = fill === null && border === null
  const container = new Path(object.currentSourcePath, {
    fill: 'transparent',
    stroke: bare ? SHAPE_PLACEHOLDER_STROKE : undefined,
    strokeWidth: bare ? 1 : 0,
    // A UI hint, so it stays one pixel at any zoom. The real border does the
    // opposite and scales with the object — see `strokePaint.ts`.
    strokeUniform: true,
    objectCaching: false,
  })
  // `nonzero` is what keeps counters and holes open.
  container.fillRule = 'nonzero'
  container.set('role', 'container')
  applyPaint(container, fill, boxOfChild(container))
  children.push(container)

  /*
   * The border, straight after the fill it belongs to and BELOW the banner and
   * the words.
   *
   * A border is part of the container, not something laid over the artwork —
   * drawn last it would slice through any letter that reaches the edge, which
   * is exactly where letters end up in a shape they have been fitted to.
   */
  if (border && border.width > 0) children.push(strokeChild(object.currentSourcePath, border))

  /*
   * The banner and the words, laid down along the run.
   *
   * In SLICES when there are any, alternating banner and words in the order the
   * run travels — so where a run crosses itself the later pass covers the
   * earlier one, words and all, and it reads as one strip of material rather
   * than two flat layers. Where nothing overlaps the order makes no difference
   * and the drawing is the same either way.
   *
   * `nonzero` is what leaves the middle of a lap open: the band is an outer loop
   * with the inner one reversed, and `evenodd` would punch holes wherever a
   * spiral's turns overlap.
   */
  const inked = paints.line
  /*
   * Slices only while the banner and the words are ONE PIECE.
   *
   * The ribbon is drawn as banner, words, banner, words along the run, so that
   * where the run crosses itself the later pass covers the earlier — which is
   * what a strip of material does. That ordering assumes the banner under a
   * letter is the letter's own banner. Give the banner a loop of its own and it
   * stops being true: the banner slides out from under the words, and a slice
   * drawn later paints its background over letters that are no longer on it.
   *
   * So a banner moving in its own right is drawn as one layer beneath all the
   * words, which is the rule the whole thing is for — a banner is a background,
   * and a background never covers what stands on it. The cost is that the words
   * of a self-crossing run no longer occlude each other in that one case, and
   * that is the right thing to give up.
   */
  if (inked && ribbon.length > 0 && wordsRideTheirBanner(object)) {
    for (const slice of ribbon) {
      if (slice.band.length > 0) {
        const band = new Path(slice.band, {
          strokeWidth: 0,
          objectCaching: false,
        })
        band.fillRule = 'nonzero'
        band.set('role', 'band')
        applyPaint(band, inked, boxOfChild(band))
        children.push(band)
      }
      if (slice.text.length > 0) {
        const words = new Path(slice.text, {
          strokeWidth: 0,
          objectCaching: false,
        })
        words.fillRule = 'nonzero'
        words.set('role', 'text')
        applyPaint(words, paints.text, boxOfChild(words))
        children.push(words)
      }
    }
    const centre = combinedCentre(children)
    return finishGroup(object, children, centre)
  }

  if (bandPath.length > 0 && inked) {
    const band = new Path(bandPath, {
      strokeWidth: 0,
      objectCaching: false,
    })
    band.fillRule = 'nonzero'
    band.set('role', 'band')
    applyPaint(band, inked, boxOfChild(band))
    children.push(band)
  }

  if (hasText) {
    const glyphs = new Path(textPath, {
      strokeWidth: 0,
      objectCaching: false,
    })
    glyphs.fillRule = 'nonzero'
    glyphs.set('role', 'text')
    applyPaint(glyphs, paints.text, boxOfChild(glyphs))
    children.push(glyphs)
  }

  // Measure the children's combined bounds BEFORE grouping. A freshly
  // constructed Fabric Path reports left/top as its own bounding-box centre in
  // the path's own coordinates, which is exactly the local space the document
  // stores. Grouping rewrites those values to be relative to the group, so the
  // measurement has to happen first.
  return finishGroup(object, children, combinedCentre(children))
}

/** Gather the children into a positioned group. */
export function finishGroup(
  object: DocumentObject,
  children: FabricObject[],
  centre: { x: number; y: number },
): Group {
  const group = new Group(children, {
    originX: 'center',
    originY: 'center',
    scaleX: object.transform.scaleX,
    scaleY: object.transform.scaleY,
    angle: object.transform.rotation,
    flipX: object.transform.flipX,
    flipY: object.transform.flipY,
    opacity: opacityOf(object),
    visible: object.visible,
    selectable: !object.locked,
    evented: !object.locked,
    subTargetCheck: false,
    objectCaching: false,
    /*
     * The selection frame and its handles.
     *
     * Never set before, so every object wore Fabric's default pale lilac — which
     * is why selection read as faint next to everything else in the app. White
     * handles with a blue edge stay legible over artwork of any colour, which a
     * solid fill of either one does not.
     */
    borderColor: selectionColour(),
    cornerColor: '#ffffff',
    cornerStrokeColor: selectionColour(),
    cornerSize: 8,
    transparentCorners: false,
  })

  group.set('shapeId', object.id)
  group.set('localCentre', centre)
  positionGroup(group, object)
  return group
}

/** Centre of the combined bounding box of paths still in local coordinates. */
function combinedCentre(children: readonly FabricObject[]): { x: number; y: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const child of children) {
    /*
     * The SCALED size, not the raw one.
     *
     * A mosaic's glyphs carry a scale: each outline is built for the largest
     * rectangle its tile reaches across every state and then scaled down to the
     * state on show, which is what lets playback move them with a transform
     * instead of rewriting paths. Measuring `width` alone counts every one of
     * them at its largest, so the moment two states differed the group's centre
     * jumped — taking the whole mosaic with it, sliding the glyphs off the tile
     * outlines, and leaving the clickable area somewhere the mosaic no longer
     * was.
     */
    const width = child.width * (child.scaleX ?? 1)
    const height = child.height * (child.scaleY ?? 1)
    minX = Math.min(minX, child.left - width / 2)
    maxX = Math.max(maxX, child.left + width / 2)
    minY = Math.min(minY, child.top - height / 2)
    maxY = Math.max(maxY, child.top + height / 2)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0 }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * Place a group so the object's LOCAL ORIGIN lands on its stored transform.
 *
 * `group.left/top` addresses the centre of the children's combined bounds,
 * while the document positions objects by their local origin. Without this
 * correction an object shifts on screen whenever its text changes the combined
 * bounds — it would visibly jump as you type.
 */
function positionGroup(group: Group, object: DocumentObject): void {
  const centre = (group.get('localCentre') as { x: number; y: number } | undefined) ?? {
    x: 0,
    y: 0,
  }
  group.set(placementFor(centre, object.transform))
  group.setCoords()
}

/**
 * Where a group's `left`/`top` go for an object at this transform.
 *
 * A group is built `originX: 'center'` from children in the object's local
 * space, so Fabric's fit-content layout lands its origin on the ARTWORK's
 * centre — `localCentre` — which is the object's own origin only for artwork
 * that happens to be centred on it. This carries that offset through the
 * object's rotation and scale, and it is the ONLY place that formula lives:
 * the static renderer and the playback loop both go through it, having once
 * had their own copies that quietly disagreed.
 */
function placementFor(
  centre: { x: number; y: number },
  t: Transform2D,
): { left: number; top: number } {
  const rad = (t.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = t.scaleX * (t.flipX ? -1 : 1)
  const sy = t.scaleY * (t.flipY ? -1 : 1)
  const dx = centre.x * sx
  const dy = centre.y * sy
  return { left: t.x + (dx * cos - dy * sin), top: t.y + (dx * sin + dy * cos) }
}

/**
 * Place one member inside its frame's group, mid-playback.
 *
 * The same placement as a static build, shifted into the group's own plane.
 * Fabric re-bases a child's coordinates onto the group's centre when it lays
 * itself out, so what a top-level object would call `left` is `left` minus the
 * frame's `localCentre` once the child is inside — and a playback loop that set
 * the raw transform made every member jump by its own artwork offset the moment
 * Play was pressed, then snap back when it stopped.
 */
export function placeMemberChild(child: FabricObject, transform: Transform2D): void {
  const own = (child.get('localCentre') as { x: number; y: number } | undefined) ?? { x: 0, y: 0 }
  const built = child.get('builtAt') as Transform2D | undefined
  const anchor = child.get('placedAt') as { left: number; top: number } | undefined

  if (built && anchor) {
    // A DELTA from where Fabric actually put it, both ends through the same
    // formula, so the group's own layout basis cancels out exactly.
    const was = placementFor(own, built)
    const now = placementFor(own, transform)
    child.set({ left: anchor.left + (now.left - was.left), top: anchor.top + (now.top - was.top) })
  }

  child.set({
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    angle: transform.rotation,
    flipX: transform.flipX,
    flipY: transform.flipY,
  })
  child.setCoords()
}

/**
 * Draw one frame onto a group's children, in place.
 *
 * The one road from a frame to the canvas, and the reason it is one is that
 * stopping a loop has to put the artwork back EXACTLY. That was done by hand
 * before — the text child and the container, because those were the two anyone
 * was thinking about — so a banner, and every slice of a sliced ribbon but the
 * first, stayed wherever the loop happened to stop. Drawing the still frame
 * through the same function that drew the moving ones cannot go out of step.
 *
 * In place rather than by rebuilding the group: a rebuild would drop Fabric's
 * selection and its controls sixty times a second.
 */
export function paintFrame(
  group: Group,
  frame: SequenceFrame,
  /** The container's resting outline, for the frames that leave it alone. */
  rest: { path: Path['path']; fill: Path['fill'] } | null,
): void {
  const children = group.getObjects().filter((child): child is Path => child instanceof Path)
  const container = children.find((child) => child.get('role') === 'container')

  /*
   * Every banner and word child, paired in the order they were laid down.
   *
   * A ribbon is drawn as slices — banner, words, banner, words — so that a run
   * crossing itself covers what it passes over. Updating only the first of each
   * would freeze all the rest the moment the loop started.
   */
  const slices: { band: Path; text: Path }[] = []
  let pending: Path | null = null
  for (const child of children) {
    const role = child.get('role')
    if (role === 'band') pending = child
    else if (role === 'text' && pending) {
      slices.push({ band: pending, text: child })
      pending = null
    }
  }

  if (slices.length > 1 && frame.ribbon.length === slices.length && frame.bandFill) {
    for (let i = 0; i < slices.length; i++) {
      const pair = slices[i] as { band: Path; text: Path }
      const next = frame.ribbon[i] as SequenceFrame['ribbon'][number]
      pair.band.set({ path: new Path(next.band).path })
      applyPaint(pair.band, frame.bandFill, boxOfChild(pair.band))
      pair.band.setCoords()
      pair.text.set({ path: new Path(next.text).path })
      applyPaint(pair.text, frame.textFill, boxOfChild(pair.text))
      pair.text.setCoords()
    }
  } else {
    const text = children.find((child) => child.get('role') === 'text')
    if (text) {
      text.set({ path: new Path(frame.path).path })
      applyPaint(text, frame.textFill, boxOfChild(text))
      text.setCoords()
    }
    const band = children.find((child) => child.get('role') === 'band')
    if (band && frame.bandPath && frame.bandFill) {
      band.set({ path: new Path(frame.bandPath).path })
      applyPaint(band, frame.bandFill, boxOfChild(band))
      band.setCoords()
    }
  }

  // The container's own preset, if it has one. This is the same outline the type
  // was just drawn through, so the two cannot drift apart.
  if (container && rest) {
    container.set({ path: frame.shapePath ? new Path(frame.shapePath).path : rest.path })
    if (frame.shapeFill) applyPaint(container, frame.shapeFill, boxOfChild(container))
    else container.set({ fill: rest.fill, opacity: 1 })
    container.setCoords()
  }
}

export interface SyncInput {
  canvas: Canvas
  doc: TextShaperDocument
  /** Rendered glyph path per object id, produced by the typography engine. */
  textPaths: Record<string, string>
  /** The banner behind the type, per object id. Empty where there is none. */
  bandPaths: Record<string, string>
  /** The banner and words in slices, per object id, in the order they are laid down. */
  ribbons: Record<string, RibbonSlice[]>
  /**
   * Which state of each mosaic is being looked at, by object id.
   *
   * Passed in rather than read off the object, because it is not the artwork —
   * it lives in `uiStore`. That does make the renderer a function of the
   * document AND of where the cursor is standing, which is the honest shape: two
   * people looking at different states of the same mosaic are looking at the
   * same document.
   */
  mosaicStates?: Record<string, number>
  /**
   * The frame being worked INSIDE, if any.
   *
   * Like `mosaicStates`, this is where the cursor is standing rather than what
   * the document says — and the frame is BUILT differently for it: inside, its
   * members are real selectable objects with Fabric's own controls; outside,
   * the frame is one object and a press anywhere on it presses the frame.
   */
  insideFrame?: string | null
  /**
   * The object with states laid out as a ROW, one window per state, if any —
   * a mosaic or a frame.
   *
   * A view, like `insideFrame`: the document never learns about it. While
   * spread the first window is pinned to state 1 whatever is on show, so
   * pressing in window 3 — which makes state 3 the shown one — does not
   * re-order the row under the hand doing it.
   */
  spread?: string | null
  /**
   * The object the plate stands under — the frame being worked inside, else
   * the selected object with states — if any.
   *
   * A view again. It changes one thing about how an EMPTY object is drawn:
   * its light ground is left out, because the plate is that ground while it
   * is there (`groundFor`).
   */
  held?: string | null
  rendered: Map<string, RenderedObject>
}

/**
 * Reconcile the canvas with the document.
 *
 * Returns the updated render cache. Objects whose geometry, text, and
 * appearance are unchanged are left completely untouched.
 */
/**
 * What a typography object looks like, as one string.
 *
 * The solved paths carry most of it — they already encode the text, the fit and
 * the geometry — so what has to be added is the PAINT, and it is keyed by the
 * described paint rather than the raw colour because a gradient changes what is
 * drawn without any colour changing at all.
 */
/**
 * One border, as a string, for the content keys.
 *
 * Every field that changes the drawing, because a border's width and position
 * decide how the group is BUILT — whether a child is added at all, and whether
 * a clip is attached to it — so a cheaper "is there one" flag would leave the
 * canvas showing yesterday's border.
 */
function strokeKey(stroke: Stroke | PositionedStroke | null): string {
  if (!stroke) return 'none'
  const dash = stroke.dash ? `${stroke.dash.length}/${stroke.dash.gap}` : 'solid'
  const position = 'position' in stroke ? stroke.position : 'in'
  return `${storedPaintKey(stroke.colour)}:${stroke.width}:${position}:${dash}`
}

function typographyContentKey(
  object: TypographyObject,
  textPath: string,
  bandPath: string,
): string {
  const paints = restingPaints(object)
  return [
    object.geometryRevision,
    textPath,
    bandPath,
    paintKey(paints.text),
    object.appearance.containerFill === null ? 'none' : paintKey(paints.container),
    paintKey(paints.line),
    /*
     * The border, in full.
     *
     * Its width and position decide how the group is BUILT — a border child is
     * added or not, and its clip is attached or not — so this cannot be a
     * cheaper "is there one" flag. Every field that changes the drawing goes in.
     */
    strokeKey(object.appearance.containerStroke),
    // Giving the banner a loop of its own changes how the group is BUILT rather
    // than only what is drawn into it.
    wordsRideTheirBanner(object),
  ].join('|')
}

/** The same question for a mosaic: everything the tiles and glyphs are drawn from. */
function mosaicContentKey(object: LetterMosaicObject, at: number): string {
  const state = object.states[at] ?? object.states[0]
  return [
    // Which state is shown, so picking a different one rebuilds the group. The
    // values below would catch it for states that differ — but three identical
    // states are exactly what a new mosaic has, and switching between those must
    // still move the caret and the handles onto the state being edited.
    at,
    /*
     * Whether the font has ARRIVED, not just which one it is.
     *
     * The renderer runs before any font has loaded — every page load does — and
     * a glyph cannot be drawn without one, so the group built during that wait
     * has tiles and no letters. Left out of this key, that group was never
     * rebuilt once the font landed: a mosaic came back from a reload empty and
     * only reappeared when something was typed into it, because typing was the
     * first thing that changed the key.
     *
     * `fitKey` carries the same flag for the same reason, and its comment says
     * so. This is that lesson a second time, one object type later.
     */
    /*
     * Whether every font the mosaic uses has arrived — not just the shown one.
     *
     * Outlines are cut for all of them up front, so a second font landing after
     * the group was built has to rebuild it, exactly as the first one does.
     */
    object.states.map((each) => (isFontLoaded(each.font.fontId) ? '1' : '0')).join(''),
    // And WHICH fonts they are, so changing one in a state nobody is looking at
    // still cuts the outlines that state will need.
    object.states.map((each) => fontKey(each.font)).join(','),
    /*
     * And what every state WRITES, for the same reason: the outlines are cut for
     * all of them up front, so a letter appearing in a state nobody is looking
     * at still has to be cut before the animation reaches it.
     */
    object.states.map((each) => JSON.stringify(each.chars)).join(','),
    // Which tiles exist and what is in them — the tiles carry no numbers, so
    // this is cheap.
    JSON.stringify(object.tiles),
    state?.font.fontId,
    state?.font.weight,
    state?.font.italic,
    state?.gap,
    state?.outerPadding,
    state?.glyphInset,
    /*
     * The radii, which are paint-only and so cost a rebuild they do not need.
     *
     * They are here because the static path has no separate repaint step: a
     * mosaic that is not animating is only ever redrawn by being rebuilt, so a
     * radius left out of this key would not appear until something else changed.
     * The alternative — a repaint pass just for two numbers — is more machinery
     * than the saving is worth, and dragging a radius is not a hot path.
     */
    state?.tileRadius,
    state?.outerRadius,
    /*
     * The border, for the same reason the radii are here: on the static path a
     * mosaic is only redrawn by being rebuilt, so a border adjusted while
     * nothing is animating would not appear until something else changed it.
     */
    strokeKey(state?.stroke ?? null),
    // The bounds are geometry a mosaic actually draws from, unlike a shape's.
    object.localBounds.width,
    object.localBounds.height,
    object.opacity,
    state?.background ?? 'none',
    JSON.stringify(state?.x ?? {}),
    JSON.stringify(state?.y ?? {}),
    /*
     * And every OTHER state's geometry, which used to be left out on the
     * grounds that it changed nothing until one was picked. That stopped being
     * true when glyphs began to be built for the largest rectangle their tile
     * reaches ACROSS ALL STATES: editing state 2 changes how state 1 has to be
     * drawn. Left out, the group kept the outlines it was built with and only
     * picked up the new ones at the next unrelated rebuild — so the mosaic
     * appeared to jump in the middle of a later drag.
     */
    JSON.stringify(object.states.map((each) => [each.x, each.y])),
    JSON.stringify(state?.glyphColour ?? {}),
    JSON.stringify(state?.tileColour ?? {}),
    state?.background ?? '',
  ].join('|')
}

/** The colour a tile's glyph is drawn in when the state does not name one. */


/**
 * A mosaic as a group of tiles.
 *
 * Every leaf gets a background when its state names a colour, and only the
 * leaves that hold a character get a glyph. An empty tile is a real tile — it
 * takes its share of the mosaic and it is where the caret goes — so it must not
 * be skipped just because there is nothing to draw inside it.
 *
 * Children are built in the mosaic's own local coordinates, so `positionGroup`
 * and `localCentre` place the group exactly as they do for a shape.
 */
function buildMosaicGroup(
  object: LetterMosaicObject,
  at: number,
  ground: string | null = emptyGround(object),
): Group {
  const state = object.states[at] ?? object.states[0]
  const references = glyphReferenceRects(object)
  const tiles = layoutMosaic(object.tiles, state?.x ?? {}, state?.y ?? {}, object.localBounds, {
    gap: state?.gap ?? MOSAIC_DEFAULT_SPACING.gap,
    outerPadding: state?.outerPadding ?? MOSAIC_DEFAULT_SPACING.outerPadding,
    glyphInset: state?.glyphInset ?? MOSAIC_DEFAULT_SPACING.glyphInset,
  })
  const corners = {
    tileRadius: state?.tileRadius ?? MOSAIC_DEFAULT_CORNERS.tileRadius,
    outerRadius: state?.outerRadius ?? MOSAIC_DEFAULT_CORNERS.outerRadius,
  }

  // Every distinct font across the states, deduplicated — usually exactly one.
  const fonts = new Map<string, FontSettings>()
  for (const each of object.states) fonts.set(fontKey(each.font), each.font)
  if (state) fonts.set(fontKey(state.font), state.font)

  const children: FabricObject[] = []

  for (const leaf of object.tiles) {
    const tile = tiles.get(leaf.id)
    if (!tile) continue

    /*
     * A background for EVERY tile, including the ones with no colour.
     *
     * Built only for coloured tiles, a tile that is bare in the state on show has
     * no object at all — so it can never fade in, and arriving at a coloured
     * state would mean rebuilding the group in the middle of the transition.
     * Bare tiles get an invisible rectangle instead, ready to take a colour.
     *
     * Nothing here can disturb the group: children are never hit-tested
     * individually (`subTargetCheck` is false), and a visible rectangle always
     * sits inside the `extent` child, so it cannot pull `combinedCentre` off the
     * mosaic's own box.
     */
    const background = state?.tileColour[leaf.id] ?? null
    const tileRadius = fittedRadius(
      corners.tileRadius,
      tile.visible.width,
      tile.visible.height,
    )
    const rect = new FabricRect({
      left: tile.visible.x + tile.visible.width / 2,
      top: tile.visible.y + tile.visible.height / 2,
      width: Math.max(0, tile.visible.width),
      height: Math.max(0, tile.visible.height),
      rx: tileRadius,
      ry: tileRadius,
      originX: 'center',
      originY: 'center',
      // `transparent` rather than a fully faded colour: there is no colour here
      // to fade, and inventing one would be a value nobody authored.
      fill: fillOf(background, 'transparent', { size: tile.visible }),
      opacity: imageOpacity(background),
      strokeWidth: 0,
      objectCaching: false,
      evented: false,
    })
    rect.set('role', 'tile')
    rect.set('leafId', leaf.id)
    children.push(rect)

    /*
     * Every LETTER this tile shows, across every state, in every font.
     *
     * The same argument as the fonts, one level further out: a letter cannot be
     * interpolated either, so a change of writing is a cut — and a cut means a
     * different outline, which is the one thing a frame may not compute. So each
     * (letter, font) this tile ever needs is cut once here, and the frame only
     * chooses between them.
     *
     * Usually one letter and one font, and this costs exactly what it did
     * before. A tile that says something different in each of six states carries
     * six outlines and shows one.
     */
    const written = new Set<string>()
    for (const state of object.states) {
      const char = state.chars[leaf.id]
      if (char) written.add(char)
    }
    if (written.size === 0) continue
    /*
     * Built for the LARGEST rectangle this tile reaches across every state, then
     * scaled down to the one being shown.
     *
     * `glyphInRect` picks its draw size from the rectangle it fills, so the
     * residual scale is never above 1 and the serialiser's three decimals can
     * only be shrunk. Building at the widest rectangle keeps that true for every
     * frame of an animation as well — a tile's width is linear in its
     * coordinates, so no blend of two states is wider than the wider of them —
     * which is what lets playback move a glyph with a transform instead of
     * writing a new path sixty times a second. See `mosaicPlayback.ts`.
     */
    const reference = references.get(leaf.id) ?? tile.glyph
    if (!(reference.width > 0) || !(reference.height > 0)) continue

    /*
     * One outline per FONT the mosaic uses, not one per tile.
     *
     * A font is the one part of a state that cannot be interpolated, so it is a
     * cut taken on arrival — and a cut means different outlines, which is the
     * one thing a frame is not allowed to compute: writing a path per frame is
     * exactly what this whole path exists to avoid.
     *
     * So every font is cut once, here, and a frame only chooses which of them is
     * visible. Almost always there is just one and this costs nothing; a mosaic
     * animating between two typefaces carries two sets and shows one.
     */
    const shownKey = state ? `${state.chars[leaf.id] ?? ''}|${fontKey(state.font)}` : ''
    for (const char of written) {
      for (const font of fonts.values()) {
        const data = glyphInRect(font.fontId, char, reference)
        if (!data) continue
        const key = `${char}|${fontKey(font)}`
        /*
         * Where this character's ink sits inside the reference rectangle, which
         * is the whole of it for a letter and less for a mark. Fabric places a
         * path by its BOUNDING BOX, so a glyph that no longer fills the
         * rectangle cannot simply be centred on the tile — a full stop would be
         * hauled off its baseline into the middle. Carried on the child so the
         * frame painter can place it the same way without measuring again.
         */
        const box = inkBoxIn(font.fontId, char, reference)
        const placed = placeInk(box, reference, tile.glyph)
        const glyph = new Path(data, {
          fill: fillOf(state?.glyphColour[leaf.id] ?? DEFAULT_GLYPH_COLOUR, 'transparent', glyphBox(reference, box)),
          opacity: imageOpacity(state?.glyphColour[leaf.id]),
          strokeWidth: 0,
          objectCaching: false,
          originX: 'center',
          originY: 'center',
          left: placed.x,
          top: placed.y,
          scaleX: tile.glyph.width / reference.width,
          scaleY: tile.glyph.height / reference.height,
          visible: key === shownKey,
        })
        glyph.fillRule = 'nonzero'
        glyph.set('role', 'glyph')
        glyph.set('leafId', leaf.id)
        glyph.set('glyphKey', key)
        glyph.set('inkBox', box)
        children.push(glyph)
      }
    }
  }

  /*
   * The mosaic's own box, always — and the backdrop, when there is one.
   *
   * Without it the group's bounds would be the bounds of whatever happens to be
   * inked — so a mosaic whose letters have not arrived yet would have no size at
   * all, and one whose outer tiles are empty would be smaller than the mosaic
   * is. The composition occupies its rectangle whether or not anything is drawn
   * in the corners.
   *
   * Which makes it exactly the right child to colour. The backdrop fills the
   * outer padding and the gaps between tiles — ground no tile owns — and this is
   * the one child that already covers all of it. Unshifted, so it is drawn
   * FIRST and everything else sits on top; and the group's clip rounds it with
   * the same outer radius, so the backdrop IS the silhouette.
   *
   * `transparent` rather than a faded colour when there is none: there is no
   * colour here to fade, and inventing one would be a value nobody authored.
   */
  const backdrop = state?.background ?? null
  // An empty mosaic stands on a light, rounded ground, so it can be seen at
  // all; see `emptyGround`. The rounding is the ground's, not the mosaic's:
  // the outer radius is authored, and nothing has been authored yet.
  const rounding = ground ? groundRadius(object.localBounds.width, object.localBounds.height) : 0
  const extent = new FabricRect({
    left: object.localBounds.x + object.localBounds.width / 2,
    top: object.localBounds.y + object.localBounds.height / 2,
    width: object.localBounds.width,
    height: object.localBounds.height,
    originX: 'center',
    originY: 'center',
    fill: fillOf(backdrop, ground ?? 'transparent', { size: object.localBounds }),
    opacity: imageOpacity(backdrop),
    rx: rounding,
    ry: rounding,
    strokeWidth: 0,
    objectCaching: false,
  })
  extent.set('role', 'extent')
  extent.set('restFill', ground ?? 'transparent')
  children.unshift(extent)

  /*
   * The composition's own edge, on top of everything.
   *
   * Last, because it is about the whole mosaic rather than any tile in it — a
   * border a tile could cover would not be the mosaic's outline.
   *
   * Always attached, even with no border, for the same reason the clip below is
   * always attached: playback adjusts it per frame, and a child that appears
   * and disappears as a border fades in would tear the group's cache down
   * mid-transition. With no border it is a rectangle of zero width.
   */
  const outline = strokeRect(object.localBounds, corners.outerRadius, state?.stroke ?? null)
  children.push(outline)

  const group = finishGroup(object, children, combinedCentre(children))

  /*
   * The rounded outline, as a clip on the whole group.
   *
   * Rounding the tiles at the rim would leave any letter that reaches the edge
   * poking out of the curve, and with a gap between tiles there is no rim tile
   * in the corner at all — so the mosaic's own corners would stay square however
   * round its tiles were. Clipping cuts everything on the same curve, which is
   * what makes the silhouette read as one shape.
   *
   * Centred on nothing, deliberately: the `extent` child is exactly
   * `localBounds`, and everything visible sits inside it, so the group's centre
   * IS the box's centre and a clip rectangle at the origin lines up with it.
   *
   * Always attached, even at radius zero, where it clips nothing. Attaching and
   * detaching as an animated radius crosses zero would tear the group's cache
   * down mid-transition for no gain.
   */
  /*
   * Grown by whatever the border reaches outside the silhouette.
   *
   * Nothing but the border ever draws in that margin — the tiles are a
   * partition of `localBounds` and cannot leave it — so the extra room costs
   * the composition nothing and is exactly what a centred or outside band needs
   * to survive the clip. `mosaicClip` raises the radius to match, which keeps
   * the curve the same shape rather than merely bigger.
   */
  const clip = mosaicClip(object.localBounds, corners.outerRadius, state?.stroke ?? null)
  group.clipPath = new FabricRect({
    left: 0,
    top: 0,
    width: clip.width,
    height: clip.height,
    rx: clip.radius,
    ry: clip.radius,
    originX: 'center',
    originY: 'center',
    objectCaching: false,
  })

  return group
}

/**
 * What a frame looks like, as one string.
 *
 * Every member's own drawing, plus where the shown state puts it. A frame is
 * only ever redrawn by being rebuilt — like a static mosaic — so anything that
 * changes the picture has to be in here or it will not appear until something
 * else does.
 */
/**
 * Paint one member's artwork for this instant, preset and all.
 *
 * Through `paintFrame` and `frameAt`, which is what an ordinary object's loop
 * uses — and that is the point of it. A member had three partial painters of its
 * own: one for the fills, one for the outline, one for the type. None of them
 * knew about the member's OWN animation, so a shape carrying a Wave stopped
 * waving the moment it was dropped into a frame. `animatingIds` walks
 * `doc.objectOrder`, and a member is not in it, so nothing was driving the
 * preset at all.
 *
 * Composition falls out of handing `frameAt` the member as the FRAME has it
 * this instant: the preset deforms the blended outline, and `paintAt` works
 * from the blended colour rather than replacing it. The frame says where a
 * member is and what it looks like; the preset says what it is doing there.
 *
 * The border is painted separately because `paintFrame` has no part for it.
 */
export function paintMemberArtwork(
  child: FabricObject,
  member: FrameObject['members'][number],
  drawn: DocumentObject,
  values: ReturnType<typeof valuesFor>,
  fits: Record<string, (FitOutcome | null)[]> | undefined,
  stateIndex: number,
  /** Where the member is in its OWN loop, which runs on its own clock. */
  phase: number,
): void {
  if (drawn.kind !== 'typography' || member.object.kind !== 'typography') return
  const group = child as Group
  if (!group.getObjects) return

  // Everything that decides the picture, so a hold costs one string compare.
  const mark = `${stateIndex}|${phase}|${drawn.typography.padding}|${drawn.currentSourcePath}|${JSON.stringify(drawn.appearance)}`
  if (group.get('paintedAs') === mark) return
  group.set('paintedAs', mark)

  paintMemberBorder(group, drawn)

  const paints = restingPaints(drawn)
  const restPath = new Path(drawn.currentSourcePath)
  const rest = {
    path: restPath.path,
    fill: paints.container ? fabricPaint(paints.container, boxOfChild(restPath)) : 'transparent',
  }

  /*
   * The container is painted whether or not there is type, and that is not a
   * detail: a shape with nothing written in it has no FIT — `fitObject` refuses
   * empty text — so routing everything through the type's painter left a
   * text-less member's outline frozen through an entire morph. Which is most
   * members.
   */
  const solved = fits?.[member.object.id]
  const fitted = solved?.[stateIndex] ?? solved?.[0] ?? null
  if (!fitted?.ok) {
    paintContainer(group, rest)
    return
  }

  /*
   * Whether the region the type should occupy is the one the fit used.
   *
   * Two things move it: the outline and the padding. Unmoved, the fit's own
   * patch is reused rather than rebuilt, so a member that is only running a
   * preset costs no patch build per frame.
   */
  const fitPadding = values.typeSettings?.typography?.padding ?? 0
  const moved =
    drawn.currentSourcePath !== member.object.currentSourcePath ||
    Math.abs(drawn.typography.padding - fitPadding) > 1e-6

  const source = pourThrough(drawn, fitted, moved ? drawn.currentSourcePath : undefined, PATCH_SAMPLES_DRAFT)
  if (!source) {
    paintContainer(group, rest)
    return
  }

  paintFrame(group, frameAt(drawn, source, phase), rest)
}

/**
 * The frame's own backdrop for this instant.
 *
 * Separate from the members because it belongs to none of them: it is a
 * property of the STATE, and the only one that is. Painted in place like
 * everything else in the loop, so a colour that fades in does so smoothly
 * rather than arriving when the group is next rebuilt.
 */
export function paintFrameBackground(group: Group, colour: Paint | null): void {
  for (const part of group.getObjects()) {
    if (part.get('role') !== 'plate') continue
    const next = fillOf(colour, (part.get('restFill') as string | undefined) ?? 'transparent', boxOfChild(part))
    const opacity = imageOpacity(colour)
    if (part.fill === next && part.opacity === opacity) continue
    part.set({ fill: next, opacity })
    part.set('dirty', true)
  }
}

/** The opacity a paint gives its child: a picture's own, or full. */
export function imageOpacity(paint: Paint | null | undefined): number {
  return paint && typeof paint === 'object' && paint.kind === 'image' ? (paint.opacity ?? 1) : 1
}

/**
 * The box a letter's picture is placed in: the reference rectangle it was
 * cut for, which its ink box sits inside — so a picture covers the tile's
 * letter box rather than the ink alone, and stays put as the letter changes.
 */
export function glyphBox(reference: Rect, inkBox: Rect): FillBox {
  return { size: reference, offset: { x: reference.x - inkBox.x, y: reference.y - inkBox.y } }
}

/** The outline and its fill, for a member with no type to emit through it. */
function paintContainer(
  group: Group,
  rest: { path: Path['path']; fill: Path['fill'] },
): void {
  for (const part of group.getObjects()) {
    if (part.get('role') !== 'container') continue
    part.set({ path: rest.path, fill: rest.fill })
    part.setCoords()
  }
}

/**
 * The member's border, which `paintFrame` does not draw.
 *
 * A state with no border BLANKS the child rather than leaving it: skipping left
 * whatever the last frame painted on screen through the whole of the next hold,
 * so a border that had faded out reappeared the moment it arrived nowhere.
 */
function paintMemberBorder(group: Group, object: DocumentObject): void {
  if (object.kind !== 'typography') return
  const stroke = object.appearance.containerStroke
  for (const part of group.getObjects()) {
    if (part.get('role') !== 'border') continue
    part.set(
      stroke
        ? {
            stroke: stroke.colour,
            strokeWidth: strokePaint(stroke).width,
            strokeDashArray: dashArrayFor(stroke),
          }
        : { stroke: 'transparent', strokeWidth: 0 },
    )
    // An inside or outside border is cached so its clip works, and a cache does
    // not notice a property change unless it is told.
    part.set('dirty', true)
  }
}

/**
 * A member as the state on show has it looking.
 *
 * The appearance is SUBSTITUTED rather than painted over the finished group: a
 * container fill, a banner and a border are separate children built at separate
 * points, and reaching in afterwards to recolour them would be a second place
 * that has to know how a shape is assembled. Handing the builder an object that
 * already carries the blended colours keeps one road from a document to canvas.
 *
 * Shared with `frameContentKey` on purpose. The key decides whether the group is
 * rebuilt at all, so if it derived its colours differently from the builder, a
 * frame could be told nothing had changed while looking quite different.
 */
export function memberAsDrawn(
  member: FrameObject['members'][number],
  values: ReturnType<typeof valuesFor>,
  /** Every state's stroke for this member, so one that only appears later still gets a child. */
  everStroked?: PositionedStroke | null,
): DocumentObject {
  if (member.object.kind !== 'typography' || !values.appearance) return member.object

  /*
   * A border this state does not have, built anyway at zero alpha.
   *
   * The mosaic's lesson, one object along: a part that is absent in the state
   * on show has no Fabric child, so it cannot fade in — arriving at a bordered
   * state would mean rebuilding the group mid-transition, which tears its cache
   * down exactly when it is being drawn. So if ANY state gives this member a
   * border, every state draws one; the ones that did not ask for it draw it
   * completely transparent, which is nothing to look at and something to
   * animate.
   */
  const appearance =
    values.appearance.containerStroke === null && everStroked
      ? { ...values.appearance, containerStroke: { ...everStroked, colour: fadedPaint(everStroked.colour) as StrokePaint } }
      : values.appearance

  // Everything else — the state's shape, its place, its cut-tier settings, the
  // padding as it is this instant — is the model's answer, not the renderer's.
  return memberAtState(member, values, appearance)
}

/**
 * How see-through a member is at this moment.
 *
 * Two opacities multiplied, and they are different things: the member's own,
 * which is an appearance and therefore belongs to the state, and the state's
 * own for that member, which is the fade knob. Both being per-state is what
 * lets a member arrive by fading in.
 *
 * It has its own function because it did NOT have one: the builder and the two
 * halves of the playback loop each carried a copy, all three read the member at
 * REST instead of as the state has it, and the result was an opacity that could
 * be set and never seen. Every colour beside it worked, because those are read
 * off the object the builder is handed.
 */
export function memberOpacity(
  member: FrameObject['members'][number],
  values: ReturnType<typeof valuesFor>,
): number {
  return opacityOf(memberAsDrawn(member, values)) * values.opacity
}

/**
 * Put one member into the state it is in at this instant: where it stands, how
 * see-through it is, and how it is painted.
 *
 * The playback loop's whole per-member body, so that it and the still build
 * cannot answer differently — which they already had, three times over.
 */
export function applyMemberMoment(
  child: FabricObject,
  member: FrameObject['members'][number],
  values: ReturnType<typeof valuesFor>,
  /** Solved fits by member object id, one per state. */
  fits?: Record<string, (FitOutcome | null)[]>,
  /**
   * Which state's type to show.
   *
   * The one being LEFT, through a whole transition. Size, spacing and the text
   * itself cut rather than tween, so the layout in play is the departing
   * state's until the moment it arrives.
   */
  stateIndex = 0,
  /** Where the member is in its OWN loop. Zero is the member at rest. */
  phase = 0,
): void {
  const drawn = memberAsDrawn(member, values)
  placeMemberChild(child, values.transform)
  child.set({ opacity: memberOpacity(member, values) })
  paintMemberArtwork(child, member, drawn, values, fits, stateIndex, phase)
}



/**
 * The first border this member has in any state, or null if it never has one.
 *
 * Resolved through `valuesFor`, so the member's own border counts as well as
 * one a state authored — a state that takes the border AWAY then still draws
 * it at zero alpha, and the fade out has something to fade.
 */
function strokeAnyState(object: FrameObject, memberId: string): PositionedStroke | null {
  const member = object.members.find((each) => each.id === memberId)
  if (!member) return null
  for (const state of object.states) {
    const stroke = valuesFor(member, state).appearance?.containerStroke
    if (stroke) return stroke
  }
  return null
}

/**
 * Put a frame back on one of its authored states.
 *
 * What stopping does, and what a press on a playing frame does FIRST — before
 * Fabric sets the gesture up — so that a drag begins from the arrangement
 * being edited and not from wherever the clock had painted the member. One
 * function for both, or the two would settle differently. `except` is the
 * child Fabric is already holding, which is left exactly where the pointer
 * has it.
 */
export function settleFrame(
  group: Group,
  frame: FrameObject,
  at: number,
  fits: Record<string, (FitOutcome | null)[]>,
  except?: FabricObject,
): void {
  const shown = Math.min(Math.max(0, at), frame.states.length - 1)
  for (const child of group.getObjects()) {
    if (child === except) continue
    const memberId = child.get('memberId') as string | undefined
    if (!memberId) continue
    const member = frame.members.find((each) => each.id === memberId)
    if (!member) continue
    applyMemberMoment(child, member, valuesFor(member, frame.states[shown]), fits, shown)
  }
  // The backdrop too, or the plate keeps a blended colour that belongs to no
  // state until the group is next rebuilt.
  paintFrameBackground(group, frame.states[shown]?.background ?? null)
  group.set('dirty', true)
}

function frameContentKey(object: FrameObject, at: number, input: SyncInput): string {
  const shown = Math.min(Math.max(0, at), object.states.length - 1)
  const state = object.states[shown]
  return [
    shown,
    // Entering rebuilds: inside, the members are selectable objects in their own
    // right, and that is a different group rather than a different drawing.
    input.insideFrame === object.id,
    object.clip,
    // All four of the box: the plate and the clip are built from x and y too.
    object.localBounds.x,
    object.localBounds.y,
    object.localBounds.width,
    object.localBounds.height,
    object.opacity,
    state?.background ?? 'none',
    object.members
      .map((member) => {
        const values = valuesFor(member, state)
        const t = values.transform
        /*
         * Keyed on the member AS DRAWN — the same substitution the builder
         * makes, through the same function.
         *
         * This key is the only thing that makes a frame redraw: it is rebuilt or
         * it is unchanged. So anything the key cannot see is something that does
         * not appear until something else happens to move, and a key computed
         * from the member's RESTING colours could never see a state's.
         */
        const drawn = memberAsDrawn(member, values, strokeAnyState(object, member.id))
        /*
         * A member's own key, from the very function that keys it at the top
         * level — so a member answers for what would look different in exactly
         * the same terms an ordinary object does.
         *
         * Listing the fields again by hand is how the TEXT went missing: the
         * hand-written list had the shape, the paints and the border, and no
         * text path at all, so typing into a member changed nothing this could
         * see and the words never appeared however long you typed.
         */
        const own =
          drawn.kind === 'typography'
            ? typographyContentKey(
                drawn,
                input.textPaths[drawn.id] ?? '',
                input.bandPaths[drawn.id] ?? '',
              )
            : drawn.kind === 'mosaic'
              ? mosaicContentKey(drawn, input.mosaicStates?.[drawn.id] ?? 0)
              : ''
        return [
          member.id,
          drawn.kind,
          drawn.kind === 'typography' ? drawn.currentSourcePath : '',
          own,
          t.x,
          t.y,
          t.scaleX,
          t.scaleY,
          t.rotation,
          // The builder applies these; a key that could not see them never
          // repainted a member a state had mirrored.
          t.flipX,
          t.flipY,
          values.opacity,
        ].join(':')
      })
      .join('|'),
  ].join('~')
}

/**
 * A frame, and its members nested inside it.
 *
 * The one place in this renderer that nests. Each member is built by the same
 * builder it would get at the top level, then placed by the state's blended
 * transform RELATIVE to the frame rather than absolutely — which is the whole
 * difference between being in a frame and being beside one.
 */
/**
 * The gap between windows of a spread object, as a share of the object's width.
 *
 * Proportional, so it holds at any size: a fixed gap reads as a crack between
 * two large windows and as a long strip between two small ones.
 */
const WINDOW_GAP = 0.12

/** Where window `index` of a spread object stands, in artboard units. */
export function windowOffset(object: Stated, index: number): number {
  const step = object.localBounds.width * (object.transform.scaleX || 1) * (1 + WINDOW_GAP)
  return index * step
}

/**
 * One window of a stated object: the object drawn at state `at`.
 *
 * The one place the kinds are told apart for drawing. Each kind's builder
 * draws its state completely — a mosaic cuts every glyph up front; a frame
 * places its members and is settled to its state's type by `settleWindows`,
 * because the fits arrive with the text paths rather than with the builder.
 */
function buildWindow(object: Stated, at: number, input: SyncInput): Group {
  const ground = groundFor(object, input.held)
  return object.kind === 'mosaic'
    ? buildMosaicGroup(object, at, ground)
    : object.kind === 'mesh'
      ? buildMeshGroup(object, at, ground)
      : buildFrameGroup(object, at, input, ground)
}

/** What a window of a stated object at state `at` is drawn from, as one string. */
function statedContentKey(object: Stated, at: number, input: SyncInput): string {
  const own =
    object.kind === 'mosaic'
      ? mosaicContentKey(object, at)
      : object.kind === 'mesh'
        ? meshContentKey(object, at)
        : frameContentKey(object, at, input)
  // The ground is drawn or it is not, and only the plate's arrival changes which.
  // And whether each picture the object refers to has ARRIVED: a group built
  // while one was still decoding draws nothing there, and has to be built
  // again once it can.
  const pictures = [...collectAssetIds([object])].map((id) => `${id}:${imageReady(id) ? 1 : 0}`).join(',')
  return `${own}~ground:${groundFor(object, input.held) ?? ''}~pictures:${pictures}`
}

/**
 * The window contract, in one place.
 *
 * The first window IS the object — it keeps `shapeId`, stays as selectable as
 * the mode left it, and is what every lookup by id already finds. The rest
 * are further pictures of it: they carry NO `shapeId`, because it would enrol
 * them in every first-match lookup at once and which group each returned
 * would be add-order luck; and they can never be picked up as a whole, because
 * a drag of one would reach `collectTransforms` as a transform of the object
 * it is only a picture of. The object is moved by its first window, and every
 * window follows, because they are all stood from its transform — the first
 * where the object already is, so nothing jumps when a spread opens.
 *
 * Every window is stamped with whose it is and which STATE it draws, so that
 * anything holding it or a child of it can ask where a press or a write
 * belongs, instead of asking the UI store what it happens to be looking at.
 * Applied on every sync, built or reused, so the stamps are never stale and
 * the reuse path — which sets `selectable` from `locked` alone — cannot hand
 * a further window back its handles.
 */
function placeWindow(group: Group, object: Stated, index: number, stateIndex: number): void {
  group.set('statedId', object.id)
  group.set('stateIndex', Math.min(Math.max(0, stateIndex), object.states.length - 1))
  if (index === 0) return
  group.set('shapeId', undefined)
  group.set({ selectable: false, left: group.left + windowOffset(object, index) })
  group.setCoords()
}

/**
 * Every window of a spread object settled to ITS state, for the kinds that
 * need it: a frame's builder only has the shown state's text paths, so each
 * window's type is poured through its own outline afterwards, by the one
 * settle the stop button uses. A mosaic's window is complete when built.
 */
export function settleWindows(
  entry: RenderedObject,
  object: Stated,
  fits: Record<string, (FitOutcome | null)[]>,
): void {
  if (!entry.windows || object.kind !== 'frame') return
  entry.windows.forEach((window, i) => settleFrame(window, object, i, fits))
}

/**
 * A frame's group, whose hit area is what it DRAWS rather than what it measures.
 *
 * Fabric only looks inside a group when the pointer is within the group's own
 * four corners — so with clipping off, a member hanging over the frame's edge
 * was painted in full and could not be clicked anywhere past that edge, and
 * the press that missed it was read as a press outside the frame. Nothing
 * about that is particular to any view; it is any frame whose contents
 * overflow it.
 *
 * `getCoords` is the one place to say it: the targeting path, the selection
 * lasso and the bounding rectangle all ask it where the object is, so widening
 * it here keeps picking, rubber-banding and fit-to-content telling the same
 * story. The group still MEASURES its authored bounds — `width`, `height` and
 * the resize handles are untouched — so a frame is still resized by its own
 * edges and members still lay out against the box you dragged out.
 *
 * With clipping on the overhang is not drawn, so it is not clickable either and
 * the base behaviour is exactly right.
 */
class FrameGroup extends Group {
  /** False when the frame clips, which is when the base rule already holds. */
  declare reachesOverflow: boolean

  override getCoords(): Point[] {
    const own = super.getCoords()
    if (!this.reachesOverflow || this._objects.length === 0) return own

    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    const take = (points: Point[]): void => {
      for (const point of points) {
        if (point.x < x1) x1 = point.x
        if (point.x > x2) x2 = point.x
        if (point.y < y1) y1 = point.y
        if (point.y > y2) y2 = point.y
      }
    }
    take(own)
    for (const child of this._objects) {
      child.setCoords()
      take(child.getCoords())
    }

    /*
     * An upright hull, even for a turned frame. Containment is all these four
     * points are asked for, and the looseness only ever shows in the corners of
     * a rotated frame that something already overhangs.
     */
    return [new Point(x1, y1), new Point(x2, y1), new Point(x2, y2), new Point(x1, y2)]
  }
}

function buildFrameGroup(
  object: FrameObject,
  at: number,
  input: SyncInput,
  ground: string | null = emptyGround(object),
): Group {
  /** Whether the frame is being worked INSIDE, which is what makes it interactive. */
  const inside = input.insideFrame === object.id
  /** Each member and where it belongs, applied once the group exists. */
  const placements: { child: FabricObject; transform: Transform2D }[] = []
  // Past the end draws the LAST state — the answer every gesture gives a stale
  // index, so what is looked at is what is edited. It used to fall to the first.
  const shown = Math.min(Math.max(0, at), object.states.length - 1)
  const state = object.states[shown]
  const children: FabricObject[] = []

  /*
   * The bounds themselves, drawn first and always.
   *
   * What the clip is measured against and what carries the state's backdrop,
   * so it is never absent — but it draws no edge of its own: a frame on the
   * page behaves as any other object, marked when selected and plain when
   * not. An EMPTY frame is made visible by `EmptyHints` and the rounded
   * ground it stands on, not by a line.
   */
  const rounding = ground ? groundRadius(object.localBounds.width, object.localBounds.height) : 0
  const plate = new FabricRect({
    left: object.localBounds.x + object.localBounds.width / 2,
    top: object.localBounds.y + object.localBounds.height / 2,
    width: object.localBounds.width,
    height: object.localBounds.height,
    originX: 'center',
    originY: 'center',
    /*
     * The state's own backdrop, behind everything the frame holds. It is the one
     * thing in a frame that belongs to no member, so it is painted onto the
     * plate — the rectangle that was already there to make an empty frame
     * visible and to measure the clip against.
     */
    fill: fillOf(state?.background, ground ?? 'transparent', { size: object.localBounds }),
    opacity: imageOpacity(state?.background),
    rx: rounding,
    ry: rounding,
    strokeWidth: 0,
    objectCaching: false,
    evented: false,
  })
  plate.set('role', 'plate')
  plate.set('restFill', ground ?? 'transparent')
  children.push(plate)

  for (const member of object.members) {
    const values = valuesFor(member, state)
    const drawn = memberAsDrawn(member, values, strokeAnyState(object, member.id))
    const inner =
      drawn.kind === 'mosaic'
        ? buildMosaicGroup(drawn, input.mosaicStates?.[drawn.id] ?? 0)
        : drawn.kind === 'typography'
          ? buildGroup(
              drawn,
              input.textPaths[drawn.id] ?? '',
              input.bandPaths[drawn.id] ?? '',
              input.ribbons[drawn.id] ?? [],
            )
          : null
    if (!inner) continue

    /*
     * Placed relative to the frame's own origin, not the artboard's — and
     * placed through `positionGroup`, which is the whole point.
     *
     * Writing `left = transform.x` by hand looks equivalent and is not. A group
     * is built `originX: 'center'` from children in the object's local space, so
     * its centre lands on the ARTWORK's centre, which is `localCentre` and is
     * only the local origin for artwork that happens to be centred on it.
     * `positionGroup` is the one place that carries that offset through the
     * object's own rotation and scale; skipping it drew every member displaced
     * by its own `localCentre`, which is why each one was off by a different
     * amount and why the hit test could never find them.
     */
    inner.set({
      scaleX: values.transform.scaleX,
      scaleY: values.transform.scaleY,
      angle: values.transform.rotation,
      flipX: values.transform.flipX,
      flipY: values.transform.flipY,
      opacity: memberOpacity(member, values),
      /*
       * Selectable only from INSIDE. Outside, a press anywhere on the frame is
       * a press on the frame — which is what makes it one object to drag.
       *
       * Inside, Fabric owns the member completely: its own controls, its own
       * cursors, rotation, Shift to keep the ratio. That is the point of the
       * interactive group — a member behaves like an object on the artboard
       * because it IS one, rather than wearing handles drawn on top of it.
       */
      selectable: inside,
      evented: inside,
      hasControls: inside,
      hasBorders: inside,
      borderColor: selectionColour(),
      cornerColor: '#ffffff',
      cornerStrokeColor: selectionColour(),
      cornerSize: 8,
      transparentCorners: false,
    })
    positionGroup(inner, { ...member.object, transform: values.transform })
    inner.set('memberId', member.id)
    placements.push({ child: inner, transform: values.transform })
    /*
     * The transform this child was BUILT at, kept on it.
     *
     * Fabric re-bases every child onto the group's own centre when the group
     * lays itself out, and it works that centre out its own way — strokes
     * counted, in units of its own. Re-deriving that basis analytically got it
     * right to a quarter of a pixel here and would be out by half a border's
     * width on a thick one, so playback anchors to what was actually built
     * instead: it moves a child by the DIFFERENCE between two placements, from
     * a position Fabric itself chose.
     */
    inner.set('builtAt', { ...values.transform })
    children.push(inner)
  }

  /*
   * The CHILDREN's centre, as every other builder passes — never the bounds'.
   *
   * Fabric lays a group out to fit its content: the group's origin ends up on
   * the union of what is in it. `localCentre` is what `positionGroup` uses to
   * put local (0,0) back where the document says it is, so the two have to be
   * the same point or the whole frame drifts. Passing the bounds' centre held
   * only while nothing overhung them — and with clipping off, overhanging is a
   * thing members are allowed to do.
   */
  /*
   * A FIXED layout, not fit-content — and this is what lets a member behave like
   * any other object.
   *
   * Fit-content derives the group's box from what is in it, so transforming a
   * child re-lays the group out and the frame moves as its contents do. A frame's
   * bounds are AUTHORED: you dragged them out, and nothing inside should move
   * them. Fixed also makes the group's origin its own centre rather than the
   * content's, so a child's coordinates are simply the member's local ones and
   * the offset that `combinedCentre` existed to cancel is gone.
   *
   * `interactive` hands Fabric the members while you are inside: real controls,
   * real cursors, rotation, Shift to keep the ratio — everything an object on the
   * artboard has, because they are now the same thing. Off from outside, where a
   * frame is one object you drag as a whole.
   */
  const group = new FrameGroup(children, {
    originX: 'center',
    originY: 'center',
    width: object.localBounds.width,
    height: object.localBounds.height,
    layoutManager: new LayoutManager(new FixedLayout()),
    interactive: inside,
    subTargetCheck: inside,
    scaleX: object.transform.scaleX,
    scaleY: object.transform.scaleY,
    angle: object.transform.rotation,
    flipX: object.transform.flipX,
    flipY: object.transform.flipY,
    opacity: opacityOf(object),
    visible: object.visible,
    /*
     * Selectable inside as well as out. Fabric hands a press on a member to the
     * member — that is what `interactive` is for — and keeps only the presses
     * that land on the frame's own ground, which select the frame: its box and
     * its handles come back the moment nothing inside it is picked, as in
     * Figma. It used to step back while you were inside, and then came back by
     * accident on every document change, because the reuse path sets this from
     * `locked` alone.
     */
    selectable: !object.locked,
    evented: !object.locked,
    objectCaching: false,
    borderColor: selectionColour(),
    cornerColor: '#ffffff',
    cornerStrokeColor: selectionColour(),
    cornerSize: 8,
    transparentCorners: false,
  })

  group.set('shapeId', object.id)
  // Reaches its overflow exactly when it draws it: the same condition the clip
  // rectangle below is sized by, so the two can never disagree.
  group.reachesOverflow = !object.clip
  // The bounds' centre, which a fixed layout makes the group's own origin too.
  group.set('localCentre', {
    x: object.localBounds.x + object.localBounds.width / 2,
    y: object.localBounds.y + object.localBounds.height / 2,
  })
  positionGroup(group, object)

  /*
   * Placed AFTER the group exists, because that is the only point at which a
   * child's coordinates mean what they need to.
   *
   * Fabric re-bases children on construction — measured, by half the group's
   * size, taking them to have been authored in a top-left-origin box. From then
   * on a child's `left`/`top` are relative to the group's CENTRE, which a fixed
   * layout makes the frame's own local origin. So the placement is written here,
   * in frame-local coordinates, rather than guessed before the re-basing.
   */
  for (const { child, transform } of placements) {
    const own = (child.get('localCentre') as { x: number; y: number } | undefined) ?? { x: 0, y: 0 }
    child.set(placementFor(own, transform))
    child.setCoords()
    child.set('placedAt', { left: child.left, top: child.top })
  }

  /*
   * Attached always, and switched by size rather than by existence.
   *
   * The mosaic learned this: attaching and detaching a clip as a state crosses
   * tears the group's cache down mid-transition. With clipping off the rectangle
   * is simply large enough to cut nothing.
   */
  const room = object.clip ? 0 : Math.max(object.localBounds.width, object.localBounds.height) * 4
  group.clipPath = new FabricRect({
    /*
     * On the group's own centre, which a fixed layout makes the frame's bounds
     * centre — so the window sits exactly on the box however far a member
     * overhangs it.
     */
    left: 0,
    top: 0,
    width: object.localBounds.width + room,
    height: object.localBounds.height + room,
    originX: 'center',
    originY: 'center',
    objectCaching: false,
  })

  return group
}

export function syncCanvas(input: SyncInput): Map<string, RenderedObject> {
  const { canvas, doc, textPaths, bandPaths, ribbons, rendered } = input
  const next = new Map<string, RenderedObject>()

  /*
   * Take the objects out of any multi-selection before touching them.
   *
   * Fabric parents the members of an `ActiveSelection` into it, and a parented
   * object's `left`/`top` are RELATIVE to the selection. Everything below writes
   * ABSOLUTE positions — `positionGroup` puts each group where the document says
   * it is — so with a selection open, every one of those writes was read back by
   * Fabric as an offset from the selection's centre and the whole set jumped away
   * from its own bounding box the moment two things were selected.
   *
   * Discarding first is not a workaround for that; it is the only order that
   * makes sense. The document is the authority on where objects are, and a
   * selection is a view of them — so the objects are placed, and then the
   * selection is rebuilt around where they ended up, which is what
   * `syncSelectionToCanvas` does immediately after this returns.
   *
   * Only for a real multi-selection. A single selected object is not parented,
   * so there is nothing to take it out of, and discarding it would throw its
   * controls away and rebuild them on every keystroke.
   */
  if (canvas.getActiveObjects().length > 1) canvas.discardActiveObject()

  // Remove objects that no longer exist.
  for (const [id, entry] of rendered) {
    if (!doc.objects[id]) removeRendered(canvas, entry)
  }

  for (const id of doc.objectOrder) {
    const object = doc.objects[id]
    if (!object) continue

    const existing = rendered.get(id)

    /*
     * One key that says everything about what is DRAWN.
     *
     * Any change to it rebuilds the group. Mutating a group's children in place
     * makes Fabric re-lay-out the whole thing, which is what used to separate
     * the text from its container — so a change of content is a new group, and
     * anything else leaves the group alone and only moves it.
     *
     * One string rather than a field per property, because the two kinds of
     * object have nothing in common to compare: a mosaic has no text path and no
     * banner, and a typography object has no partition. Each kind answers for
     * itself what would look different.
     */
    /*
     * Spread, the first window is pinned to state 1 whatever is on show.
     * Pressing in window 3 makes state 3 the shown one — that is what lands
     * the edit — and the row must not re-order itself under the hand doing it.
     */
    const spread = isStated(object) && input.spread === object.id
    const shownState = input.mosaicStates?.[object.id] ?? 0
    const stateForGroup = spread ? 0 : shownState

    /*
     * Spread, the key describes EVERY window, because every window is drawn.
     * Keyed on the first state alone, a colour or an arrangement changed in
     * state 3 changed nothing the key could see, and window 3 went on showing
     * what it showed before.
     */
    const contentKey = isStated(object)
      ? spread
        ? `spread:${object.states.map((_, i) => statedContentKey(object, i, input)).join('|')}`
        : statedContentKey(object, stateForGroup, input)
      : typographyContentKey(object, textPaths[id] ?? '', bandPaths[id] ?? '')

    let group: Group
    let windows: Group[] | undefined
    if (!existing || existing.contentKey !== contentKey) {
      if (existing) removeRendered(canvas, existing)
      group = isStated(object)
        ? buildWindow(object, stateForGroup, input)
        : buildGroup(object, textPaths[id] ?? '', bandPaths[id] ?? '', ribbons[id] ?? [])
      canvas.add(group)

      /*
       * The rest of the row, one window per remaining state — the same builder
       * called again, so a window cannot drift from the object it is a window
       * onto.
       */
      if (spread && isStated(object)) {
        windows = [group]
        for (let i = 1; i < object.states.length; i++) {
          const window = buildWindow(object, i, input)
          canvas.add(window)
          windows.push(window)
        }
      }
    } else {
      group = existing.group
      windows = existing.windows
      applyTransform(group, object)
      for (const window of windows ?? []) if (window !== group) applyTransform(window, object)
    }

    // Stood along the row and stamped, built or reused — see `placeWindow`.
    if (isStated(object)) {
      ;(windows ?? [group]).forEach((window, i) =>
        placeWindow(window, object, i, spread ? i : shownState),
      )
    }

    next.set(id, windows ? { group, contentKey, windows } : { group, contentKey })
  }

  // Apply z-order: objectOrder index 0 is the bottom of the stack.
  for (const id of doc.objectOrder) {
    const entry = next.get(id)
    if (!entry) continue
    for (const group of windowsOf(entry)) canvas.bringObjectToFront(group)
  }

  // Editor overlays stay above the artwork.
  //
  // This has to happen HERE rather than in the overlay's own effect. React runs
  // a child's effects before its parent's, so an overlay that raised itself was
  // immediately buried again by this very function — the guides disappeared
  // behind the shape being edited on every store update.
  // The one exception is the plate behind a spread frame's row, which is an
  // overlay in every sense but the one that matters: it goes UNDER.
  for (const object of canvas.getObjects()) {
    const role = object.get('gridRole')
    if (role === 'frame-plate') canvas.sendObjectToBack(object)
    else if (role) canvas.bringObjectToFront(object)
  }

  canvas.requestRenderAll()
  return next
}

/**
 * Read a group's on-canvas placement back as a document transform.
 *
 * The inverse of `positionGroup`: Fabric reports the centre of the children's
 * combined bounds, and the document stores the object's local origin, so the
 * same offset has to be removed again after the user drags or rotates.
 */
export function readTransformFromGroup(group: Group): Transform2D {
  const centre = (group.get('localCentre') as { x: number; y: number } | undefined) ?? {
    x: 0,
    y: 0,
  }

  /*
   * Where the group sits on the CANVAS, not where it sits in whatever contains
   * it.
   *
   * A group selected on its own is contained by nothing and its own properties
   * are the answer. A group inside an `ActiveSelection` is not: Fabric parents
   * it, rewrites its `left`/`top` as an offset from the selection's centre, and
   * leaves its angle and scale at the values it had before it was selected,
   * composing the selection's own transform on top only when it draws. Read
   * directly, a two-object drag therefore reported one object as having moved
   * and the other as having stayed put, and wrote both to the document.
   *
   * The composed matrix is the same question asked once and answered for both
   * cases, and `decompose` already splits it the way the document stores it —
   * positive scales with the mirroring in `flipY`.
   */
  const placed = group.group
    ? decompose(group.calcTransformMatrix() as Mat2D)
    : {
        x: group.left,
        y: group.top,
        rotation: group.angle,
        scaleX: Math.abs(group.scaleX),
        scaleY: Math.abs(group.scaleY),
        flipX: group.flipX,
        flipY: group.flipY,
      }

  const rad = (placed.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = placed.scaleX * (placed.flipX ? -1 : 1)
  const sy = placed.scaleY * (placed.flipY ? -1 : 1)

  const dx = centre.x * sx
  const dy = centre.y * sy

  return {
    x: placed.x - (dx * cos - dy * sin),
    y: placed.y - (dx * sin + dy * cos),
    scaleX: placed.scaleX,
    scaleY: placed.scaleY,
    rotation: placed.rotation,
    flipX: placed.flipX,
    flipY: placed.flipY,
  }
}

/** Push document transform values onto an existing group without rebuilding it. */
export function applyTransform(group: Group, object: DocumentObject): void {
  group.set({
    scaleX: object.transform.scaleX,
    scaleY: object.transform.scaleY,
    angle: object.transform.rotation,
    flipX: object.transform.flipX,
    flipY: object.transform.flipY,
    opacity: opacityOf(object),
    visible: object.visible,
    selectable: !object.locked,
    evented: !object.locked,
  })
  // Position last: it depends on the scale and rotation set above.
  positionGroup(group, object)
}

/**
 * Where an object is being drawn RIGHT NOW, which during a drag is not where the
 * document says it is.
 *
 * Fabric moves the group as the pointer moves and only writes the result back
 * when the gesture ends, so anything drawn from `object.transform` mid-drag is
 * drawn where the object USED to be. That is fine for the object itself — Fabric
 * paints it — but not for the overlays beside it: a mosaic's tile outlines and
 * its state control sat where the mosaic had been, then jumped to catch up on
 * release.
 *
 * Falls back to the stored transform when the object has no group yet, which is
 * the honest answer before anything has been drawn.
 */
export function liveTransform(
  canvas: Canvas | null,
  id: string,
  stored: Transform2D,
): Transform2D {
  if (!canvas) return stored
  const group = canvas.getObjects().find((o) => o.get('shapeId') === id)
  return group instanceof Group ? readTransformFromGroup(group) : stored
}

/**
 * A font's identity as one string.
 *
 * Family, weight and slant together: two states set in the same family at
 * different weights are different outlines, so they are different fonts as far
 * as anything that has to draw them is concerned.
 */
export function fontKey(font: FontSettings | undefined): string {
  if (!font) return ''
  return `${font.fontId}|${font.weight}|${font.italic ? 'i' : 'r'}`
}
