import { Canvas } from 'fabric/node'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'

import { evaluateFrameAtTime, valuesFor, withTypeSettings } from '../../src/frame/frame'
import { initClipper } from '../../src/geometry/clipper'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { applyMemberMoment, syncCanvas, type RenderedObject } from '../../src/editor/renderer'
import { frameMoves, frameRuns } from '../../src/editor/animationPlayback'
import { useDocumentStore } from '../../src/state/documentStore'
import { registerFont } from '../../src/typography/fontRegistry'
import { fitObject } from '../../src/typography/objectFit'
import type { FitOutcome } from '../../src/typography/fit'
import type { FrameObject, PathOutline } from '../../src/types/document'

/**
 * Words that follow a form as it bends.
 *
 * A member reshaped between two states is, part-way through, a container nobody
 * authored — so there is no text path waiting for it. `useTextPaths` solves one
 * per STATE, and the frames in between are exactly the ones it cannot know
 * about. Left alone, the outline morphed and the type sat still inside it: on
 * play "only the shape moves between states, the text remains the same".
 *
 * The answer is not to re-fit. The layout is solved once and only the PATCH —
 * the space the type sits in — is rebuilt at this instant's outline, so every
 * glyph follows and not one line break moves.
 */

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})
afterEach(() => resetPaperScope())

const store = () => useDocumentStore.getState()

const frameIn = (id: string): FrameObject => {
  const object = store().doc.objects[id]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

let canvas: Canvas
let rendered = new Map<string, RenderedObject>()
let frame: string
let memberObjectId: string
let fits: Record<string, (FitOutcome | null)[]>

/** Everything the renderer is handed, including the member's solved fit. */
const render = (): void => {
  const member = frameIn(frame).members[0]!
  if (member.object.kind !== 'typography') throw new Error('expected a shape')
  const fitted = fitObject(member.object)
  // One fit per state, as the hook supplies. Both states share this layout
  // here; the cut-tier tests below give them their own.
  fits = fitted.ok ? { [member.object.id]: frameIn(frame).states.map(() => fitted) } : {}
  rendered = syncCanvas({
    canvas,
    doc: store().doc,
    textPaths: { [memberObjectId]: fitted.ok ? fitted.path : '' },
    bandPaths: {},
    ribbons: {},
    rendered,
  } as never)
}

/** The glyph path the member is actually drawn from. */
const drawnText = (): string => {
  const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
  const child = group
    .getObjects()
    .find((o: never) => (o as { get: (k: string) => unknown }).get('memberId')) as never as {
    getObjects: () => never[]
  }
  const text = child
    .getObjects()
    .find((o: never) => (o as { get: (k: string) => unknown }).get('role') === 'text')
  return text ? JSON.stringify((text as never as { path: unknown }).path) : ''
}

/** Pull one corner of the member's outline, without changing its topology. */
const pulled = (dx: number, dy: number): PathOutline => {
  const member = frameIn(frame).members[0]!
  if (member.object.kind !== 'typography' || !member.object.outline) {
    throw new Error('expected an editable outline')
  }
  return {
    subpaths: member.object.outline.subpaths.map((subpath) => ({
      ...subpath,
      nodes: subpath.nodes.map((node, i) =>
        i === 1 ? { ...node, point: { x: node.point.x + dx, y: node.point.y + dy } } : node,
      ),
    })),
  }
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  canvas = new Canvas(undefined as never, { width: 1000, height: 800 })
  rendered = new Map()
  fits = {}

  frame = store().createFrame({
    box: { x: 0, y: 0, width: 460, height: 380 },
    artboardCenter: { x: 320, y: 240 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -110 -80 L 110 -80 L 110 80 L -110 80 Z',
    localBounds: { x: -110, y: -80, width: 220, height: 160 },
    artboardCenter: { x: 320, y: 240 },
    name: 'Words',
  })
  store().updateObject(shape, { text: 'HOT NOW BYE', font: { fontId: 'anton', weight: 400, italic: false } })
  const outline = pathToOutline(store().doc.objects[shape]!.kind === 'typography'
    ? (store().doc.objects[shape] as { currentSourcePath: string }).currentSourcePath
    : '')
  if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
  store().addToFrame(frame, [shape])
  memberObjectId = frameIn(frame).members[0]!.object.id
})

/** Drive the playback loop's own per-member body at one moment. */
const paintAt = (authoredMs: number): void => {
  const object = frameIn(frame)
  const moment = evaluateFrameAtTime(object, authoredMs)
  const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
  for (const child of group.getObjects()) {
    const memberId = (child as { get: (k: string) => unknown }).get('memberId') as string | undefined
    if (!memberId) continue
    const values = moment.members[memberId]
    const member = object.members.find((each) => each.id === memberId)
    if (values && member)
      applyMemberMoment(child as never, member, values, fits, moment.stateIndex)
  }
}

describe('type inside a morphing member', () => {
  it('follows the shape part-way between two states', () => {
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: pulled(120, -110) })
    render()
    const atRest = drawnText()
    expect(atRest.length, 'there is type to move').toBeGreaterThan(100)

    const object = frameIn(frame)
    paintAt(object.states[0]!.holdMs + object.states[0]!.transitionMs / 2)

    expect(drawnText(), 'the words moved with the form').not.toBe(atRest)
  })

  it('keeps moving across the transition rather than snapping once', () => {
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: pulled(140, -120) })
    render()

    const object = frameIn(frame)
    const hold = object.states[0]!.holdMs
    const span = object.states[0]!.transitionMs
    const seen = new Set<string>()
    for (const at of [0.2, 0.4, 0.6, 0.8]) {
      paintAt(hold + span * at)
      seen.add(drawnText())
    }
    expect(seen.size, 'a different shape of type at each step').toBe(4)
  })

  it('leaves the type alone when the member is not being reshaped', () => {
    /*
     * The other half of the contract. Re-pouring costs a patch build and a whole
     * block of glyphs, so a frame that only MOVES its members — which is most of
     * them — must not pay it.
     */
    const member = frameIn(frame).members[0]!
    const values = valuesFor(member, frameIn(frame).states[0])
    store().setMemberValues(frame, 1, member.id, {
      transform: { ...values.transform, x: values.transform.x + 120 },
    })
    render()
    const atRest = drawnText()

    const object = frameIn(frame)
    paintAt(object.states[0]!.holdMs + object.states[0]!.transitionMs / 2)

    expect(drawnText(), 'moved, not re-poured').toBe(atRest)
  })
})

describe('stopping a morph', () => {
  it('puts the FITTED type back on a state that was never reshaped', () => {
    /*
     * Stopping settles the frame on the state being edited. A state that has not
     * been reshaped needs the type it was fitted with, not whatever the last
     * played frame left in the child — and the group is not rebuilt on stop, so
     * nothing else will put it back. The shape snapped home correctly while the
     * words stayed mid-morph.
     */
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: pulled(130, -120) })
    render()
    const authored = drawnText()

    const object = frameIn(frame)
    paintAt(object.states[0]!.holdMs + object.states[0]!.transitionMs / 2)
    expect(drawnText(), 'mid-morph, as playback leaves it').not.toBe(authored)

    // Settle on state 0, which is the member's own shape.
    paintAt(0)
    expect(drawnText()).toBe(authored)
  })
})

describe('a state that sets its own type', () => {
  /** Fit each state on its own settings, exactly as `useTextPaths` does. */
  const fitPerState = (): void => {
    const object = frameIn(frame)
    const member = object.members[0]!
    fits = {
      [member.object.id]: object.states.map((state) => {
        const shape = withTypeSettings(member.object, valuesFor(member, state).typeSettings)
        if (shape.kind !== 'typography') return null
        const solved = fitObject(shape)
        return solved.ok ? solved : null
      }),
    }
  }

  it('shows the DEPARTING state’s words for the whole transition', () => {
    /*
     * The cut tier's whole point. The type is readable throughout and changes
     * once, on arrival — rather than re-flowing part-way through a move, which
     * would have words hopping between rows while somebody reads them.
     */
    const member = frameIn(frame).members[0]!
    const settings = valuesFor(member, frameIn(frame).states[1]).typeSettings
    store().setMemberValues(frame, 1, member.id, {
      typeSettings: { ...settings, text: 'COLD LATER' },
    })
    render()
    fitPerState()

    const object = frameIn(frame)
    const first = drawnText()

    // Anywhere inside the transition, the departing state's type still shows.
    const hold = object.states[0]!.holdMs
    const span = object.states[0]!.transitionMs
    for (const at of [0.2, 0.5, 0.8]) {
      paintAt(hold + span * at)
      expect(drawnText(), `at ${at}`).toBe(first)
    }
  })

  it('arrives with the new words once the transition ends', () => {
    const member = frameIn(frame).members[0]!
    const settings = valuesFor(member, frameIn(frame).states[1]).typeSettings
    store().setMemberValues(frame, 1, member.id, {
      typeSettings: { ...settings, text: 'COLD LATER' },
    })
    render()
    fitPerState()

    const object = frameIn(frame)
    paintAt(0)
    const first = drawnText()

    // The hold on state 2, which is where the cut has landed.
    const arrived = object.states[0]!.holdMs + object.states[0]!.transitionMs + 1
    paintAt(arrived)
    expect(drawnText(), 'the new sentence is set').not.toBe(first)
  })
})

/** Fit every state, as the hook does. */
const fitsForEveryState = (): void => {
  const object = frameIn(frame)
  const member = object.members[0]!
  fits = {
    [member.object.id]: object.states.map((state) => {
      const shape = withTypeSettings(member.object, valuesFor(member, state).typeSettings)
      if (shape.kind !== 'typography') return null
      const solved = fitObject(shape)
      return solved.ok ? solved : null
    }),
  }
}

/** Paint at one moment with one preset phase, and report the artwork. */
const paintAtWithPhase = (authoredMs: number, phase: number): string => {
  const object = frameIn(frame)
  const moment = evaluateFrameAtTime(object, authoredMs)
  const group = rendered.get(frame)?.group as never as { getObjects: () => never[] }
  for (const child of group.getObjects()) {
    const memberId = (child as { get: (k: string) => unknown }).get('memberId') as string | undefined
    if (!memberId) continue
    const values = moment.members[memberId]
    const member = object.members.find((each) => each.id === memberId)
    if (values && member) applyMemberMoment(child as never, member, values, fits, moment.stateIndex, phase)
  }
  return drawnText()
}

const paintPhase = (phase: number): string => paintAtWithPhase(0, phase)

describe('a member’s own preset', () => {
  /** Give the member a shape preset, the way its Animate tab does. */
  const givePreset = (): void => {
    const member = frameIn(frame).members[0]!
    if (member.object.kind !== 'typography') throw new Error('expected a shape')
    store().updateObject(member.object.id, {
      animation: { ...member.object.animation, preset: 'wave', loopDuration: 2 },
    })
  }

  it('counts as motion, so the frame’s loop runs for it', () => {
    /*
     * `animatingIds` walks `doc.objectOrder`, and a member is not in it — so
     * nothing drove a member's preset and a shape carrying a Wave stopped waving
     * the moment it was dropped into a frame. Two clocks, and either one is
     * reason enough to run the loop.
     */
    expect(frameRuns(frameIn(frame)), 'nothing moving yet').toBe(false)
    givePreset()
    expect(frameMoves(frameIn(frame)), 'the states are still identical').toBe(false)
    expect(frameRuns(frameIn(frame)), 'but the member is moving').toBe(true)
  })

  it('changes the artwork as its own phase advances', () => {
    givePreset()
    render()
    fitsForEveryState()

    const seen = new Set<string>()
    for (const phase of [0, 0.25, 0.5, 0.75]) seen.add(paintPhase(phase))
    expect(seen.size, 'a different frame of the loop each time').toBe(4)
  })

  it('composes with the frame rather than replacing it', () => {
    /*
     * The frame says where the member is and what it looks like; the preset says
     * what it is doing there. So the same phase over two different arrangements
     * must give two different pictures — the preset deforms what the frame
     * hands it, rather than starting from the member at rest.
     */
    const member = frameIn(frame).members[0]!
    store().setMemberValues(frame, 1, member.id, { nodes: pulled(120, -110) })
    givePreset()
    render()
    fitsForEveryState()

    const object = frameIn(frame)
    const early = object.states[0]!.holdMs + object.states[0]!.transitionMs * 0.25
    const late = object.states[0]!.holdMs + object.states[0]!.transitionMs * 0.75
    expect(paintAtWithPhase(early, 0.3)).not.toBe(paintAtWithPhase(late, 0.3))
  })
})
