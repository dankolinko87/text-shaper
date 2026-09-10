import { beforeEach, describe, expect, it } from 'vitest'

import { shapeIn } from '../fixtures/objects'
import { outlineToPath } from '../../src/geometry/outline'
import { pathBounds } from '../../src/geometry/path'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { circleStroke } from '../fixtures/strokes'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { useDocumentStore } from '../../src/state/documentStore'
import { splitTransform } from '../../src/editor/transformIntent'

function newShape(): string {
  const store = useDocumentStore.getState()
  const pathData = PRIMITIVES[0]!.build(400, 300)
  return store.createObjectFromGeometry({
    pathData,
    localBounds: pathBounds(pathData),
    artboardCenter: { x: 500, y: 400 },
    open: false,
  })
}

beforeEach(() => {
  useDocumentStore.getState().resetDocument()
})

describe('baking a resize into the shape', () => {
  it('changes the outline instead of leaving a scale on the transform', () => {
    // The behaviour being fixed: a resize used to live on the object's
    // transform, so the rendered group scaled the container and the glyphs
    // together — the text was stretched as part of one picture rather than
    // being laid out again for the shape it now is.
    const id = newShape()
    const store = useDocumentStore.getState()
    const before = pathBounds(shapeIn(store.doc, id).currentSourcePath)

    store.bakeTransform(id, {
      scaleX: 2,
      scaleY: 0.5,
      rotation: 0,
      flipX: false,
      flipY: false,
    })

    const object = shapeIn(useDocumentStore.getState().doc, id)
    const after = pathBounds(object.currentSourcePath)

    expect(after.width / before.width).toBeCloseTo(2, 2)
    expect(after.height / before.height).toBeCloseTo(0.5, 2)
    expect(object.transform.scaleX).toBe(1)
    expect(object.transform.scaleY).toBe(1)
  })

  it('bumps the geometry revision so the text is fitted again', () => {
    const id = newShape()
    const before = shapeIn(useDocumentStore.getState().doc, id).geometryRevision
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 1.5, scaleY: 1, rotation: 0, flipX: false, flipY: false })
    expect(shapeIn(useDocumentStore.getState().doc, id).geometryRevision).toBeGreaterThan(before)
  })

  it('leaves the shape where it was', () => {
    // The matrix carries no translation, so the local origin — and therefore
    // the object's position — is untouched.
    const id = newShape()
    const before = { ...shapeIn(useDocumentStore.getState().doc, id).transform }
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 1.8, scaleY: 0.7, rotation: 30, flipX: false, flipY: false })
    const after = shapeIn(useDocumentStore.getState().doc, id).transform
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    // The angle folded into the geometry comes OFF the stored one, so the shape
    // is left facing the way it faced. Clearing it outright would have turned
    // the object by the thirty degrees just baked into its outline.
    expect(after.rotation).toBeCloseTo(before.rotation - 30, 6)
  })

  it('keeps an object turned when a resize is baked into it', () => {
    /*
     * The regression this exists for, and it took every resize of every rotated
     * shape with it.
     *
     * `splitTransform` folds the SCALE of a gesture into the outline and
     * deliberately leaves the rotation on the object — a row divider is a
     * function of x and cannot survive being turned, so rotation is never baked.
     * `bakeTransform` then cleared the angle anyway, so a shape turned 40
     * degrees snapped back to square the moment it was resized.
     */
    const id = newShape()
    const store = () => useDocumentStore.getState()
    const object = store().doc.objects[id]!
    store().updateObject(id, { transform: { ...object.transform, rotation: 40 } })

    const split = splitTransform({
      ...store().doc.objects[id]!.transform,
      scaleX: 1.5,
      scaleY: 1.5,
    })
    store().updateObject(id, { transform: split.transform })
    expect(split.bake).not.toBeNull()
    if (split.bake) store().bakeTransform(id, split.bake)

    expect(store().doc.objects[id]!.transform.rotation).toBeCloseTo(40, 6)
    expect(store().doc.objects[id]!.transform.scaleX).toBe(1)
  })

  it('leaves the grid alone, because patch space is intrinsic', () => {
    // Dividers are fractions of the container, not object coordinates: "a third
    // of the way down" still means that after a resize, and the patch is simply
    // rebuilt from the new outline. Putting them through the matrix — as was
    // right when they held object coordinates — sent a row at v = 0.5 to v = 1.0
    // on a shape scaled by two, destroying the grid on every resize.
    const id = newShape()
    const store = useDocumentStore.getState()
    store.updateObject(id, {
      dividers: [
        {
          id: 'd1',
          points: [
            { x: 0, y: 0.5 },
            { x: 0.5, y: 0.4 },
            { x: 1, y: 0.5 },
          ],
        },
      ],
    })
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 2, scaleY: 3, rotation: 0, flipX: false, flipY: false })

    const points = shapeIn(useDocumentStore.getState().doc, id).dividers[0]!.points
    expect(points[0]).toEqual({ x: 0, y: 0.5 })
    expect(points[1]).toEqual({ x: 0.5, y: 0.4 })
    expect(points[2]).toEqual({ x: 1, y: 0.5 })
  })

  it('updates local bounds to the new outline', () => {
    const id = newShape()
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 2, scaleY: 1, rotation: 0, flipX: false, flipY: false })
    const object = shapeIn(useDocumentStore.getState().doc, id)
    expect(object.localBounds.width).toBeCloseTo(pathBounds(object.currentSourcePath).width, 3)
  })
})

describe('the nodes through a bake', () => {
  /*
   * An object carries its shape twice — the path everything reads, and the nodes
   * the editor takes hold of. A bake rewrites the path. If it left the nodes
   * where they were, the shape would look right until someone dragged a handle,
   * and then snap back to the size it was before the resize.
   */
  function drawnShape(): string {
    const stroke = strokeToShapePath(circleStroke(300, 300, 120))
    if (!stroke.ok) throw new Error('fixture stroke failed to convert')
    return useDocumentStore.getState().createObjectFromGeometry(stroke)
  }

  it('carries them through the same matrix as the path', () => {
    const id = drawnShape()
    const store = useDocumentStore.getState()
    expect(shapeIn(store.doc, id).outline).not.toBeNull()

    store.bakeTransform(id, { scaleX: 2, scaleY: 0.5, rotation: 0, flipX: false, flipY: false })

    const object = shapeIn(useDocumentStore.getState().doc, id)
    expect(object.outline, 'still node-editable').not.toBeNull()
    const drawn = pathBounds(outlineToPath(object.outline!))
    const stored = pathBounds(object.currentSourcePath)
    expect(Math.abs(drawn.width - stored.width), 'width').toBeLessThan(0.05)
    expect(Math.abs(drawn.height - stored.height), 'height').toBeLessThan(0.05)
    expect(Math.abs(drawn.x - stored.x), 'x').toBeLessThan(0.05)
    expect(Math.abs(drawn.y - stored.y), 'y').toBeLessThan(0.05)
  })

  it('agrees with the path through a rotation too', () => {
    // A rotation is where a handle carried as an absolute point rather than a
    // vector would go visibly wrong, so it is worth asking separately.
    const id = drawnShape()
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 1.4, scaleY: 1, rotation: 37, flipX: false, flipY: false })

    const object = shapeIn(useDocumentStore.getState().doc, id)
    const drawn = pathBounds(outlineToPath(object.outline!))
    const stored = pathBounds(object.currentSourcePath)
    expect(Math.abs(drawn.width - stored.width), 'width').toBeLessThan(0.05)
    expect(Math.abs(drawn.height - stored.height), 'height').toBeLessThan(0.05)
  })

  it('leaves a primitive without nodes rather than inventing some', () => {
    const id = newShape()
    useDocumentStore
      .getState()
      .bakeTransform(id, { scaleX: 2, scaleY: 2, rotation: 0, flipX: false, flipY: false })
    expect(shapeIn(useDocumentStore.getState().doc, id).outline).toBeNull()
  })
})
