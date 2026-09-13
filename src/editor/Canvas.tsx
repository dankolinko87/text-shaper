import {
  Canvas as FabricCanvas,
  FabricText,
  Point,
  Polyline,
  Rect as FabricRect,
  type TPointerEventInfo,
} from 'fabric'
import { useState, useCallback, useEffect, useRef } from 'react'

import { pointArtboardToObject } from '../geometry/objectSpace'
import { MOSAIC_CELL } from '../types/mosaic'
import { layoutMosaic } from '../mosaic/layout'
import { authoredTimeFor, evaluateMosaicAtTime } from '../mosaic/timeline'
import { glyphReferenceRects, paintMosaicFrame } from './mosaicPlayback'
import { strokeToLinePath, strokeToShapePath } from '../geometry/strokeToPath'
import { MAX_ZOOM, MIN_ZOOM, fitToRect } from '../geometry/viewportMath'
import { useDocumentStore } from '../state/documentStore'
import { clearPlayhead, setPlayhead } from '../state/playhead'
import { useUiStore, type ToolId } from '../state/uiStore'
import type {
  FrameObject,
  LetterMosaicObject,
  MeshObject,
  Rect,
  TextShaperDocument,
  Transform2D,
  TypographyObject,
  Vec2,
} from '../types/document'
import { isStated, isTypography } from '../types/document'
import type { FitOutcome } from '../typography/fit'
import { clamp } from '../utils/math'
import {
  applyCanvasBackground,
  fontKey,
  contentBounds,
  applyMemberMoment,
  memberAsDrawn,
  paintFrame,
  paintFrameBackground,
  settleFrame,
  settleWindows,
  syncCanvas,
  windowsOf,
  type RenderedObject,
} from './renderer'
import { ActiveSelection, Path, type FabricObject, type Group } from 'fabric'

import { isFontLoaded } from '../typography/fontRegistry'
import { frameAt, prepareFrames, stillFrame } from '../typography/objectFit'
import { GridLayer } from './GridLayer'
import { applyColourGuard } from './colourGuard'
import { firstTile, tileAt } from '../mosaic/tiles'
import { firstMeshTile, meshTileAt } from '../mesh/layout'
import { evaluateMeshAtTime, meshAuthoredTimeFor, restingMeshFrame } from '../mesh/timeline'
import { EmptyHints } from './EmptyHints'
import { setLiveCanvas } from './liveCanvas'
import { createWheelGesture } from './wheelGesture'
import { newPaintCache, paintMeshFrame, type MeshPaintCache } from './meshPlayback'
import { evaluateFrameAtTime, frameAuthoredTimeFor, valuesFor } from '../frame/frame'
import { FrameLayer } from './FrameLayer'
import { FramePlate } from './FramePlate'
import { ensureImagesLoaded } from './imageCache'
import { CropLayer } from './CropLayer'
import { CropBar } from './CropBar'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { ALIGNMENT_OPTIONS, DISTRIBUTION_OPTIONS, alignSelection } from './alignment'
import { stackingLabel, type Stacking } from '../state/stacking'
import { decompose, invert, multiply } from '../geometry/transform'
import type { Mat2D } from '../types/geometry'
import { memberBoxes } from './frameBoxes'
import { memberParentOf, memberProbe } from './memberTarget'
import { constrainMove } from './objectDrag'
import { MeshLayer } from './MeshLayer'
import { MosaicLayer } from './MosaicLayer'
import { showState, shownWindow, spreadHoldsGround, windowTransform } from './stated'
import { ObjectBar } from './ObjectBar'
import { ObjectLabel } from './ObjectLabel'
import { useSelectedObject } from './selection'
import { SpreadChips } from './SpreadChips'
import { SpreadLayer } from './SpreadLayer'
import { PathLayer } from './PathLayer'
import { PenLayer } from './PenLayer'
import {
  animatingFrameIds,
  animatingIds,
  animatingMeshIds,
  animatingMosaicIds,
  phaseAt,
  playbackDiff,
  signatureOf,
  type PlaybackState,
} from './animationPlayback'
import { collectTransforms } from './transformSync'
import { useTextPaths } from './useTextPaths'
import './canvas.css'
import { selectionColour, selectionWash } from './colours'
import { openShapeEditing } from './shapeEditing'

/*
 * Selection blue, from the stylesheet rather than a literal here — see
 * `colours.ts`. Called rather than captured, so it resolves after the styles
 * have loaded.
 */
const SELECTION_COLOR = selectionColour

/**
 * Side of one cell while a mosaic is being dragged out, in artboard units.
 *
 * The drag says how big the mosaic is and the cell size turns that into a count,
 * so dragging further adds cells rather than stretching the ones already there.
 * It matches the size `createMosaic` builds at, so the mosaic that appears is
 * the one the preview drew.
 */

/**
 * Smaller than this in either direction and a frame drag is a mis-click.
 *
 * A frame is a place to put things, so one too small to drop anything into was
 * not a request. Generous, because the cost of abandoning a real one is a
 * repeated gesture and the cost of creating a stray one is an object nobody
 * wanted in the layer list.
 */
const MIN_FRAME_SIDE = 24

export function EditorCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const fabricRef = useRef<FabricCanvas | null>(null)
  const renderedRef = useRef(new Map<string, RenderedObject>())

  /** Live stroke state — deliberately refs, so a gesture never re-renders React. */
  const strokeRef = useRef<Vec2[]>([])
  const previewRef = useRef<Polyline | null>(null)
  const drawingRef = useRef(false)
  /**
   * Whether the stroke in progress is a LINE rather than a shape.
   *
   * Caught on the press, not read on release: the tool resets to Select when a
   * stroke finishes, so by the time the pointer comes up the answer has already
   * changed.
   */
  const drawingLineRef = useRef(false)
  /** Where a mosaic drag began, and the preview of the grid it will make. */
  const mosaicRef = useRef<{
    from: Vec2
    preview: FabricRect
    label: FabricText
    grid: Path | null
    /** Which kind the drag makes: a mosaic, or its free-cornered cousin. */
    kind: 'mosaic' | 'mesh'
    /** What `grid` was drawn for, so it is only rebuilt when that changes. */
    cells: { columns: number; rows: number }
  } | null>(null)
  /** A frame being dragged out: where it started, and the rectangle previewing it. */
  const frameRef = useRef<{ from: Vec2; preview: FabricRect } | null>(null)
  /** Where the pointer last was, so a release knows how big the drag ended up. */
  const hoverRef = useRef<Vec2 | null>(null)
  const panningRef = useRef<{ x: number; y: number } | null>(null)
  /** Guards against the store -> canvas -> store feedback loop. */
  const applyingRef = useRef(false)
  /** Ids Alt-drag left behind this gesture, or null when it has not cloned. */
  const cloneRef = useRef<string[] | null>(null)

  const { textPaths, bandPaths, ribbons, rowBands, fits } = useTextPaths()
  /**
   * Which state each mosaic is showing.
   *
   * A subscription rather than a `getState()` read, because the canvas is built
   * from it: picking a different state changes nothing in the document, so
   * without this the group would keep drawing the state it was built for.
   */
  const mosaicStates = useUiStore((s) => s.mosaicStates)
  /** The frame being worked inside — the canvas is built differently for it. */
  const insideFrame = useUiStore((s) => s.insideFrame)
  /** The frame drawn as a row of windows, one per state. */
  const spread = useUiStore((s) => s.spread)
  const frameSelection = useUiStore((s) => s.frameSelection)
  const { stated } = useSelectedObject()
  /** Where a right-click asked for the menu, in window pixels; null while there is none. */
  /** Where the context menu is, and whether it is about objects or the members of the open frame. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; members: boolean } | null>(null)
  /** Moves when a picture arrives, so the group waiting for it is rebuilt. */
  const imageRevision = useUiStore((s) => s.imageRevision)
  const assets = useDocumentStore((s) => s.doc.assets)
  useEffect(() => ensureImagesLoaded(assets), [assets])
  /**
   * The object the plate stands under: the frame being worked inside, else
   * the selected object with states. The canvas is built from it — an empty
   * object leaves its own ground out while the plate is that ground.
   */
  const held =
    useDocumentStore((s) =>
      insideFrame && s.doc.objects[insideFrame]?.kind === 'frame' ? insideFrame : null,
    ) ??
    stated?.id ??
    null

  /* --------------------------------------------------------- setup */
  useEffect(() => {
    const el = canvasElRef.current
    const container = containerRef.current
    if (!el || !container) return

    const canvas = new FabricCanvas(el, {
      preserveObjectStacking: true,
      selection: true,
      selectionColor: selectionWash(),
      selectionBorderColor: SELECTION_COLOR(),
      selectionLineWidth: 1,
      enableRetinaScaling: true,
      fireRightClick: false,
      // Left to bubble: the stage's own handler turns a right-click into the
      // object menu, and takes the browser's menu away itself.
      stopContextMenu: false,
    })
    fabricRef.current = canvas
    setLiveCanvas(canvas, () => renderedRef.current)

    // Dev-only handle, for inspecting canvas state from the console.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __canvas?: FabricCanvas }).__canvas = canvas
    }

    applyCanvasBackground(canvas, useDocumentStore.getState().doc)

    // The view cannot be framed in this effect: layout has not run yet, so the
    // container measures 0x0 and the zoom would clamp to its minimum. It is
    // framed on every resize until the user zooms or pans themselves, which
    // also keeps the work in view as the window changes size.
    /*
     * The drawing travels with its stage.
     *
     * The canvas's origin is the stage's top-left corner, so when something
     * standing to the left of the stage takes room — the projects drawer
     * sliding out — the same viewport carries the drawing along by the shift.
     * That is the point: the drawer PUSHES the work aside rather than sliding
     * over it. An earlier version shifted the pan back to hold the drawing
     * where the eye had left it, which made the drawer look like a cover.
     */
    const resize = new ResizeObserver(() => {
      const r = container.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return

      canvas.setDimensions({ width: r.width, height: r.height })
      useUiStore.getState().setStageSize({ width: r.width, height: r.height })

      if (!useUiStore.getState().viewportAdjusted) {
        const artboard = useDocumentStore.getState().doc.artboard
        // On an endless canvas there is no page to fit, so frame whatever has
        // been drawn — falling back to a default region while it is empty.
        const target =
          contentBounds(renderedRef.current) ??
          { x: 0, y: 0, width: artboard.width, height: artboard.height }
        const fitted = fitToRect(r.width, r.height, target, 96)
        canvas.setViewportTransform([fitted.zoom, 0, 0, fitted.zoom, fitted.panX, fitted.panY])
        useUiStore.getState().setViewport(fitted)
      }
      /*
       * Rendered NOW, not on the next frame. Giving the element a new size
       * wipes its bitmap, and Fabric's deferred render would let the browser
       * paint the blank canvas first — one blink per step of a resize, which
       * during the rail's slide is a dozen blinks in a row.
       */
      canvas.renderAll()
    })
    resize.observe(container)

    return () => {
      resize.disconnect()
      setLiveCanvas(null)
      void canvas.dispose()
      fabricRef.current = null
      renderedRef.current.clear()
    }
  }, [])

  /* ------------------------------------------------ document -> canvas */
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return

    const render = (): void => {
      applyingRef.current = true
      const doc = useDocumentStore.getState().doc
      renderedRef.current = syncCanvas({
        mosaicStates,
        insideFrame,
        spread,
        held,
        canvas,
        doc,
        textPaths,
        bandPaths,
        ribbons,
        rendered: renderedRef.current,
      })
      // Every window of a spread object settled to ITS state, where the kind
      // needs a settle at all.
      if (spread) {
        const entry = renderedRef.current.get(spread)
        const object = doc.objects[spread]
        if (entry && object && isStated(object)) settleWindows(entry, object, fits)
      }
      // Restore Fabric's selection to match the store.
      syncSelectionToCanvas(canvas, renderedRef.current, editingRef.current)
      // A group is replaced outright whenever its drawing changes, so the guard
      // has to be put back on the new one or it lasts exactly one keystroke.
      applyColourGuard(canvas, colouringIdRef.current)
      applyingRef.current = false
    }

    render()
    return useDocumentStore.subscribe(render)
    /*
     * `mosaicStates` is a real dependency, not something to reach for with
     * `getState()`. Which state a mosaic shows is UI state, but the canvas is
     * built from it — read it out of band and picking a different state would
     * never repaint, because nothing in the DOCUMENT changed.
     */
    /*
     * `insideFrame` for the same reason: a frame is BUILT differently for it —
     * inside, its members are selectable objects with their own controls.
     */
    /*
     * And `spread`, which changes how many groups a frame is; `fits`
     * arrives with the text paths and is what each window is settled with.
     */
    /*
     * And `held`, for the one thing it changes about the drawing: whether an
     * empty object paints its own ground under the plate.
     */
    // And `imageRevision`: a picture that has just been decoded changes what a
    // group can draw, and nothing in the document changed to say so.
  }, [textPaths, bandPaths, ribbons, fits, mosaicStates, insideFrame, spread, held, imageRevision])

  /* --------------------------------------------------- selection sync */
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return

    const onSelection = (): void => {
      if (applyingRef.current) return

      /*
       * Inside a frame, what Fabric has hold of is a MEMBER.
       *
       * Mirrored into `frameSelection` rather than into the document's, because
       * the document's selection is still the frame — that is what keeps the
       * frame's own bar and panel on screen while you work inside it. The panel
       * then describes the member, exactly as it did when this layer picked
       * members itself.
       */
      const active = canvas.getActiveObjects()
      const members = active
        .map((o) => o.get('memberId') as string | undefined)
        .filter((id): id is string => Boolean(id))
      if (useUiStore.getState().insideFrame) {
        /*
         * Which STATE the pick was made in is read off the child's parent —
         * the group stamps the state it draws — and written with the pick as
         * one change. Every write that follows asks the pick, so it lands on
         * the state the object was picked in, never on whatever the store
         * happened to be showing.
         */
        const picked = active.find((o) => o.get('memberId'))
        const parent = memberParentOf(picked)
        const frameId = parent?.get?.('statedId')
        const at = parent?.get?.('stateIndex')
        if (members.length > 0 && typeof frameId === 'string' && typeof at === 'number') {
          useUiStore.getState().setFramePick(frameId, members, at)
          return
        }
        useUiStore.getState().setFrameSelection(members)
        if (members.length > 0) return
      }

      /*
       * A spread window is the object. Only the first window carries the
       * object's `shapeId`; the others carry its `statedId` and nothing else,
       * so a press on their ground used to read as a press on nothing and
       * deselected the object you had just spread out to look at.
       */
      const ids = [
        ...new Set(
          active
            .map((o) => (o.get('shapeId') ?? o.get('statedId')) as string | undefined)
            .filter((id): id is string => Boolean(id)),
        ),
      ]
      useDocumentStore.getState().setSelection(ids)
      /*
       * A row lives while its object is selected. Picking something else is
       * "done looking": the plate, the chips and the bar all follow the
       * selection, and a row with none of them is a row nobody asked for.
       */
      const ui = useUiStore.getState()
      if (ui.spread && !ids.includes(ui.spread)) ui.setSpread(null)
    }

    const onCleared = (): void => {
      if (applyingRef.current) return
      /*
       * Only a plain click of the Select tool may clear the selection.
       *
       * Fabric fires `selection:cleared` whenever it finds no target under the
       * pointer — and every mode that edits an object's insides sets
       * `skipTargetFind`, precisely so a press on a node does not drag the
       * object out from under it. So inside one of those modes EVERY click looks
       * like a click on nothing, and acting on it drops the selection, which
       * tears down the overlay being worked on.
       *
       * The tool check covers the grid and the drawing tools, which have a tool
       * of their own. Point editing does not: it happens under Select, so it
       * needs saying separately — the first click on a node left the mode
       * outright.
       */
      /*
       * A spread frame stays selected through a press on the ground: the row
       * is a view you are looking at, and a click beside it is not "done
       * looking". Fabric has already let go of the group, so the store's
       * selection is put back on it once Fabric's own handling of the press is
       * over — the same mirror every document change runs. Before the inside
       * check below, because a spread is always inside.
       */
      if (spreadHoldsGround()) {
        queueMicrotask(() =>
          syncSelectionToCanvas(canvas, renderedRef.current, editingRef.current),
        )
        return
      }
      if (useUiStore.getState().activeTool() !== 'select' || editingRef.current) return
      useDocumentStore.getState().clearSelection()
    }

    /**
     * Write transforms back only on `object:modified` — the event that fires
     * once when a drag or resize ENDS. Listening to `object:moving` instead
     * would write on every pointer sample and fill the history with hundreds
     * of entries for one drag.
     */
    /**
     * The object being dragged, resized or turned holds still while it is.
     *
     * Fabric fires these continuously through a gesture, so setting the same id
     * over and over is the normal case and costs a store write only when it
     * actually changes. `object:modified` clears it at the end, and `mouse:up`
     * clears it again for the gesture that ended some other way — a drag
     * interrupted by a lost pointer leaves no `modified` behind, and one object
     * frozen while everything else plays is a bad way to find that out.
     */
    const onManipulating = (opt: { target?: FabricObject }): void => {
      const target = memberProbe(opt.target)
      /*
       * A member under the pointer holds its FRAME still: the frame is what
       * animates, and a member repainted from the clock mid-drag is a picture
       * that belongs to no state. Asked of the child's parent, not the store.
       */
      const parent = memberParentOf(target)
      /*
       * A member FIRST. A member's inner group is built by the same builder as
       * a top-level object and carries that object's `shapeId` — which nothing
       * animates or previews, so holding it still held nothing. What holds
       * still is the frame it belongs to, which its parent names.
       */
      const id = target?.get('memberId')
        ? (parent?.get?.('statedId') as string | undefined)
        : (target?.get('shapeId') as string | undefined)
      const ui = useUiStore.getState()
      if (!id) return
      if (ui.interacting !== id) ui.setInteracting(id)
    }

    /**
     * Alt-drag leaves a copy behind.
     *
     * The copy is what stays, not what moves: Fabric's transform is already
     * bound to the object under the pointer, and swapping it onto a new object
     * mid-gesture would mean rebuilding that transform from scratch. Since the
     * two are identical, dropping a stationary copy at the start position looks
     * exactly like dragging a copy away, and the selection stays on the thing
     * being dragged — which is what you want to keep nudging afterwards.
     *
     * Once per gesture, on the first MOVE rather than on the press: Alt-clicking
     * without dragging should select, not litter the artboard with copies. The
     * copy is not committed here — `onModified` commits at the end of the drag,
     * so the copy and the move it came from are one entry in the history and one
     * undo takes both back.
     */
    const onMoving = (opt: { e?: Event; target?: FabricObject }): void => {
      if (cloneRef.current !== null) return
      if (!(opt.e as MouseEvent | undefined)?.altKey) return
      /*
       * A member inside a frame is NOT this gesture's business. The selection
       * is still the frame while you are inside it, so cloning "the selection"
       * duplicated the whole frame every time somebody Alt-dragged one shape in
       * it — while `FrameLayer` duplicated the member as well. Two copies.
       */
      if (opt.target?.get('memberId')) return
      const store = useDocumentStore.getState()
      if (store.selection.length === 0) return
      cloneRef.current = store.duplicateInPlace(store.selection)
    }

    /*
     * Shift while dragging holds the move to one axis.
     *
     * Fabric has placed the target for this move already; the displacement
     * from where the gesture began — the transform's `original` — is held to
     * its dominant axis and written back, before anything else reads the
     * position. The same for an object, a selection of them and a member
     * inside a frame: `original` is in whatever plane the target moves in.
     */
    const onConstrained = (opt: {
      e?: Event
      target?: FabricObject
      transform?: { action?: string; original?: { left?: number; top?: number } }
    }): void => {
      const target = opt.target
      const original = opt.transform?.original
      if (!target || !original || opt.transform?.action !== 'drag') return
      if (!(opt.e as MouseEvent | undefined)?.shiftKey) return
      const left = original.left ?? target.left
      const top = original.top ?? target.top
      const held = constrainMove({ x: target.left - left, y: target.top - top })
      if (target.left === left + held.x && target.top === top + held.y) return
      target.set({ left: left + held.x, top: top + held.y })
      target.setCoords()
    }

    const onSettled = (): void => {
      const ui = useUiStore.getState()
      if (ui.interacting) ui.setInteracting(null)
    }

    const onModified = (opt?: { target?: FabricObject }): void => {
      onSettled()
      const cloned = cloneRef.current !== null
      cloneRef.current = null
      if (applyingRef.current) return
      const store = useDocumentStore.getState()

      /*
       * A MEMBER moved, scaled or turned inside its frame.
       *
       * Fabric owns the gesture now — real controls, real cursors, the same
       * handles an object on the artboard has — and this is where its answer
       * becomes the document's. The transform is read out of the child in the
       * frame's own space, which is what a state records.
       */
      const target = opt?.target
      const activeMembers = canvas.getActiveObjects().filter((o) => o.get('memberId'))
      const moved =
        activeMembers.length > 0 ? activeMembers : target?.get('memberId') ? [target] : []
      if (moved.length > 0) {
        // Read them all, then write them all — a write re-renders, and a
        // second member measured after the first one's write is measured
        // against a canvas that has already moved.
        const reads = moved.map(readMemberTransform).filter((r): r is NonNullable<typeof r> => Boolean(r))
        const before = useDocumentStore.getState().doc
        for (const r of reads) store.setMemberValues(r.frameId, r.at, r.memberId, { transform: r.transform })
        if (useDocumentStore.getState().doc !== before) store.commit('Move in frame')
        return
      }

      /*
       * Every object READ before any of them is written.
       *
       * A write re-renders the canvas, which takes the objects back out of
       * Fabric's selection and re-places them, so reading and writing in one
       * pass measured the second object of a moved pair against a canvas the
       * first object's write had already changed. See `collectTransforms`.
       */
      const updates = collectTransforms(renderedRef.current, store.doc.objects)
      if (updates.length === 0) return

      for (const update of updates) {
        // Position first: `bakeTransform` keeps the local origin where it is,
        // so the shape must already be sitting where the drag left it.
        // The transform belongs to every object, so it goes through the action
        // that every object shares — a mosaic has no `updateObject` to accept it.
        store.setBase(update.id, { transform: update.transform })
        if (update.bake) store.bakeTransform(update.id, update.bake)
      }

      /*
       * And a drop into a frame, if that is where the gesture ended.
       *
       * Captured on release, which is what dragging something onto a container
       * means everywhere else. Only ADDING happens by dragging: a member taken
       * outside the bounds is how a slide-in is authored, so that direction has
       * to stay a plain move or building a reveal would keep emptying the frame.
       */
      /*
       * Asked of the document AFTER the writes, not the snapshot from before
       * them. `store` was read at the top of this handler, so its `doc` still
       * has every object where the drag STARTED — and a drop is decided by
       * where it ended.
       */
      const settled = useDocumentStore.getState().doc
      const landed = frameUnder(settled, updates.map((update) => update.id))
      if (landed) {
        store.addToFrame(landed.frameId, landed.objectIds)
        store.commit(cloned ? 'Duplicate into frame' : 'Move into frame')
        return
      }

      // Named for what the gesture actually did. An Alt-drag makes a copy and
      // moves it, and "Transform" in the history would not say so.
      store.commit(cloned ? 'Duplicate' : 'Transform')
    }

    canvas.on('selection:created', onSelection)
    canvas.on('selection:updated', onSelection)
    canvas.on('selection:cleared', onCleared)
    canvas.on('object:moving', onConstrained)
    canvas.on('object:moving', onManipulating)
    canvas.on('object:moving', onMoving)
    canvas.on('object:scaling', onManipulating)
    canvas.on('object:rotating', onManipulating)
    canvas.on('mouse:up', onSettled)
    canvas.on('object:modified', onModified)

    return () => {
      canvas.off('selection:created', onSelection)
      canvas.off('selection:updated', onSelection)
      canvas.off('selection:cleared', onCleared)
      canvas.off('object:moving', onConstrained)
      canvas.off('object:moving', onManipulating)
      canvas.off('object:moving', onMoving)
      canvas.off('object:scaling', onManipulating)
      canvas.off('object:rotating', onManipulating)
      canvas.off('mouse:up', onSettled)
      canvas.off('object:modified', onModified)
    }
  }, [])

  /*
   * The surface colour, kept in step with the document.
   *
   * Applied once at mount and never again, so changing it from the panel left
   * the canvas painted in the colour the document had when the tab opened.
   */
  const artboardBackground = useDocumentStore((s) => s.doc.artboard.background)
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    canvas.backgroundColor = artboardBackground
    canvas.requestRenderAll()
  }, [artboardBackground])

  /* --------------------------------------------------------- drawing */
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return

    const finishStroke = (): void => {
      if (!drawingRef.current) return
      drawingRef.current = false
      useUiStore.getState().setDrawing(false)

      if (previewRef.current) {
        canvas.remove(previewRef.current)
        previewRef.current = null
      }

      const points = strokeRef.current
      strokeRef.current = []

      /*
       * The same samples either way; what differs is what is made of them.
       *
       * A shape is closed, united with itself to resolve crossings, and judged
       * by area. A line is none of those: it stays open, and a stroke that
       * doubles back encloses nothing, so the area gate would throw out every
       * line ever drawn.
       */
      const drawingLine = drawingLineRef.current
      const result = drawingLine ? strokeToLinePath(points) : strokeToShapePath(points)
      if (!result.ok) {
        canvas.requestRenderAll()
        return
      }

      // ONE history entry for the whole gesture: nothing was written to the
      // document while the pointer was down.
      const store = useDocumentStore.getState()
      // `open` rides along on the result: the pipeline that produced the
      // geometry is the only thing that knows which of the two this is, and it
      // says so itself rather than leaving it to be restated here.
      store.createObjectFromGeometry(result)
      store.commit(drawingLine ? 'Draw line' : 'Draw shape')
      useUiStore.getState().setTool('select')
    }

    /**
     * How many columns and rows a drag of this size asks for.
     *
     * The drag says how BIG the mosaic is; the count falls out of it at a fixed
     * cell size. Dragging further therefore adds cells rather than stretching
     * the ones already there, which is what makes `6 × 6` mean something while
     * the pointer is still down.
     */
    const mosaicSize = (from: Vec2, to: Vec2): { columns: number; rows: number } => ({
      columns: Math.max(1, Math.round(Math.abs(to.x - from.x) / MOSAIC_CELL)),
      rows: Math.max(1, Math.round(Math.abs(to.y - from.y) / MOSAIC_CELL)),
    })

    /**
     * A frame, from the rectangle just dragged out.
     *
     * Empty, and that is the point: you draw a place and then put things in it.
     * A frame too small to drop anything into is a mis-click rather than a
     * request, so below a threshold the drag is simply abandoned.
     */
    const finishFrame = (): void => {
      const drag = frameRef.current
      frameRef.current = null
      if (!drag) return
      canvas.remove(drag.preview)
      useUiStore.getState().setDrawing(false)

      const to = hoverRef.current ?? drag.from
      const width = Math.abs(to.x - drag.from.x)
      const height = Math.abs(to.y - drag.from.y)
      useUiStore.getState().setTool('select')
      if (width < MIN_FRAME_SIDE || height < MIN_FRAME_SIDE) return

      const store = useDocumentStore.getState()
      store.createFrame({
        box: { x: 0, y: 0, width, height },
        artboardCenter: { x: (drag.from.x + to.x) / 2, y: (drag.from.y + to.y) / 2 },
      })
      store.commit('Draw frame')
    }

    const finishMosaic = (): void => {
      const drag = mosaicRef.current
      mosaicRef.current = null
      if (!drag) return
      canvas.remove(drag.preview)
      canvas.remove(drag.label)
      if (drag.grid) canvas.remove(drag.grid)
      useUiStore.getState().setDrawing(false)

      const to = hoverRef.current ?? drag.from
      const { columns, rows } = mosaicSize(drag.from, to)
      const store = useDocumentStore.getState()
      // Empty, and ready to be typed into. A mosaic is made to hold what someone
      // is about to write in it.
      const artboardCenter = { x: (drag.from.x + to.x) / 2, y: (drag.from.y + to.y) / 2 }
      const id =
        drag.kind === 'mesh'
          ? store.createMesh({ columns, rows, artboardCenter })
          : store.createMosaic({ columns, rows, artboardCenter })
      store.commit(drag.kind === 'mesh' ? 'Draw mesh' : 'Draw mosaic')
      useUiStore.getState().setTool('select')

      /*
       * The caret lands in the first tile, so a mosaic can be typed into the
       * moment it exists. First in READING order — the tree's own first leaf is
       * the top of the peeled column, which is only the top-left by coincidence.
       */
      // Read back from the store, not from `store` — that snapshot predates the
      // object it just created.
      const made = useDocumentStore.getState().doc.objects[id]
      if (made?.kind === 'mosaic') {
        const first = firstTile(made)
        if (first) useUiStore.getState().setTyping({ object: id, leaf: first })
      } else if (made?.kind === 'mesh') {
        const first = firstMeshTile(made)
        if (first) useUiStore.getState().setTyping({ object: id, leaf: first })
      }
    }

    const onDown = (opt: TPointerEventInfo): void => {
      const tool = useUiStore.getState().activeTool()

      if (tool === 'pan') {
        const e = opt.e as MouseEvent
        panningRef.current = { x: e.clientX, y: e.clientY }
        return
      }

      if (tool === 'frame') {
        const p = canvas.getScenePoint(opt.e)
        const from = { x: p.x, y: p.y }
        hoverRef.current = from
        useUiStore.getState().setDrawing(true)

        /*
         * Dashed, like the frame itself draws. A frame is a place rather than a
         * mark, and the preview says so before it exists.
         */
        const preview = new FabricRect({
          left: from.x,
          top: from.y,
          width: 0,
          height: 0,
          originX: 'left',
          originY: 'top',
          fill: selectionWash(),
          stroke: SELECTION_COLOR(),
          strokeWidth: 1.5 / canvas.getZoom(),
          strokeDashArray: [4 / canvas.getZoom(), 4 / canvas.getZoom()],
          strokeUniform: true,
          selectable: false,
          evented: false,
          objectCaching: false,
        })
        frameRef.current = { from, preview }
        canvas.add(preview)
        return
      }

      if (tool === 'mosaic' || tool === 'mesh') {
        const p = canvas.getScenePoint(opt.e)
        const from = { x: p.x, y: p.y }
        hoverRef.current = from
        useUiStore.getState().setDrawing(true)

        const preview = new FabricRect({
          left: from.x,
          top: from.y,
          width: 0,
          height: 0,
          originX: 'left',
          originY: 'top',
          fill: selectionWash(),
          stroke: SELECTION_COLOR(),
          strokeWidth: 1.5 / canvas.getZoom(),
          strokeUniform: true,
          selectable: false,
          evented: false,
          objectCaching: false,
        })
        const label = new FabricText('1 × 1', {
          left: from.x,
          top: from.y,
          fontSize: 13 / canvas.getZoom(),
          fill: SELECTION_COLOR(),
          fontFamily: 'ui-monospace, monospace',
          selectable: false,
          evented: false,
          objectCaching: false,
        })
        mosaicRef.current = { from, preview, label, grid: null, kind: tool, cells: { columns: 0, rows: 0 } }
        canvas.add(preview)
        canvas.add(label)
        return
      }

      if (tool !== 'draw' && tool !== 'line') return
      drawingLineRef.current = tool === 'line'

      drawingRef.current = true
      useUiStore.getState().setDrawing(true)
      const p = canvas.getScenePoint(opt.e)
      strokeRef.current = [{ x: p.x, y: p.y }]

      const preview = new Polyline([{ x: p.x, y: p.y }], {
        stroke: SELECTION_COLOR(),
        strokeWidth: 1.5 / canvas.getZoom(),
        fill: selectionWash(),
        selectable: false,
        evented: false,
        objectCaching: false,
        strokeUniform: true,
      })
      previewRef.current = preview
      canvas.add(preview)
    }

    const onMove = (opt: TPointerEventInfo): void => {
      if (panningRef.current) {
        const e = opt.e as MouseEvent
        const dx = e.clientX - panningRef.current.x
        const dy = e.clientY - panningRef.current.y
        panningRef.current = { x: e.clientX, y: e.clientY }
        const vt = canvas.viewportTransform
        vt[4] += dx
        vt[5] += dy
        canvas.setViewportTransform(vt)
        useUiStore.getState().adjustViewport({ zoom: vt[0], panX: vt[4], panY: vt[5] })
        return
      }

      const framing = frameRef.current
      if (framing) {
        const p = canvas.getScenePoint(opt.e)
        hoverRef.current = { x: p.x, y: p.y }
        const zoom = canvas.getZoom() || 1
        framing.preview.set({
          left: Math.min(framing.from.x, p.x),
          top: Math.min(framing.from.y, p.y),
          width: Math.abs(p.x - framing.from.x),
          height: Math.abs(p.y - framing.from.y),
          strokeWidth: 1.5 / zoom,
          strokeDashArray: [4 / zoom, 4 / zoom],
        })
        framing.preview.setCoords()
        canvas.requestRenderAll()
        return
      }

      const drag = mosaicRef.current
      if (drag) {
        const p = canvas.getScenePoint(opt.e)
        hoverRef.current = { x: p.x, y: p.y }
        const { columns, rows } = mosaicSize(drag.from, hoverRef.current)
        const zoom = canvas.getZoom() || 1
        drag.preview.set({
          left: Math.min(drag.from.x, p.x),
          top: Math.min(drag.from.y, p.y),
          width: Math.abs(p.x - drag.from.x),
          height: Math.abs(p.y - drag.from.y),
          strokeWidth: 1.5 / zoom,
        })
        drag.preview.setCoords()

        /*
         * The cells themselves, not just their count.
         *
         * `4 × 3` tells you what you are about to get only if you can already
         * picture it. Drawing the divisions lets the drag be judged against the
         * thing being made, and makes the moment a column is gained or lost
         * visible where it happens rather than as a digit changing in a corner.
         *
         * Drawn in UNIT space and stretched to the box, so the path itself only
         * depends on how many cells there are. A drag changes the size on every
         * pointer move and the count perhaps five times in total — so this is
         * rebuilt on the rare change and merely re-stretched on the common one.
         */
        const x0 = Math.min(drag.from.x, p.x)
        const y0 = Math.min(drag.from.y, p.y)
        const width = Math.abs(p.x - drag.from.x)
        const height = Math.abs(p.y - drag.from.y)

        if (!drag.grid || drag.cells.columns !== columns || drag.cells.rows !== rows) {
          if (drag.grid) canvas.remove(drag.grid)
          const segments: string[] = []
          for (let column = 1; column < columns; column++) {
            segments.push(`M ${column / columns} 0 L ${column / columns} 1`)
          }
          for (let row = 1; row < rows; row++) {
            segments.push(`M 0 ${row / rows} L 1 ${row / rows}`)
          }
          const grid = segments.length
            ? new Path(segments.join(' '), {
                originX: 'left',
                originY: 'top',
                stroke: SELECTION_COLOR(),
                fill: '',
                opacity: 0.55,
                strokeUniform: true,
                selectable: false,
                evented: false,
                objectCaching: false,
              })
            : null
          drag.grid = grid
          drag.cells = { columns, rows }
          if (grid) {
            canvas.add(grid)
            // Under the label, which has to stay readable over it.
            canvas.bringObjectToFront(drag.label)
          }
        }

        if (drag.grid) {
          drag.grid.set({
            left: x0,
            top: y0,
            scaleX: width,
            scaleY: height,
            strokeWidth: 1 / zoom,
          })
          drag.grid.setCoords()
        }

        // Above the corner the pointer is at, so it never sits under the cursor.
        drag.label.set({
          text: `${columns} × ${rows}`,
          left: Math.min(drag.from.x, p.x),
          top: Math.min(drag.from.y, p.y) - 20 / zoom,
          fontSize: 13 / zoom,
        })
        canvas.requestRenderAll()
        return
      }

      if (!drawingRef.current) return
      const p = canvas.getScenePoint(opt.e)
      const last = strokeRef.current[strokeRef.current.length - 1]
      // Drop samples closer than a pixel on screen, so a stationary pointer
      // does not inject hundreds of duplicates.
      const minDistance = 1 / canvas.getZoom()
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDistance) return

      strokeRef.current.push({ x: p.x, y: p.y })
      const preview = previewRef.current
      if (preview) {
        preview.set({ points: strokeRef.current.map((pt) => new Point(pt.x, pt.y)) })
        preview.setBoundingBox(true)
        canvas.requestRenderAll()
      }
    }

    const onUp = (): void => {
      panningRef.current = null
      if (frameRef.current) {
        finishFrame()
        return
      }
      if (mosaicRef.current) {
        finishMosaic()
        return
      }
      finishStroke()
    }

    /**
     * Double-click goes INSIDE an object, to the points it is made of.
     *
     * Figma's model: a click selects something to move and turn, and a
     * double-click enters it. Only objects that carry a node list can be entered
     * — a primitive is a preset rather than a drawing, and a shape whose edges
     * the grid rewrote is a several-hundred-point polyline that would come back
     * as a wall of markers.
     *
     * Registered here rather than in `PathLayer` because it is what MOUNTS that
     * overlay: the overlay cannot be listening for the gesture that brings it
     * into existence.
     */
    const onDoubleClick = (opt: TPointerEventInfo): void => {
      const ui = useUiStore.getState()
      if (ui.activeTool() !== 'select') return
      const store = useDocumentStore.getState()

      /*
       * Inside an object, this gesture belongs to the overlay.
       *
       * It means add a point, remove one, or leave — and only the overlay can
       * tell which, because only it knows where the curve and the nodes are on
       * screen. Answering "leave" from here would have to guess at that, and the
       * guess available here is the object's bounding box, which is not drawn in
       * this mode: a double-click in the middle of a shape would then do nothing
       * for a reason nobody can see.
       */
      if (ui.editingPoints) return

      // A further window of a spread carries no `shapeId`, only whose it is.
      const id = (opt.target?.get('shapeId') ?? opt.target?.get('statedId')) as string | undefined
      const object = id ? store.doc.objects[id] : undefined
      if (!id || !object) return

      /*
       * Going inside a MOSAIC means putting the caret back in it.
       *
       * Same gesture, same meaning as for a shape — a double-click goes inside
       * the object to the thing it is made of. For a shape that is its points;
       * for a mosaic it is its letters. Typing stops when you click away or
       * press Escape, and without this there would be no way back in: the tiles
       * would be editable exactly once, on the pass that created them.
       *
       * The caret lands on the tile that was double-clicked rather than at the
       * beginning, because the point of aiming at a tile is to edit that tile.
       */
      /*
       * Going inside a FRAME means getting at the objects it holds.
       *
       * The same gesture and the same meaning as for a shape or a mosaic: a
       * click selects the thing to move it, a double-click goes in to what it
       * is made of. For a frame that is its members, and moving one writes to
       * the state that is open — which is how an arrangement is authored.
       */
      if (object.kind === 'frame') {
        /*
         * Going inside a frame, and picking what the double-click LANDED on.
         *
         * The ladder reads the same at every depth: one gesture takes you in and
         * hands you the thing you aimed at, with its own controls on it. A third
         * double-click, on a member already picked, opens its points — that one
         * is handled in `FrameLayer`, because going inside turns Fabric's target
         * finding off and this handler then has no target to work from.
         *
         * Leaving the selection empty meant going in and then clicking the very
         * shape you had just double-clicked, which is the same aim twice.
         */
        const ui = useUiStore.getState()
        ui.setInsideFrame(id)

        const at = canvas.getScenePoint(opt.e)
        // Measured in the WINDOW that was pressed, which is where its members
        // are; window 0 only when the press did not name one.
        const group =
          opt.target?.get('statedId') === id
            ? (opt.target as Group)
            : renderedRef.current.get(id)?.group
        const boxes = memberBoxes(group)
        const landed = [...object.members].reverse().find((member) => {
          const box = boxes.get(member.id)
          if (!box) return false
          return (
            at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height
          )
        })
        const shown = group?.get('stateIndex')
        if (typeof shown === 'number') ui.setFramePick(id, landed ? [landed.id] : [], shown)
        else ui.setFrameSelection(landed ? [landed.id] : [])
        return
      }

      if (object.kind === 'mesh') {
        const stamped = opt.target?.get('stateIndex')
        const shown = Math.min(
          typeof stamped === 'number' ? stamped : (useUiStore.getState().mosaicStates[id] ?? 0),
          object.states.length - 1,
        )
        const window = useUiStore.getState().spread === id ? shown : 0
        const at = pointArtboardToObject(windowTransform(object, window), canvas.getScenePoint(opt.e))
        const leaf = meshTileAt(object, at, shown) ?? firstMeshTile(object, shown)
        if (!leaf) return
        store.setSelection([id])
        showState(object, shown)
        ui.setTyping({ object: id, leaf })
        return
      }

      if (object.kind === 'mosaic') {
        /*
         * Against the state the pressed WINDOW draws, which its stamp says —
         * collapsed there is one window and it draws the shown state, so the
         * stamp and the store agree; spread, the window pressed is the state
         * that gets the caret, and the point is read in that window's space.
         * Clamped, because an index can outlive the state it named.
         */
        const stamped = opt.target?.get('stateIndex')
        const shown = Math.min(
          typeof stamped === 'number' ? stamped : (useUiStore.getState().mosaicStates[id] ?? 0),
          object.states.length - 1,
        )
        const window = useUiStore.getState().spread === id ? shown : 0
        const at = pointArtboardToObject(windowTransform(object, window), canvas.getScenePoint(opt.e))
        const leaf = tileAt(object, at, shown) ?? firstTile(object, shown)
        if (!leaf) return
        store.setSelection([id])
        showState(object, shown)
        ui.setTyping({ object: id, leaf })
        return
      }

      /*
       * One mode for the whole shape: its outline's nodes and the grid lines the
       * text flows through, together. `openShapeEditing` is shared with the
       * toolbar and the keyboard so all three mean exactly the same thing,
       * including deriving nodes for a shape that has none yet.
       */
      if (!openShapeEditing(id)) return

      /*
       * Applied here and not left to the effect, which runs a frame later.
       *
       * In that frame the object is still selectable, so a press arriving in it
       * drags the whole shape instead of grabbing a node — the object jumps
       * across the artboard and the drag looks like it came from nowhere.
       * Fabric reads these flags synchronously, so they are written
       * synchronously; the effect keeps them in step afterwards.
       *
       * Flagged as ours while it runs, because taking the bounding box away
       * makes Fabric announce a cleared selection — and the listener for that
       * would take it at face value and clear the selection just set, which is
       * the selection this whole mode hangs off.
       */
      applyingRef.current = true
      applyCanvasMode(canvas, 'select', true)
      applyingRef.current = false
      canvas.requestRenderAll()
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    canvas.on('mouse:dblclick', onDoubleClick)

    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      canvas.off('mouse:dblclick', onDoubleClick)
    }
  }, [])

  /* ------------------------------------------------------- fit to content */

  /**
   * Frame everything that has been drawn.
   *
   * One implementation, because there are two ways to ask for it — the fit
   * command and opening a spread — and a second copy would be a second thing
   * to keep in step with `contentBounds`.
   */
  const frameContent = useCallback((): void => {
    const canvas = fabricRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const r = container.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return

    // On an endless canvas "fit" means framing the artwork, not a page.
    const artboard = useDocumentStore.getState().doc.artboard
    const target = contentBounds(renderedRef.current) ?? {
      x: 0,
      y: 0,
      width: artboard.width,
      height: artboard.height,
    }
    const fitted = fitToRect(r.width, r.height, target, 96)
    canvas.setViewportTransform([fitted.zoom, 0, 0, fitted.zoom, fitted.panX, fitted.panY])
    useUiStore.getState().adjustViewport(fitted)
  }, [])

  useEffect(() => {
    const onFit = (): void => frameContent()
    window.addEventListener('text-shaper:fit', onFit)
    return () => window.removeEventListener('text-shaper:fit', onFit)
  }, [frameContent])

  /*
   * The spread does NOT re-frame the view. It used to zoom out to fit the whole
   * row, and back on collapse; the jump was the thing you noticed, not the row.
   * The row grows to the right of the frame at the zoom you were at, and the
   * plate behind it says where it ends. ⇧1 still fits everything.
   */

  /* ------------------------------------------------------------ zoom */
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return

    const container = containerRef.current
    const gesture = createWheelGesture()

    /** One wheel event, applied to the view; `at` is the cursor in the canvas's own pixels. */
    const apply = (e: WheelEvent, at: { x: number; y: number }): void => {
      e.preventDefault()
      e.stopPropagation()

      const vt = canvas.viewportTransform
      if (e.ctrlKey || e.metaKey) {
        // Pinch or ctrl+wheel: zoom about the cursor.
        const zoom = clamp(canvas.getZoom() * 0.999 ** (e.deltaY * 4), MIN_ZOOM, MAX_ZOOM)
        canvas.zoomToPoint(new Point(at.x, at.y), zoom)
      } else {
        // Plain wheel: pan, which is what a trackpad two-finger scroll means.
        vt[4] -= e.deltaX
        vt[5] -= e.deltaY
        canvas.setViewportTransform(vt)
      }
      const next = canvas.viewportTransform
      useUiStore.getState().adjustViewport({ zoom: next[0], panX: next[4], panY: next[5] })
      gesture.touch(performance.now())
    }

    const onWheel = (opt: TPointerEventInfo<WheelEvent>): void => {
      apply(opt.e, { x: opt.e.offsetX, y: opt.e.offsetY })
    }

    /*
     * Every wheel that is the canvas's but did not land on it.
     *
     * Seen first, at the window, before whatever is under the cursor can
     * scroll with it. Two cases. Anything floating over the stage — the tool
     * pill, the transport bar, the plate chips — is the canvas's ALWAYS: none
     * of it scrolls, and a pan that begins with the cursor resting on the
     * tools should pan. Anything outside the stage — the rail, the properties
     * panel — is the canvas's only while its gesture is still in flight (see
     * `wheelGesture.ts`), so a scroll that BEGINS on a panel is the panel's.
     * The canvas element itself is left to Fabric, which raises `mouse:wheel`.
     */
    const stage = container?.closest('.app__stage') ?? container
    const onWindowWheel = (e: WheelEvent): void => {
      if (!container || !stage || !(e.target instanceof Node)) return
      if (canvas.upperCanvasEl.contains(e.target) || canvas.lowerCanvasEl.contains(e.target)) return
      const floating = stage.contains(e.target)
      if (!floating && !gesture.holds(performance.now())) return
      const rect = container.getBoundingClientRect()
      apply(e, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      canvas.requestRenderAll()
    }

    canvas.on('mouse:wheel', onWheel)
    window.addEventListener('wheel', onWindowWheel, { capture: true, passive: false })
    return () => {
      canvas.off('mouse:wheel', onWheel)
      window.removeEventListener('wheel', onWindowWheel, { capture: true })
    }
  }, [])

  const selection = useDocumentStore((s) => s.selection)
  const selectedRowBands =
    selection.length === 1 && selection[0] ? (rowBands[selection[0]] ?? []) : []
  /**
   * The object whose points are on show.
   *
   * Both conditions have to hold: the object is the one that was gone inside,
   * AND it is still the selection. Selecting something else leaves point editing
   * without needing an effect to notice and clear the mode.
   */
  const objectsById = useDocumentStore((s) => s.doc.objects)
  const editingPoints = useUiStore((s) => s.editingPoints)
  const edited =
    editingPoints && selection.length === 1 && selection[0] === editingPoints
      ? objectsById[editingPoints]
      : undefined
  const editedObject = edited && isTypography(edited) ? edited : undefined
  /*
   * Whether point editing is really happening, which is NOT the same as the
   * stored id and must not be confused with it.
   *
   * Being inside an object's points depends on three things — the id, it still
   * being the whole selection, and the object still existing with nodes to edit
   * — and the id alone answers none of them. Every gate below reads THIS, so a
   * stale id can never leave the canvas in a mode nothing can get out of. It
   * did: `skipTargetFind` stayed on after the selection moved elsewhere, and the
   * whole artboard stopped answering clicks.
   */
  /*
   * A member's points count too.
   *
   * `editedObject` cannot see them — a member is not in `doc.objects` and the
   * frame is what is selected — so a gate reading it alone treated editing a
   * member's shape as editing nothing, and the effect that clears a stale
   * `editingPoints` threw you straight back out again.
   */
  const editingMemberPoints = Boolean(
    editingPoints &&
      insideFrame &&
      frameSelection.length === 1 &&
      objectsById[insideFrame]?.kind === 'frame',
  )
  /** The picture fill being cropped, and the object it is painted on. */
  const croppingPaint = useUiStore((s) => s.croppingPaint)
  const croppingObject = (() => {
    if (!croppingPaint) return undefined
    const top = objectsById[croppingPaint.objectId]
    if (top) return top
    const frame = croppingPaint.member ? objectsById[croppingPaint.member.frameId] : undefined
    if (!frame || frame.kind !== 'frame') return undefined
    const picked = frame.members.find((each) => each.id === croppingPaint.member!.memberId)
    return picked ? memberAsDrawn(picked, valuesFor(picked, frame.states[croppingPaint.stateIndex])) : undefined
  })()
  const cropping = Boolean(croppingObject)
  const editing = Boolean(editedObject) || editingMemberPoints || cropping

  /**
   * The mosaic whose tiles are on show.
   *
   * The one the caret is in, or failing that the one selected. Selection is
   * enough because the tile edges are what the spacing controls move, and
   * touching those controls means focus is in the panel — so outlines shown only
   * while typing were hidden exactly when they were being adjusted.
   */
  const typing = useUiStore((s) => s.typing)

  /** The mosaic being typed into, which owns the canvas while it is. */
  const editedMosaic = (() => {
    const found = typing ? objectsById[typing.object] : undefined
    return found?.kind === 'mosaic' ? found : undefined
  })()
  /** Or the mesh: the same mode, on polygons. */
  const editedMesh = (() => {
    const found = typing ? objectsById[typing.object] : undefined
    return found?.kind === 'mesh' ? found : undefined
  })()
  const shownMesh = (() => {
    if (editedMesh) return editedMesh
    if (selection.length !== 1) return undefined
    const selected = selection[0] ? objectsById[selection[0]] : undefined
    return selected?.kind === 'mesh' ? selected : undefined
  })()

  const shownMosaic = (() => {
    if (editedMosaic) return editedMosaic
    // Not inside one, but looking at one: its tile edges are what the spacing
    // controls move, and adjusting those means focus is in the panel — so
    // outlines shown only while editing were hidden exactly when they were
    // being changed.
    if (selection.length !== 1) return undefined
    const selected = selection[0] ? objectsById[selection[0]] : undefined
    return selected?.kind === 'mosaic' ? selected : undefined
  })()
  /**
   * Inside an object rather than looking at it.
   *
   * Point editing and mosaic editing are the same situation as far as the canvas
   * is concerned: the object's own handles must go, presses belong to the
   * overlay rather than to Fabric — otherwise dragging a tile edge would drag
   * the whole mosaic — and the bounding box would only be in the way. They stay
   * separate values because only one of them has a stale id to clean up.
   */
  /*
   * Being inside is a property of ONE object, never of the artboard.
   *
   * `inside` turns off `canvas.selection`, turns on `skipTargetFind` and makes
   * every shape unselectable, so it can only ever be entered deliberately — by
   * double-clicking the thing you mean. Deriving it from a panel tab instead
   * stopped the whole canvas answering clicks: tiles still responded, because
   * `MosaicLayer` hit-tests those itself, which is why it read as "only one
   * glyph can be selected" while everything else had quietly gone dead.
   */
  /** The object with states selected as a whole, if one is — through the one selection rule. */
  /** The frame being worked inside, which owns the canvas while it is. */
  const openFrame = (() => {
    const found = insideFrame ? objectsById[insideFrame] : undefined
    return found?.kind === 'frame' ? found : undefined
  })()
  /*
   * Or the points of a member, which the rule above cannot see.
   *
   * Inside a frame the SELECTION is still the frame, and a member is not in
   * `doc.objects` at all — so both of that test's conditions fail for the one
   * thing actually being edited. The member is resolved as the shown state has
   * it, so the handles sit on the shape that is drawn rather than on the one
   * the member rests at.
   */
  const editedMemberObject = (() => {
    if (!editingPoints || !openFrame || frameSelection.length !== 1) return undefined
    const picked = openFrame.members.find((each) => each.id === frameSelection[0])
    if (!picked || picked.object.id !== editingPoints) return undefined
    const at = Math.min(
      useUiStore.getState().mosaicStates[openFrame.id] ?? 0,
      openFrame.states.length - 1,
    )
    const shown = memberAsDrawn(picked, valuesFor(picked, openFrame.states[at]))
    return isTypography(shown) ? shown : undefined
  })()
  /** The points on show: a member's if one is being edited, else the object's. */
  const editedPoints = editedMemberObject ?? editedObject
  /*
   * Where a member's handles are mapped from: the frame's own transform, plus
   * the offset of the WINDOW that member is drawn in. A spread draws the same
   * member once per state and only the first is at the frame's own position,
   * so the frame's transform alone put the handles a row-step away from the
   * shape they belong to.
   */
  const memberHost = openFrame
    ? windowTransform(openFrame, shownWindow(openFrame, { spread, mosaicStates }))
    : undefined
  /** The object laid out as a row, if any — whichever kind it is. */
  const spreadObject = (() => {
    const found = spread ? objectsById[spread] : undefined
    return found && isStated(found) ? found : undefined
  })()

  const inside = editing || Boolean(editedMosaic) || Boolean(editedMesh) || Boolean(insideFrame)
  const editingRef = useRef(inside)
  editingRef.current = inside

  /**
   * The mosaic being worked INSIDE, and which must therefore hold still — the
   * ONE object taken hold of while its tiles are being picked.
   *
   * Not the artboard-wide `inside` switch, which is what broke selection when
   * this was tried before: one object's controls come off so that a tile
   * marquee cannot also scale it, and everything else on the canvas carries on
   * answering clicks as usual.
   */
  const colouringId = editedMosaic ? editedMosaic.id : editedMesh ? editedMesh.id : null
  const colouringIdRef = useRef(colouringId)
  colouringIdRef.current = colouringId

  // And the stored id is dropped once it means nothing, so the state does not
  // rot quietly between renders.
  useEffect(() => {
    if (editingPoints && !editing) useUiStore.getState().setEditingPoints(null)
  }, [editingPoints, editing])

  // A row folds when its object stops being selected from ANYWHERE — the
  // layers panel, a delete, an undo — not only from a press on the canvas.
  useEffect(() => {
    if (spread && !selection.includes(spread)) useUiStore.getState().setSpread(null)
  }, [selection, spread])

  useAnimationLoop(fabricRef, renderedRef)
  useMosaicPlayback(fabricRef, renderedRef)
  useMeshPlayback(fabricRef, renderedRef)
  useFramePlayback(fabricRef, renderedRef, fits, spread)

  /* ------------------------------------------------- tool -> cursor */
  const tool = useUiStore((s) => s.tool)
  const temporaryTool = useUiStore((s) => s.temporaryTool)
  const activeTool = temporaryTool ?? tool

  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return

    applyCanvasMode(
      canvas,
      activeTool,
      inside,
      Boolean(insideFrame) && !editingMemberPoints,
      insideFrame,
      spread !== null,
    )
    applyingRef.current = true
    syncSelectionToCanvas(canvas, renderedRef.current, inside)
    applyColourGuard(canvas, colouringId)
    applyingRef.current = false
    canvas.requestRenderAll()
  }, [activeTool, inside, colouringId, insideFrame, editingMemberPoints, spread])

  /* --------------------------------------- external viewport changes */
  const zoom = useUiStore((s) => s.zoom)
  const panX = useUiStore((s) => s.panX)
  const panY = useUiStore((s) => s.panY)
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const vt = canvas.viewportTransform
    if (vt[0] === zoom && vt[4] === panX && vt[5] === panY) return
    canvas.setViewportTransform([zoom, 0, 0, zoom, panX, panY])
  }, [zoom, panX, panY])

  return (
    <div
      className="canvas-stage"
      ref={containerRef}
      data-tool={activeTool}
      /*
       * A right-click on an object is a menu of what can be done to it — to
       * all of the selection, once the object is part of it. On nothing, the
       * browser's own menu stays away and nothing else happens.
       */
      onContextMenu={(e) => {
        const canvas = fabricRef.current
        if (!canvas) return
        e.preventDefault()
        const hit = canvas.findTarget(e.nativeEvent).target
        const doc = useDocumentStore.getState()
        const ui = useUiStore.getState()
        /*
         * Inside a frame, a press on a member is about the MEMBERS — a member
         * child carries its own object's `shapeId`, so it is asked for its
         * `memberId` first. One not yet picked becomes the pick, on the state
         * its window draws, as a left-click would make it; a press on the
         * frame's ground puts the pick down and is about the frame.
         */
        const probe = memberProbe(hit)
        const memberId = probe?.get('memberId') as string | undefined
        if (ui.insideFrame && memberId) {
          if (!ui.frameSelection.includes(memberId)) {
            const at = memberParentOf(probe)?.get?.('stateIndex')
            if (typeof at === 'number') ui.setFramePick(ui.insideFrame, [memberId], at)
            else ui.setFrameSelection([memberId])
          }
          setMenuAt({ x: e.clientX, y: e.clientY, members: true })
          return
        }
        const id = hit?.get('shapeId') as string | undefined
        // Several selected: Fabric answers with the selection itself, which is
        // every one of them — the menu is for all of them.
        const onSelection = hit instanceof ActiveSelection && doc.selection.length > 0
        if (!id && !onSelection) {
          setMenuAt(null)
          return
        }
        if (ui.insideFrame && ui.frameSelection.length > 0) ui.setFrameSelection([])
        if (id && !doc.selection.includes(id)) doc.setSelection([id])
        setMenuAt({ x: e.clientX, y: e.clientY, members: false })
      }}
    >
      <canvas ref={canvasElRef} />
      <GridLayer canvas={fabricRef.current} rowBands={selectedRowBands} />
      {/*
        Points are on show only after a double-click has gone inside the object,
        the way Figma does it. One rule for a drawn line and a drawn shape alike
        — a line's points used to appear on plain selection, so the two behaved
        differently for no reason a user could name, and a shape's could not be
        reached at all.
      */}
      <PathLayer
        canvas={fabricRef.current}
        object={editedPoints}
        host={editedMemberObject ? memberHost : undefined}
      />
      <PenLayer canvas={fabricRef.current} armed={activeTool === 'pen'} />
      {/* A picture fill being cropped: the rest of the picture, and the handles to move it. */}
      <CropLayer
        canvas={fabricRef.current}
        target={croppingPaint}
        object={croppingObject}
        host={croppingPaint?.member ? memberHost : undefined}
        textPath={croppingPaint ? textPaths[croppingPaint.objectId] : undefined}
        bandPath={croppingPaint ? bandPaths[croppingPaint.objectId] : undefined}
      />
      {/*
        A mosaic's tile edges, and the caret when one is in it. The caret still
        follows what is being TYPED INTO rather than what is selected, so
        clicking away puts it out without the selection having to change too.
      */}
      <MosaicLayer canvas={fabricRef.current} object={shownMosaic} />
      {/* The same furniture on a mesh's polygons. */}
      <MeshLayer canvas={fabricRef.current} object={shownMesh} />
      {/*
        Picking and moving what is inside a frame. Mounted always and inert
        unless you are in one, the same as the layers above it.
      */}
      <FrameLayer canvas={fabricRef.current} object={openFrame} />
      {/* The plate under the thing with states you have hold of: the open frame, or the selection. */}
      <FramePlate canvas={fabricRef.current} object={openFrame ?? stated} />
      {/*
        The bar under the selected object — play, its states, the spread. HTML
        rather than canvas so it keeps one size at every zoom and can take a
        hover, focus and a real menu. It follows the mosaic being typed into
        even while nothing is selected.
      */}
      <ObjectBar canvas={fabricRef.current} inside={editedMosaic ?? editedMesh} />
      <CropBar canvas={fabricRef.current} />
      {menuAt ? (
        <ContextMenu
          at={menuAt}
          onClose={() => setMenuAt(null)}
          items={(() => {
            const act = (label: string, run: () => void) => (): void => {
              run()
              useDocumentStore.getState().commit(label)
            }
            /* Lining up: only when there is more than one thing to line up. */
            const alignRows = (count: number): ContextMenuEntry[] =>
              count > 1
                ? [
                    'divider',
                    {
                      row: [...ALIGNMENT_OPTIONS, ...(count > 2 ? DISTRIBUTION_OPTIONS : [])].map(
                        (option) => ({
                          label: option.label,
                          shortcut: option.shortcut,
                          icon: option.icon,
                          onSelect: () => alignSelection(option.how),
                        }),
                      ),
                    },
                  ]
                : []
            const stacking = (move: (to: Stacking) => void): ContextMenuEntry[] =>
              (['front', 'forward', 'backward', 'back'] as const).map((to) => ({
                label: stackingLabel(to),
                shortcut:
                  to === 'front' ? '⌥⌘]' : to === 'forward' ? '⌘]' : to === 'backward' ? '⌘[' : '⌥⌘[',
                onSelect: act(stackingLabel(to), () => move(to)),
              }))

            const ui = useUiStore.getState()
            const doc = useDocumentStore.getState()
            if (menuAt.members && ui.insideFrame) {
              /* The members picked inside the open frame. */
              const frameId = ui.insideFrame
              const members = [...ui.frameSelection]
              const many = members.length > 1
              return [
                {
                  label: many ? 'Duplicate members' : 'Duplicate',
                  shortcut: '⌘D',
                  onSelect: act('Duplicate in frame', () => {
                    const store = useDocumentStore.getState()
                    const copies = members
                      .map((memberId) => store.duplicateFrameMember(frameId, memberId))
                      .filter((made): made is string => Boolean(made))
                    if (copies.length > 0) useUiStore.getState().setFrameSelection(copies)
                  }),
                },
                'divider',
                ...stacking((to) =>
                  useDocumentStore.getState().reorderFrameMembers(frameId, members, to),
                ),
                ...alignRows(members.length),
                'divider',
                {
                  label: many ? 'Delete members' : 'Delete',
                  shortcut: '⌫',
                  danger: true,
                  onSelect: act('Delete from frame', () => {
                    if (useDocumentStore.getState().deleteFrameMembers(frameId, members)) {
                      useUiStore.getState().setFrameSelection([])
                    }
                  }),
                },
              ]
            }

            const ids = [...doc.selection]
            const many = ids.length > 1
            return [
              {
                label: many ? 'Duplicate objects' : 'Duplicate',
                shortcut: '⌘D',
                onSelect: act('Duplicate', () => useDocumentStore.getState().duplicateObjects(ids)),
              },
              'divider',
              ...stacking((to) => useDocumentStore.getState().reorderObjects(ids, to)),
              ...alignRows(ids.length),
              'divider',
              {
                label: many ? 'Delete objects' : 'Delete',
                shortcut: '⌫',
                danger: true,
                onSelect: act('Delete', () => useDocumentStore.getState().deleteObjects(ids)),
              },
            ]
          })()}
        />
      ) : null}
      {/* What a press means on a row, for every kind; and the number over each window. */}
      <SpreadLayer canvas={fabricRef.current} object={spreadObject} />
      <SpreadChips canvas={fabricRef.current} object={spreadObject} />
      {/* The selected object's name, above it. */}
      <ObjectLabel canvas={fabricRef.current} />
      <EmptyHints canvas={fabricRef.current} />
    </div>
  )
}

/**
 * Put the canvas into the mode the active tool and the editing state imply.
 *
 * Its own function because it has to be applied at TWO different moments. The
 * effect below keeps it in step with React's state, and the double-click that
 * goes inside an object applies it there and then — before that handler
 * returns.
 *
 * Doing it only from the effect left a window one frame wide in which the mode
 * was set but nothing had been told: the object was still selectable, so a press
 * that arrived in that frame dragged the whole shape instead of grabbing a node.
 * Fabric's flags are read synchronously by Fabric's own event handling, so they
 * have to be written synchronously too.
 */
/**
 * The frame a just-moved object was dropped into, if any.
 *
 * By the object's CENTRE rather than by any overlap: an object half over a
 * frame's edge has to be either in or out, and the centre is the one answer a
 * person can predict while dragging. Overlap would capture something that
 * merely brushed past.
 *
 * The topmost frame wins where two overlap, matching what is drawn on top.
 */
function frameUnder(
  doc: TextShaperDocument,
  movedIds: readonly string[],
): { frameId: string; objectIds: string[] } | null {
  const frames = doc.objectOrder
    .map((id) => doc.objects[id])
    .filter((object): object is FrameObject => object?.kind === 'frame')
  if (frames.length === 0) return null

  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i] as FrameObject
    const box = {
      x: frame.transform.x + frame.localBounds.x,
      y: frame.transform.y + frame.localBounds.y,
      width: frame.localBounds.width,
      height: frame.localBounds.height,
    }
    const caught = movedIds.filter((id) => {
      const object = doc.objects[id]
      // A frame never swallows another frame: one level, deliberately.
      if (!object || object.kind === 'frame') return false
      const { x, y } = object.transform
      return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
    })
    if (caught.length > 0) return { frameId: frame.id, objectIds: caught }
  }
  return null
}

function applyCanvasMode(
  canvas: FabricCanvas,
  activeTool: ToolId,
  editing: boolean,
  /**
   * Inside a FRAME, which is the one "inside" that still wants Fabric hunting.
   *
   * Every other inside-mode hand-picks what the pointer is over — a node, a
   * tile — so Fabric targeting as well would drag the object out from under
   * them. A frame's members are Fabric's own objects now, so it has to target
   * them or there is no hover, no cursor and no handle to grab.
   */
  inFrame = false,
  /** The frame being worked inside, which stays selectable while every other object steps back. */
  openFrame: string | null = null,
  /** An object laid out as a row: a view you look at, not a field to lasso across. */
  spread = false,
): void {
  const drawing = activeTool === 'draw'
  const panning = activeTool === 'pan'
  const penning = activeTool === 'pen'
  const mosaicking = activeTool === 'mosaic' || activeTool === 'mesh'
  const framing = activeTool === 'frame'
  // No grid tool here any more: editing a shape is a MODE, and `editing` below
  // already says so. Its cursor is not a crosshair either — nothing is being
  // placed, handles are being taken hold of.
  const crosshair = drawing || penning || mosaicking || framing

  /*
   * On inside a frame as well: Fabric only joins a shift-clicked member to
   * the one already held when `selection` is on, and that is how more than
   * one member is picked. A press on the ground still drags the frame, and
   * one outside it leaves — so the marquee it also allows only ever begins
   * on the artboard.
   */
  canvas.selection = activeTool === 'select' && (!editing || inFrame) && !spread
  canvas.defaultCursor = panning ? 'grab' : crosshair ? 'crosshair' : 'default'
  canvas.hoverCursor = panning ? 'grab' : crosshair ? 'crosshair' : 'move'
  /*
   * Target finding OFF for every mode that edits an object's insides, and for
   * every tool whose click means "put something here".
   *
   * Without it a press on a node lands on the shape underneath as well and
   * Fabric drags the whole object out from under the point being moved; and a
   * pen click picks up whatever happens to be under it instead of placing a
   * node. The pen can still continue an existing path, because it reads the
   * SELECTION, which is already there when the tool is picked up.
   */
  canvas.skipTargetFind =
    drawing || panning || penning || mosaicking || framing || (editing && !inFrame)
  canvas.forEachObject((o) => {
    if (!o.get('shapeId')) return
    // Held back by being inside something — unless it IS the frame you are
    // inside, whose ground is how it is moved and resized from in there.
    const held = editing && !(inFrame && openFrame !== null && o.get('statedId') === openFrame)
    o.set({ selectable: activeTool === 'select' && !held })
  })
  /*
   * Going inside an object takes its bounding box away. The handles ARE the
   * selection now, and a box drawn over them is eight more things to hit and a
   * frame around the very geometry being read. Making the shape unselectable
   * does not drop a selection Fabric is already holding, so it is dropped here.
   */
  if (editing && !inFrame) canvas.discardActiveObject()
}

/**
 * A member's transform, as Fabric left it, written to the state on show.
 *
 * The inverse of how it was placed: `placementFor` carries the artwork offset
 * out through the object's own rotation and scale, so reading back takes it off
 * again. Everything else is read straight from the child — Fabric has done the
 * work, and a second implementation of "what did that drag mean" is exactly the
 * kind of duplicate that has bitten this feature five times.
 */
export function readMemberTransform(
  child: FabricObject,
): { frameId: string; memberId: string; at: number; transform: Transform2D } | null {
  const memberId = child.get('memberId') as string | undefined
  /*
   * Which frame and which STATE: the child's parent knows, because the group
   * stamps the state it draws. Asked there rather than of the UI store, so the
   * write lands on the state of the object the gesture acted on — a press
   * selects and a release modifies, and leaning on the store having caught up
   * would make the answer depend on event order.
   */
  const parent = memberParentOf(child)
  const frameId = parent?.get?.('statedId')
  const stamped = parent?.get?.('stateIndex')
  if (!memberId || typeof frameId !== 'string' || typeof stamped !== 'number') return null
  const frame = useDocumentStore.getState().doc.objects[frameId]
  if (!frame || frame.kind !== 'frame') return null
  const member = frame.members.find((each) => each.id === memberId)
  if (!member) return null

  const at = Math.min(stamped, frame.states.length - 1)
  const values = valuesFor(member, frame.states[at])
  const own = (child.get('localCentre') as Vec2 | undefined) ?? { x: 0, y: 0 }

  /*
   * Where the child sits in its FRAME.
   *
   * Held alone, its own properties say: Fabric keeps a child's `left`/`top`
   * relative to its group's centre. Held with others in an `ActiveSelection`,
   * they do not — the selection re-parents it, rewrites its position as an
   * offset from the selection's centre, and composes its own move, turn or
   * scale on top only when it draws. So a pair of members dragged together
   * read as one having moved by the wrong amount and the other not at all.
   * The composed matrix, taken back into the frame's plane, is the same
   * question answered once for both cases — as `readTransformFromGroup` does
   * for objects on the artboard. The flips stay the child's: a selection
   * cannot be flipped, and `decompose` folds a flipped X into a half turn.
   */
  const placed =
    child.group !== parent && parent
      ? readThroughSelection(child, parent as Group)
      : {
          left: child.left ?? 0,
          top: child.top ?? 0,
          rotation: child.angle ?? 0,
          scaleX: Math.abs(child.scaleX ?? 1),
          scaleY: Math.abs(child.scaleY ?? 1),
        }
  const { rotation, scaleX, scaleY } = placed
  const rad = (rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = scaleX * (child.flipX ? -1 : 1)
  const sy = scaleY * (child.flipY ? -1 : 1)
  const dx = own.x * sx
  const dy = own.y * sy

  return {
    frameId,
    memberId,
    at,
    transform: {
      ...values.transform,
      x: placed.left - (dx * cos - dy * sin),
      y: placed.top - (dx * sin + dy * cos),
      scaleX,
      scaleY,
      rotation,
      flipX: Boolean(child.flipX),
      flipY: Boolean(child.flipY),
    },
  }
}

/** A child's placement in `parent`'s plane, read through whatever Fabric has wrapped it in. */
function readThroughSelection(
  child: FabricObject,
  parent: Group,
): { left: number; top: number; rotation: number; scaleX: number; scaleY: number } {
  const local = decompose(
    multiply(invert(parent.calcTransformMatrix() as Mat2D), child.calcTransformMatrix() as Mat2D),
  )
  // `decompose` reports a flipped X as a half turn with Y flipped instead;
  // the child's own flips are kept, so the turn comes back off the angle.
  const rotation = local.rotation - (child.flipX ? 180 : 0)
  return {
    left: local.x,
    top: local.y,
    rotation: ((rotation % 360) + 540) % 360 - 180,
    scaleX: local.scaleX,
    scaleY: local.scaleY,
  }
}

function syncSelectionToCanvas(
  canvas: FabricCanvas,
  rendered: Map<string, RenderedObject>,
  editingPoints: boolean,
): void {
  /*
   * Inside an object's points, it is not shown as selected.
   *
   * The handles ARE the selection now, and a bounding box drawn over them is
   * eight more things to hit and a frame around geometry the user is trying to
   * read. Fabric drops the active object on its own when the shape is made
   * unselectable; without this, the next document change — which is every
   * keystroke — put it straight back.
   */
  /*
   * Inside a frame, the thing Fabric should be holding is a MEMBER.
   *
   * The other direction of the mirror: `onSelection` sends Fabric's answer to
   * the store, and this sends the store's back — which is what makes a member
   * picked by the double-click that entered the frame arrive wearing Fabric's
   * own controls, rather than merely being noted in the panel.
   */
  const ui = useUiStore.getState()
  if (ui.insideFrame && !ui.editingPoints) {
    const entry = rendered.get(ui.insideFrame)
    /*
     * Searched in the WINDOW the pick was made in, because a spread draws the
     * same member once per state. The pick recorded which state; that is the
     * window. Collapsed there is one window and the answer is the same.
     */
    const windows = entry ? windowsOf(entry) : []
    const at = Math.min(ui.mosaicStates[ui.insideFrame] ?? 0, Math.max(0, windows.length - 1))
    const group = windows[0]
    const children = ui.frameSelection
      .map((wanted) =>
        (windows[at] ?? group)?.getObjects().find((each) => each.get('memberId') === wanted),
      )
      .filter((each): each is FabricObject => Boolean(each))
    const holding = canvas.getActiveObject()
    /*
     * More than one member picked: an `ActiveSelection` of them, the same
     * thing Fabric builds when they are shift-clicked, so a multi-pick that
     * came from the store — a menu action, a render after a write — wears
     * one box and moves as one, as it does on the artboard. Kept when Fabric
     * is already holding exactly these children.
     */
    if (children.length > 1) {
      const same =
        holding instanceof ActiveSelection &&
        holding.size() === children.length &&
        children.every((each) => holding.contains(each))
      if (!same) canvas.setActiveObject(new ActiveSelection(children, { canvas }))
      return
    }
    const child = children[0]
    if (child) {
      if (holding !== child) canvas.setActiveObject(child)
      return
    }
    /*
     * Nothing inside it picked: the FRAME is what is held. Its box and handles
     * are back the moment the member pick is put down, as in Figma — and it is
     * how a frame is moved or resized without leaving it first.
     */
    if (group && holding !== group) canvas.setActiveObject(group)
    return
  }

  if (editingPoints) {
    canvas.discardActiveObject()
    return
  }

  const ids = useDocumentStore.getState().selection
  const current = canvas
    .getActiveObjects()
    .map((o) => o.get('shapeId') as string | undefined)
    .filter((id): id is string => Boolean(id))

  if (sameIds(ids, current)) return

  canvas.discardActiveObject()
  const targets = ids
    .map((id) => rendered.get(id)?.group)
    .filter((g): g is NonNullable<typeof g> => Boolean(g))

  if (targets.length === 1 && targets[0]) {
    canvas.setActiveObject(targets[0])
  } else if (targets.length > 1) {
    /*
     * Rebuilt here rather than left to whatever Fabric happened to be holding.
     *
     * `syncCanvas` has just taken the objects out of any selection so it could
     * place them, and it also replaces a group outright whenever its drawing
     * changes — which happens on every keystroke. A selection left alone would
     * be pointing at groups that are no longer on the canvas, drawn from the
     * relative coordinates they had when they were parented. So the store's ids
     * are the selection, and this is where they become one.
     */
    canvas.setActiveObject(new ActiveSelection(targets, { canvas }))
  }
  canvas.requestRenderAll()
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((id) => set.has(id))
}

/**
 * Play the selected shape's loop, straight onto the canvas.
 *
 * Runs only while the Animate tab is open, so the artboard stays still during
 * layout work — and only for the selected shape, because one moving thing is
 * what you are judging.
 *
 * React is deliberately not involved per frame. The phase lives in a ref and
 * the new outline is written onto the Fabric child directly: re-rendering the
 * component tree at frame rate would be hopeless, and a store write per frame
 * would bury undo history under hundreds of entries.
 *
 * The layout is solved ONCE when playback starts and reused for every frame.
 * Re-solving would not only be far too slow, it would let the line breaks move
 * part-way through a loop.
 */
/** One animated object's solved frames, and the artwork to put back. */
interface PlaybackEntry {
  signature: string
  source: NonNullable<ReturnType<typeof prepareFrames>>
  resting: ReturnType<typeof stillFrame>
  /** The container's resting outline, for the frames that leave it alone. */
  rest: { path: Path['path']; fill: Path['fill'] } | null
  /**
   * The group `rest` was measured from.
   *
   * Kept so the measurement is never taken twice off the same group. `rest` is
   * read off the canvas, and once this loop has painted a shape animation into a
   * group the container standing there is a FRAME rather than the shape — so
   * re-measuring on a rebuild would record a mid-pulse outline as the resting
   * one, and every later frame that leaves the container alone would leave it
   * alone in that position.
   *
   * `syncCanvas` replaces a group outright whenever its drawing changes, so a
   * different instance is a freshly built one, resting, and safe to measure.
   */
  group: Group
}

/**
 * Every animated object on the canvas, painted from one clock.
 *
 * ONE long-lived frame loop, not one per object and not one that restarts. What
 * it holds per object is solved once and rebuilt only when that object changes —
 * the fit behind a frame is far too slow to run at frame rate, and re-solving
 * mid-loop would let line breaks move while the words were moving.
 *
 * The loop reads the document through a ref rather than through its dependency
 * array, which is what lets an edit land live. That matters more than it sounds:
 * an effect that restarted on every edit would take the shared clock with it and
 * jerk every OTHER object back to the start of its loop, so nudging one slider
 * would visibly reset the whole artboard.
 */

/**
 * A mosaic previewing its own timeline.
 *
 * Separate from `useAnimationLoop`, which drives typography through presets on a
 * shared clock. A mosaic moves between compositions somebody authored, on a
 * timeline of its own, so it has its own loop and its own evaluator.
 *
 * Nothing here writes to the document. The frame is worked out by
 * `evaluateMosaicAtTime` and painted straight onto the group the renderer
 * already built — no rebuild, no path serialisation, no history. Stopping paints
 * the authored state back, through the same painter, so the canvas can never be
 * left holding a frame that belongs to no state.
 */
function useMosaicPlayback(
  fabricRef: React.RefObject<FabricCanvas | null>,
  renderedRef: React.RefObject<Map<string, RenderedObject>>,
): void {
  const playback = useUiStore((s) => s.mosaicPlayback)
  const shownStates = useUiStore((s) => s.mosaicStates)
  const globalPlaying = useUiStore((s) => s.playing)
  const spread = useUiStore((s) => s.spread)
  const doc = useDocumentStore((s) => s.doc)

  const liveRef = useRef({ doc, shownStates })
  liveRef.current = { doc, shownStates }

  const previewing = playback?.playing === true ? (playback.object ?? null) : null
  const { ids, shared } = animatingMosaicIds(doc, { playing: globalPlaying, previewing, spread })
  const from = shared ? 0 : (playback?.atMs ?? 0)
  // The effect restarts only when the SET changes, not on every document edit.
  const key = ids.join(',')

  useEffect(() => {
    const canvas = fabricRef.current
    if (key === '' || !canvas) return
    const animating = key.split(',')

    const objectOf = (id: string): LetterMosaicObject | null => {
      const object = liveRef.current.doc.objects[id]
      return object && object.kind === 'mosaic' ? object : null
    }
    const groupOf = (id: string): Group | null => renderedRef.current?.get(id)?.group ?? null

    /*
     * The outlines are built for the biggest rectangle each tile reaches across
     * every state, so a frame only ever scales them down. Worked out once per
     * mosaic rather than per frame — they depend on the states, not the clock.
     */
    const references = new Map<string, Map<string, Rect>>()
    const signatures = new Map<string, string>()
    for (const id of animating) {
      const object = objectOf(id)
      if (!object) continue
      references.set(id, glyphReferenceRects(object))
      signatures.set(id, JSON.stringify(object.states.map((each) => [each.x, each.y])))
    }

    /** Put a mosaic back on the state being edited. */
    const settle = (id: string): void => {
      const object = objectOf(id)
      const group = groupOf(id)
      if (!object || !group) return
      const at = liveRef.current.shownStates[id] ?? 0
      const state = object.states[at] ?? object.states[0]
      if (!state) return
      paintMosaicFrame(
        group,
        {
          stateIndex: at,
          nextStateIndex: null,
          segment: 'hold',
          localTime: 0,
          progress: 0,
          easedProgress: 0,
          coordinateValues: { ...state.x, ...state.y },
          spacing: { gap: state.gap, outerPadding: state.outerPadding, glyphInset: state.glyphInset },
          corners: { tileRadius: state.tileRadius, outerRadius: state.outerRadius },
          font: state.font,
          fontKey: fontKey(state.font),
          chars: state.chars,
          glyphKeys: Object.fromEntries(
            Object.entries(state.chars).map(([tile, char]) => [
              tile,
              `${char}|${fontKey(state.font)}`,
            ]),
          ),
          glyphColours: state.glyphColour,
          tileColours: state.tileColour,
          background: state.background ?? null,
          stroke: state.stroke ?? null,
          tileLayouts: layoutMosaic(object.tiles, state.x, state.y, object.localBounds, {
            gap: state.gap,
            outerPadding: state.outerPadding,
            glyphInset: state.glyphInset,
          }),
        },
        references.get(id) ?? new Map(),
        object.localBounds,
      )
    }

    let handle = 0
    const epoch = performance.now()

    const tick = (): void => {
      let painted = false
      for (const id of animating) {
        const object = objectOf(id)
        const group = groupOf(id)
        if (!object || !group) continue

        // Editing a state during playback changes what the outlines have to
        // cover, so the references are refreshed when the states actually move.
        const now = JSON.stringify(object.states.map((each) => [each.x, each.y]))
        if (now !== signatures.get(id)) {
          signatures.set(id, now)
          references.set(id, glyphReferenceRects(object))
        }

        /*
         * One clock for every mosaic under the global play button, so two of the
         * same length stay in step. The panel's preview keeps its own position
         * instead, which is what lets pause and play pick up where they were.
         */
        const wall = from + (performance.now() - epoch)
        // Speed converts wall time into authored time. The evaluator itself
        // knows nothing about it, so a boundary is the same moment at any rate.
        const authored = authoredTimeFor(object, wall)
        setPlayhead(id, authored)
        const frame = evaluateMosaicAtTime(object, authored)
        paintMosaicFrame(group, frame, references.get(id) ?? new Map(), object.localBounds)
        painted = true
      }
      if (painted) canvas.requestRenderAll()
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(handle)
      clearPlayhead(animating)
      const ui = useUiStore.getState()
      /*
       * Where the panel's clock got to, so pressing play again resumes rather
       * than starting over. One write, at the end, not sixty a second. The
       * global button has no position to keep — it always starts from zero.
       */
      if (!shared && ui.mosaicPlayback?.playing) {
        ui.pauseMosaicPlayback(from + (performance.now() - epoch))
      } else {
        for (const id of animating) settle(id)
        canvas.requestRenderAll()
      }
    }
  }, [fabricRef, renderedRef, key, from, shared])
}

/**
 * Meshes, running between their arrangements.
 *
 * The mosaic's loop with the mesh's painter: every tick evaluates the mesh at
 * authored time and rewrites the group's paths in place. A cache per mesh
 * remembers which tiles stood still, so a frame that moves one corner costs
 * one corner's tiles.
 */
function useMeshPlayback(
  fabricRef: React.RefObject<FabricCanvas | null>,
  renderedRef: React.RefObject<Map<string, RenderedObject>>,
): void {
  const playback = useUiStore((s) => s.mosaicPlayback)
  const shownStates = useUiStore((s) => s.mosaicStates)
  const globalPlaying = useUiStore((s) => s.playing)
  const spread = useUiStore((s) => s.spread)
  const doc = useDocumentStore((s) => s.doc)

  const liveRef = useRef({ doc, shownStates })
  liveRef.current = { doc, shownStates }

  const previewing = playback?.playing === true ? (playback.object ?? null) : null
  const { ids, shared } = animatingMeshIds(doc, { playing: globalPlaying, previewing, spread })
  const from = shared ? 0 : (playback?.atMs ?? 0)
  const key = ids.join(',')

  useEffect(() => {
    const canvas = fabricRef.current
    if (key === '' || !canvas) return
    const animating = key.split(',')

    const objectOf = (id: string): MeshObject | null => {
      const object = liveRef.current.doc.objects[id]
      return object && object.kind === 'mesh' ? object : null
    }
    const caches = new Map<string, MeshPaintCache>()
    const paint = (id: string, authored: number | null): void => {
      const object = objectOf(id)
      const group = renderedRef.current?.get(id)?.group
      if (!object || !group) return
      const centre = (group.get('localCentre') as Vec2 | undefined) ?? { x: 0, y: 0 }
      let cache = caches.get(id)
      if (!cache) {
        cache = newPaintCache()
        caches.set(id, cache)
      }
      const frame =
        authored === null
          ? restingMeshFrame(object, liveRef.current.shownStates[id] ?? 0)
          : evaluateMeshAtTime(object, authored)
      paintMeshFrame(group as never, frame, object.tiles, centre, cache)
    }

    let handle = 0
    const epoch = performance.now()
    const tick = (): void => {
      let painted = false
      for (const id of animating) {
        const object = objectOf(id)
        if (!object) continue
        const wall = from + (performance.now() - epoch)
        const authored = meshAuthoredTimeFor(object, wall)
        setPlayhead(id, authored)
        paint(id, authored)
        painted = true
      }
      if (painted) canvas.requestRenderAll()
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(handle)
      clearPlayhead(animating)
      const ui = useUiStore.getState()
      if (!shared && ui.mosaicPlayback?.playing) {
        ui.pauseMosaicPlayback(from + (performance.now() - epoch))
      } else {
        for (const id of animating) paint(id, null)
        canvas.requestRenderAll()
      }
    }
  }, [fabricRef, renderedRef, key, from, shared])
}

/**
 * Frames, running between their arrangements.
 *
 * Much cheaper than the mosaic's loop and for a good reason: a frame never
 * rebuilds anything per frame. Its members are already built and nested, so a
 * tick is a transform and an opacity per member — which is exactly why the tier
 * table puts everything that would need re-solving into the CUT column.
 */
function useFramePlayback(
  fabricRef: React.RefObject<FabricCanvas | null>,
  renderedRef: React.RefObject<Map<string, RenderedObject>>,
  /** Solved fits by member object id, so a morph carries its type with it. */
  fits: Record<string, (FitOutcome | null)[]>,
  /** The frame laid out as a row, which cannot animate. */
  spread: string | null,
): void {
  const playback = useUiStore((s) => s.mosaicPlayback)
  const globalPlaying = useUiStore((s) => s.playing)
  const doc = useDocumentStore((s) => s.doc)

  const liveRef = useRef(doc)
  liveRef.current = doc
  /*
   * Refreshed every render without restarting the loop, as the document is. A
   * fit arriving — a font landing, say — must reach the next frame, not wait for
   * the animation to be stopped and started again.
   */
  const fitsRef = useRef(fits)
  fitsRef.current = fits

  const previewing = playback?.playing === true ? (playback.object ?? null) : null
  const interacting = useUiStore((s) => s.interacting)
  const { ids, shared } = animatingFrameIds(doc, {
    playing: globalPlaying,
    previewing,
    interacting,
    spread,
  })
  const from = shared ? 0 : (playback?.atMs ?? 0)
  const key = ids.join(',')

  useEffect(() => {
    const canvas = fabricRef.current
    if (key === '' || !canvas) return
    const animating = key.split(',')

    let handle = 0
    const epoch = performance.now()

    /**
     * A press on a playing frame settles it FIRST.
     *
     * Fired before Fabric resolves the gesture, so the member the pointer is
     * on is put back on the state being edited before the drag is set up —
     * otherwise the drag began from wherever the clock had painted it, and the
     * release wrote a moment that belonged to no state. A preview of the frame
     * ends here, as a press on a previewing mosaic ends its preview; under the
     * global play the frame is merely held until the pointer lets go.
     */
    const onPress = (opt: { target?: FabricObject }): void => {
      const hit = memberProbe(opt.target)
      const parent = memberParentOf(hit)
      const frameId = hit?.get('memberId')
        ? (parent?.get?.('statedId') as string | undefined)
        : (hit?.get('statedId') as string | undefined)
      if (!frameId || !animating.includes(frameId)) return
      const object = liveRef.current.objects[frameId]
      const group = renderedRef.current?.get(frameId)?.group
      if (!object || object.kind !== 'frame' || !group) return
      const ui = useUiStore.getState()
      settleFrame(group, object, ui.mosaicStates[frameId] ?? 0, fitsRef.current)
      ui.setInteracting(frameId)
      if (ui.mosaicPlayback?.object === frameId) ui.stopMosaicPlayback()
      canvas.requestRenderAll()
    }
    canvas.on('mouse:down:before', onPress)

    const paint = (frame: FrameObject, authoredMs: number, now: number): void => {
      const group = renderedRef.current?.get(frame.id)?.group
      if (!group) return
      const moment = evaluateFrameAtTime(frame, authoredMs)
      paintFrameBackground(group, moment.background)

      for (const child of group.getObjects()) {
        const memberId = child.get('memberId') as string | undefined
        if (!memberId) continue
        const values = moment.members[memberId]
        if (!values) continue
        const member = frame.members.find((each) => each.id === memberId)
        // Where it stands, how see-through it is, and how it is painted — all
        // through the one function the still build uses, so the two cannot
        // answer differently. They already had, three times over.
        if (!member) continue
        /*
         * The member's OWN phase, from the shared clock — a second clock beside
         * the frame's. The frame says where the member is and what it looks
         * like; its preset says what it is doing there, and the two compose
         * rather than competing.
         */
        const own =
          member.object.kind === 'typography'
            ? phaseAt(now - epoch, member.object.animation.loopDuration)
            : 0
        applyMemberMoment(child, member, values, fitsRef.current, moment.stateIndex, own)
      }
      group.set('dirty', true)
    }

    const tick = (): void => {
      const now = performance.now()
      for (const id of animating) {
        const object = liveRef.current.objects[id]
        if (!object || object.kind !== 'frame') continue
        // Wall time into authored time, which is where speed comes in — the
        // evaluator itself only ever sees the timeline as written.
        const authored = frameAuthoredTimeFor(object, from + (now - epoch))
        setPlayhead(id, authored)
        paint(object, authored, now)
      }
      canvas.requestRenderAll()
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(handle)
      clearPlayhead(animating)
      /*
       * Put every frame back on the state being edited, so stopping leaves the
       * arrangement somebody is working on rather than wherever the clock
       * happened to be — the same courtesy the mosaic's loop pays.
       */
      canvas.off('mouse:down:before', onPress)
      const holding = canvas.getActiveObject() ?? undefined
      const held = useUiStore.getState().interacting
      for (const id of animating) {
        const object = liveRef.current.objects[id]
        if (!object || object.kind !== 'frame') continue
        const at = useUiStore.getState().mosaicStates[id] ?? 0
        const group = renderedRef.current?.get(id)?.group
        if (!group) continue
        // Stopped BECAUSE a member is being dragged: Fabric owns that child
        // until release, and putting it back on its state would snatch it
        // out from under the pointer.
        settleFrame(group, object, at, fitsRef.current, id === held ? holding : undefined)
      }
      canvas.requestRenderAll()
    }
  }, [fabricRef, renderedRef, key, from])
}

function useAnimationLoop(
  fabricRef: React.RefObject<FabricCanvas | null>,
  renderedRef: React.RefObject<Map<string, RenderedObject>>,
): void {
  const panelTab = useUiStore((s) => s.panelTab)
  const playing = useUiStore((s) => s.playing)
  const previewing = useUiStore((s) => s.previewObject)
  const interacting = useUiStore((s) => s.interacting)
  const selection = useDocumentStore((s) => s.selection)
  const doc = useDocumentStore((s) => s.doc)

  // Motion previews while the Animate tab is open, so a preset can be judged as
  // it is chosen. A mosaic has no such tab: it plays from the control under it.
  const watching = panelTab === 'animate'
  const state: PlaybackState = { playing, watching, selection, interacting, previewing }

  // Everything the loop reads, refreshed on every render without restarting it.
  const liveRef = useRef({ doc, state })
  liveRef.current = { doc, state }

  /** Whether the loop needs to run at all — the only thing it restarts for. */
  const wanted = animatingIds(doc, state)
  const idle = wanted.length === 0

  useEffect(() => {
    const canvas = fabricRef.current
    if (idle || !canvas) return

    const entries = new Map<string, PlaybackEntry>()
    const groupOf = (id: string): Group | null => renderedRef.current?.get(id)?.group ?? null
    const fontReady = (object: TypographyObject): boolean => isFontLoaded(object.font.fontId)

    /** The container child, whose outline most frames leave exactly alone. */
    const restOf = (group: Group): PlaybackEntry['rest'] => {
      const container = group
        .getObjects()
        .find(
          (child: { get(key: string): unknown }) =>
            child instanceof Path && child.get('role') === 'container',
        )
      return container instanceof Path ? { path: container.path, fill: container.fill } : null
    }

    /**
     * Put an object back the way it rests.
     *
     * Through the same function the frames went through, so it is every part of
     * the artwork rather than the parts whoever wrote it happened to think of.
     * Called when an object leaves the set and when the loop stops, which is
     * what stops a shape being stranded mid-loop.
     */
    const settle = (id: string, entry: PlaybackEntry): void => {
      const group = groupOf(id)
      if (group && entry.resting) paintFrame(group, entry.resting, entry.rest)
    }

    let handle = 0
    const epoch = performance.now()
    /**
     * The objects resting because they are being handled, so each is put back
     * once rather than on every frame of a drag.
     */
    const settled = new Set<string>()

    const tick = (): void => {
      const { doc: live, state: now } = liveRef.current
      const ids = animatingIds(live, now)

      // Rebuild what is new or stale, and let go of what has left.
      const { build, drop } = playbackDiff(entries, live, ids, fontReady)
      for (const id of drop) {
        const entry = entries.get(id)
        if (entry) settle(id, entry)
        entries.delete(id)
        settled.delete(id)
      }
      for (const id of build) {
        const object = live.objects[id]
        // `animatingIds` already excludes them; this is what makes that a
        // type-level fact rather than a coincidence the compiler has to trust.
        if (!object || !isTypography(object)) continue
        const group = groupOf(id)
        const source = prepareFrames(object)
        if (!group || !source) {
          entries.delete(id)
          continue
        }
        const previous = entries.get(id)
        entries.set(id, {
          signature: signatureOf(object, fontReady(object)),
          source,
          resting: stillFrame(object),
          rest: previous?.group === group ? previous.rest : restOf(group),
          group,
        })
        settled.delete(id)
      }

      let painted = false
      for (const id of ids) {
        const entry = entries.get(id)
        const object = live.objects[id]
        const group = groupOf(id)
        if (!entry || !object || !isTypography(object) || !group) continue

        /*
         * The object being handled sits this out, resting, until the gesture is
         * over — and is put back ONCE rather than repainted every frame of a
         * drag that is not going to change it.
         */
        if (now.interacting === id) {
          if (!settled.has(id)) {
            settle(id, entry)
            settled.add(id)
            painted = true
          }
          continue
        }
        settled.delete(id)

        const phase = phaseAt(performance.now() - epoch, object.animation.loopDuration)
        paintFrame(group, frameAt(object, entry.source, phase), entry.rest)
        painted = true
      }

      if (painted) canvas.requestRenderAll()
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(handle)
      for (const [id, entry] of entries) settle(id, entry)
      canvas.requestRenderAll()
    }
    // Only whether there is anything to animate at all. Everything else is read
    // live, on purpose — see the note above.
  }, [idle, fabricRef, renderedRef])
}
