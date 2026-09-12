import { describe, expect, it } from 'vitest'

import { frameMoves } from '../../src/editor/animationPlayback'
import {
  blendAppearance,
  blendValues,
  sameArrangement,
  valuesFor,
} from '../../src/frame/frame'
import { DEFAULT_STROKE } from '../../src/geometry/stroke'
import { alphaOf, parseHex } from '../../src/typography/colour'
import type { AppearanceSettings, FrameObject } from '../../src/types/document'
import type { FrameMember, FrameState } from '../../src/types/frame'

/**
 * How a member LOOKS across a frame's states.
 *
 * The tier this belongs to is "tweened": every field here is blended each frame
 * and nothing is re-solved. What makes it worth its own file is the two fields
 * that are only PARTLY tweenable — a fill that may be nothing at either end, and
 * a border whose dash rhythm and position have no in-between.
 */

const APPEARANCE = (patch: Partial<AppearanceSettings> = {}): AppearanceSettings => ({
  textFill: '#101014',
  containerFill: '#dcdcd8',
  lineFill: null,
  containerStroke: null,
  opacity: 1,
  ...patch,
})

const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }

const memberWith = (appearance: AppearanceSettings): FrameMember =>
  ({
    id: 'm1',
    object: { kind: 'typography', id: 'o1', transform, appearance },
  }) as unknown as FrameMember

const stateWith = (values: FrameState['values']): FrameState => ({
  id: `s${Math.random()}`,
  values,
  holdMs: 0,
  transitionMs: 600,
  easing: 'ease-in-out',
})

describe('what a state says about how a member looks', () => {
  it('falls back to the member’s own colours when the state is silent', () => {
    /*
     * The fallback is what makes a colour animation authorable one state at a
     * time: a frame nobody has recoloured mentions appearance nowhere, and every
     * state answers with the shape's resting colours.
     */
    const member = memberWith(APPEARANCE({ containerFill: '#00ff00' }))
    expect(valuesFor(member, stateWith({})).appearance?.containerFill).toBe('#00ff00')
  })

  it('prefers the state’s own when it has one', () => {
    const member = memberWith(APPEARANCE({ containerFill: '#00ff00' }))
    const state = stateWith({ m1: { appearance: APPEARANCE({ containerFill: '#ff0000' }) } })
    expect(valuesFor(member, state).appearance?.containerFill).toBe('#ff0000')
  })
})

describe('blending two appearances', () => {
  it('interpolates a plain colour', () => {
    const out = blendAppearance(
      APPEARANCE({ textFill: '#000000' }),
      APPEARANCE({ textFill: '#ffffff' }),
      0.5,
    )
    const [r, g, b] = parseHex(out.textFill as string) as [number, number, number, number]
    for (const channel of [r, g, b]) expect(channel).toBeGreaterThan(100)
    for (const channel of [r, g, b]) expect(channel).toBeLessThan(155)
  })

  it('fades a fill in from NOTHING without going through black', () => {
    /*
     * The rule the mosaic learned and this now shares: a fill nobody has added
     * is not a transparent black one. Blend towards black and the fade picks up
     * a dark edge on its way — visible, wrong, and very hard to name once you
     * are looking at it. Only the alpha may move.
     */
    const out = blendAppearance(
      APPEARANCE({ containerFill: null }),
      APPEARANCE({ containerFill: '#ff0000' }),
      0.5,
    )
    const mid = out.containerFill as string
    const [r, g, b] = parseHex(mid) as [number, number, number, number]
    expect(r, 'still the red it is becoming').toBeGreaterThan(200)
    expect(g).toBeLessThan(40)
    expect(b).toBeLessThan(40)
    expect(alphaOf(mid), 'half way in').toBeGreaterThan(0.4)
    expect(alphaOf(mid)).toBeLessThan(0.6)
  })

  it('gives back both ends exactly as authored, null included', () => {
    const a = APPEARANCE({ containerFill: null })
    const b = APPEARANCE({ containerFill: '#ff0000' })
    expect(blendAppearance(a, b, 0).containerFill).toBeNull()
    expect(blendAppearance(a, b, 1).containerFill).toBe('#ff0000')
  })

  it('cuts the border’s position rather than crawling between them', () => {
    // There is nothing between inside and outside for a band to be.
    const inside = { ...DEFAULT_STROKE, position: 'inside' as const, width: 4 }
    const outside = { ...DEFAULT_STROKE, position: 'outside' as const, width: 4 }
    const a = APPEARANCE({ containerStroke: inside })
    const b = APPEARANCE({ containerStroke: outside })

    expect(blendAppearance(a, b, 0.25).containerStroke?.position).toBe('inside')
    expect(blendAppearance(a, b, 0.75).containerStroke?.position).toBe('outside')
  })

  it('interpolates the border’s width, which does have an in-between', () => {
    const a = APPEARANCE({ containerStroke: { ...DEFAULT_STROKE, width: 2 } })
    const b = APPEARANCE({ containerStroke: { ...DEFAULT_STROKE, width: 10 } })
    expect(blendAppearance(a, b, 0.5).containerStroke?.width).toBeCloseTo(6, 6)
  })

  it('blends the member’s values through the state pair', () => {
    const member = memberWith(APPEARANCE({ containerFill: '#000000' }))
    const from = stateWith({ m1: { appearance: APPEARANCE({ containerFill: '#000000' }) } })
    const to = stateWith({ m1: { appearance: APPEARANCE({ containerFill: '#ffffff' }) } })
    const mid = blendValues(member, from, to, 0.5).appearance?.containerFill as string
    expect(mid).not.toBe('#000000')
    expect(mid).not.toBe('#ffffff')
  })
})

describe('an edit that is only a colour', () => {
  const member = memberWith(APPEARANCE())
  const plain = stateWith({ m1: { transform, opacity: 1 } })
  const recoloured = stateWith({
    m1: { transform, opacity: 1, appearance: APPEARANCE({ containerFill: '#ff0000' }) },
  })

  it('counts as a different arrangement, which is what makes it a keyframe', () => {
    // A colour-only difference has to be able to say "there is something to
    // animate here" for itself.
    expect(sameArrangement(plain, recoloured, [member])).toBe(false)
  })

  it('counts a gradient where there was a colour, which is what makes it a keyframe too', () => {
    const blended = stateWith({
      m1: {
        transform,
        opacity: 1,
        appearance: APPEARANCE({
          containerFill: {
            kind: 'gradient',
            shape: 'linear',
            stops: [
              { at: 0, colour: '#dcdcd8' },
              { at: 1, colour: '#ff0000' },
            ],
            angle: 0,
          },
        }),
      },
    })
    expect(sameArrangement(plain, blended, [member])).toBe(false)
    expect(sameArrangement(blended, blended, [member])).toBe(true)
  })

  it('is enough to make the frame worth playing', () => {
    // Without this a colour-only animation would blend perfectly and never run,
    // because the transport only appears for a frame that has something to play.
    const frame = {
      kind: 'frame',
      members: [member],
      states: [plain, recoloured],
    } as unknown as FrameObject
    expect(frameMoves(frame)).toBe(true)
  })

  it('is not invented out of two states that merely look alike', () => {
    const frame = {
      kind: 'frame',
      members: [member],
      states: [plain, stateWith({ m1: { transform, opacity: 1 } })],
    } as unknown as FrameObject
    expect(frameMoves(frame)).toBe(false)
  })
})

describe('a state that changes one colour', () => {
  it('records that colour and follows the member for the other four', () => {
    const member = memberWith(APPEARANCE({ containerFill: '#00ff00', textFill: '#123456' }))
    const state = stateWith({ m1: { appearance: { containerFill: '#ff0000' } } })
    const got = valuesFor(member, state).appearance!
    expect(got.containerFill).toBe('#ff0000')
    expect(got.textFill).toBe('#123456')
    expect(got.containerStroke).toBeNull()
  })

  it('sees a later change to the member in the fields it did not touch', () => {
    // What "following the member" means: recolour the shape itself and every
    // state that said nothing about that colour shows the new one.
    const state = stateWith({ m1: { appearance: { containerFill: '#ff0000' } } })
    const later = memberWith(APPEARANCE({ textFill: '#abcdef' }))
    expect(valuesFor(later, state).appearance?.textFill).toBe('#abcdef')
    expect(valuesFor(later, state).appearance?.containerFill).toBe('#ff0000')
  })
})
