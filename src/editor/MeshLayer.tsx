import { Circle, Line, Polygon, Rect, type Canvas as FabricCanvas, type FabricObject } from 'fabric'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  pointArtboardToObject,
  pointObjectToArtboard,
  vectorObjectToArtboard,
} from '../geometry/objectSpace'
import {
  dragNodes,
  handleAt,
  nodesMovedBy,
  nodesOf,
  sameHandle,
  thicknessFloor,
  type MeshHandle,
  type Tolerance,
} from '../mesh/edit'
import { activeMeshState, firstMeshTile, meshSpacing, meshTileAt, meshTiles } from '../mesh/layout'
import { collinearChain, edgeKey, edgesOf, polygonBounds, type Positions } from '../mesh/mesh'
import { chordAcross, extrusionOffset, extrusionReach, isBendPoint } from '../mesh/ops'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { MeshObject, Vec2 } from '../types/document'
import { meshMoves } from './animationPlayback'
import { selectionColour } from './colours'
import { resizeCursorFor } from './cursors'
import { shownTransform } from './stated'
import { useTileTyping, type TypingTarget } from './tileTyping'

/**
 * The editing furniture on a mesh: every tile's outline, the picked tiles, the
 * caret — and the handles that reshape it. A dot on every node and every edge
 * grabbable; a drag on either writes node positions into the state on show.
 * Then the gestures that change what the mesh IS: double-click an edge for a
 * point, ⌘-drag a rim edge to grow a cell out of it, ⌘-drag across a cell to
 * cut it, Backspace on a picked point to take it out.
 *
 * The mesh's `MosaicLayer`, on polygons. Everything maps through the object's
 * LIVE transform stood to the shown window, as the mosaic's does, so the
 * outlines travel with the object mid-drag and sit on the window being edited
 * while it is spread. The gesture has the mosaic's shape too: a press on a
 * handle is HELD rather than acted on, and only moving makes it a drag —
 * let go without moving and it was a click on the tile (or the node) under it.
 */

const FOCUS_COLOR = selectionColour
/** The nodes have nowhere further to go. */
const LIMIT_COLOR = '#e0a03a'
const OUTLINE_OPACITY = 0.55
const CARET_BLINK_MS = 530
/** Reach of the handle hit test, in SCREEN pixels, so it feels the same at any zoom. */
const HOVER_PIXELS = 7
/** How far the pointer must travel before a held press becomes a drag. */
const DRAG_SLOP_PIXELS = 3
/** A node's dot, in screen pixels. */
const NODE_RADIUS = 3.5

interface Pending {
  handle: MeshHandle
  from: Vec2
  tolerance: Tolerance
  shift: boolean
  /** Shift on an edge limits the drag to the segment. */
  segmentOnly: boolean
}

interface Gesture {
  handle: MeshHandle
  /** The nodes this drag moves. */
  moved: string[]
  /** The one the snap is measured on. */
  primary: string
  /** Where the pointer went down, in the mesh's own space. */
  from: Vec2
  /** Where every node was, so each frame starts from the same place. */
  before: Record<string, Vec2>
  /** Whether any frame has written a position other than `before`. */
  changed: boolean
}

interface Marquee {
  from: Vec2
  add: boolean
  /** Sweeping nodes rather than tiles — Alt held at the press. */
  nodes: boolean
  band: Rect | null
}

/** A cell being grown out of a rim edge; the ghost shows where it will be. */
interface Extrude {
  edge: [string, string]
  from: Vec2
  tolerance: Tolerance
  ghost: Polygon | null
}

/** A cut being drawn across a tile; the line shows the chord it will take. */
interface Cut {
  tile: string
  from: Vec2
  tolerance: Tolerance
  line: Line | null
}

const shownIndex = (o: MeshObject): number =>
  Math.min(useUiStore.getState().mosaicStates[o.id] ?? 0, o.states.length - 1)

const positionsOf = (o: MeshObject): Positions => activeMeshState(o, shownIndex(o))?.nodes ?? {}

const isFormField = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function MeshLayer({
  canvas,
  object,
}: {
  canvas: FabricCanvas | null
  object: MeshObject | undefined
}) {
  const typing = useUiStore((s) => s.typing)
  const selection = useUiStore((s) => s.mosaicSelection)
  const focus = object && typing?.object === object.id ? typing.leaf : null
  const inside = Boolean(focus)
  const shown = useUiStore((s) => (object ? (s.mosaicStates[object.id] ?? 0) : 0))
  const spread = useUiStore((s) => Boolean(object) && s.spread === object?.id)
  const previewing = useUiStore((s) => {
    if (!object) return false
    if (s.mosaicPlayback?.object === object.id) return true
    return s.playing && meshMoves(object)
  })
  /*
   * A counter that ticks while the object is being dragged, scaled or turned —
   * the mosaic's. Fabric writes the result back only when the gesture ends, so
   * nothing in the document changes in between and the overlay would sit at
   * the old place until then.
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

  const tiles = useMemo(() => (object ? meshTiles(object, shown) : null), [object, shown])
  const shapesRef = useRef<FabricObject[]>([])
  const blinkRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const gestureRef = useRef<Gesture | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const extrudeRef = useRef<Extrude | null>(null)
  const cutRef = useRef<Cut | null>(null)
  const lastPointRef = useRef<Vec2 | null>(null)
  const releaseToleranceRef = useRef<Tolerance | null>(null)

  /**
   * Which handle is under the pointer, which is held, whether it is at its
   * limit, and which nodes are picked: STATE, because the overlay draws them.
   */
  const [hovered, setHovered] = useState<MeshHandle | null>(null)
  const [active, setActive] = useState<MeshHandle | null>(null)
  const [limited, setLimited] = useState(false)
  const [pickedRaw, setPicked] = useState<string[]>([])
  // Picked nodes that are no longer in the mesh are no longer picked.
  const picked = useMemo(() => {
    if (!object) return pickedRaw
    const known = new Set(nodesOf(object.tiles))
    return pickedRaw.every((id) => known.has(id)) ? pickedRaw : pickedRaw.filter((id) => known.has(id))
  }, [object, pickedRaw])
  const pickedRef = useRef<string[]>([])
  useEffect(() => {
    pickedRef.current = picked
  }, [picked])

  /* Outlines, the picked tiles, the focus ring, the caret, the handles. */
  useEffect(() => {
    if (!canvas) return

    const clear = (): void => {
      if (blinkRef.current) {
        clearInterval(blinkRef.current)
        blinkRef.current = null
      }
      for (const shape of shapesRef.current) canvas.remove(shape)
      shapesRef.current = []
    }
    clear()
    if (!object || !tiles || previewing) {
      canvas.requestRenderAll()
      return
    }

    const zoom = canvas.getZoom() || 1
    const host = shownTransform(canvas, object)
    const toArtboard = (p: Vec2): Vec2 => pointObjectToArtboard(host, p)
    const shared = { selectable: false, evented: false, objectCaching: false, strokeUniform: true } as const
    const chosen = new Set(selection)
    const positions = positionsOf(object)
    const add = (shape: FabricObject, role: string): void => {
      shape.set('gridRole', role)
      shapesRef.current.push(shape)
      canvas.add(shape)
    }

    for (const [id, layout] of tiles) {
      if (id === focus) continue
      add(
        new Polygon(layout.visible.map(toArtboard), {
          ...shared,
          fill: 'transparent',
          stroke: FOCUS_COLOR(),
          strokeWidth: 1 / zoom,
          strokeDashArray: [4 / zoom, 3 / zoom],
          opacity: chosen.has(id) ? 1 : OUTLINE_OPACITY,
        }),
        'meshTile',
      )
    }

    for (const id of chosen) {
      const layout = tiles.get(id)
      if (!layout) continue
      add(
        new Polygon(layout.visible.map(toArtboard), {
          ...shared,
          fill: 'transparent',
          stroke: '#000000',
          strokeWidth: 3.5 / zoom,
          opacity: 0.35,
        }),
        'meshSelected',
      )
      add(
        new Polygon(layout.visible.map(toArtboard), {
          ...shared,
          fill: 'transparent',
          stroke: FOCUS_COLOR(),
          strokeWidth: 2 / zoom,
        }),
        'meshSelected',
      )
    }

    if (focus) {
      const layout = tiles.get(focus)
      if (layout) {
        add(
          new Polygon(layout.visible.map(toArtboard), {
            ...shared,
            fill: 'transparent',
            stroke: FOCUS_COLOR(),
            strokeWidth: 2 / zoom,
          }),
          'meshFocus',
        )

        // The caret: a line down the letter box, inset a little — at the left
        // of an empty cell, and after the word in one that holds something,
        // since that is where the next letter goes.
        const box = polygonBounds(layout.glyph)
        const inset = Math.min(box.width, box.height) * 0.12
        const held = Boolean(activeMeshState(object, shown)?.chars[focus])
        const x = held ? box.x + box.width - inset : box.x + inset
        const a = toArtboard({ x, y: box.y + inset })
        const b = toArtboard({ x, y: box.y + box.height - inset })
        const caret = new Line([a.x, a.y, b.x, b.y], {
          ...shared,
          stroke: FOCUS_COLOR(),
          strokeWidth: 2 / zoom,
        })
        add(caret, 'meshCaret')

        let lit = true
        blinkRef.current = setInterval(() => {
          lit = !lit
          caret.set({ visible: lit })
          canvas.requestRenderAll()
        }, CARET_BLINK_MS)
      }
    }

    /*
     * The handles, only while inside: a press on a merely selected mesh is
     * Fabric's, and moves the object.
     *
     * An edge under the pointer lights the whole run it would move — the
     * mosaic's reach wash, on a line — and turns to the limit colour when the
     * drag has nowhere further to go. Nodes are dots; a picked node is filled.
     */
    if (inside) {
      const reaching = active ?? hovered
      if (reaching && reaching.kind === 'edge') {
        const run = collinearChain(object.tiles, positions, [reaching.a, reaching.b])
        for (const [p, q] of run) {
          const a = positions[p]
          const b = positions[q]
          if (!a || !b) continue
          const a0 = toArtboard(a)
          const b0 = toArtboard(b)
          const own = (p === reaching.a && q === reaching.b) || (p === reaching.b && q === reaching.a)
          add(
            new Line([a0.x, a0.y, b0.x, b0.y], {
              ...shared,
              stroke: active && limited ? LIMIT_COLOR : FOCUS_COLOR(),
              strokeWidth: (own ? 4 : 2.5) / zoom,
              opacity: own ? 1 : 0.6,
            }),
            'meshHandle',
          )
        }
      }

      const pickedSet = new Set(picked)
      const activeNode = active?.kind === 'node' ? active.id : null
      const hoveredNode = hovered?.kind === 'node' ? hovered.id : null
      const moving = new Set(
        active ? nodesMovedBy(object.tiles, positions, active, { picked }) : [],
      )
      for (const id of nodesOf(object.tiles)) {
        const p = positions[id]
        if (!p) continue
        const at = toArtboard(p)
        const strong = id === activeNode || id === hoveredNode || moving.has(id)
        const filled = pickedSet.has(id) || strong
        const bend = isBendPoint(object.tiles, id)
        add(
          new Circle({
            ...shared,
            left: at.x,
            top: at.y,
            originX: 'center',
            originY: 'center',
            // A bend point is smaller than a corner: it is a detail on a side, not a crossing.
            radius: ((strong ? NODE_RADIUS + 1.5 : NODE_RADIUS) * (bend ? 0.8 : 1)) / zoom,
            fill: filled ? (active && limited && moving.has(id) ? LIMIT_COLOR : FOCUS_COLOR()) : '#ffffff',
            stroke: active && limited && moving.has(id) ? LIMIT_COLOR : FOCUS_COLOR(),
            strokeWidth: 1.5 / zoom,
          }),
          'meshNode',
        )
      }
    }

    canvas.requestRenderAll()
    return clear
  }, [
    canvas,
    object,
    tiles,
    selection,
    focus,
    inside,
    previewing,
    dragging,
    spread,
    shown,
    hovered,
    active,
    limited,
    picked,
  ])

  /* Presses while INSIDE the mesh: handles, the marquee, the topology gestures, and which tile. */
  useEffect(() => {
    if (!canvas) return

    const live = (): MeshObject | null => {
      const id = useUiStore.getState().typing?.object
      if (!id) return null
      const found = useDocumentStore.getState().doc.objects[id]
      return found && found.kind === 'mesh' ? found : null
    }

    /** Pointer in the mesh's own space, with the hover reach in those units — per axis, through the live transform. */
    const at = (e: Event, target: MeshObject) => {
      const scene = canvas.getScenePoint(e as MouseEvent)
      const zoom = canvas.getZoom() || 1
      const host = shownTransform(canvas, target)
      const ex = vectorObjectToArtboard(host, { x: 1, y: 0 })
      const ey = vectorObjectToArtboard(host, { x: 0, y: 1 })
      const perX = Math.hypot(ex.x, ex.y) * zoom
      const perY = Math.hypot(ey.x, ey.y) * zoom
      return {
        point: pointArtboardToObject(host, scene),
        tolerance: {
          x: perX > 0 ? HOVER_PIXELS / perX : HOVER_PIXELS,
          y: perY > 0 ? HOVER_PIXELS / perY : HOVER_PIXELS,
        },
      }
    }

    const slopped = (from: Vec2, to: Vec2, tolerance: Tolerance): boolean =>
      Math.abs(to.x - from.x) >= (tolerance.x * DRAG_SLOP_PIXELS) / HOVER_PIXELS ||
      Math.abs(to.y - from.y) >= (tolerance.y * DRAG_SLOP_PIXELS) / HOVER_PIXELS

    const overlay = { selectable: false, evented: false, excludeFromExport: true, objectCaching: false } as const

    /** The cursor for a handle, measured on screen. */
    const cursorFor = (handle: MeshHandle, target: MeshObject): string => {
      if (handle.kind === 'node') return 'move'
      const positions = positionsOf(target)
      const a = positions[handle.a]
      const b = positions[handle.b]
      if (!a || !b) return 'default'
      // An edge is dragged ACROSS itself: the axis is its perpendicular.
      const along = vectorObjectToArtboard(shownTransform(canvas, target), {
        x: b.x - a.x,
        y: b.y - a.y,
      })
      return resizeCursorFor({ x: -along.y, y: along.x })
    }

    /** A rim edge, in the walk of the one tile it belongs to — or null for an interior edge. */
    const rimEdge = (target: MeshObject, handle: MeshHandle): [string, string] | null => {
      if (handle.kind !== 'edge') return null
      const found = edgesOf(target.tiles).get(edgeKey(handle.a, handle.b))
      if (!found || found.tiles.length !== 1) return null
      const owner = target.tiles.find((tile) => tile.id === found.tiles[0])
      if (!owner) return null
      const n = owner.ring.length
      for (let i = 0; i < n; i++) {
        const p = owner.ring[i] as string
        const q = owner.ring[(i + 1) % n] as string
        if ((p === handle.a && q === handle.b) || (p === handle.b && q === handle.a)) return [p, q]
      }
      return null
    }

    /** Put the caret and the selection on the tile under a point. */
    const selectAt = (target: MeshObject, point: Vec2, shift: boolean): void => {
      const ui = useUiStore.getState()
      const leaf = meshTileAt(target, point, shownIndex(target))
      if (!leaf) return
      if (shift) {
        const adding = !ui.mosaicSelection.includes(leaf)
        ui.toggleMosaicSelection(leaf)
        if (adding) ui.setTyping({ object: target.id, leaf })
        return
      }
      ui.setMosaicSelection([leaf])
      ui.setTyping({ object: target.id, leaf })
    }

    const onDown = (opt: { e: Event }): void => {
      const target = live()
      if (!target) return
      const ui = useUiStore.getState()
      // A press on a mesh that is previewing LEAVES the preview; see `MosaicLayer`.
      if (ui.mosaicPlayback?.object === target.id || (ui.playing && meshMoves(target))) {
        ui.stopMosaicPlayback()
        if (ui.playing) ui.setPlaying(false)
        return
      }
      const e = opt.e as MouseEvent
      const command = e.metaKey || e.ctrlKey
      const { point, tolerance } = at(opt.e, target)

      // Handles answer first, and are HELD: move and it is a drag, let go and it was a click.
      const handle = handleAt(target.tiles, positionsOf(target), point, tolerance)
      if (handle) {
        // ⌘ on a rim edge grows a cell out of it.
        const rim = command ? rimEdge(target, handle) : null
        if (rim) {
          extrudeRef.current = { edge: rim, from: point, tolerance, ghost: null }
          setActive(handle)
          return
        }
        pendingRef.current = {
          handle,
          from: point,
          tolerance,
          shift: e.shiftKey,
          segmentOnly: e.shiftKey,
        }
        setActive(handle)
        return
      }

      const tile = meshTileAt(target, point, shownIndex(target))
      if (!tile && !e.altKey) {
        // Outside every tile: leave text entry, as a press on the artboard does.
        ui.setTyping(null)
        if (!e.shiftKey) ui.setMosaicSelection([])
        return
      }

      // ⌘ inside a tile draws a cut across it.
      if (command && tile) {
        cutRef.current = { tile, from: point, tolerance, line: null }
        return
      }

      // Inside, and not on a handle. Held: move and it is a marquee, let go and
      // it was a click on the tile under it. Alt sweeps nodes instead of tiles.
      marqueeRef.current = { from: point, add: e.shiftKey, nodes: e.altKey, band: null }
    }

    /** Every tile whose polygon's box meets a box, in object space — touching counts. */
    const tilesWithin = (target: MeshObject, a: Vec2, b: Vec2): string[] => {
      const left = Math.min(a.x, b.x)
      const right = Math.max(a.x, b.x)
      const top = Math.min(a.y, b.y)
      const bottom = Math.max(a.y, b.y)
      const out: string[] = []
      for (const [id, tile] of meshTiles(target, shownIndex(target))) {
        const r = tile.bounds
        if (r.x < right && r.x + r.width > left && r.y < bottom && r.y + r.height > top) out.push(id)
      }
      return out
    }

    const nodesWithin = (target: MeshObject, a: Vec2, b: Vec2): string[] => {
      const left = Math.min(a.x, b.x)
      const right = Math.max(a.x, b.x)
      const top = Math.min(a.y, b.y)
      const bottom = Math.max(a.y, b.y)
      const positions = positionsOf(target)
      return nodesOf(target.tiles).filter((id) => {
        const p = positions[id]
        return Boolean(p && p.x >= left && p.x <= right && p.y >= top && p.y <= bottom)
      })
    }

    /** Turn a held handle into a drag: decide what moves, and record where it started. */
    const begin = (pending: Pending): boolean => {
      const target = live()
      if (!target) return false
      const positions = positionsOf(target)
      const moved = nodesMovedBy(target.tiles, positions, pending.handle, {
        picked: pickedRef.current,
        segmentOnly: pending.segmentOnly,
      })
      const before: Record<string, Vec2> = {}
      for (const id of moved) {
        const p = positions[id]
        if (p) before[id] = { ...p }
      }
      const primary = pending.handle.kind === 'node' ? pending.handle.id : pending.handle.a
      if (!before[primary]) return false
      gestureRef.current = { handle: pending.handle, moved, primary, from: pending.from, before, changed: false }
      setActive(pending.handle)
      return true
    }

    /** The quad an extrusion would add, in the mesh's own space, for the pointer's offset. */
    const ghostQuad = (target: MeshObject, extrude: Extrude, point: Vec2): Vec2[] | null => {
      const positions = positionsOf(target)
      const p = positions[extrude.edge[0]]
      const q = positions[extrude.edge[1]]
      if (!p || !q) return null
      const delta = { x: point.x - extrude.from.x, y: point.y - extrude.from.y }
      const reach = extrusionReach(p, q, delta, thicknessFloor(meshSpacing(target, shownIndex(target))))
      const offset = extrusionOffset(p, q, reach)
      return [q, p, { x: p.x + offset.x, y: p.y + offset.y }, { x: q.x + offset.x, y: q.y + offset.y }]
    }

    const onMove = (opt: { e: Event }): void => {
      const target = live()
      if (!target) return
      const e = opt.e as MouseEvent
      const { point, tolerance } = at(opt.e, target)
      const host = shownTransform(canvas, target)
      const toArtboard = (p: Vec2): Vec2 => pointObjectToArtboard(host, p)
      const zoom = canvas.getZoom() || 1

      const extrude = extrudeRef.current
      if (extrude) {
        if (!extrude.ghost && !slopped(extrude.from, point, extrude.tolerance)) return
        const quad = ghostQuad(target, extrude, point)
        if (!quad) return
        // Built afresh each frame: a polygon given new points keeps the
        // position its first points gave it, and only its size follows.
        if (extrude.ghost) canvas.remove(extrude.ghost)
        const ghost = new Polygon(quad.map(toArtboard), {
          ...overlay,
          fill: FOCUS_COLOR(),
          opacity: 0.18,
          stroke: FOCUS_COLOR(),
          strokeWidth: 1.5 / zoom,
          strokeUniform: true,
        })
        ghost.set('gridRole', 'meshGhost')
        canvas.add(ghost)
        extrude.ghost = ghost
        canvas.requestRenderAll()
        return
      }

      const cut = cutRef.current
      if (cut) {
        if (!cut.line && !slopped(cut.from, point, cut.tolerance)) return
        const tile = target.tiles.find((each) => each.id === cut.tile)
        const chord = tile ? chordAcross(tile.ring, positionsOf(target), cut.from, point) : null
        const [a, b] = chord ? [toArtboard(chord.a), toArtboard(chord.b)] : [toArtboard(cut.from), toArtboard(point)]
        if (cut.line) canvas.remove(cut.line)
        const line = new Line([a.x, a.y, b.x, b.y], {
          ...overlay,
          stroke: FOCUS_COLOR(),
          strokeWidth: 2 / zoom,
          strokeDashArray: chord ? undefined : [4 / zoom, 3 / zoom],
          strokeUniform: true,
        })
        line.set('gridRole', 'meshCut')
        canvas.add(line)
        cut.line = line
        canvas.requestRenderAll()
        return
      }

      const marquee = marqueeRef.current
      if (marquee) {
        if (marquee.band === null && !slopped(marquee.from, point, tolerance)) return
        const a = toArtboard(marquee.from)
        const b = toArtboard(point)
        if (!marquee.band) {
          const band = new Rect({
            ...overlay,
            originX: 'center',
            originY: 'center',
            fill: FOCUS_COLOR(),
            opacity: 0.14,
            stroke: FOCUS_COLOR(),
            strokeWidth: 1 / zoom,
            strokeDashArray: marquee.nodes ? [4, 3] : undefined,
          })
          band.set('gridRole', 'meshMarquee')
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
        if (!slopped(pending.from, point, pending.tolerance)) return
        pendingRef.current = null
        if (!begin(pending)) {
          setActive(null)
          return
        }
      }

      const gesture = gestureRef.current
      if (gesture) {
        const shownAt = shownIndex(target)
        const result = dragNodes(
          target.tiles,
          { ...positionsOf(target), ...gesture.before },
          gesture.moved,
          gesture.primary,
          { x: point.x - gesture.from.x, y: point.y - gesture.from.y },
          {
            // Alt drags free of the grid, read every frame.
            snapStep: e.altKey ? 0 : target.snapStep,
            spacing: meshSpacing(target, shownAt),
          },
        )
        setLimited(result.clamped)
        if (result.moved) gestureRef.current = { ...gesture, changed: true }
        useDocumentStore.getState().setMeshNodes(target.id, shownAt, result.updates)
        return
      }

      const found = handleAt(target.tiles, positionsOf(target), point, tolerance)
      setHovered((was) => (sameHandle(was, found) ? was : found))
      canvas.defaultCursor = found ? cursorFor(found, target) : 'default'
    }

    /** End the gesture: keep what it did, or put it back. */
    const finish = (cancel: boolean): void => {
      const to = lastPointRef.current
      const box = releaseToleranceRef.current ?? { x: HOVER_PIXELS, y: HOVER_PIXELS }

      const extrude = extrudeRef.current
      if (extrude) {
        extrudeRef.current = null
        setActive(null)
        if (extrude.ghost) canvas.remove(extrude.ghost)
        const target = live()
        if (target && !cancel && to && slopped(extrude.from, to, box)) {
          const store = useDocumentStore.getState()
          const shownAt = shownIndex(target)
          const made = store.extrudeMeshEdge(
            target.id,
            extrude.edge,
            { x: to.x - extrude.from.x, y: to.y - extrude.from.y },
            shownAt,
          )
          if (made) {
            store.commit('Extrude edge')
            const ui = useUiStore.getState()
            ui.setMosaicSelection([made])
            ui.setTyping({ object: target.id, leaf: made })
          }
        }
        canvas.requestRenderAll()
        return
      }

      const cut = cutRef.current
      if (cut) {
        cutRef.current = null
        if (cut.line) canvas.remove(cut.line)
        const target = live()
        if (target && !cancel && to) {
          if (slopped(cut.from, to, box)) {
            const tile = target.tiles.find((each) => each.id === cut.tile)
            const chord = tile ? chordAcross(tile.ring, positionsOf(target), cut.from, to) : null
            if (chord) {
              const store = useDocumentStore.getState()
              const made = store.cutMeshTile(target.id, cut.tile, chord.entry, chord.exit)
              if (made) {
                store.commit('Cut tile')
                const ui = useUiStore.getState()
                ui.setMosaicSelection([made])
                ui.setTyping({ object: target.id, leaf: made })
              }
            }
          } else {
            selectAt(target, cut.from, false)
          }
        }
        canvas.requestRenderAll()
        return
      }

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
        const end = to ?? marquee.from
        if (slopped(marquee.from, end, box)) {
          if (marquee.nodes) {
            const hit = nodesWithin(target, marquee.from, end)
            setPicked(marquee.add ? [...new Set([...pickedRef.current, ...hit])] : hit)
          } else {
            const hit = tilesWithin(target, marquee.from, end)
            const next = marquee.add ? [...new Set([...ui.mosaicSelection, ...hit])] : hit
            ui.setMosaicSelection(next)
            const last = next[next.length - 1]
            if (last) ui.setTyping({ object: target.id, leaf: last })
          }
        } else if (marquee.nodes) {
          if (!marquee.add) setPicked([])
        } else {
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
        if (!target || cancel) return
        if (pending.handle.kind === 'node') {
          // A click on a node picks it; shift adds it to, or takes it from, the picked.
          const id = pending.handle.id
          setPicked((was) =>
            pending.shift ? (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]) : [id],
          )
        } else {
          selectAt(target, pending.from, pending.shift)
        }
        return
      }

      const gesture = gestureRef.current
      if (!gesture) return
      gestureRef.current = null
      setActive(null)
      setLimited(false)
      const target = live()
      if (!target) return

      const store = useDocumentStore.getState()
      if (cancel) {
        store.setMeshNodes(
          target.id,
          shownIndex(target),
          Object.entries(gesture.before).map(([id, p]) => ({ id, at: p })),
        )
        return
      }
      if (!gesture.changed) return
      store.commit('Move points')
    }

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
    // `pointerup` precedes Fabric's `mouse:up` and carries its own position; see `MosaicLayer`.
    const onWindowUp = (e: Event): void => release(e)
    const onBlur = (): void => finish(false)

    /** Double-click an edge: a point on it, where the pointer is, picked and ready to drag. */
    const onDoubleClick = (opt: { e: Event }): void => {
      const target = live()
      if (!target) return
      const { point, tolerance } = at(opt.e, target)
      const handle = handleAt(target.tiles, positionsOf(target), point, tolerance)
      if (!handle || handle.kind !== 'edge') return
      const positions = positionsOf(target)
      const a = positions[handle.a]
      const b = positions[handle.b]
      if (!a || !b) return
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = dx * dx + dy * dy
      const t = length > 0 ? Math.min(0.95, Math.max(0.05, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0.5
      const store = useDocumentStore.getState()
      const made = store.addMeshPoint(target.id, [handle.a, handle.b], t)
      if (!made) return
      store.commit('Add point')
      setPicked([made])
    }

    /**
     * Backspace on picked bend points takes them out; ⌘-Backspace on the
     * selected tiles takes THEM out. On the capture phase and stopped, so the
     * caret's own Backspace — which clears a letter — does not also run.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      if (isFormField(e.target)) return
      const target = live()
      if (!target) return
      const store = useDocumentStore.getState()
      const ui = useUiStore.getState()
      if (e.metaKey || e.ctrlKey) {
        const chosen = ui.mosaicSelection.filter((id) => target.tiles.some((tile) => tile.id === id))
        if (chosen.length === 0) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!store.removeMeshTiles(target.id, chosen)) return
        store.commit(chosen.length === 1 ? 'Remove tile' : 'Remove tiles')
        const after = useDocumentStore.getState().doc.objects[target.id]
        const leaf = after && after.kind === 'mesh' ? firstMeshTile(after, shownIndex(after)) : null
        ui.setMosaicSelection([])
        if (leaf) ui.setTyping({ object: target.id, leaf })
        return
      }
      const bends = pickedRef.current.filter((id) => isBendPoint(target.tiles, id))
      if (bends.length === 0) return
      e.preventDefault()
      e.stopImmediatePropagation()
      let removed = 0
      for (const id of bends) if (store.removeMeshPoint(target.id, id)) removed++
      if (removed > 0) store.commit(removed === 1 ? 'Remove point' : 'Remove points')
      setPicked([])
    }

    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)
    canvas.on('mouse:dblclick', onDoubleClick)
    window.addEventListener('pointerup', onWindowUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      canvas.off('mouse:down', onDown)
      canvas.off('mouse:move', onMove)
      canvas.off('mouse:up', onUp)
      canvas.off('mouse:dblclick', onDoubleClick)
      window.removeEventListener('pointerup', onWindowUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, { capture: true })
      canvas.defaultCursor = 'default'
    }
  }, [canvas])

  /* A gesture, and the picked nodes, must not outlive the mesh they belong to. */
  useEffect(() => {
    if (!object || !inside) {
      gestureRef.current = null
      pendingRef.current = null
      marqueeRef.current = null
      extrudeRef.current = null
      cutRef.current = null
      setActive(null)
      setHovered(null)
      setLimited(false)
      setPicked([])
    }
  }, [object, inside])

  /* The keyboard, shared with the mosaic. */
  const liveTarget = useCallback((): TypingTarget | null => {
    const ui = useUiStore.getState()
    const typingNow = ui.typing
    if (!typingNow) return null
    const found = useDocumentStore.getState().doc.objects[typingNow.object]
    if (!found || found.kind !== 'mesh') return null
    const at = Math.min(ui.mosaicStates[found.id] ?? 0, found.states.length - 1)
    return { object: found, leaf: typingNow.leaf, layout: meshTiles(found, at), at, holds: 'word' }
  }, [])
  /** Escape during a gesture cancels the GESTURE, not the mode. */
  const onEscape = useCallback((): boolean => {
    const gesture = gestureRef.current
    const pending = pendingRef.current
    const extrude = extrudeRef.current
    const cut = cutRef.current
    if (!gesture && !pending && !extrude && !cut) return false
    gestureRef.current = null
    pendingRef.current = null
    extrudeRef.current = null
    cutRef.current = null
    if (extrude?.ghost) canvas?.remove(extrude.ghost)
    if (cut?.line) canvas?.remove(cut.line)
    canvas?.requestRenderAll()
    setActive(null)
    setLimited(false)
    const ui = useUiStore.getState()
    const id = ui.typing?.object
    const found = id ? useDocumentStore.getState().doc.objects[id] : undefined
    if (gesture && found && found.kind === 'mesh') {
      useDocumentStore
        .getState()
        .setMeshNodes(
          found.id,
          shownIndex(found),
          Object.entries(gesture.before).map(([node, p]) => ({ id: node, at: p })),
        )
    }
    return true
  }, [canvas])
  useTileTyping({ live: liveTarget, onEscape })

  return null
}
