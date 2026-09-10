import { ActiveSelection, Canvas } from 'fabric/node'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { collectTransforms } from '../../src/editor/transformSync'
import { useDocumentStore } from '../../src/state/documentStore'
import type { Vec2 } from '../../src/types/document'

/**
 * The canvas half of the editor, driven headlessly.
 *
 * Fabric ships a Node build, so the object graph, the active selection and the
 * matrix maths are all the real ones — which is the only way these bugs can be
 * caught, because every one of them has been about what Fabric does to an object
 * when it is selected rather than about our arithmetic in isolation.
 *
 * It is also the only responsible way to find them. The multi-selection bugs
 * this file covers were originally diagnosed by dragging things around a real
 * document, which cost that document four object positions.
 */

const RECTANGLE = PRIMITIVES.find((p) => p.id === 'rectangle')!
const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!

beforeAll(async () => {
  await initClipper()
})

afterEach(() => {
  resetPaperScope()
})

let canvas: Canvas
let rendered: Map<string, RenderedObject>

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
  canvas = new Canvas(undefined as never, { width: 1200, height: 800 })
  rendered = new Map()
})

/** One object of the given primitive, centred where asked. */
function shape(primitive: typeof RECTANGLE, at: Vec2): string {
  const pathData = primitive.build(200, 150)
  return useDocumentStore.getState().createObjectFromGeometry({
    pathData,
    localBounds: pathBounds(pathData),
    artboardCenter: at,
    open: false,
  })
}

/** Push the document onto the canvas, as the editor does on every store change. */
function render(): void {
  const doc = useDocumentStore.getState().doc
  rendered = syncCanvas({
    canvas,
    doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
  })
}

/** Pull the canvas back into the document, as `object:modified` does. */
function writeBack(): void {
  const store = useDocumentStore.getState()
  const updates = collectTransforms(rendered, store.doc.objects)
  for (const update of updates) {
    store.updateObject(update.id, { transform: update.transform })
    if (update.bake) store.bakeTransform(update.id, update.bake)
  }
}

const at = (id: string): Vec2 => {
  const t = useDocumentStore.getState().doc.objects[id]!.transform
  return { x: t.x, y: t.y }
}

describe('moving several objects at once', () => {
  /*
   * The bug this file exists for, and the reason it is worth a headless canvas.
   *
   * Fabric does not move the members of a selection: it parents them into an
   * `ActiveSelection`, rewrites each one's `left`/`top` as an offset from the
   * selection's centre, and composes the selection's own transform on top only
   * when it draws. So a member read as it stands reports where it was BEFORE it
   * was selected, and the difference between the two is the offset from the
   * selection's centre — which is why a mis-read object did not drift, it jumped
   * the opposite way from the drag.
   */
  it('moves every selected object by the same amount, and nothing else', () => {
    const a = shape(RECTANGLE, { x: 200, y: 200 })
    const b = shape(ELLIPSE, { x: 600, y: 400 })
    const other = shape(RECTANGLE, { x: 900, y: 150 })
    render()

    const before = { a: at(a), b: at(b), other: at(other) }

    const selection = new ActiveSelection(
      [rendered.get(a)!.group, rendered.get(b)!.group],
      { canvas },
    )
    canvas.setActiveObject(selection)
    selection.set({ left: selection.left + 40, top: selection.top + 25 })
    selection.setCoords()

    writeBack()

    expect(at(a).x - before.a.x).toBeCloseTo(40, 6)
    expect(at(a).y - before.a.y).toBeCloseTo(25, 6)
    expect(at(b).x - before.b.x).toBeCloseTo(40, 6)
    expect(at(b).y - before.b.y).toBeCloseTo(25, 6)
    expect(at(other)).toEqual(before.other)
  })

  /*
   * Fabric fires `object:modified` once per member, so the write-back always
   * runs more than once for a single gesture — and every run but the first
   * happens after a render has already reconciled the canvas.
   *
   * That is what makes idempotence the property to test rather than a nicety.
   * It is also what the old read-one-write-one loop could not have: its second
   * pass measured objects against a canvas its own first pass had redrawn.
   */
  it('is idempotent, because Fabric reports one gesture several times', () => {
    const a = shape(RECTANGLE, { x: 200, y: 200 })
    const b = shape(ELLIPSE, { x: 600, y: 400 })
    render()
    const before = { a: at(a), b: at(b) }

    const selection = new ActiveSelection(
      [rendered.get(a)!.group, rendered.get(b)!.group],
      { canvas },
    )
    canvas.setActiveObject(selection)
    selection.set({ left: selection.left - 70, top: selection.top + 15 })
    selection.setCoords()

    // The whole gesture: a write-back, the render its commit triggers, and then
    // the write-back Fabric fires for the second member.
    writeBack()
    render()
    writeBack()
    render()
    writeBack()

    expect(at(a).x - before.a.x).toBeCloseTo(-70, 6)
    expect(at(a).y - before.a.y).toBeCloseTo(15, 6)
    expect(at(b).x - before.b.x).toBeCloseTo(-70, 6)
    expect(at(b).y - before.b.y).toBeCloseTo(15, 6)
  })

  it('leaves the objects where they are when the selection is only made', () => {
    // Selecting is not an edit. It used to be: placing a group writes an
    // absolute position, and a parented group reads that as an offset from the
    // selection, so the whole set jumped away from its own bounding box.
    const a = shape(RECTANGLE, { x: 200, y: 200 })
    const b = shape(ELLIPSE, { x: 600, y: 400 })
    render()
    const before = { a: at(a), b: at(b) }

    canvas.setActiveObject(
      new ActiveSelection([rendered.get(a)!.group, rendered.get(b)!.group], { canvas }),
    )
    // A store change of any kind re-renders while the selection is open.
    useDocumentStore.getState().setSelection([a, b])
    render()
    writeBack()

    expect(at(a)).toEqual(before.a)
    expect(at(b)).toEqual(before.b)
  })

  it('turns a whole selection without unpicking the objects in it', () => {
    const a = shape(RECTANGLE, { x: 300, y: 300 })
    const b = shape(ELLIPSE, { x: 500, y: 300 })
    render()

    const selection = new ActiveSelection(
      [rendered.get(a)!.group, rendered.get(b)!.group],
      { canvas },
    )
    canvas.setActiveObject(selection)
    selection.rotate(90)
    selection.setCoords()

    writeBack()

    const objects = useDocumentStore.getState().doc.objects
    expect(objects[a]!.transform.rotation).toBeCloseTo(90, 3)
    expect(objects[b]!.transform.rotation).toBeCloseTo(90, 3)

    // And each has swung round the selection's centre rather than its own: the
    // two were level and are now stacked.
    expect(Math.abs(at(a).x - at(b).x)).toBeLessThan(1)
    expect(Math.abs(at(a).y - at(b).y)).toBeGreaterThan(150)
  })
})

describe('resizing a frame', () => {
  /*
   * A frame had never resized. Its scale was split off into a "bake" — the step
   * that folds a resize into an outline — and `bakeTransform` only bakes
   * typography, so the scale was computed and then dropped on the floor.
   * Dragging a frame's corner moved it and left it exactly the size it was.
   */
  const aFrame = (): string => {
    const store = useDocumentStore.getState()
    const frame = store.createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = store.createObjectFromGeometry({
      open: false,
      pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
      localBounds: { x: -40, y: -40, width: 80, height: 80 },
      artboardCenter: { x: 300, y: 200 },
      name: 'Box',
    })
    useDocumentStore.getState().addToFrame(frame, [shape])
    return frame
  }

  const draw = (): void => {
    rendered = syncCanvas({
      canvas,
      doc: useDocumentStore.getState().doc,
      textPaths: {},
      bandPaths: {},
      ribbons: {},
      rendered,
    } as never)
  }

  it('keeps the scale on the transform instead of asking for a bake', () => {
    const frame = aFrame()
    draw()
    const group = rendered.get(frame)!.group
    group.set({ scaleX: 1.5, scaleY: 1.5 })
    group.setCoords()

    const update = collectTransforms(rendered, useDocumentStore.getState().doc.objects).find(
      (each) => each.id === frame,
    )
    expect(update, 'the frame is reported as changed').toBeDefined()
    expect(update!.transform.scaleX, 'and carries the new scale').toBeCloseTo(1.5, 6)
    expect(update!.bake, 'with nothing left for a bake that would discard it').toBeNull()
  })

  it('survives the round trip into the document', () => {
    const frame = aFrame()
    draw()
    const group = rendered.get(frame)!.group
    group.set({ scaleX: 1.5, scaleY: 1.5 })
    group.setCoords()
    for (const update of collectTransforms(rendered, useDocumentStore.getState().doc.objects)) {
      useDocumentStore.getState().setBase(update.id, { transform: update.transform })
    }
    expect(useDocumentStore.getState().doc.objects[frame]?.transform.scaleX).toBeCloseTo(1.5, 6)
  })
})
