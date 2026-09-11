import { Canvas } from 'fabric/node'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { memberBoxes } from '../../src/editor/frameBoxes'
import {
  memberAsDrawn,
  placeMemberChild,
  syncCanvas,
  type RenderedObject,
} from '../../src/editor/renderer'
import { objectToArtboard } from '../../src/geometry/objectSpace'
import { applyToPoint, multiply } from '../../src/geometry/transform'
import { evaluateFrameAtTime, valuesFor } from '../../src/frame/frame'
import { initClipper } from '../../src/geometry/clipper'
import { useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject } from '../../src/types/document'

/**
 * Where a member is drawn, and where the editor thinks it is.
 *
 * These two numbers were different, and everything that went wrong inside a
 * frame came from that: the outlines sat away from the shapes, no click ever
 * landed on a member, and pressing one shape moved another. None of it was
 * three bugs — it was one disagreement about which coordinate space an answer
 * was in, told three ways.
 *
 * The shapes here are deliberately awkward: artwork that is NOT centred on its
 * own local origin, a frame that is NOT at the artboard origin, and a member
 * that overhangs the frame's bounds. Each of those was a case where a wrong
 * answer happened to look right.
 */

beforeAll(async () => {
  await initClipper()
})

const store = () => useDocumentStore.getState()

/** Artwork sitting well away from its own origin, so `localCentre` is not zero. */
const offCentreShape = (name: string, at: { x: number; y: number }): string =>
  store().createObjectFromGeometry({
    open: false,
    pathData: 'M 100 60 L 200 60 L 200 160 L 100 160 Z',
    localBounds: { x: 100, y: 60, width: 100, height: 100 },
    artboardCenter: at,
    name,
  })

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

/*
 * The `rendered` map is carried between calls, exactly as the editor carries it.
 * Handing `syncCanvas` an empty one makes it believe nothing has been drawn yet,
 * so it adds a SECOND group for the same object and every lookup by `shapeId`
 * then finds the stale one.
 */
let rendered = new Map<string, RenderedObject>()
const render = (canvas: Canvas): Map<string, RenderedObject> => {
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: {},
    bandPaths: {},
    ribbons: {},
    rendered,
  } as never)
  return rendered
}

let canvas: Canvas

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  canvas = new Canvas(undefined, { width: 1200, height: 900 })
  rendered = new Map()
})

describe('a member’s drawn position', () => {
  it('honours its state transform, off-centre artwork and all', () => {
    /*
     * The bug: the renderer wrote `left = transform.x` straight onto the member
     * group. A group is centred on its ARTWORK, so that put the artwork's
     * centre where the origin belonged and every member was displaced by its
     * own `localCentre` — a different amount each, which is why one shape's
     * outline could land on top of another shape.
     */
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Off-centre', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])

    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, x: 50, y: 25 },
    })

    render(canvas)
    const box = memberBoxes(rendered.get(frame)?.group).get(member.id)

    /*
     * Frame centred at (300,200), so its local origin is there. The member's
     * origin is 50,25 further on, and its artwork spans 100..200 x 60..160 from
     * that origin.
     */
    expect(box).toBeDefined()
    expect(box!.x).toBeCloseTo(300 + 50 + 100, 0)
    expect(box!.y).toBeCloseTo(200 + 25 + 60, 0)
    expect(box!.width).toBeCloseTo(100, 0)
    expect(box!.height).toBeCloseTo(100, 0)
  })

  it('moves by exactly what the state says, and takes nothing else with it', () => {
    // "sometimes when i move one shape other shapes move" — the hit test and the
    // outlines were both built from boxes that did not describe their members.
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const a = offCentreShape('A', { x: 260, y: 180 })
    const b = offCentreShape('B', { x: 340, y: 220 })
    store().addToFrame(frame, [a, b])

    const [one, two] = frameIn(frame).members as [
      FrameObject['members'][number],
      FrameObject['members'][number],
    ]

    render(canvas)
    const before = memberBoxes(rendered.get(frame)?.group)

    const values = one.object.transform
    store().setMemberValues(frame, 0, one.id, {
      transform: { ...values, x: values.x + 70, y: values.y - 40 },
    })
    render(canvas)
    const after = memberBoxes(rendered.get(frame)?.group)

    expect(after.get(one.id)!.x - before.get(one.id)!.x).toBeCloseTo(70, 6)
    expect(after.get(one.id)!.y - before.get(one.id)!.y).toBeCloseTo(-40, 6)
    expect(after.get(two.id)!.x).toBeCloseTo(before.get(two.id)!.x, 6)
    expect(after.get(two.id)!.y).toBeCloseTo(before.get(two.id)!.y, 6)
  })

  it('is on the ARTBOARD, not in the frame’s local space', () => {
    /*
     * The one that made nothing selectable. `getCoords()` on a child answers in
     * the group's plane; the outlines are canvas objects and the pointer is a
     * scene point, so both needed the frame's transform applied. With the frame
     * at the origin the two agree by accident — hence a frame far from it.
     */
    const near = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 0, y: 0 },
    })
    const shape = offCentreShape('S', { x: 0, y: 0 })
    store().addToFrame(near, [shape])
    const member = frameIn(near).members[0]!

    render(canvas)
    const atOrigin = memberBoxes(rendered.get(near)?.group).get(member.id)!

    // The same frame, moved. Its member must move with it, by the same amount.
    store().setBase(near, { transform: { ...frameIn(near).transform, x: 500, y: 400 } })
    render(canvas)
    const moved = memberBoxes(rendered.get(near)?.group).get(member.id)!

    expect(moved.x - atOrigin.x).toBeCloseTo(500, 6)
    expect(moved.y - atOrigin.y).toBeCloseTo(400, 6)
  })

  it('survives a member overhanging the bounds, which is allowed', () => {
    /*
     * `localCentre` has to be the CHILDREN's centre, because that is where
     * Fabric's fit-content layout puts the group's origin. The frame passed its
     * bounds' centre instead, which is the same point only while nothing hangs
     * outside — and with clipping off, hanging outside is the feature.
     */
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 200, height: 150 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Overhang', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])
    const member = frameIn(frame).members[0]!

    // Well outside the frame's 200x150 box.
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, x: 400, y: 300 },
    })

    render(canvas)
    const box = memberBoxes(rendered.get(frame)?.group).get(member.id)!

    expect(box.x).toBeCloseTo(300 + 400 + 100, 0)
    expect(box.y).toBeCloseTo(200 + 300 + 60, 0)
  })

  it('turns with a rotated frame instead of staying upright', () => {
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Turned', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])
    const member = frameIn(frame).members[0]!

    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, x: 0, y: 0 },
    })
    render(canvas)
    const upright = memberBoxes(rendered.get(frame)?.group).get(member.id)!

    store().setBase(frame, { transform: { ...frameIn(frame).transform, rotation: 90 } })
    render(canvas)
    const turned = memberBoxes(rendered.get(frame)?.group).get(member.id)!

    /*
     * A quarter turn about the frame's origin at (300,200): a member whose
     * artwork sat at local (100..200, 60..160) lands at local (-160..-60,
     * 100..200), so the box moves to the other side and swaps its extents.
     */
    expect(turned.x).toBeCloseTo(300 - 160, 0)
    expect(turned.y).toBeCloseTo(200 + 100, 0)
    // Square artwork, so the size is unchanged — but the POSITION is not.
    expect(turned.width).toBeCloseTo(upright.width, 0)
    expect(turned.x).not.toBeCloseTo(upright.x, 1)
  })
})

describe('playback places a member exactly where a still render does', () => {
  it('agrees at a moment that is a state, so pressing Play moves nothing', () => {
    /*
     * The two had separate copies of the placement: the renderer went through
     * `positionGroup`, which carries the artwork offset, and the playback loop
     * set the raw transform. So a member jumped by its own `localCentre` the
     * instant Play was pressed and snapped back when it stopped — and only for
     * artwork that is not centred on its own origin, which is why it could sit
     * unnoticed. They now share `placementFor`; this is what says so.
     */
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Off-centre', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, x: 50, y: 25 },
    })

    render(canvas)
    const still = memberBoxes(rendered.get(frame)?.group).get(member.id)!

    // Time zero is the first state exactly, so painting it must change nothing.
    const object = frameIn(frame)
    const moment = evaluateFrameAtTime(object, 0)
    const group = rendered.get(frame)?.group as never as {
      getObjects: () => never[]
    }
    for (const child of group.getObjects()) {
      const memberId = (child as { get: (k: string) => unknown }).get('memberId') as
        | string
        | undefined
      if (!memberId) continue
      const values = moment.members[memberId]
      if (!values) continue
      placeMemberChild(child as never, values.transform)
    }

    const played = memberBoxes(rendered.get(frame)?.group).get(member.id)!
    expect(played.x).toBeCloseTo(still.x, 6)
    expect(played.y).toBeCloseTo(still.y, 6)
    expect(played.width).toBeCloseTo(still.width, 6)
    expect(played.height).toBeCloseTo(still.height, 6)
  })
})

describe('the member the point editor is handed', () => {
  /*
   * The overlay maps every handle with the object's own transform. For a member
   * that is only half the journey — the frame's is composed on top — but the
   * half it does use has to be the transform the member is DRAWN at, which is
   * the state's, not the one it rests at.
   *
   * The two are equal until the member is moved, because joining a frame writes
   * the same transform into every state. Move it once and only the STATE
   * changes; the member's own object keeps what it had. Every handle was then
   * offset by exactly that difference, which is what "still not aligned with the
   * shape" looks like.
   */
  it('is positioned where the state puts it, not where the member rests', () => {
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Moved', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])

    const member = frameIn(frame).members[0]!
    const resting = { ...member.object.transform }
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...resting, x: resting.x + 140, y: resting.y - 95 },
    })

    const moved = frameIn(frame).members[0]!
    const values = valuesFor(moved, frameIn(frame).states[0])
    const drawn = memberAsDrawn(moved, values)

    expect(drawn.transform.x).toBeCloseTo(resting.x + 140, 6)
    expect(drawn.transform.y).toBeCloseTo(resting.y - 95, 6)
    // And the member's own object is untouched, which is why the two can differ.
    expect(moved.object.transform.x).toBeCloseTo(resting.x, 6)
  })

  it('agrees with where the member is actually drawn', () => {
    // The end of the chain: map the object's own local origin through the same
    // composition the overlay uses, and it must land inside the drawn box.
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Moved', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])

    const member = frameIn(frame).members[0]!
    const resting = { ...member.object.transform }
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...resting, x: resting.x + 140, y: resting.y - 95 },
    })
    render(canvas)

    const object = frameIn(frame)
    const moved = object.members[0]!
    const drawn = memberAsDrawn(moved, valuesFor(moved, object.states[0]))
    const toArtboard = multiply(objectToArtboard(object.transform), objectToArtboard(drawn.transform))

    // The artwork spans local 100..200 x 60..160, so its own centre is 150,110.
    const centre = applyToPoint(toArtboard, { x: 150, y: 110 })
    const box = memberBoxes(rendered.get(object.id)?.group).get(moved.id)!

    expect(centre.x).toBeGreaterThan(box.x)
    expect(centre.x).toBeLessThan(box.x + box.width)
    expect(centre.y).toBeGreaterThan(box.y)
    expect(centre.y).toBeLessThan(box.y + box.height)
    // And near the middle of it, not merely inside.
    expect(Math.abs(centre.x - (box.x + box.width / 2))).toBeLessThan(2)
    expect(Math.abs(centre.y - (box.y + box.height / 2))).toBeLessThan(2)
  })
})

describe('clicking a member that hangs over the frame’s edge', () => {
  /**
   * Is `point` somewhere Fabric would look inside this group? Fabric targets an
   * object by testing the pointer against the corners `getCoords` reports, and
   * only looks at a group's children once that test has passed.
   */
  const wouldTarget = (
    group: { getCoords: () => { x: number; y: number }[] },
    point: { x: number; y: number },
  ): boolean => {
    const corners = group.getCoords()
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    return (
      point.x >= Math.min(...xs) &&
      point.x <= Math.max(...xs) &&
      point.y >= Math.min(...ys) &&
      point.y <= Math.max(...ys)
    )
  }

  const overhanging = (clip: boolean) => {
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = store().createObjectFromGeometry({
      open: false,
      pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
      localBounds: { x: -40, y: -40, width: 80, height: 80 },
      artboardCenter: { x: 300, y: 200 },
      name: 'Box',
    })
    store().addToFrame(frame, [shape])
    store().setFrameClip(frame, clip)
    const member = frameIn(frame).members[0]!
    // Half the frame's width to the right: past the edge, still drawn when the
    // frame does not clip.
    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, x: 260, y: 0 },
    })
    render(canvas)
    return { frame, member }
  }

  it('reaches it, because with clipping off the frame draws it', () => {
    const { frame } = overhanging(false)
    const group = rendered.get(frame)!.group
    expect(wouldTarget(group, { x: 560, y: 200 }), 'the overhang is clickable').toBe(true)
    expect(wouldTarget(group, { x: 300, y: 200 }), 'and so is the frame itself').toBe(true)
  })

  it('still measures its authored bounds, so resizing is unchanged', () => {
    const { frame } = overhanging(false)
    const group = rendered.get(frame)!.group
    expect(group.width).toBeCloseTo(400, 6)
    expect(group.height).toBeCloseTo(300, 6)
  })

  it('does NOT reach it when the frame clips, because then it is not drawn', () => {
    const { frame } = overhanging(true)
    const group = rendered.get(frame)!.group
    expect(wouldTarget(group, { x: 560, y: 200 }), 'nothing painted, nothing to click').toBe(false)
    expect(wouldTarget(group, { x: 300, y: 200 }), 'the frame itself is unaffected').toBe(true)
  })
})

describe('the frame while you are inside it', () => {
  const inside = (frame: string, at = 0): Map<string, RenderedObject> => {
    rendered = syncCanvas({
      canvas,
      doc: store().doc,
      textPaths: {},
      bandPaths: {},
      ribbons: {},
      rendered,
      insideFrame: frame,
      mosaicStates: { [frame]: at },
    } as never)
    return rendered
  }

  const aFrame = (): string => {
    const frame = store().createFrame({
      box: { x: 0, y: 0, width: 400, height: 300 },
      artboardCenter: { x: 300, y: 200 },
    })
    const shape = offCentreShape('Off-centre', { x: 300, y: 200 })
    store().addToFrame(frame, [shape])
    return frame
  }

  it('stays selectable, so its ground is how it is moved and resized from in there', () => {
    const frame = aFrame()
    inside(frame)
    const group = rendered.get(frame)!.group
    expect(group.selectable, 'selectable inside').toBe(true)
    expect(group.interactive, 'and its members are Fabric’s').toBe(true)

    // A document change takes the reuse path — which used to flip this back.
    store().updateObject(frame, { name: 'Renamed' })
    inside(frame)
    expect(rendered.get(frame)!.group.selectable, 'still selectable after a change').toBe(true)
  })

  it('stamps which frame and which state each group draws', () => {
    const frame = aFrame()
    store().duplicateFrameState(frame, 1)
    inside(frame, 2)
    const group = rendered.get(frame)!.group
    expect(group.get('statedId')).toBe(frame)
    expect(group.get('stateIndex')).toBe(2)
  })

  it('draws the LAST state for an index past the end, as every gesture assumes', () => {
    /*
     * After deleting a state the shown index can outlive it. The renderer used
     * to fall back to the FIRST state while every write clamped to the last —
     * so you looked at one state and edited another.
     */
    const frame = aFrame()
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, {
      transform: { ...member.object.transform, x: 100, y: 0 },
    })
    inside(frame, 99)
    const group = rendered.get(frame)!.group
    expect(group.get('stateIndex'), 'the last state, not the first').toBe(1)
    const box = memberBoxes(group).get(member.id)!
    // Frame at 300; state 2 puts the member 100 further on; artwork spans 100..200.
    expect(box.x).toBeCloseTo(300 + 100 + 100, 0)
  })

  it('redraws for a flip or a moved box, which the key could not see before', () => {
    const frame = aFrame()
    const member = frameIn(frame).members[0]!
    inside(frame)
    const before = rendered.get(frame)!.group

    store().setMemberValues(frame, 0, member.id, {
      transform: { ...member.object.transform, flipX: true },
    })
    inside(frame)
    expect(rendered.get(frame)!.group, 'a flip rebuilds').not.toBe(before)

    const again = rendered.get(frame)!.group
    const object = frameIn(frame)
    store().setBase(frame, { localBounds: { ...object.localBounds, x: object.localBounds.x - 40 } })
    inside(frame)
    expect(rendered.get(frame)!.group, 'a moved box rebuilds').not.toBe(again)
  })
})
