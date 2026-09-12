import { Canvas } from 'fabric/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { emptyGround, groundFor, groundRadius, invitationFor } from '../../src/editor/invitations'
import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { useDocumentStore } from '../../src/state/documentStore'
import type { Stated } from '../../src/types/document'

/**
 * An object with states that holds nothing yet invites something in; one
 * that holds anything does not.
 */

const store = () => useDocumentStore.getState()
const stated = (id: string): Stated => store().doc.objects[id] as Stated

beforeEach(() => {
  store().resetDocument()
})

describe('the invitation', () => {
  it('is on an empty frame, and gone once a member lands in it', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 300, height: 200 }, artboardCenter: { x: 0, y: 0 } })
    expect(invitationFor(stated(frame))?.icon).toBe('frame')
    const mosaic = store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
    store().addToFrame(frame, [mosaic])
    expect(invitationFor(stated(frame))).toBeNull()
  })

  it('is on a mosaic or a mesh with no letters in any state, and gone once one is typed', () => {
    const mosaic = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 } })
    expect(invitationFor(stated(mosaic))?.icon).toBe('mosaic')
    const tile = (stated(mosaic) as { tiles: { id: string }[] }).tiles[0]!.id
    store().setMosaicChars(mosaic, 2, { [tile]: 'Z' })
    expect(invitationFor(stated(mosaic)), 'a letter in the last state alone counts').toBeNull()

    const mesh = store().createMesh({ columns: 2, rows: 1, artboardCenter: { x: 0, y: 0 } })
    expect(invitationFor(stated(mesh))?.icon).toBe('mesh')
    const cell = (stated(mesh) as { tiles: { id: string }[] }).tiles[0]!.id
    store().setMosaicChars(mesh, 0, { [cell]: 'Q' })
    expect(invitationFor(stated(mesh))).toBeNull()
  })
})

/**
 * The ground an empty object stands on: light green and rounded when nothing
 * holds it; left out — the plate is that ground, and square — while held.
 */
describe('the ground under an empty object', () => {
  let canvas: Canvas
  let rendered: Map<string, RenderedObject>
  beforeEach(() => {
    canvas = new Canvas(undefined, { width: 800, height: 600 })
    rendered = new Map()
  })
  afterEach(() => {
    void canvas.dispose()
  })
  const draw = (held: string | null): void => {
    rendered = syncCanvas({ canvas, doc: store().doc, textPaths: {}, bandPaths: {}, ribbons: {}, rendered, held })
  }
  const part = (id: string, role: string) =>
    rendered.get(id)!.group.getObjects().find((o) => o.get('role') === role)!

  it('is rounded by a share of the shorter side', () => {
    expect(groundRadius(300, 200)).toBeCloseTo(12)
    expect(groundRadius(50, 400)).toBeCloseTo(3)
    expect(groundRadius(0, 400)).toBe(0)
  })

  it('is left out while the plate stands under the object', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 300, height: 200 }, artboardCenter: { x: 0, y: 0 } })
    expect(groundFor(stated(frame), null)).toBe(emptyGround(stated(frame)))
    expect(groundFor(stated(frame), 'other')).toBe(emptyGround(stated(frame)))
    expect(groundFor(stated(frame), frame)).toBeNull()
  })

  it('is drawn rounded when nothing holds the object, and square and clear when held', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 300, height: 200 }, artboardCenter: { x: 0, y: 0 } })
    const mosaic = store().createMosaic({ columns: 2, rows: 1, artboardCenter: { x: 400, y: 0 } })
    draw(null)
    const plate = part(frame, 'plate')
    expect(plate.fill).toBe(emptyGround(stated(frame)))
    expect(plate.get('rx')).toBeCloseTo(groundRadius(300, 200))
    const extent = part(mosaic, 'extent')
    expect(extent.fill).toBe(emptyGround(stated(mosaic)))
    expect(extent.get('rx')).toBeGreaterThan(0)

    draw(frame)
    const heldPlate = part(frame, 'plate')
    expect(heldPlate, 'rebuilt for the plate').not.toBe(plate)
    expect(heldPlate.fill).toBe('transparent')
    expect(heldPlate.get('rx')).toBe(0)
    expect(part(mosaic, 'extent'), 'the other object untouched').toBe(extent)

    draw(null)
    expect(part(frame, 'plate').fill, 'back once let go').toBe(emptyGround(stated(frame)))
  })
})
