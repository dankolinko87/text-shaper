import { beforeEach, describe, expect, it } from 'vitest'

import { cropBoxFor, cropPaintFor } from '../../src/state/cropModel'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import { mosaicTiles } from '../../src/mosaic/tiles'
import type { LetterMosaicObject } from '../../src/types/document'
import type { ImagePaint } from '../../src/types/paint'

/**
 * Cropping a picture where it is painted: which box, which paint, and where
 * a changed crop lands.
 */

const store = () => useDocumentStore.getState()
const picture = (crop = { scale: 1, x: 0, y: 0 }): ImagePaint => ({ kind: 'image', asset: 'img_a', crop })
const mosaic = (id: string) => store().doc.objects[id] as LetterMosaicObject

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ croppingPaint: null, tool: 'select', editingPoints: null })
})

describe('the box and the paint a target names', () => {
  it('is the tile, the letter box or the whole object for a mosaic', () => {
    const id = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'AB' })
    const tile = mosaic(id).tiles[1]!.id
    store().setMosaicTileColour(id, 0, [tile], picture())
    store().setMosaicGlyphColour(id, 0, [tile], picture({ scale: 2, x: 0, y: 0 }))
    store().setMosaicBackground(id, 0, picture())
    const layout = mosaicTiles(mosaic(id), 0).get(tile)!
    expect(cropBoxFor(store().doc, { objectId: id, surface: 'tile', stateIndex: 0, leafIds: [tile] }, {})).toEqual(layout.visible)
    expect(cropBoxFor(store().doc, { objectId: id, surface: 'glyph', stateIndex: 0, leafIds: [tile] }, {})).toEqual(layout.glyph)
    expect(cropBoxFor(store().doc, { objectId: id, surface: 'background', stateIndex: 0 }, {})).toEqual(mosaic(id).localBounds)
    expect(cropPaintFor(store().doc, { objectId: id, surface: 'glyph', stateIndex: 0, leafIds: [tile] })?.crop.scale).toBe(2)
    expect(cropPaintFor(store().doc, { objectId: id, surface: 'tile', stateIndex: 0, leafIds: ['nope'] })).toBeNull()
    // A tile painted with a colour has no picture to crop.
    const other = mosaic(id).tiles[0]!.id
    expect(cropPaintFor(store().doc, { objectId: id, surface: 'tile', stateIndex: 0, leafIds: [other] })).toBeNull()
  })

  it('is the shape’s outline, or the paths the type and the banner drew', () => {
    const id = store().createObjectFromGeometry({
      open: false,
      pathData: 'M 0 0 L 100 0 L 100 50 L 0 50 Z',
      localBounds: { x: 0, y: 0, width: 100, height: 50 },
      artboardCenter: { x: 0, y: 0 },
      name: 'S',
    })
    const shape = store().doc.objects[id]!
    if (shape.kind !== 'typography') throw new Error('expected type')
    store().updateObject(id, { appearance: { ...shape.appearance, containerFill: picture(), textFill: picture() } })
    const box = cropBoxFor(store().doc, { objectId: id, surface: 'shape', stateIndex: 0 }, {})
    expect(box?.width).toBeCloseTo(100, 6)
    expect(box?.height).toBeCloseTo(50, 6)
    expect(cropBoxFor(store().doc, { objectId: id, surface: 'text', stateIndex: 0 }, {}), 'no type drawn yet').toBeNull()
    expect(cropBoxFor(store().doc, { objectId: id, surface: 'text', stateIndex: 0 }, { textPath: 'M 10 10 L 30 10 L 30 20 Z' })).toEqual({ x: 10, y: 10, width: 20, height: 10 })
    expect(cropPaintFor(store().doc, { objectId: id, surface: 'shape', stateIndex: 0 })).toEqual(picture())
    expect(cropPaintFor(store().doc, { objectId: id, surface: 'banner', stateIndex: 0 })).toBeNull()
  })
})

describe('changing a crop', () => {
  it('moves every picked tile’s picture by the same change, and nothing else', () => {
    const id = store().createMosaic({ columns: 3, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'ABC' })
    const [a, b, c] = mosaic(id).tiles.map((t) => t.id) as [string, string, string]
    store().setMosaicTileColour(id, 0, [a], picture({ scale: 1, x: 0, y: 0 }))
    store().setMosaicTileColour(id, 0, [b], picture({ scale: 2, x: 0.1, y: 0 }))
    store().setMosaicTileColour(id, 0, [c], '#ff0000')
    store().commit('Setup')
    const past = store().past.length
    store().editPaintCrop({ objectId: id, surface: 'tile', stateIndex: 0, leafIds: [a, b, c] }, (crop) => ({ ...crop, x: crop.x + 0.2 }))
    const state = mosaic(id).states[0]!
    expect((state.tileColour[a] as ImagePaint).crop.x).toBeCloseTo(0.2, 9)
    expect((state.tileColour[b] as ImagePaint).crop.x).toBeCloseTo(0.3, 9)
    expect(state.tileColour[c], 'a colour is left alone').toBe('#ff0000')
    expect(store().past.length, 'no entry until the layer commits').toBe(past)
    // Carried forward to the states that were still copies, like any tile edit.
    expect((mosaic(id).states[1]!.tileColour[a] as ImagePaint).crop.x).toBeCloseTo(0.2, 9)
  })

  it('reaches a background, a frame’s background, and a shape’s fill', () => {
    const id = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    store().setMosaicBackground(id, 1, picture())
    store().editPaintCrop({ objectId: id, surface: 'background', stateIndex: 1 }, (crop) => ({ ...crop, scale: 3 }))
    expect((mosaic(id).states[1]!.background as ImagePaint).crop.scale).toBe(3)
    expect(mosaic(id).states[0]!.background, 'the other state untouched').toBeNull()

    const frame = store().createFrame({ box: { x: 0, y: 0, width: 200, height: 100 }, artboardCenter: { x: 0, y: 0 } })
    store().setFrameStateBackground(frame, 0, picture())
    store().editPaintCrop({ objectId: frame, surface: 'background', stateIndex: 0 }, (crop) => ({ ...crop, y: -0.3 }))
    const held = store().doc.objects[frame]
    expect(held?.kind === 'frame' && (held.states[0]!.background as ImagePaint).crop.y).toBeCloseTo(-0.3, 9)

    const shape = store().createObjectFromGeometry({
      open: false,
      pathData: 'M 0 0 L 100 0 L 100 50 L 0 50 Z',
      localBounds: { x: 0, y: 0, width: 100, height: 50 },
      artboardCenter: { x: 0, y: 0 },
      name: 'S',
    })
    const own = store().doc.objects[shape]!
    if (own.kind !== 'typography') throw new Error('expected type')
    store().updateObject(shape, { appearance: { ...own.appearance, textFill: picture() } })
    store().editPaintCrop({ objectId: shape, surface: 'text', stateIndex: 0 }, (crop) => ({ ...crop, x: 0.5 }))
    const after = store().doc.objects[shape]!
    expect(after.kind === 'typography' && (after.appearance.textFill as ImagePaint).crop.x).toBe(0.5)
    // A fill that is not a picture is not changed.
    store().editPaintCrop({ objectId: shape, surface: 'shape', stateIndex: 0 }, (crop) => ({ ...crop, x: 0.5 }))
    const still = store().doc.objects[shape]!
    expect(still.kind === 'typography' && still.appearance.containerFill).toBe(own.appearance.containerFill)
  })

  it('lands on a member’s patch inside a frame, for the frame’s state it was made in', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 400, height: 300 }, artboardCenter: { x: 0, y: 0 } })
    const shape = store().createObjectFromGeometry({
      open: false,
      pathData: 'M -50 -25 L 50 -25 L 50 25 L -50 25 Z',
      localBounds: { x: -50, y: -25, width: 100, height: 50 },
      artboardCenter: { x: 0, y: 0 },
      name: 'In',
    })
    store().addToFrame(frame, [shape])
    const held = store().doc.objects[frame]
    if (held?.kind !== 'frame') throw new Error('expected a frame')
    const member = held.members[0]!
    store().setMemberValues(frame, 1, member.id, { appearance: { containerFill: picture() } })
    const target = { objectId: member.object.id, surface: 'shape' as const, stateIndex: 1, member: { frameId: frame, memberId: member.id } }
    expect(cropPaintFor(store().doc, target)).toEqual(picture())
    store().editPaintCrop(target, (crop) => ({ ...crop, scale: 2 }))
    const after = store().doc.objects[frame]
    if (after?.kind !== 'frame') throw new Error('expected a frame')
    expect((after.states[1]!.values[member.id]!.appearance!.containerFill as ImagePaint).crop.scale).toBe(2)
    expect(after.states[0]!.values[member.id], 'the other state untouched').toBeUndefined()
  })
})

describe('the crop mode', () => {
  it('is left when a tool is picked, like point editing', () => {
    const ui = useUiStore.getState()
    ui.setCroppingPaint({ objectId: 'x', surface: 'background', stateIndex: 0 })
    ui.setTool('pen')
    expect(useUiStore.getState().croppingPaint).toBeNull()
    ui.setCroppingPaint({ objectId: 'x', surface: 'background', stateIndex: 0 })
    ui.setTool('select')
    expect(useUiStore.getState().croppingPaint, 'Select is the tool the mode belongs to').not.toBeNull()
  })
})
