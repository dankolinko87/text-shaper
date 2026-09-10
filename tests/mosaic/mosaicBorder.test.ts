import { describe, expect, it } from 'vitest'

import { initialState, sameGeometry, seedMosaic } from '../../src/mosaic/dissection'
import { evaluateMosaicAtTime } from '../../src/mosaic/timeline'
import { alphaOf } from '../../src/typography/colour'
import type { LetterMosaicObject, PositionedStroke, Rect } from '../../src/types/document'
import type { MosaicState } from '../../src/types/mosaic'

/**
 * The mosaic's own edge, drawn on its silhouette.
 *
 * One per state, interpolated like the backdrop it sits beside — and always
 * inside the outline, because the group is clipped to itself.
 */

const BOX: Rect = { x: -150, y: -150, width: 300, height: 300 }
const base = seedMosaic(3, 3)

const stateFrom = (over: Partial<MosaicState> = {}): MosaicState => ({
  ...initialState(base.x, base.y, { fontId: 'anton', weight: 400, italic: false }),
  ...over,
})

const mosaicWith = (states: MosaicState[]): LetterMosaicObject =>
  ({
    kind: 'mosaic',
    id: 'm1',
    name: 'Mosaic',
    localBounds: BOX,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    tiles: base.tiles,
    seed: { columns: 3, rows: 3 },
    font: { fontId: 'anton', weight: 400 },
    states,
    gap: 6,
    outerPadding: 0,
    glyphInset: 6,
    snapStep: 10,
    loop: true,
    speed: 1,
    opacity: 1,
    visible: true,
    locked: false,
  }) as LetterMosaicObject

const RED: PositionedStroke = { colour: '#ff0000ff', width: 4, position: 'inside', dash: null }

describe('a new mosaic', () => {
  it('has no border, which is not the same as one of no width', () => {
    expect(stateFrom().stroke).toBeNull()
  })
})

describe('two states, one with a border', () => {
  it('are not copies of each other', () => {
    /*
     * The same reason the corners and the backdrop count: it SHOWS. A state
     * given an edge of its own has been authored, so an edit carrying forward
     * must stop at it and deleting it must think to ask.
     */
    const plain = stateFrom()
    const edged = stateFrom({ stroke: RED })

    expect(sameGeometry(plain, plain)).toBe(true)
    expect(sameGeometry(plain, edged)).toBe(false)
    expect(sameGeometry(edged, stateFrom({ stroke: { ...RED, width: 5 } }))).toBe(false)
  })
})

describe('the border through a transition', () => {
  const timing = { holdMs: 0, transitionMs: 1000, easing: 'linear' as const }

  it('carries the colour and the width together', () => {
    const mosaic = mosaicWith([
      stateFrom({ ...timing, stroke: { colour: '#ff0000ff', width: 4, position: 'inside', dash: null } }),
      stateFrom({ ...timing, stroke: { colour: '#0000ffff', width: 12, position: 'inside', dash: null } }),
    ])
    expect(evaluateMosaicAtTime(mosaic, 0).stroke?.width).toBe(4)
    expect(evaluateMosaicAtTime(mosaic, 500).stroke?.width).toBe(8)
  })

  it('fades a border in rather than popping it on at full weight', () => {
    const mosaic = mosaicWith([
      stateFrom({ ...timing, stroke: null }),
      stateFrom({ ...timing, stroke: RED }),
    ])
    /*
     * A hold of zero is stepped over, so t=0 is already the first frame of the
     * transition rather than a rest on the state with no border — and the fade
     * is visible from there: the width it will settle at, at no opacity yet.
     */
    const start = evaluateMosaicAtTime(mosaic, 0).stroke
    const quarter = evaluateMosaicAtTime(mosaic, 250).stroke

    expect(start?.width, 'already the width it will settle at').toBe(4)
    expect(alphaOf(start!.colour), 'and none of the opacity').toBeCloseTo(0, 2)
    expect(quarter?.width).toBe(4)
    expect(alphaOf(quarter!.colour), 'a quarter of the way in').toBeCloseTo(0.25, 1)
  })

  it('rests on exactly what each state authored', () => {
    const mosaic = mosaicWith([
      stateFrom({ holdMs: 400, transitionMs: 200, easing: 'linear', stroke: RED }),
      stateFrom({ holdMs: 400, transitionMs: 200, easing: 'linear', stroke: null }),
    ])
    expect(evaluateMosaicAtTime(mosaic, 100).stroke?.width).toBe(4)
    expect(evaluateMosaicAtTime(mosaic, 100).stroke?.colour).toBe(RED.colour)
    // Its own hold, after the transition into it.
    expect(evaluateMosaicAtTime(mosaic, 800).stroke).toBeNull()
  })
})
