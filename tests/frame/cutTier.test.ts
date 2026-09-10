import { describe, expect, it } from 'vitest'

import { frameMoves } from '../../src/editor/animationPlayback'
import {
  blendValues,
  sameArrangement,
  sameTypeSettings,
  valuesFor,
  withTypeSettings,
} from '../../src/frame/frame'
import type { FrameObject, TypographyObject } from '../../src/types/document'
import type { FrameMember, FrameState, MemberTypeSettings } from '../../src/types/frame'

/**
 * The settings that CUT rather than tween.
 *
 * What every one of them has in common is that it changes the LAYOUT — which
 * word lands on which row, how big it is, how far apart the letters sit — and a
 * layout has no in-between. Blend a font size and the line breaks move while the
 * transition runs, so words hop between rows mid-move; blend the text itself and
 * there is nothing between two sentences to show.
 *
 * So they snap on ARRIVAL, and the state being left keeps its value for the
 * whole transition. That is a different rule from the flips, which cut at the
 * halfway mark — either end is equally right for a mirror, whereas a page of
 * type re-flowing mid-move reads as a glitch rather than a decision.
 */

const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false }

const TYPOGRAPHY = { lineSpacing: 1.14, letterSpacing: 0, padding: 0 }
const RUN = { fontSize: 40, turns: 'one' as const, side: 0, outward: false, centreHole: 0, split: false, splitAngle: 0, gap: 0, lineHeight: 1, rigid: false, upright: false, baselineShift: 0 }
const FONT = { fontId: 'anton', weight: 400, italic: false }

const SETTINGS = (patch: Partial<MemberTypeSettings> = {}): MemberTypeSettings => ({
  text: 'HOT',
  font: FONT,
  fittingMode: 'boundary-warp',
  textFlowMode: 'word',
  typography: TYPOGRAPHY,
  run: RUN,
  ...patch,
}) as MemberTypeSettings

const member = (): FrameMember =>
  ({
    id: 'm1',
    object: {
      kind: 'typography',
      id: 'o1',
      transform,
      text: 'HOT',
      font: FONT,
      fittingMode: 'boundary-warp',
      textFlowMode: 'word',
      typography: TYPOGRAPHY,
      run: RUN,
      appearance: { textFill: '#000', containerFill: null, lineFill: null, containerStroke: null, opacity: 1 },
    },
  }) as unknown as FrameMember

const stateWith = (values: FrameState['values']): FrameState => ({
  id: `s${Math.random()}`,
  values,
  holdMs: 0,
  transitionMs: 600,
  easing: 'ease-in-out',
})

describe('what a state says about a member’s type', () => {
  it('falls back to the member’s own when the state is silent', () => {
    const values = valuesFor(member(), stateWith({}))
    expect(values.typeSettings?.text).toBe('HOT')
    expect(values.typeSettings?.run?.fontSize).toBe(40)
  })

  it('prefers the state’s own when it has one', () => {
    const state = stateWith({ m1: { typeSettings: SETTINGS({ text: 'BYE' }) } })
    expect(valuesFor(member(), state).typeSettings?.text).toBe('BYE')
  })
})

describe('applying a state’s settings to a shape', () => {
  it('replaces only what the state mentions', () => {
    const object = member().object as TypographyObject
    const out = withTypeSettings(object, { text: 'BYE' } as MemberTypeSettings)
    expect(out.text).toBe('BYE')
    expect(out.run.fontSize, 'untouched').toBe(40)
    expect(out.font.fontId).toBe('anton')
  })

  it('leaves a shape alone when the state says nothing', () => {
    const object = member().object as TypographyObject
    expect(withTypeSettings(object, undefined)).toBe(object)
  })

  it('does not reshape — the outline is not part of this tier', () => {
    /*
     * The one field deliberately excluded. A reshaped state pours the same
     * layout through a different container; re-fitting to it would move the
     * line breaks, which is exactly what a morph must not do.
     */
    const object = member().object as TypographyObject
    const out = withTypeSettings(object, SETTINGS({ text: 'BYE' }))
    expect(out.currentSourcePath).toBe(object.currentSourcePath)
  })
})

describe('crossing between two states', () => {
  const from = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS({ text: 'HOT' }) } })
  const to = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS({ text: 'BYE' }) } })

  it('holds the DEPARTING text for the whole transition', () => {
    for (const t of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      expect(blendValues(member(), from, to, t).typeSettings?.text, `at ${t}`).toBe('HOT')
    }
  })

  it('changes on arrival, not half way', () => {
    expect(blendValues(member(), from, to, 1).typeSettings?.text).toBe('BYE')
  })

  it('does the same for a size, which is why it cannot tween', () => {
    const small = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS({ run: { ...RUN, fontSize: 20 } }) } })
    const big = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS({ run: { ...RUN, fontSize: 90 } }) } })
    expect(blendValues(member(), small, big, 0.5).typeSettings?.run?.fontSize).toBe(20)
    expect(blendValues(member(), small, big, 1).typeSettings?.run?.fontSize).toBe(90)
  })
})

describe('telling two sets of settings apart', () => {
  it('sees the text, the size and the spacing', () => {
    expect(sameTypeSettings(SETTINGS(), SETTINGS())).toBe(true)
    expect(sameTypeSettings(SETTINGS(), SETTINGS({ text: 'BYE' }))).toBe(false)
    expect(sameTypeSettings(SETTINGS(), SETTINGS({ run: { ...RUN, fontSize: 41 } }))).toBe(false)
    expect(
      sameTypeSettings(SETTINGS(), SETTINGS({ typography: { ...TYPOGRAPHY, letterSpacing: 0.1 } })),
    ).toBe(false)
  })

  it('sees a run field nobody wrote a comparison for', () => {
    /*
     * Compared key-wise rather than field by field, so a setting added later is
     * covered the day it is added. A hand-written list is a second place that
     * has to learn about it, and the failure when it does not is silent.
     */
    expect(sameTypeSettings(SETTINGS(), SETTINGS({ run: { ...RUN, baselineShift: 3 } }))).toBe(false)
    expect(sameTypeSettings(SETTINGS(), SETTINGS({ run: { ...RUN, upright: true } }))).toBe(false)
  })

  it('compares by value, not by identity', () => {
    // A patch is a fresh object every time one is written, so identity would
    // call every state different and carry-forward would stop immediately.
    expect(sameTypeSettings(SETTINGS(), { ...SETTINGS() })).toBe(true)
  })
})

describe('a state that only changes the text', () => {
  const plain = stateWith({ m1: { transform, opacity: 1 } })
  const retyped = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS({ text: 'BYE' }) } })

  it('counts as a different arrangement, so the frame has something to play', () => {
    expect(sameArrangement(plain, retyped, [member()])).toBe(false)
  })

  it('is enough to make the frame worth playing', () => {
    const frame = { kind: 'frame', members: [member()], states: [plain, retyped] } as unknown as FrameObject
    expect(frameMoves(frame)).toBe(true)
  })

  it('is not invented out of two states that say the same thing', () => {
    const same = stateWith({ m1: { transform, opacity: 1, typeSettings: SETTINGS() } })
    const frame = { kind: 'frame', members: [member()], states: [plain, same] } as unknown as FrameObject
    expect(frameMoves(frame), 'the patch spells out what the member already was').toBe(false)
  })
})

describe('a state that changes one type setting', () => {
  it('keeps every other setting the member has, padding included', () => {
    /*
     * The patch is two levels deep. A state that says `{ text }` has said
     * nothing about the font or the typography, and the padding — the one
     * setting of this group that tweens — is read off the MERGED settings. A
     * whole-object fallback answered 0 here while the drawn object kept the
     * member's real inset, and the two disagreed about where the type sat.
     */
    const m = member()
    ;(m.object as unknown as { typography: typeof TYPOGRAPHY }).typography = {
      ...TYPOGRAPHY,
      padding: 12,
    }
    const state = stateWith({ m1: { typeSettings: { text: 'BYE' } } })
    const got = valuesFor(m, state)
    expect(got.typeSettings?.text).toBe('BYE')
    expect(got.typeSettings?.font).toEqual(FONT)
    expect(got.typeSettings?.fittingMode).toBe('boundary-warp')
    expect(got.padding, 'read off the merged settings, not off a partial patch').toBe(12)
  })
})
