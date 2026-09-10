import { Canvas } from 'fabric/node'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { evaluateFrameAtTime, valuesFor } from '../../src/frame/frame'
import { frameMoves } from '../../src/editor/animationPlayback'
import { initClipper } from '../../src/geometry/clipper'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import {
  applyMemberMoment,
  memberOpacity,
  syncCanvas,
  type RenderedObject,
} from '../../src/editor/renderer'
import { useDocumentStore } from '../../src/state/documentStore'
import { opacityOf } from '../../src/types/document'
import type { FrameObject } from '../../src/types/document'

/**
 * A member's opacity, which is the one appearance field that is not a colour.
 *
 * It broke in a way the colours did not, and the reason is worth keeping: the
 * fills are read off the object the builder is HANDED, which is the member as
 * the state has it, while the opacity was read straight off `member.object` —
 * the member at rest. So every colour followed the state and the opacity did
 * not, which is exactly what "does not show in the preview" looks like.
 */

beforeAll(async () => {
  await initClipper()
})

const store = () => useDocumentStore.getState()

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

let rendered = new Map<string, RenderedObject>()
let canvas: Canvas

const render = (): Map<string, RenderedObject> => {
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

/** What Fabric will actually draw the member at. */
const drawnOpacity = (frameId: string): number => {
  const group = rendered.get(frameId)?.group as never as { getObjects: () => never[] }
  const child = group
    .getObjects()
    .find((o: never) => (o as { get: (k: string) => unknown }).get('memberId')) as never as {
    opacity: number
  }
  return child.opacity
}

let frame: string

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  canvas = new Canvas(undefined, { width: 900, height: 700 })
  rendered = new Map()

  frame = store().createFrame({
    box: { x: 0, y: 0, width: 300, height: 240 },
    artboardCenter: { x: 100, y: 80 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -40 -40 L 40 -40 L 40 40 L -40 40 Z',
    localBounds: { x: -40, y: -40, width: 80, height: 80 },
    artboardCenter: { x: 100, y: 80 },
    name: 'Inner',
  })
  /*
   * Points, before it joins. A primitive carries no node list until something
   * asks to edit it — `openShapeEditing` derives one on the way in — and a
   * member has to have its topology settled before any state can reshape it,
   * since topology is what every state shares.
   */
  const outline = pathToOutline(store().doc.objects[shape]!.kind === 'typography'
    ? (store().doc.objects[shape] as { currentSourcePath: string }).currentSourcePath
    : '')
  if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
  store().addToFrame(frame, [shape])
})

/** Set the shown state's appearance opacity, the way the panel's control does. */
const setStateOpacity = (at: number, opacity: number): void => {
  const member = frameIn(frame).members[0]!
  const look = valuesFor(member, frameIn(frame).states[at]).appearance
  if (!look) throw new Error('expected an appearance')
  store().setMemberValues(frame, at, member.id, { appearance: { ...look, opacity } })
}

describe('a member’s opacity', () => {
  it('follows the state, like every other appearance field', () => {
    setStateOpacity(0, 0.25)
    render()
    expect(drawnOpacity(frame)).toBeCloseTo(0.25, 6)
  })

  it('is left alone when no state has touched it', () => {
    render()
    expect(drawnOpacity(frame)).toBeCloseTo(1, 6)
  })

  it('does not write itself onto the member’s resting object', () => {
    // Structure is shared by every state; how it LOOKS is not.
    setStateOpacity(0, 0.4)
    expect(opacityOf(frameIn(frame).members[0]!.object)).toBeCloseTo(1, 6)
  })

  it('differs between two states, which is what a fade IS', () => {
    setStateOpacity(1, 0)
    render()
    // State 0 is on show and untouched.
    expect(drawnOpacity(frame)).toBeCloseTo(1, 6)

    const object = frameIn(frame)
    const member = object.members[0]!
    expect(valuesFor(member, object.states[0]).appearance?.opacity).toBeCloseTo(1, 6)
    expect(valuesFor(member, object.states[1]).appearance?.opacity).toBeCloseTo(0, 6)
  })

  it('multiplies the member’s own with the state’s fade knob', () => {
    /*
     * Two opacities, and they are different things: the member's own, which is
     * an appearance and so belongs to the state, and `MemberValues.opacity`,
     * which is the fade. A member set half-transparent that then fades to half
     * is a quarter, the same as any two stacked transparencies.
     */
    setStateOpacity(0, 0.5)
    const object = frameIn(frame)
    const member = object.members[0]!
    const values = valuesFor(member, object.states[0])
    expect(memberOpacity(member, { ...values, opacity: 0.5 })).toBeCloseTo(0.25, 6)
    expect(memberOpacity(member, { ...values, opacity: 1 })).toBeCloseTo(0.5, 6)
  })

  it('blends across the transition rather than cutting', () => {
    setStateOpacity(1, 0)
    const object = frameIn(frame)
    const member = object.members[0]!

    const half =
      object.states[0]!.holdMs + object.states[0]!.transitionMs / 2
    const moment = evaluateFrameAtTime(object, half)
    const at = moment.members[member.id]?.appearance?.opacity as number

    expect(at).toBeGreaterThan(0.05)
    expect(at).toBeLessThan(0.95)
  })

  it('reaches the canvas during playback, not only in the still render', () => {
    /*
     * Playback repaints in place rather than rebuilding, so it has its own line
     * for the opacity — and that line had the same bug as the builder's. A fade
     * that the model computed correctly and nothing ever drew is the worst of
     * the three failures, because the timeline looks right everywhere you check
     * except the screen.
     */
    setStateOpacity(1, 0)
    render()

    const object = frameIn(frame)
    const member = object.members[0]!
    const half = object.states[0]!.holdMs + object.states[0]!.transitionMs / 2
    const moment = evaluateFrameAtTime(object, half)

    const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
    for (const child of group.getObjects()) {
      const memberId = (child as { get: (k: string) => unknown }).get('memberId') as
        | string
        | undefined
      if (!memberId) continue
      const values = moment.members[memberId]
      if (!values) continue
      // The playback loop's own per-member body, called rather than restated —
      // a test that re-implemented it would agree with itself forever.
      applyMemberMoment(child as never, member, values)
    }

    const shown = drawnOpacity(frame)
    expect(shown).toBeGreaterThan(0.05)
    expect(shown).toBeLessThan(0.95)
  })
})

describe('a member reshaped per state', () => {
  /** The path the member's container is actually drawn from. */
  const drawnPath = (frameId: string): string => {
    const group = rendered.get(frameId)?.group as never as { getObjects: () => never[] }
    const child = group
      .getObjects()
      .find((o: never) => (o as { get: (k: string) => unknown }).get('memberId')) as never as {
      getObjects: () => never[]
    }
    const container = child
      .getObjects()
      .find((o: never) => (o as { get: (k: string) => unknown }).get('role') === 'container')
    return JSON.stringify((container as never as { path: unknown }).path)
  }

  /** Push every node out by a factor, so the shape grows without changing topology. */
  const scaledOutline = (factor: number) => {
    const member = frameIn(frame).members[0]!
    if (member.object.kind !== 'typography' || !member.object.outline) {
      throw new Error('expected an editable outline')
    }
    return {
      subpaths: member.object.outline.subpaths.map((subpath) => ({
        ...subpath,
        nodes: subpath.nodes.map((node) => ({
          ...node,
          point: { x: node.point.x * factor, y: node.point.y * factor },
        })),
      })),
    }
  }

  it('draws the state’s shape, not the member’s resting one', () => {
    render()
    const before = drawnPath(frame)

    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 0, member.id, { nodes: scaledOutline(2) })
    render()

    expect(drawnPath(frame)).not.toBe(before)
    // And the member's own structure is untouched: topology is shared, the
    // shape is not.
    const still = frameIn(frame).members[0]!
    if (still.object.kind !== 'typography') throw new Error('expected a shape')
    expect(still.object.outline?.subpaths[0]?.nodes[0]?.point).toEqual({ x: -40, y: -40 })
  })

  it('morphs during playback rather than cutting', () => {
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: scaledOutline(3) })
    render()
    const atRest = drawnPath(frame)

    const object = frameIn(frame)
    const half = object.states[0]!.holdMs + object.states[0]!.transitionMs / 2
    const moment = evaluateFrameAtTime(object, half)

    const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
    for (const child of group.getObjects()) {
      const memberId = (child as { get: (k: string) => unknown }).get('memberId') as
        | string
        | undefined
      if (!memberId) continue
      const values = moment.members[memberId]
      if (values) applyMemberMoment(child as never, object.members[0]!, values)
    }

    const midway = drawnPath(frame)
    expect(midway, 'the shape has moved off the first state').not.toBe(atRest)
    expect(midway, 'and is not simply the second state').not.toBe(
      JSON.stringify(scaledOutline(3)),
    )
  })

  it('counts a reshape as a different arrangement', () => {
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: scaledOutline(2) })
    expect(frameMoves(frameIn(frame))).toBe(true)
  })
})
