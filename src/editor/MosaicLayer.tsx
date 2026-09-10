import { Line, Rect, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  collateral,
  edgeAt,
  moveEdge,
  reachesBeyond,
  selectionEdges,
  selectionRuns,
  type MosaicEdge,
} from '../mosaic/boundaries'
import type { Span } from '../mosaic/dissection'
import { activeState, mosaicChars, mosaicSpacing, mosaicTiles, tileAt } from '../mosaic/tiles'
import { isTypedCharacter } from '../mosaic/graphemes'
import { readingOrder, stepThrough, tileInDirection } from '../mosaic/order'
import { mosaicMoves } from './animationPlayback'
import { liveTransform } from './renderer'
import {
  backspaceCharacter,
  deleteCharacter,
  pasteCharacters,
  typeCharacter,
} from '../mosaic/typing'
import {
  pointArtboardToObject,
  pointObjectToArtboard,
  vectorObjectToArtboard,
} from '../geometry/objectSpace'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { LetterMosaicObject, Vec2 } from '../types/document'
import type { MosaicTile } from '../types/mosaic'
import { selectionColour } from './colours'

/*
 * Selection blue, from the stylesheet — see `colours.ts`. A function rather than
 * a captured value, so it resolves once the styles are in.
 */
const FOCUS_COLOR = selectionColour
/** The edge has nowhere further to go. */
const LIMIT_COLOR = '#e0a03a'

const OUTLINE_OPACITY = 0.55

/**
 * Half a blink, in milliseconds — the caret is lit for this long, then dark.
 *
 * The rate every desktop text field has used for decades. Faster reads as an
 * error indicator and slower stops reading as a caret at all.
 */
const CARET_BLINK_MS = 530

/** Reach of the handle hit test, in SCREEN pixels, so it feels the same at any zoom. */
const HOVER_PIXELS = 7
/**
 * How far the pointer must travel before a press on a handle becomes a resize.
 *
 * Below this it was a click, and a click selects the tile under it. Small enough
 * that a deliberate drag never feels sticky, large enough that a hand resting on
 * the button does not resize by accident.
 */
const DRAG_SLOP_PIXELS = 3

interface Gesture {
  edge: MosaicEdge
  /** Where the pointer went down, in the mosaic's own space. */
  from: Vec2
  /** Where every line it moves was, so each frame starts from the same place. */
  before: Record<string, number>
  /**
   * The tiles as they were, when the drag had to detach the line first.
   *
   * Only set in that case, and only so that cancelling puts the alignment back:
   * an abandoned drag must leave nothing behind, and a fork is a change to which
   * tiles read which line even when nothing has moved.
   */
  beforeTiles: MosaicTile[] | null
  moved: boolean
}

const shownIndex = (o: LetterMosaicObject): number => useUiStore.getState().mosaicStates[o.id] ?? 0

const coordinatesOf = (o: LetterMosaicObject) => {
  const state = activeState(o, shownIndex(o))
  return { x: state?.x ?? {}, y: state?.y ?? {} }
}

/** Two edges are the same edge when they move the same line. */
const sameEdge = (a: MosaicEdge, b: MosaicEdge): boolean => a.axis === b.axis && a.id === b.id

/**
 * How far the selection reaches along the axis a line runs down.
 *
 * In fractions, because that is what a fork is measured in. Null when the
 * selection holds nothing that is still in the mosaic.
 */
function selectionSpans(
  object: LetterMosaicObject,
  selection: readonly string[],
  axis: 'x' | 'y',
): Span[] {
  const state = activeState(object, shownIndex(object))
  if (!state) return []
  return selectionRuns(object.tiles, state.x, state.y, axis, selection)
}

/** A point on an edge's line, at `along` on the axis it runs down. */
const pointOnEdge = (edge: MosaicEdge, along: number): Vec2 =>
  edge.axis === 'x' ? { x: edge.position, y: along } : { x: along, y: edge.position }

/**
 * The cursor for an edge, measured on SCREEN rather than in the model.
 *
 * A mosaic can be turned, and a vertical edge in its own space is not vertical
 * on the artboard once it is — naming the axis by its local direction alone
 * would put an east-west cursor on a line running up the screen.
 */
function cursorFor(edge: MosaicEdge, object: LetterMosaicObject): string {
  const axis =
    edge.axis === 'x'
      ? vectorObjectToArtboard(object.transform, { x: 1, y: 0 })
      : vectorObjectToArtboard(object.transform, { x: 0, y: 1 })
  // Folded into a half turn: a drag axis has an orientation, not a direction.
  const degrees = ((Math.atan2(axis.y, axis.x) * 180) / Math.PI + 180) % 180
  if (degrees < 22.5 || degrees >= 157.5) return 'ew-resize'
  if (degrees < 67.5) return 'nwse-resize'
  if (degrees < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

interface MosaicLayerProps {
  canvas: FabricCanvas | null
  /**
   * The mosaic whose tiles are on show: the one being typed into, or failing
   * that the one selected.
   *
   * Selection is enough because the tile edges are what the spacing controls
   * move, and adjusting them means focus is in the panel rather than on the
   * canvas — so tying the outlines to typing hid them exactly when they were
   * being changed.
   */
  object: LetterMosaicObject | undefined
}

/**
 * The caret in a mosaic, and the keyboard that fills it.
 *
 * Modelled on `PathLayer`: markers drawn straight onto the Fabric canvas rather
 * than into the document, live values held in a ref so the handlers register
 * once, and every decision about what a keystroke MEANS made by the pure
 * functions in `mosaic/typing.ts` rather than here.
 *
 * The caret is a tile, not a position between characters. A tile holds one
 * character, so there is nowhere within it to be — which is why typing into a
 * full tile replaces rather than inserts, and why an empty tile is somewhere the
 * caret can happily sit.
 */
export function MosaicLayer({ canvas, object }: MosaicLayerProps) {
  const shapesRef = useRef<FabricObject[]>([])
  /** The caret's blink timer, cleared wherever the overlay is cleared. */
  const blinkRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const typing = useUiStore((s) => s.typing)
  const selection = useUiStore((s) => s.mosaicSelection)
  const focus = object && typing?.object === object.id ? typing.leaf : null

  /**
 * A handle that has been pressed but not yet dragged.
 *
 * The press does not decide. A handle's reach reaches into the neighbouring
 * tile, so a press near an edge is as likely to mean "select that tile" as
 * "resize this one" — and only moving tells them apart.
 */
interface Pending {
  grabbed: MosaicEdge
  from: Vec2
  tolerance: { x: number; y: number }
  shift: boolean
}

/** The handle being dragged, and what it needs to know to finish. */
  const gestureRef = useRef<Gesture | null>(null)
  /** A handle pressed and not yet moved. See `Pending`. */
  const pendingRef = useRef<Pending | null>(null)
  /** A press inside the mosaic, which becomes a marquee if it travels. */
  const marqueeRef = useRef<{ from: Vec2; add: boolean; band: Rect | null } | null>(null)
  /** Where the pointer last was, since a release carries no position of its own. */
  const lastPointRef = useRef<Vec2 | null>(null)
  /**
   * The mosaic on show, for handlers bound once to the canvas to read.
   *
   * A ref rather than the prop: the pointer effect depends only on `canvas`, so
   * anything it closes over is frozen at the moment it was bound.
   */
  const objectIdRef = useRef<string | null>(null)
  objectIdRef.current = object?.id ?? null
  /** Screen-pixels-to-object-units at the moment of release, for the slop test. */
  const releaseToleranceRef = useRef<{ x: number; y: number } | null>(null)
  /*
   * Which handle is under the pointer, and which is being dragged, are STATE:
   * the overlay is drawn from them, so they have to cause a render. What changes
   * on every pointer sample lives in the ref, which must not.
   */
  const [hovered, setHovered] = useState<MosaicEdge | null>(null)
  const [active, setActive] = useState<MosaicEdge | null>(null)
  const [limited, setLimited] = useState(false)

  // Memoised because the draw effect depends on it: rebuilt every render, the
  // whole overlay would be torn down and re-added on renders that changed nothing.
  const shown = useUiStore((s) => (object ? (s.mosaicStates[object.id] ?? 0) : 0))
  /*
   * Playback owns the canvas while it runs.
   *
   * No handles, no resizing and no typing: what is on screen is an interpolated
   * frame that belongs to no state, and editing it would mean writing a drag
   * into whichever state happened to be selected while looking at a different
   * picture. Pausing does not change that — to edit, pick an authored state.
   */
  const previewing = useUiStore((s) => {
    if (!object) return false
    // Either way in: the panel's own transport, or the global play button, which
    // runs every mosaic that has an animation.
    if (s.mosaicPlayback?.object === object.id) return true
    return s.playing && mosaicMoves(object)
  })

  const tiles = useMemo(() => (object ? mosaicTiles(object, shown) : null), [object, shown])

  /*
   * A counter that ticks while the object is being dragged, scaled or turned.
   *
   * Fabric writes the result back only when the gesture ends, so nothing in the
   * document changes in between and the overlay would never redraw. This is what
   * makes the outlines travel with the mosaic instead of waiting at the old spot.
   */
  const [dragging, setDragging] = useState(0)
  useEffect(() => {
    if (!canvas) return
    const bump = (): void => setDragging((n) => n + 1)
    canvas.on('object:moving', bump)
    canvas.on('object:scaling', bump)
    canvas.on('object:rotating', bump)
    return () => {
      canvas.off('object:moving', bump)
      canvas.off('object:scaling', bump)
      canvas.off('object:rotating', bump)
    }
  }, [canvas])

  /*
   * The edges that can be grabbed: the selected tiles', and nobody else's.
   *
   * Every boundary at once meant a line lit up wherever the pointer happened to
   * be, with no way to tell which of the dozens on screen was about to move.
   * Asking for a tile first turns that into "which edge of this one" — and
   * selecting several tiles that line up gives one handle that moves them
   * together, which is the only way to resize a column whose tiles belong to
   * different splits.
   */
  const handles = useMemo(() => {
    if (!object || previewing) return []
    const { x, y } = coordinatesOf(object)
    // The spacing of the state on show. Gap and padding are per state, and
    // handles built from another state's numbers sit beside the edge they move.
    return selectionEdges(
      object.tiles,
      x,
      y,
      object.localBounds,
      mosaicSpacing(object, shown),
      selection,
    )
  }, [object, selection, previewing, shown])

  /* Draw the tile outlines, and the caret when there is one. */
  useEffect(() => {
    if (!canvas) return

    const clear = (): void => {
      /*
       * The blink goes with the caret it blinks.
       *
       * Cleared HERE rather than in the effect's cleanup, because `clear` runs
       * on both — at the top of every redraw and again on teardown — and a timer
       * left running would go on toggling a Fabric object that had been taken
       * off the canvas, once per redraw, forever.
       */
      if (blinkRef.current !== null) {
        clearInterval(blinkRef.current)
        blinkRef.current = null
      }
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }

    clear()
    /*
     * Nothing of the editor while a preview runs.
     *
     * The outlines and the caret describe an authored state, and what is on
     * screen during playback is a frame between two of them — so they would be
     * drawn around tiles that have moved out from under them. The mosaic itself
     * stays selectable; it is the editing furniture that goes.
     */
    if (!object || !tiles || previewing) {
      canvas.requestRenderAll()
      return
    }

    const zoom = canvas.getZoom() || 1
    /*
     * The LIVE transform, not the stored one. Fabric moves the group as the
     * pointer moves and only writes the result back when the gesture ends, so
     * outlines drawn from the document sat where the mosaic had been and caught
     * up only on release — the mosaic appeared to leave its own grid behind.
     */
    const toArtboard = (p: Vec2): Vec2 =>
      pointObjectToArtboard(liveTransform(canvas, object.id, object.transform), p)

    const shared = {
      selectable: false,
      evented: false,
      objectCaching: false,
      strokeUniform: true,
    } as const

    /*
     * Every tile, faintly, whenever the mosaic is selected.
     *
     * An empty tile draws nothing of its own — no letter, and a background only
     * where one has been chosen — so an untyped mosaic is invisible, and there
     * is nothing to aim a click at. These are an editing affordance rather than
     * artwork: they live on the overlay, so they are never exported and never
     * confused with a tile that has actually been given a colour.
     *
     * Dashed for that last reason, and it earns its keep twice: a dashed line is
     * plainly a guide rather than a drawn border, and the rhythm of the dashes
     * stays readable over light and dark artwork alike, where a faint solid line
     * would disappear into one or the other.
     */
    for (const [id, each] of tiles) {
      if (id === focus) continue
      const p = toArtboard({ x: each.visible.x, y: each.visible.y })
      const q = toArtboard({
        x: each.visible.x + each.visible.width,
        y: each.visible.y + each.visible.height,
      })
      const outline = new Rect({
        ...shared,
        left: (p.x + q.x) / 2,
        top: (p.y + q.y) / 2,
        width: Math.abs(q.x - p.x),
        height: Math.abs(q.y - p.y),
        originX: 'center',
        originY: 'center',
        fill: 'transparent',
        stroke: FOCUS_COLOR(),
        strokeWidth: 1 / zoom,
        strokeDashArray: [4 / zoom, 3 / zoom],
        opacity: OUTLINE_OPACITY,
      })
      outline.set('gridRole', 'mosaicTile')
      canvas.add(outline)
      shapesRef.current.push(outline)
    }

    /*
     * The selected tiles, outlined more strongly than the rest.
     *
     * Outlined rather than filled: the letter inside has to stay readable, since
     * the whole point of selecting a tile is to work on what is in it as well as
     * on how big it is.
     */
    for (const id of selection) {
      if (id === focus) continue
      const each = tiles.get(id)
      if (!each) continue
      const p = toArtboard({ x: each.visible.x, y: each.visible.y })
      const q = toArtboard({
        x: each.visible.x + each.visible.width,
        y: each.visible.y + each.visible.height,
      })
      /*
       * Two strokes, dark under light.
       *
       * A tile can now carry any colour at all, and one mint line disappears on
       * a mint tile. A dark halo under a light stroke reads on both: whichever
       * of the two the fill swallows, the other survives.
       */
      const box = {
        ...shared,
        left: (p.x + q.x) / 2,
        top: (p.y + q.y) / 2,
        width: Math.abs(q.x - p.x),
        height: Math.abs(q.y - p.y),
        originX: 'center' as const,
        originY: 'center' as const,
        fill: 'transparent',
      }
      const halo = new Rect({ ...box, stroke: '#12151a', strokeWidth: 3.5 / zoom, opacity: 0.55 })
      halo.set('gridRole', 'mosaicSelected')
      canvas.add(halo)
      shapesRef.current.push(halo)

      const outline = new Rect({ ...box, stroke: FOCUS_COLOR(), strokeWidth: 2 / zoom })
      outline.set('gridRole', 'mosaicSelected')
      canvas.add(outline)
      shapesRef.current.push(outline)
    }

    /*
     * The tiles a drag would resize, while an edge is hovered or held.
     *
     * Some edges move only what is selected; others move more — a tile's top
     * edge is really its whole row's, because a guillotine tree gives a row one
     * height. Showing the reach is what keeps that from being a surprise.
     */
    const reaching = active ?? hovered
    if (reaching) {
      for (const id of reaching.moves) {
        if (selection.includes(id)) continue
        const each = tiles.get(id)
        if (!each) continue
        const p = toArtboard({ x: each.visible.x, y: each.visible.y })
        const q = toArtboard({
          x: each.visible.x + each.visible.width,
          y: each.visible.y + each.visible.height,
        })
        const wash = new Rect({
          ...shared,
          left: (p.x + q.x) / 2,
          top: (p.y + q.y) / 2,
          width: Math.abs(q.x - p.x),
          height: Math.abs(q.y - p.y),
          originX: 'center',
          originY: 'center',
          fill: FOCUS_COLOR(),
          opacity: 0.12,
          strokeWidth: 0,
        })
        wash.set('gridRole', 'mosaicReach')
        canvas.add(wash)
        shapesRef.current.push(wash)
      }
    }

    /*
     * The grab handles, drawn along the selected tiles' own edges.
     *
     * A line rather than a square at each corner: what moves is the whole edge,
     * and a handle shaped like the thing it moves says so without a legend. The
     * hovered one thickens; the one being dragged turns to the limit colour when
     * it has nowhere further to go.
     */
    for (const handle of handles) {
      const isHovered = hovered !== null && sameEdge(handle, hovered)
      const isActive = active !== null && sameEdge(handle, active)
      const strong = isHovered || isActive
      /*
       * Solid when the line is the selection's own — it moves the selected tiles
       * and the ones directly opposite. Dashed when it is SHARED with tiles the
       * selection did not ask about, which is alignment doing its job: those
       * tiles read the same number, so they move together. The dashes say "this
       * one is shared" before it is grabbed, and the tint says with what.
       */
      const broad = collateral(handle, selection) > 2

      const a0 = toArtboard(pointOnEdge(handle, handle.from))
      const b0 = toArtboard(pointOnEdge(handle, handle.to))
      const line = new Line([a0.x, a0.y, b0.x, b0.y], {
        ...shared,
        stroke: isActive && limited ? LIMIT_COLOR : FOCUS_COLOR(),
        strokeWidth: (strong ? 4 : 2.5) / zoom,
        opacity: strong ? 1 : broad ? 0.5 : 0.85,
        strokeDashArray: broad ? [6 / zoom, 4 / zoom] : undefined,
      })
      line.set('gridRole', 'mosaicHandle')
      canvas.add(line)
      shapesRef.current.push(line)
    }

    const tile = focus ? tiles.get(focus) : null
    if (!tile) {
      canvas.requestRenderAll()
      return clear
    }

    const a = toArtboard({ x: tile.visible.x, y: tile.visible.y })
    const b = toArtboard({
      x: tile.visible.x + tile.visible.width,
      y: tile.visible.y + tile.visible.height,
    })

    // The focused tile, outlined rather than filled: a fill would hide the
    // letter, and the tile may already have a background colour of its own.
    // Solid where the others are dashed, so the caret's tile is unmistakable.
    const ring = new Rect({
      ...shared,
      left: (a.x + b.x) / 2,
      top: (a.y + b.y) / 2,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      originX: 'center',
      originY: 'center',
      fill: 'transparent',
      stroke: FOCUS_COLOR(),
      strokeWidth: 2 / zoom,
    })
    ring.set('gridRole', 'mosaicFocus')
    canvas.add(ring)
    shapesRef.current.push(ring)

    /*
     * The caret itself, down the left of the tile.
     *
     * Drawn OVER the glyph and in the accent colour so it stays visible against
     * a tile that has been given a background — and inset a little, so it reads
     * as being inside the tile rather than as part of its outline.
     */
    const inset = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 0.12
    const caret = new Line(
      [
        Math.min(a.x, b.x) + inset,
        Math.min(a.y, b.y) + inset,
        Math.min(a.x, b.x) + inset,
        Math.max(a.y, b.y) - inset,
      ],
      { ...shared, stroke: FOCUS_COLOR(), strokeWidth: 2.5 / zoom },
    )
    caret.set('gridRole', 'mosaicCaret')
    canvas.add(caret)
    shapesRef.current.push(caret)

    /*
     * And it blinks, the way a caret in any text field does.
     *
     * A still bar is read as a mark on the drawing rather than as a place to
     * type — the blink is the whole of what says "your keystrokes land here".
     *
     * The phase restarts from LIT every time this effect runs, which is every
     * keystroke and every move of the caret. That is deliberate and it is what
     * real carets do: catching the blink mid-dark just as you type reads as the
     * editor missing the key. Redrawing is what resets it, so the two can never
     * drift apart.
     */
    let lit = true
    blinkRef.current = setInterval(() => {
      lit = !lit
      caret.set({ visible: lit })
      canvas.requestRenderAll()
    }, CARET_BLINK_MS)

    canvas.requestRenderAll()
    return clear
  }, [canvas, object, focus, tiles, selection, handles, hovered, active, limited, previewing, dragging])

  /*
   * Clicking a tile, and dragging its edges.
   *
   * One handler for both, and that is the point: selecting a tile and resizing
   * it are the same activity, so they cannot be two modes competing for the same
   * press. A press on a handle resizes; anything else is about which tile you
   * are working on.
   */
  useEffect(() => {
    if (!canvas) return

    /**
     * The mosaic these presses belong to, as the STORES have it — never a
     * render-time copy.
     *
     * `typing` and nothing else, because `typing` is what INSIDE means. A
     * merely-selected mosaic is still Fabric's to drag, and taking its presses
     * here would break moving it. Double-click to come in; Escape to leave.
     */
    const live = (): LetterMosaicObject | null => {
      const id = useUiStore.getState().typing?.object
      if (!id) return null
      const found = useDocumentStore.getState().doc.objects[id]
      return found && found.kind === 'mosaic' ? found : null
    }

    /** Pointer in the mosaic's own space, with the hover reach in those units. */
    const at = (e: Event, target: LetterMosaicObject) => {
      const scene = canvas.getScenePoint(e as MouseEvent)
      const zoom = canvas.getZoom() || 1
      /*
       * Screen pixels into local units PER AXIS, through the object's own
       * transform. One scalar would be wrong the moment a mosaic is scaled
       * unevenly, and measuring in local space is what keeps a drag correct
       * after the object has been moved, turned or stretched.
       */
      const ex = vectorObjectToArtboard(target.transform, { x: 1, y: 0 })
      const ey = vectorObjectToArtboard(target.transform, { x: 0, y: 1 })
      const perX = Math.hypot(ex.x, ex.y) * zoom
      const perY = Math.hypot(ey.x, ey.y) * zoom
      return {
        point: pointArtboardToObject(target.transform, scene),
        tolerance: {
          x: perX > 0 ? HOVER_PIXELS / perX : HOVER_PIXELS,
          y: perY > 0 ? HOVER_PIXELS / perY : HOVER_PIXELS,
        },
      }
    }

    const handlesFor = (target: LetterMosaicObject, chosen: readonly string[]): MosaicEdge[] => {
      const { x, y } = coordinatesOf(target)
      return selectionEdges(
        target.tiles,
        x,
        y,
        target.localBounds,
        mosaicSpacing(target, shownIndex(target)),
        chosen,
      )
    }

    const onDown = (opt: { e: Event }): void => {
      const target = live()
      if (!target) return
      /*
       * A press on a mosaic that is previewing LEAVES the preview.
       *
       * A frame is not editable — paused or not, it belongs to no state, and a
       * drag begun on one would write itself into whichever state happened to be
       * selected. But refusing the press and leaving it at that made the mosaic a
       * dead end: pausing kept the preview on screen, so every later click did
       * nothing and the object looked broken.
       *
       * So the press is spent going back: playback stops, the authored state
       * returns, and the next press edits it. That is what the brief means by
       * beginning an edit returning to the nearest authored state — never
       * editing an interpolated frame.
       */
      const ui0 = useUiStore.getState()
      const shownAsFrame =
        ui0.mosaicPlayback?.object === target.id || (ui0.playing && mosaicMoves(target))
      if (shownAsFrame) {
        // Whichever clock is driving it stops. Reaching for a mosaic is asking
        // to edit it, and an interpolated frame is not editable.
        ui0.stopMosaicPlayback()
        if (ui0.playing) ui0.setPlaying(false)
        return
      }
      const ui = useUiStore.getState()
      const { point, tolerance } = at(opt.e, target)

      /*
       * Handles answer first, and the marquee gets everything else.
       *
       * These used to be two modes: the Design tab tested edges and clicked
       * tiles, the Colour tab swept a marquee and had no handles at all. Which
       * meant you could never sweep while reshaping, nor nudge an edge while
       * choosing tiles, and the mode was chosen in a panel across the screen.
       *
       * They compose without a switch because a handle is a VISIBLE, precise
       * target — it is drawn on the selected tiles and reaches seven screen
       * pixels — while a marquee starts anywhere else. The old objection was
       * that a press near a selected tile's edge armed a resize instead of
       * taking the tile; that is answered below by holding the press rather
       * than acting on it, in both branches. Move, and it is a resize or a
       * sweep; let go without moving, and it was a click on the tile under it.
       */
      const grabbed = edgeAt(handlesFor(target, ui.mosaicSelection), point, tolerance)
      if (grabbed) {
        /*
         * Held, not started.
         *
         * A handle's reach is seven screen pixels either side of the line, and
         * the outer half of that lies inside the NEIGHBOURING tile — so pressing
         * on a tile next to the selected one to select it grabbed the edge
         * instead, and the tile would not take. Reported as glyphs near the
         * selection being hard to click, which is exactly what it was.
         *
         * Narrowing the reach would only move the problem: it has to be
         * generous, because it is how an edge is grabbed at all. The press
         * simply does not have to decide. Move, and it is a resize; let go
         * without moving, and it was a click and the tile under it is selected.
         *
         * Nothing is forked here either. Detaching lines is what a drag does, so
         * a press that turns out to be a click no longer mints coordinates and
         * merges them away again on release.
         */
        pendingRef.current = { grabbed, from: point, tolerance, shift: (opt.e as MouseEvent).shiftKey }
        setActive(grabbed)
        return
      }

      /*
       * A press outside the mosaic's own box leaves text entry — that is a press
       * on the artboard or on something else, and carrying on typing into a
       * mosaic nobody is looking at would be wrong. The BOX rather than the
       * tiles, which stop short of it wherever there is outer padding.
       */
      const b = target.localBounds
      const within =
        point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height
      if (!within) {
        ui.setTyping(null)
        if (!(opt.e as MouseEvent).shiftKey) ui.setMosaicSelection([])
        return
      }

      // Inside, and not on a handle. Held, not acted on: move and it is a
      // marquee across the tiles, let go and it was a click on the one under it.
      marqueeRef.current = { from: point, add: (opt.e as MouseEvent).shiftKey, band: null }
    }

    /** Every tile whose visible rectangle meets a box, in object space. */
    const tilesWithin = (target: LetterMosaicObject, a: Vec2, b: Vec2): string[] => {
      const left = Math.min(a.x, b.x)
      const right = Math.max(a.x, b.x)
      const top = Math.min(a.y, b.y)
      const bottom = Math.max(a.y, b.y)
      const out: string[] = []
      for (const [id, tile] of mosaicTiles(target, shownIndex(target))) {
        const r = tile.visible
        // Touching counts, not containing: dragging across a row should take the
        // whole row, not only the tiles swallowed whole.
        if (r.x < right && r.x + r.width > left && r.y < bottom && r.y + r.height > top) {
          out.push(id)
        }
      }
      return out
    }

    /** Put the caret and the selection on the tile under a point. */
    const selectAt = (target: LetterMosaicObject, point: Vec2, shift: boolean): void => {
      const ui = useUiStore.getState()
      // In the state on show. Its tiles are where the press was aimed.
      const leaf = tileAt(target, point, shownIndex(target))
      if (!leaf) return

      // Shift extends the selection, which is how several tiles come to share
      // one handle.
      if (shift) {
        const adding = !ui.mosaicSelection.includes(leaf)
        ui.toggleMosaicSelection(leaf)
        // The caret follows a tile being ADDED, but not one being taken out —
        // putting it on a tile just deselected would select it again.
        if (adding) ui.setTyping({ object: target.id, leaf })
        return
      }

      ui.setMosaicSelection([leaf])
      ui.setTyping({ object: target.id, leaf })
    }

    /**
     * Turn a held handle into a real drag: detach what it moves, and record
     * where everything started.
     *
     * Everything the press used to do the moment it landed. Returns false when
     * the edge has gone — a fork can leave the grabbed line naming nothing.
     */
    const beginResize = (pending: Pending): boolean => {
      const target = live()
      if (!target) return false
      const ui = useUiStore.getState()
      const { grabbed, from: point, tolerance } = pending

      /*
       * Detach the line first, when it is shared with tiles nobody selected.
       *
       * Tiles reading one number stay in line, which is what makes a grid a
       * grid — but it also means dragging one tile's edge would drag its whole
       * column. So the line is split for the selection before the drag starts:
       * what moves is what was chosen, and everything around it responds.
       */
      let edge = grabbed
      let beforeTiles: MosaicTile[] | null = null
      const spans = selectionSpans(target, ui.mosaicSelection, grabbed.axis)

      if (spans.length > 0) {
        /*
         * Every line the drag will move, not only the one grabbed. Resizing a
         * block scales the lines INSIDE it too, and those are just as shared as
         * its outer edge.
         */
        for (const line of [grabbed.id, ...(grabbed.block?.interior ?? [])]) {
          const now = live()
          if (!now) return false
          const found = handlesFor(now, ui.mosaicSelection).find(
            (e) => e.axis === grabbed.axis && e.id === line,
          )
          // Nothing to detach when the line already stops at the selection.
          if (!found) continue
          const values = coordinatesOf(now)
          if (!reachesBeyond(found, now.tiles, values.x, values.y, spans)) continue
          if (
            useDocumentStore
              .getState()
              .forkMosaicCoordinate(now.id, grabbed.axis, line, spans, shownIndex(now))
          ) {
            beforeTiles = beforeTiles ?? target.tiles
          }
        }

        const after = live()
        if (!after) return false
        // The detached lines sit exactly where the old ones did, so the same
        // press finds the edge — and it now moves only what was selected.
        const fresh = edgeAt(handlesFor(after, ui.mosaicSelection), point, tolerance)
        if (fresh) edge = fresh
      }

      const current = live() ?? target
      const values = coordinatesOf(current)[edge.axis]
      const before: Record<string, number> = {}
      for (const line of [edge.id, ...(edge.block?.interior ?? [])]) {
        if (values[line] !== undefined) before[line] = values[line] as number
      }
      if (before[edge.id] === undefined) return false

      gestureRef.current = { edge, from: point, before, beforeTiles, moved: beforeTiles !== null }
      setActive(edge)
      return true
    }

    const onMove = (opt: { e: Event }): void => {
      const target = live()
      if (!target) return
      const { point, tolerance } = at(opt.e, target)

      /*
       * Far enough to be a drag? Then it was a resize all along.
       *
       * A few pixels of slop, so a press that shifts by a hair while the button
       * goes down is still a click. Measured in the same screen pixels the
       * handle's reach is, so it feels the same at any zoom.
       */
      const marquee = marqueeRef.current
      if (marquee) {
        const target2 = live()
        if (!target2) return
        const slopX = (tolerance.x * DRAG_SLOP_PIXELS) / HOVER_PIXELS
        const slopY = (tolerance.y * DRAG_SLOP_PIXELS) / HOVER_PIXELS
        if (
          marquee.band === null &&
          Math.abs(point.x - marquee.from.x) < slopX &&
          Math.abs(point.y - marquee.from.y) < slopY
        ) {
          return
        }

        const a = pointObjectToArtboard(
          liveTransform(canvas, target2.id, target2.transform),
          marquee.from,
        )
        const b = pointObjectToArtboard(
          liveTransform(canvas, target2.id, target2.transform),
          point,
        )
        if (!marquee.band) {
          const band = new Rect({
            selectable: false,
            evented: false,
            excludeFromExport: true,
            originX: 'center',
            originY: 'center',
            fill: FOCUS_COLOR(),
            opacity: 0.14,
            stroke: FOCUS_COLOR(),
            strokeWidth: 1 / (canvas.getZoom() || 1),
          })
          band.set('gridRole', 'mosaicMarquee')
          canvas.add(band)
          marquee.band = band
        }
        marquee.band.set({
          left: (a.x + b.x) / 2,
          top: (a.y + b.y) / 2,
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y),
        })
        marquee.band.setCoords()
        canvas.requestRenderAll()
        return
      }

      const pending = pendingRef.current
      if (pending) {
        const slopX = (pending.tolerance.x * DRAG_SLOP_PIXELS) / HOVER_PIXELS
        const slopY = (pending.tolerance.y * DRAG_SLOP_PIXELS) / HOVER_PIXELS
        if (
          Math.abs(point.x - pending.from.x) < slopX &&
          Math.abs(point.y - pending.from.y) < slopY
        ) {
          return
        }
        pendingRef.current = null
        if (!beginResize(pending)) {
          setActive(null)
          return
        }
      }

      const gesture = gestureRef.current
      if (gesture) {
        const vertical = gesture.edge.axis === 'x'
        const offset = vertical ? point.x - gesture.from.x : point.y - gesture.from.y

        /*
         * From the value captured at pointer-down, every frame. The store already
         * holds the last frame's, so feeding that back in would compound the drag
         * and the line would drift away from the pointer.
         */
        const { x, y } = coordinatesOf(target)
        const base = gesture.edge.axis === 'x' ? { ...x, ...gesture.before } : x
        const baseY = gesture.edge.axis === 'y' ? { ...y, ...gesture.before } : y
        const result = moveEdge(
          target.tiles,
          base,
          baseY,
          target.localBounds,
          mosaicSpacing(target, shownIndex(target)),
          gesture.edge.axis,
          gesture.edge.id,
          offset,
          gesture.edge.block,
          // Alt drags free of the grid, read every frame so it can be taken and
          // released mid-gesture rather than decided at pointer-down.
          (opt.e as MouseEvent).altKey ? 0 : target.snapStep,
        )
        if (!result) return

        setLimited(result.clamped)
        const current = coordinatesOf(target)[gesture.edge.axis]
        const changed = result.updates.filter((u) => current[u.id] !== u.value)
        if (changed.length > 0) {
          gestureRef.current = { ...gesture, moved: true }
          useDocumentStore
            .getState()
            .setMosaicCoordinates(target.id, gesture.edge.axis, changed, shownIndex(target))
        }
        return
      }

      const found = edgeAt(handlesFor(target, useUiStore.getState().mosaicSelection), point, tolerance)
      setHovered((was) => (was && found && sameEdge(was, found) ? was : found))
      canvas.defaultCursor = found ? cursorFor(found, target) : 'default'
    }

    /** End the drag: keep what it did, or put it back. */
    const finish = (cancel: boolean): void => {
      /*
       * Let go without moving and it was never a resize — it was a click, and a
       * click selects the tile under it. This is what makes a tile beside the
       * selected one reachable: its edge may have taken the press, but the press
       * only becomes a drag by moving.
       */
      const marquee = marqueeRef.current
      if (marquee) {
        marqueeRef.current = null
        if (marquee.band) canvas.remove(marquee.band)
        const target = live()
        if (!target || cancel) {
          canvas.requestRenderAll()
          return
        }
        const ui = useUiStore.getState()
        const to = lastPointRef.current ?? marquee.from
        /*
         * Decided by where the pointer ENDED, not by whether a band was drawn.
         *
         * The band is drawn from move events, and how many of those arrive is
         * not something to rely on — a fast drag can deliver two, and a harness
         * one. Measuring the release against the press is the same question
         * asked of something that always exists.
         */
        const box = releaseToleranceRef.current ?? { x: HOVER_PIXELS, y: HOVER_PIXELS }
        const travelled =
          Math.abs(to.x - marquee.from.x) >= (box.x * DRAG_SLOP_PIXELS) / HOVER_PIXELS ||
          Math.abs(to.y - marquee.from.y) >= (box.y * DRAG_SLOP_PIXELS) / HOVER_PIXELS

        if (travelled) {
          // A sweep takes everything it touched; shift adds to what was there.
          const hit = tilesWithin(target, marquee.from, to)
          const next = marquee.add ? [...new Set([...ui.mosaicSelection, ...hit])] : hit
          ui.setMosaicSelection(next)
          /*
           * And the caret stays inside.
           *
           * `typing` is what INSIDE means now, so dropping it here would eject
           * you from the mosaic on every sweep — one drag to choose a row, and
           * the next press moves the whole object. It goes to a tile the sweep
           * actually took, which is also what keeps `setTyping` from collapsing
           * the selection back to one: the caret's tile is already in it.
           */
          const last = next[next.length - 1]
          if (last) ui.setTyping({ object: target.id, leaf: last })
        } else {
          // Never travelled: a click, which selects the tile under it.
          selectAt(target, marquee.from, marquee.add)
        }
        canvas.requestRenderAll()
        return
      }

      const pending = pendingRef.current
      if (pending) {
        pendingRef.current = null
        setActive(null)
        const target = live()
        if (target && !cancel) selectAt(target, pending.from, pending.shift)
        return
      }

      const gesture = gestureRef.current
      if (!gesture) return
      gestureRef.current = null
      setActive(null)
      setLimited(false)

      const target = live()
      if (!target) return

      if (cancel) {
        // Straight back to where the gesture started, uncommitted — an abandoned
        // drag should leave the history untouched, including any line it had to
        // detach on the way in.
        useDocumentStore.getState().setMosaicCoordinates(
          target.id,
          gesture.edge.axis,
          Object.entries(gesture.before).map(([id, value]) => ({ id, value })),
          shownIndex(target),
        )
        if (gesture.beforeTiles) {
          useDocumentStore.getState().updateMosaic(target.id, { tiles: gesture.beforeTiles })
        }
        return
      }
      // One entry for the whole gesture. A press that moved nothing writes
      // nothing, and `commit` ignores a document identical to its baseline.
      if (!gesture.moved) return

      /*
       * Lines that came to rest on the same value are one line again.
       *
       * This is what makes the fork at pointer-down reversible, and it is only
       * reachable because snapping puts two separate drags on the very same
       * number. Before the commit, so rejoining belongs to the same history
       * entry as the drag that caused it — and so a gesture that forked a line
       * and then moved nowhere undoes its own fork here, leaving the document
       * identical to its baseline and no undo step behind at all.
       *
       * Only the lines this gesture wrote: every coincidence in the mosaic being
       * fair game would let one drag silently join two others elsewhere.
       */
      const store = useDocumentStore.getState()
      store.mergeMosaicCoordinates(
        target.id,
        gesture.edge.axis,
        new Set([gesture.edge.id, ...(gesture.edge.block?.interior ?? [])]),
      )
      store.commit('Resize tiles')
    }

    /*
     * The release carries a position, and it is the one that matters.
     *
     * Taking the marquee's far corner from the last MOVE assumes moves keep
     * arriving right up to the button coming up. They do not always: a fast drag
     * can deliver two, and the band then ends wherever the last one landed
     * rather than under the pointer.
     */
    const release = (e: Event): void => {
      const target = live()
      if (target) {
        const here = at(e, target)
        lastPointRef.current = here.point
        releaseToleranceRef.current = here.tolerance
      }
      finish(false)
    }

    const onUp = (opt: { e: Event }): void => release(opt.e)

    /*
     * The same release, from the window.
     *
     * This is not only the net for a button coming up somewhere the canvas never
     * hears about — it is normally the FIRST to hear about it. `pointerup`
     * precedes the compatibility `mouseup` that Fabric listens for, so on every
     * ordinary release this runs before `mouse:up` does, and whichever runs
     * first is the one that ends the gesture.
     *
     * So it cannot be a positionless fallback. It ran first, finished the
     * marquee with no release point at all, and every sweep was therefore
     * measured as having travelled nowhere — which is to say, every drag in the
     * Colour tab was read as a click on the tile it started from. It takes the
     * position from its own event for exactly the same reason `mouse:up` does,
     * and the later `mouse:up` then finds the gesture already finished.
     */
    const onWindowUp = (e: Event): void => release(e)

    /*
     * Focus lost with a button still down. There is no release position to be
     * had here — the gesture simply ends where it had got to. Ended rather than
     * left open: an edge that keeps following the mouse after the button is up
     * is the worst way this can go wrong.
     */
    const onBlur = (): void => finish(false)

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    window.addEventListener('pointerup', onWindowUp)
    window.addEventListener('blur', onBlur)

    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      window.removeEventListener('pointerup', onWindowUp)
      window.removeEventListener('blur', onBlur)
      canvas.defaultCursor = 'default'
    }
  }, [canvas])

  /* A gesture must not outlive the thing it was dragging. */
  useEffect(() => {
    if (!object) {
      gestureRef.current = null
      pendingRef.current = null
      setActive(null)
      setHovered(null)
      setLimited(false)
    }
  }, [object])

  /*
   * A tile selection belongs to ONE mosaic, so it ends when that mosaic does.
   *
   * Leaf ids from a mosaic nobody is looking at would be a selection the panel
   * counts and reports while no tile on screen is in it, and every write against
   * them would be silently dropped for naming leaves the current mosaic has not
   * got. Keyed on the id: the object itself is a fresh value on every edit.
   */
  const editingId = object?.id
  useEffect(() => {
    return () => {
      const ui = useUiStore.getState()
      if (ui.mosaicSelection.length > 0) ui.setMosaicSelection([])
      if (ui.typing) ui.setTyping(null)
    }
  }, [editingId])

  /* The keyboard. */
  useEffect(() => {
    /**
     * The mosaic and the caret as the STORES have them, not as the last render
     * saw them.
     *
     * Keystrokes arrive faster than React re-renders — hold a key down and a
     * dozen land inside one frame. Reading a ref that is refreshed during render
     * meant every one of those applied to the tree as it was before the first,
     * so typing five letters quickly put one letter in and threw four away. The
     * stores are updated synchronously, so they are always current.
     */
    const live = () => {
      const at = useUiStore.getState().typing
      if (!at) return null
      const object = useDocumentStore.getState().doc.objects[at.object]
      if (!object || object.kind !== 'mosaic') return null
      const layout = mosaicTiles(object, shownIndex(object))
      if (!layout.has(at.leaf)) return null
      return { object, leaf: at.leaf, layout }
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && isFormField(e.target)) return
      const current = live()
      if (!current) return
      const { object: target, leaf: at, layout } = current

      const store = useDocumentStore.getState()
      const ui = useUiStore.getState()
      const order = readingOrder(layout)
      const modified = e.metaKey || e.ctrlKey || e.altKey

      /** Apply a change to the tree, and move the caret with it. */
      /*
       * Written into the state on show, not onto the tiles.
       *
       * Letters belong to a composition now, so typing edits the state being
       * looked at — and carries forward through the ones that are still copies
       * of it, which is what keeps a word typed into a fresh mosaic appearing in
       * all of them.
       */
      const apply = (
        result: { chars: Record<string, string>; focus: string | null },
        label: string,
      ): void => {
        store.setMosaicChars(target.id, shownIndex(target), result.chars)
        store.commit(label)
        if (result.focus) ui.setTyping({ object: target.id, leaf: result.focus })
      }

      const move = (leaf: string | null): void => {
        if (leaf) ui.setTyping({ object: target.id, leaf })
      }

      switch (e.key) {
        case 'Escape': {
          e.preventDefault()
          /*
           * Escape during a drag cancels the DRAG, not the mode. Leaving text
           * entry as well would undo two things for one keypress, and the drag is
           * the one that was still in flight.
           */
          const gesture = gestureRef.current
          if (gesture) {
            gestureRef.current = null
            setActive(null)
            setLimited(false)
            store.setMosaicCoordinates(
              target.id,
              gesture.edge.axis,
              Object.entries(gesture.before).map(([id, value]) => ({ id, value })),
              shownIndex(target),
            )
            if (gesture.beforeTiles) {
              store.updateMosaic(target.id, { tiles: gesture.beforeTiles })
            }
            return
          }
          // Escape leaves the mosaic, so both go — the caret and the tiles
          // that were being worked on. Said here rather than folded into
          // `setTyping`, because dropping the caret on its own is a different
          // thing and the Colour tab does it on every press.
          ui.setTyping(null)
          ui.setMosaicSelection([])
          return
        }

        case 'Tab':
          e.preventDefault()
          move(stepThrough(order, at, e.shiftKey ? -1 : 1))
          return

        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          const direction = e.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down'
          move(tileInDirection(layout, at, direction))
          return
        }

        case 'Delete':
          e.preventDefault()
          apply(deleteCharacter(mosaicChars(target, shownIndex(target)), at), 'Clear tile')
          return

        case 'Backspace':
          e.preventDefault()
          apply(backspaceCharacter(mosaicChars(target, shownIndex(target)), order, at), 'Clear tile')
          return

        default:
          break
      }

      if (!isTypedCharacter(e.key, modified)) return
      e.preventDefault()
      apply(typeCharacter(mosaicChars(target, shownIndex(target)), order, at, e.key), 'Type')
    }

    /**
     * Paste fills consecutive tiles from the caret.
     *
     * Its own listener rather than a key case, because the clipboard is only
     * readable from the paste event itself.
     */
    const onPaste = (e: ClipboardEvent): void => {
      const current = live()
      if (!current) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()

      const { object: target, leaf: at, layout } = current
      const store = useDocumentStore.getState()
      const at2 = shownIndex(target)
      const result = pasteCharacters(mosaicChars(target, at2), readingOrder(layout), at, text)
      store.setMosaicChars(target.id, at2, result.chars)
      store.commit('Paste')
      useUiStore.getState().setTyping({ object: target.id, leaf: result.focus ?? at })
      if (result.dropped > 0) {
        // Said rather than swallowed: the alternative is the user believing it
        // all went in. Non-blocking, because what fitted did go in.
        store.setWarning(
          target.id,
          `${result.dropped} character${result.dropped === 1 ? '' : 's'} did not fit.`,
        )
      } else {
        store.setWarning(target.id, null)
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  return null
}

function isFormField(target: HTMLElement): boolean {
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
