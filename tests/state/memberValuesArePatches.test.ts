import { beforeEach, describe, expect, it } from 'vitest'

import { valuesFor } from '../../src/frame/frame'
import { pathToOutline, outlineToPath } from '../../src/geometry/outline'
import { useDocumentStore } from '../../src/state/documentStore'
import type { FrameObject } from '../../src/types/document'

/**
 * A state records what was AUTHORED in it, and nothing else.
 *
 * The whole frame model rests on this: `valuesFor` fills in every field a state
 * is silent about from the member itself, so a state that stays quiet keeps
 * following the member. Writing one field must therefore write one field — and
 * `Object.keys` of a state's patch is then exactly the list of what somebody did
 * there, which is the question every test below asks.
 *
 * It did not hold. Four writers folded their patch into the RESOLVED values, so
 * nudging a shape an inch wrote that shape's entire current self into the state
 * — appearance, node geometry, type settings and a derived `padding` — and the
 * state stopped following the member for good. Reshaping afterwards left it
 * drawing the old outline while its text was fitted to the new one; a colour
 * set once appeared in states nobody had touched. Yesterday's fix caught one
 * writer of the four, which is why it changed nothing anyone could see.
 */

const store = () => useDocumentStore.getState()

let frame: string

const frameIn = (): FrameObject => {
  const object = store().doc.objects[frame]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

const member = () => frameIn().members[0]!

/** What state `index` actually records about the member: its authored keys. */
const recorded = (index: number): string[] =>
  Object.keys(frameIn().states[index]?.values[member().id] ?? {}).sort()

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 300, y: 200 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -60 -50 L 60 -50 L 60 50 L -60 50 Z',
    localBounds: { x: -60, y: -50, width: 120, height: 100 },
    artboardCenter: { x: 300, y: 200 },
    name: 'Box',
  })
  store().updateObject(shape, { text: 'HELLO WORLD TYPE' })
  // A real outline, so the shape has nodes a state could freeze.
  const outline = pathToOutline(
    (store().doc.objects[shape] as { currentSourcePath: string }).currentSourcePath,
  )
  if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
  store().addToFrame(frame, [shape])
  store().duplicateFrameState(frame, 1)
})

describe('a state at birth', () => {
  it('records nothing about a member that has just joined', () => {
    // The document could not say which states a gesture had touched while every
    // state was born looking authored.
    expect(recorded(0)).toEqual([])
    expect(recorded(1)).toEqual([])
    expect(recorded(2)).toEqual([])
  })

  it('still answers for every field, from the member itself', () => {
    const values = valuesFor(member(), frameIn().states[0])
    expect(values.transform).toEqual(member().object.transform)
    expect(values.opacity).toBe(1)
    expect(values.appearance).toBeTruthy()
    expect(values.typeSettings?.text).toBe('HELLO WORLD TYPE')
  })
})

describe('what one gesture writes', () => {
  it('a move records the transform and NOTHING else', () => {
    const at = valuesFor(member(), frameIn().states[1]).transform
    store().setMemberValues(frame, 1, member().id, { transform: { ...at, x: at.x + 80 } })

    expect(recorded(1), 'one field asked for, one field written').toEqual(['transform'])
  })

  it('a colour records that colour, and only that colour', () => {
    store().setMemberValues(frame, 1, member().id, { appearance: { containerFill: '#ff0000' } })

    expect(recorded(1)).toEqual(['appearance'])
    const patch = frameIn().states[1]!.values[member().id]!
    expect(Object.keys(patch.appearance ?? {}), 'one fill, not five').toEqual(['containerFill'])

    // And the other four still come from the member.
    const own = member().object
    const got = valuesFor(member(), frameIn().states[1]).appearance!
    expect(got.containerFill).toBe('#ff0000')
    expect(own.kind === 'typography' && got.textFill === own.appearance.textFill).toBe(true)
  })

  it('a text change records the text, and only the text', () => {
    store().setMemberValues(frame, 1, member().id, { typeSettings: { text: 'BYE' } })

    expect(recorded(1)).toEqual(['typeSettings'])
    const patch = frameIn().states[1]!.values[member().id]!
    expect(Object.keys(patch.typeSettings ?? {})).toEqual(['text'])

    const own = member().object
    const got = valuesFor(member(), frameIn().states[1])
    expect(got.typeSettings?.text).toBe('BYE')
    expect(own.kind === 'typography' && got.typeSettings?.font === own.font).toBe(true)
    expect(got.padding, 'padding still the member’s, not zero').toBe(
      own.kind === 'typography' ? own.typography.padding : -1,
    )
  })

  it('never writes the derived padding, which is not a field', () => {
    const at = valuesFor(member(), frameIn().states[1]).transform
    store().setMemberValues(frame, 1, member().id, { transform: { ...at, x: at.x + 1 } })
    store().setMemberValues(frame, 1, member().id, { typeSettings: { text: 'BYE' } })
    store().setMemberValues(frame, 1, member().id, { appearance: { textFill: '#0000ff' } })

    for (const state of frameIn().states) {
      const patch = (state.values[member().id] ?? {}) as Record<string, unknown>
      expect('padding' in patch).toBe(false)
    }
  })

  it('accumulates what was deliberately authored, field by field', () => {
    const at = valuesFor(member(), frameIn().states[1]).transform
    store().setMemberValues(frame, 1, member().id, { transform: { ...at, x: at.x + 80 } })
    store().setMemberValues(frame, 1, member().id, { opacity: 0.5 })
    store().setMemberValues(frame, 1, member().id, { appearance: { containerFill: '#ff0000' } })
    store().setMemberValues(frame, 1, member().id, { appearance: { textFill: '#00ff00' } })

    expect(recorded(1)).toEqual(['appearance', 'opacity', 'transform'])
    const patch = frameIn().states[1]!.values[member().id]!
    expect(Object.keys(patch.appearance ?? {}).sort(), 'both colours, kept apart').toEqual([
      'containerFill',
      'textFill',
    ])
    const got = valuesFor(member(), frameIn().states[1])
    expect(got.opacity).toBeCloseTo(0.5, 6)
    expect(got.transform.x).toBeCloseTo(at.x + 80, 6)
  })

  it('records nothing for a write that only restates the member', () => {
    // Judged by what it would draw: the member's own transform is no change.
    store().setMemberValues(frame, 1, member().id, { transform: { ...member().object.transform } })
    expect(recorded(1)).toEqual([])
  })
})

describe('where an edit lands', () => {
  /*
   * On the state it was made in, and nowhere else.
   *
   * An edit used to carry forward through every following state that was still
   * an identical copy — which, in a frame whose states all begin as copies, is
   * all of them. The first move of a shape moved it in every state at once and
   * the second did not, according to a history nothing on screen showed. A
   * state is a thing you arranged, not a thing that inherits from its
   * neighbours.
   */
  it('moves the shape in ONE state and leaves the others the same objects', () => {
    const before = frameIn().states
    const at = valuesFor(member(), before[0]).transform
    store().setMemberValues(frame, 0, member().id, { transform: { ...at, x: at.x + 90 } })

    const after = frameIn().states
    expect(after[0]).not.toBe(before[0])
    expect(after[1], 'state 2 untouched, the same object').toBe(before[1])
    expect(after[2], 'state 3 untouched, the same object').toBe(before[2])
    expect(valuesFor(member(), after[1]).transform.x).toBeCloseTo(at.x, 6)
  })

  it('colours ONE state, so the backdrop follows the same rule as the shape', () => {
    const before = frameIn().states
    store().setFrameStateBackground(frame, 0, '#1f8f4e')

    const after = frameIn().states
    expect(after[0]?.background).toBe('#1f8f4e')
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('lands on the LAST state when the index is past the end, as every gesture does', () => {
    const at = valuesFor(member(), frameIn().states[2]).transform
    store().setMemberValues(frame, 99, member().id, { transform: { ...at, y: at.y + 30 } })

    expect(recorded(2)).toEqual(['transform'])
    expect(recorded(0), 'not silently on the first').toEqual([])
  })
})

describe('a duplicated member', () => {
  it('copies what the original AUTHORED in each state, sparsely', () => {
    const at = valuesFor(member(), frameIn().states[1]).transform
    store().setMemberValues(frame, 1, member().id, { transform: { ...at, x: at.x + 120 } })

    const made = store().duplicateFrameMember(frame, member().id) as string
    const object = frameIn()
    const keysOf = (index: number) => Object.keys(object.states[index]?.values[made] ?? {}).sort()

    expect(keysOf(0), 'silent where the original was silent').toEqual([])
    expect(keysOf(1), 'authored where the original authored').toEqual(['transform'])
    expect(keysOf(2)).toEqual([])

    const copy = object.members.find((each) => each.id === made)!
    expect(valuesFor(copy, object.states[1]).transform.x).toBeCloseTo(at.x + 120, 6)
  })
})
