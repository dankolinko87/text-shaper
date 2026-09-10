import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'

import { blendValues, valuesFor, withTypeSettings } from '../../src/frame/frame'
import { initClipper } from '../../src/geometry/clipper'
import { outlineToPath, pathToOutline } from '../../src/geometry/outline'
import { pathBounds } from '../../src/geometry/path'
import { useDocumentStore } from '../../src/state/documentStore'
import { registerFont } from '../../src/typography/fontRegistry'
import { fitObject, frameAt, pourThrough } from '../../src/typography/objectFit'
import type { FrameObject, TypographyObject } from '../../src/types/document'

/**
 * Padding, when the type is POURED rather than freshly fitted.
 *
 * The fit lays type into the shape inset by the padding. Pouring re-emits that
 * same layout through a patch built at another outline — so if the patch is
 * built on the RAW outline, it maps padded space onto unpadded space and
 * stretches the type back out to the full shape. Padding then appears to do
 * nothing at all, which is exactly how it was reported.
 *
 * Measured before the fix: a 40-unit pad on a 300x200 shape came back 300x200
 * where a plain fit gave 220x120.
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

const store = () => useDocumentStore.getState()

let frame: string

const frameIn = (): FrameObject => {
  const object = store().doc.objects[frame]
  if (object?.kind !== 'frame') throw new Error('expected a frame')
  return object
}

beforeEach(() => {
  useDocumentStore.setState({
    doc: { ...store().doc, objects: {}, objectOrder: [] },
    past: [],
    future: [],
    selection: [],
  })
  frame = store().createFrame({
    box: { x: 0, y: 0, width: 400, height: 300 },
    artboardCenter: { x: 0, y: 0 },
  })
  const shape = store().createObjectFromGeometry({
    open: false,
    pathData: 'M -150 -100 L 150 -100 L 150 100 L -150 100 Z',
    localBounds: { x: -150, y: -100, width: 300, height: 200 },
    artboardCenter: { x: 0, y: 0 },
    name: 'Padded',
  })
  store().updateObject(shape, {
    text: 'HOT NOW',
    font: { fontId: 'anton', weight: 400, italic: false },
  })
  const outline = pathToOutline((store().doc.objects[shape] as TypographyObject).currentSourcePath)
  if (outline) store().setGeometry(shape, { path: outlineToPath(outline), outline })
  store().addToFrame(frame, [shape])
})

/** Set the shown state's padding, the way the panel's slider does. */
const setPadding = (padding: number): void => {
  const member = frameIn().members[0]!
  const current = valuesFor(member, frameIn().states[0]).typeSettings
  store().setMemberValues(frame, 0, member.id, {
    typeSettings: { ...current, typography: { ...current?.typography, padding } as never },
  })
}

/** The type as a plain fit gives it, and as pouring gives it. */
const bothWays = () => {
  const member = frameIn().members[0]!
  const values = valuesFor(member, frameIn().states[0])
  const shape = withTypeSettings(member.object, values.typeSettings)
  if (shape.kind !== 'typography') throw new Error('expected a shape')

  const fitted = fitObject(shape)
  if (!fitted.ok) return { fit: null, poured: null }

  const source = pourThrough(shape, fitted, outlineToPath(values.nodes as never))
  return {
    fit: pathBounds(fitted.path),
    poured: source ? pathBounds(frameAt(shape, source, 0).path) : null,
  }
}

describe('padding survives being poured', () => {
  it('insets the poured type by the same amount as the fit', () => {
    setPadding(40)
    const { fit, poured } = bothWays()

    expect(fit, 'the fit itself honours it').toMatchObject({ x: -110, y: -60 })
    expect(poured!.x, 'and so does the pour').toBeCloseTo(fit!.x, 0)
    expect(poured!.y).toBeCloseTo(fit!.y, 0)
    expect(poured!.width).toBeCloseTo(fit!.width, 0)
  })

  it('reaches the full shape when there is no padding', () => {
    setPadding(0)
    const { poured } = bothWays()
    expect(poured!.x).toBeCloseTo(-150, 0)
    expect(poured!.width).toBeCloseTo(300, 0)
  })

  it('tracks a change, so the slider does something at every step', () => {
    const widths: number[] = []
    for (const padding of [0, 20, 40, 60]) {
      setPadding(padding)
      widths.push(bothWays().poured!.width)
    }
    // Each step is narrower than the last, by twice the padding step.
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!, `padding step ${i}`).toBeLessThan(widths[i - 1]!)
    }
    expect(widths[0]! - widths[3]!).toBeCloseTo(120, 0)
  })

  it('falls back to the outline when the STATE’s shape is too small to pad', () => {
    /*
     * The fit refuses outright when padding collapses the member's own shape —
     * "Not enough space for text", with a warning. But a state may reshape it
     * SMALLER than the member, so a padding the fit accepted can collapse the
     * outline being poured through. Drawing it unpadded is the right way out;
     * returning nothing would blank the type part-way through a morph.
     */
    setPadding(80)
    const member = frameIn().members[0]!
    const values = valuesFor(member, frameIn().states[0])
    const shape = withTypeSettings(member.object, values.typeSettings)
    if (shape.kind !== 'typography') throw new Error('expected a shape')

    const fitted = fitObject(shape)
    expect(fitted.ok, 'the member’s own shape has room for it').toBe(true)

    // A much smaller container, which 80 units of padding cannot inset.
    const tiny = 'M -50 -30 L 50 -30 L 50 30 L -50 30 Z'
    const source = pourThrough(shape, fitted, tiny)
    expect(source, 'still pours, unpadded, rather than vanishing').not.toBeNull()
    expect(pathBounds(frameAt(shape, source!, 0).path).width).toBeGreaterThan(0)
  })
})

describe('padding across two states', () => {
  it('interpolates, where the rest of the type settings cut', () => {
    /*
     * Padding is the one field of that group which is a REGION rather than a
     * layout. It insets the container the type is poured into, which is the same
     * kind of change as reshaping the outline — so it animates the same way, and
     * no word changes row while it does.
     */
    setPadding(0)
    const member = frameIn().members[0]!
    const second = valuesFor(member, frameIn().states[1]).typeSettings
    store().setMemberValues(frame, 1, member.id, {
      typeSettings: { ...second, typography: { ...second?.typography, padding: 60 } as never },
    })

    const object = frameIn()
    const at = (t: number) =>
      blendValues(object.members[0]!, object.states[0], object.states[1], t).padding

    expect(at(0)).toBeCloseTo(0, 6)
    expect(at(0.5), 'half way, not held at either end').toBeCloseTo(30, 6)
    expect(at(1)).toBeCloseTo(60, 6)
  })

  it('leaves the LAYOUT on the departing state, so line breaks hold still', () => {
    // The fit is solved with the state's own padding; only the drawing
    // interpolates. Re-fitting per frame is what would move the breaks.
    setPadding(0)
    const member = frameIn().members[0]!
    const second = valuesFor(member, frameIn().states[1]).typeSettings
    store().setMemberValues(frame, 1, member.id, {
      typeSettings: { ...second, typography: { ...second?.typography, padding: 60 } as never },
    })

    const object = frameIn()
    const mid = blendValues(object.members[0]!, object.states[0], object.states[1], 0.5)
    expect(mid.typeSettings?.typography?.padding, 'the fit still sees the departing value').toBe(0)
    expect(mid.padding, 'while the drawing sees the blend').toBeCloseTo(30, 6)
  })

  it('shows the blended inset on the canvas, not the fit’s own', () => {
    setPadding(0)
    const member = frameIn().members[0]!
    const values = valuesFor(member, frameIn().states[0])
    const shape = withTypeSettings(member.object, values.typeSettings)
    if (shape.kind !== 'typography') throw new Error('expected a shape')
    const fitted = fitObject(shape)
    expect(fitted.ok).toBe(true)

    // The same fit, poured through the same outline at two different insets.
    const wide = pourThrough(shape, fitted, outlineToPath(values.nodes as never))
    const tight = pourThrough(
      { ...shape, typography: { ...shape.typography, padding: 50 } },
      fitted,
      outlineToPath(values.nodes as never),
    )
    const a = pathBounds(frameAt(shape, wide!, 0).path)
    const b = pathBounds(frameAt(shape, tight!, 0).path)
    expect(b.width, 'the inset one is narrower').toBeLessThan(a.width - 80)
  })
})
