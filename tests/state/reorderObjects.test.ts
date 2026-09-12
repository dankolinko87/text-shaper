import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentStore } from '../../src/state/documentStore'

/** Objects move through the stack together, keeping their own order. */
const store = () => useDocumentStore.getState()
const make = (): string => store().createMosaic({ columns: 1, rows: 1, artboardCenter: { x: 0, y: 0 }, text: 'A' })
const order = () => store().doc.objectOrder

beforeEach(() => {
  store().resetDocument()
})

describe('reordering objects', () => {
  it('sends a block to the back and brings it to the front, order kept', () => {
    const [a, b, c, d] = [make(), make(), make(), make()]
    store().reorderObjects([b, d], 'back')
    expect(order()).toEqual([b, d, a, c])
    store().reorderObjects([b, d], 'front')
    expect(order()).toEqual([a, c, b, d])
  })

  it('steps a block one outsider forward or backward, and stops at the ends', () => {
    const [a, b, c, d] = [make(), make(), make(), make()]
    store().reorderObjects([a, b], 'forward')
    expect(order()).toEqual([c, a, b, d])
    store().reorderObjects([a, b], 'forward')
    expect(order()).toEqual([c, d, a, b])
    const atFront = store().doc
    store().reorderObjects([a, b], 'forward')
    expect(store().doc, 'nowhere further to go').toBe(atFront)
    store().reorderObjects([b], 'backward')
    expect(order()).toEqual([c, d, b, a])
    store().reorderObjects([c], 'backward')
    expect(store().doc.objectOrder).toEqual([c, d, b, a])
  })

  it('ignores ids that are not objects', () => {
    const a = make()
    const before = store().doc
    store().reorderObjects(['nope'], 'front')
    expect(store().doc).toBe(before)
    store().reorderObjects([a, 'nope'], 'back')
    expect(order()).toEqual([a])
  })

  it('moves a frame’s members through the same rule', () => {
    const frame = store().createFrame({ box: { x: 0, y: 0, width: 100, height: 100 }, artboardCenter: { x: 0, y: 0 } })
    const [a, b, c] = [make(), make(), make()]
    store().addToFrame(frame, [a, b, c])
    const members = () => (store().doc.objects[frame] as { members: { id: string }[] }).members.map((m) => m.id)
    const [ma, mb, mc] = members() as [string, string, string]
    store().reorderFrameMembers(frame, [ma], 'front')
    expect(members()).toEqual([mb, mc, ma])
    store().reorderFrameMembers(frame, [ma], 'backward')
    expect(members()).toEqual([mb, ma, mc])
    const before = store().doc
    store().reorderFrameMembers(frame, [mb], 'back')
    expect(store().doc, 'at the back already').toBe(before)
  })
})
