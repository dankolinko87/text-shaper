import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createCanvas } from 'canvas'
import { Canvas } from 'fabric/node'
import opentype from 'opentype.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { newPaintCache, paintMeshFrame } from '../../src/editor/meshPlayback'
import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { meshTiles } from '../../src/mesh/layout'
import { polygonBounds } from '../../src/mesh/mesh'
import { evaluateMeshAtTime, restingMeshFrame } from '../../src/mesh/timeline'
import { useDocumentStore } from '../../src/state/documentStore'
import { registerFont } from '../../src/typography/fontRegistry'
import type { Vec2 } from '../../src/types/document'
import { meshIn } from '../fixtures/objects'
import { forgetImages, primeImage } from '../../src/editor/imageCache'
import type { WarpedPath } from '../../src/editor/warpedPath'

/**
 * A mesh on the canvas: where it lands, where its letters go, and that a
 * frame painted mid-transition moves the letters without moving the object.
 */

const FONT_ID = 'anton'

beforeAll(() => {
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    FONT_ID,
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})

let canvas: Canvas
let rendered: Map<string, RenderedObject>

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
  canvas = new Canvas(undefined, { width: 1200, height: 900 })
  rendered = new Map()
})

afterEach(() => {
  void canvas.dispose()
})

const store = () => useDocumentStore.getState()

function mesh(at = { x: 400, y: 300 }): string {
  return store().createMesh({ columns: 2, rows: 2, artboardCenter: at, text: 'WWWW' })
}

const draw = (): void => {
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
  })
}

const nodeAt = (id: string, x: number, y: number): string => {
  const found = Object.entries(meshIn(store().doc, id).states[0]!.nodes).find(
    ([, p]) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
  )
  if (!found) throw new Error(`no node at ${x},${y}`)
  return found[0]
}

describe('where a mesh lands', () => {
  it('is a group of paths centred on its origin, the size of its box', () => {
    const id = mesh({ x: 400, y: 300 })
    draw()
    const group = rendered.get(id)?.group
    expect(group, 'the mesh was drawn').toBeTruthy()
    if (!group) return
    const roles = group.getObjects().map((child) => child.get('role') as string)
    expect(roles).toContain('extent')
    expect(roles).toContain('backdrop')
    expect(roles).toContain('outline')
    expect(roles).toContain('lines')
    expect(roles.filter((role) => role === 'tile')).toHaveLength(4)
    expect(roles.filter((role) => role === 'glyph')).toHaveLength(4)

    const object = meshIn(store().doc, id)
    const box = group.getBoundingRect()
    expect(box.width).toBeCloseTo(object.localBounds.width, 0)
    expect(box.height).toBeCloseTo(object.localBounds.height, 0)
    expect(box.left + box.width / 2).toBeCloseTo(400, 0)
    expect(box.top + box.height / 2).toBeCloseTo(300, 0)
  })

  it('pours every letter into its own glyph polygon', () => {
    const id = mesh({ x: 0, y: 0 })
    // Sheared, so the polygons are not rectangles and the warp is exercised.
    store().setMeshNodes(id, 0, [{ id: nodeAt(id, 0, 0), at: { x: 30, y: -20 } }])
    draw()
    const group = rendered.get(id)!.group
    const object = meshIn(store().doc, id)
    const centre = group.get('localCentre') as Vec2
    const layouts = meshTiles(object, 0)
    for (const child of group.getObjects()) {
      if (child.get('role') !== 'glyph') continue
      const leaf = child.get('leafId') as string
      const polygon = polygonBounds(layouts.get(leaf)!.glyph)
      // Child positions are centre-relative; the glyph's box must sit inside its polygon's.
      const left = child.left + centre.x - child.width / 2
      const top = child.top + centre.y - child.height / 2
      expect(left).toBeGreaterThanOrEqual(polygon.x - 0.5)
      expect(top).toBeGreaterThanOrEqual(polygon.y - 0.5)
      expect(left + child.width).toBeLessThanOrEqual(polygon.x + polygon.width + 0.5)
      expect(top + child.height).toBeLessThanOrEqual(polygon.y + polygon.height + 0.5)
    }
  })
})

describe('painting a frame', () => {
  it('moves the letters mid-transition and leaves the object where it was', () => {
    const id = mesh({ x: 200, y: 100 })
    const corner = nodeAt(id, -120, -120)
    store().setMeshNodes(id, 1, [{ id: corner, at: { x: -60, y: -60 } }])
    draw()
    const group = rendered.get(id)!.group
    const object = meshIn(store().doc, id)
    const centre = group.get('localCentre') as Vec2
    const cache = newPaintCache()
    const glyphOf = (): { left: number; top: number; path: unknown[] } => {
      const child = group.getObjects().find((each) => each.get('role') === 'glyph')!
      const path = (child as unknown as { path: unknown[] }).path
      return { left: child.left, top: child.top, path: JSON.parse(JSON.stringify(path)) }
    }
    const before = { left: group.left, top: group.top }

    paintMeshFrame(group as never, restingMeshFrame(object, 0), object.tiles, centre, cache)
    const resting = glyphOf()
    paintMeshFrame(
      group as never,
      evaluateMeshAtTime(object, object.states[0]!.holdMs + object.states[0]!.transitionMs / 2),
      object.tiles,
      centre,
      cache,
    )
    const midway = glyphOf()
    expect(midway.path).not.toEqual(resting.path)
    expect(group.left, 'the group did not move').toBeCloseTo(before.left, 6)
    expect(group.top).toBeCloseTo(before.top, 6)

    // Back at rest, the same numbers as before: painting is a pure function of the frame.
    paintMeshFrame(group as never, restingMeshFrame(object, 0), object.tiles, centre, cache)
    expect(glyphOf()).toEqual(resting)
  })

  it('is rebuilt with the same centre when the shown state is unchanged', () => {
    const id = mesh({ x: 200, y: 100 })
    draw()
    const first = rendered.get(id)!.group
    const centre = first.get('localCentre') as Vec2
    store().setMeshNodes(id, 2, [{ id: nodeAt(id, 0, 0), at: { x: 10, y: 10 } }])
    draw()
    const second = rendered.get(id)!.group
    expect(second.get('localCentre')).toEqual(centre)
    expect(second.left).toBeCloseTo(first.left, 6)
    expect(second.top).toBeCloseTo(first.top, 6)
  })
})

describe('the backdrop shape', () => {
  it('fills the whole box round the nodes, holes and all, or follows the rim', () => {
    const id = mesh({ x: 0, y: 0 })
    expect(meshIn(store().doc, id).backdrop, 'a new mesh fills its frame').toBe('box')
    store().setMosaicBackground(id, 0, '#ff8800ff')
    // A hole in the middle of a 3 × 3: the box covers it, the rim does not.
    store().resizeMeshGrid(id, 3, 3)
    const middle = meshIn(store().doc, id).tiles[4]!.id
    store().removeMeshTiles(id, [middle])
    draw()
    const boxed = rendered.get(id)!.group.getObjects().find((c) => c.get('role') === 'backdrop')!
    expect((boxed as unknown as { path: unknown[] }).path, 'one rounded rectangle').toHaveLength(9)
    expect(boxed.width).toBeCloseTo(360, 0)

    store().setMeshBackdrop(id, 'silhouette')
    draw()
    const rimmed = rendered.get(id)!.group.getObjects().find((c) => c.get('role') === 'backdrop')!
    expect((rimmed as unknown as { path: unknown[] }).path.length, 'two loops').toBeGreaterThan(9)
    expect(rimmed.width).toBeCloseTo(360, 0)
  })
})

describe('outer padding', () => {
  it('grows the backdrop, the silhouette and the box past the rim, and blends between states', () => {
    const id = mesh({ x: 0, y: 0 })
    store().setMosaicBackground(id, 0, '#ff8800ff')
    draw()
    const plain = rendered.get(id)!.group
    const plainBox = plain.getBoundingRect()
    const plainBackdrop = plain.getObjects().find((c) => c.get('role') === 'backdrop')!

    store().setMosaicSpacing(id, { outerPadding: 20 }, 0)
    draw()
    const padded = rendered.get(id)!.group
    const paddedBox = padded.getBoundingRect()
    const paddedBackdrop = padded.getObjects().find((c) => c.get('role') === 'backdrop')!
    expect(paddedBox.width).toBeCloseTo(plainBox.width + 40, 0)
    expect(paddedBox.height).toBeCloseTo(plainBox.height + 40, 0)
    expect(paddedBackdrop.width).toBeCloseTo(plainBackdrop.width + 40, 0)
    expect(paddedBackdrop.fill).toBe('#ff8800ff')
    expect(padded.left, 'the object did not move').toBeCloseTo(plain.left, 6)

    // Halfway to a state with no padding, the backdrop is half as wide again.
    const object = meshIn(store().doc, id)
    store().setMosaicSpacing(id, { outerPadding: 0 }, 2)
    const after = meshIn(store().doc, id)
    expect(after.states[2]!.outerPadding).toBe(0)
    const centre = padded.get('localCentre') as Vec2
    const cache = newPaintCache()
    paintMeshFrame(
      padded as never,
      evaluateMeshAtTime(after, after.states[0]!.holdMs + after.states[0]!.transitionMs + after.states[1]!.holdMs + after.states[1]!.transitionMs / 2),
      after.tiles,
      centre,
      cache,
    )
    const midway = padded.getObjects().find((c) => c.get('role') === 'backdrop')!
    expect(midway.width).toBeCloseTo(plainBackdrop.width + 20, 0)
    expect(object.states[1]!.outerPadding, 'state 2 followed state 1').toBe(20)
  })
})

/**
 * A picture in a mesh cell bends with the cell, as the letters do.
 */
describe('a picture in a cell', () => {
  /** Left half red, right half blue. */
  const source = () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 32, 64)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(32, 0, 32, 64)
    return c
  }
  const pixel = (x: number, y: number): number[] => {
    const ctx = (canvas.lowerCanvasEl as unknown as { getContext(kind: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } }).getContext('2d')
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
    return [d[0]!, d[1]!, d[2]!, d[3]!]
  }

  it('is warped through the cell, left to left and right to right', () => {
    forgetImages()
    primeImage('img_cell', source() as never)
    const id = mesh({ x: 400, y: 300 })
    const object = meshIn(store().doc, id)
    const tile = object.tiles[0]!
    // Shear the first tile's outer corner so its map is bilinear, not a rectangle.
    const corner = nodeAt(id, object.localBounds.x, object.localBounds.y)
    store().setMeshNodes(id, 0, [{ id: corner, at: { x: object.localBounds.x + 30, y: object.localBounds.y - 40 } }])
    store().setMosaicTileColour(id, 0, [tile.id], { kind: 'image', asset: 'img_cell', crop: { scale: 1, x: 0, y: 0 } })
    store().setMosaicChars(id, 0, { [tile.id]: '' })
    draw()

    const group = rendered.get(id)!.group
    const child = group.getObjects().find((o) => o.get('role') === 'tile' && o.get('leafId') === tile.id) as unknown as WarpedPath
    expect(child.picture).not.toBeNull()
    expect(child.picture!.n, 'a plain quad bends a little').toBe(8)
    const layout = meshTiles(meshIn(store().doc, id), 0).get(tile.id)!
    const [i0] = layout.cornerIndices
    const first = layout.visible[i0]!
    const at = child.picture!.map(0, 0)
    expect(at.x).toBeCloseTo(first.x, 6)
    expect(at.y).toBeCloseTo(first.y, 6)

    /*
     * Rendered with every clip taken off: a clipped child draws through a
     * cache canvas, which Fabric makes with `document`, and node has none.
     * The picture's own drawing has no clip but the tile's outline, which is
     * the thing being tested.
     */
    group.clipPath = undefined
    group.objectCaching = false
    for (const each of group.getObjects()) {
      each.clipPath = undefined
      each.objectCaching = false
    }
    for (const each of canvas.getObjects()) {
      if (each !== group) each.visible = false
    }
    canvas.renderAll()
    const t = meshIn(store().doc, id).transform
    const probe = (u: number, v: number) => {
      const p = child.picture!.map(u, v)
      return pixel(p.x + t.x, p.y + t.y)
    }
    const left = probe(0.25, 0.5)
    const right = probe(0.75, 0.5)
    expect(left[0], "red where the picture's left was").toBeGreaterThan(200)
    expect(left[2]).toBeLessThan(60)
    expect(right[2], "blue where the picture's right was").toBeGreaterThan(200)
    expect(right[0]).toBeLessThan(60)
  })
})
