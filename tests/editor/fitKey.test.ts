import { describe, expect, it } from 'vitest'

import { fitKey } from '../../src/editor/fitKey'
import { documentDefaults } from '../../src/state/defaults'
import type { TypographyObject } from '../../src/types/document'

/**
 * What makes the canvas re-solve a shape.
 *
 * The editor caches a fitted path per object and re-uses it whenever this key is
 * unchanged, so a setting missing from the key is a setting the canvas ignores.
 * That failure is invisible from the inside — the document updates, undo works,
 * the panel moves — and from the outside it looks exactly like a control that
 * was never wired up. `splitAngle` shipped that way.
 *
 * So the test is written over the settings groups rather than over a list of
 * fields: every property of every group must reach the key, whatever anyone adds
 * next.
 */

const SHAPE = 'M0 0L100 0L100 100L0 100Z'

function object(): TypographyObject {
  const d = documentDefaults
  return {
    kind: 'typography',
    id: 'o1',
    name: 'test',
    originalSourcePath: SHAPE,
    currentSourcePath: SHAPE,
    simplifiedRenderPath: SHAPE,
    insetPath: SHAPE,
    localBounds: { x: 0, y: 0, width: 100, height: 100 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
    text: 'HELLO',
    font: { ...d.font },
    textFlowMode: 'word',
    typography: { ...d.typography },
    fittingMode: 'ring',
    run: { ...d.run },
    dividers: [],
    appearance: { textFill: '#111', containerFill: '#eee', lineFill: null, opacity: 1 },
    animation: { ...d.animation },
    distortion: { ...d.distortion },
    seed: 5,
    visible: true,
    locked: false,
    geometryRevision: 1,
  } as unknown as TypographyObject
}

/** A different value of the same type, so the change is real and comparable. */
function nudge(value: unknown): unknown {
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (typeof value === 'string') return `${value}-changed`
  return value
}

describe('what makes a shape refit', () => {
  const groups = ['run', 'typography', 'distortion', 'font'] as const

  for (const group of groups) {
    it(`notices every ${group} setting`, () => {
      const base = object()
      const before = fitKey(base, true)
      const settings = base[group] as unknown as Record<string, unknown>

      const keys = Object.keys(settings)
      expect(keys.length, `${group} has no settings`).toBeGreaterThan(0)

      for (const key of keys) {
        const changed = {
          ...base,
          [group]: { ...settings, [key]: nudge(settings[key]) },
        } as TypographyObject
        expect(fitKey(changed, true), `${group}.${key} does not reach the key`).not.toBe(before)
      }
    })
  }

  it('notices the things that are not settings groups', () => {
    const base = object()
    const before = fitKey(base, true)

    const changes: Array<[string, Partial<TypographyObject>]> = [
      ['text', { text: 'GOODBYE' }],
      ['textFlowMode', { textFlowMode: 'character' }],
      ['fittingMode', { fittingMode: 'path' }],
      ['seed', { seed: 6 }],
      ['geometryRevision', { geometryRevision: 2 }],
      ['outline', { currentSourcePath: `${SHAPE}M1 1L2 2Z` }],
      [
        'banner',
        { appearance: { ...base.appearance, lineFill: '#fc0' } },
      ],
      [
        'dividers',
        { dividers: [{ id: 'd', axis: 'row', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }] },
      ],
    ] as Array<[string, Partial<TypographyObject>]>

    for (const [label, patch] of changes) {
      expect(fitKey({ ...base, ...patch } as TypographyObject, true), label).not.toBe(before)
    }

    // And the font arriving, which changes an empty path into a real one.
    expect(fitKey(base, false)).not.toBe(before)
  })

  it('leaves the key alone for things the fit does not read', () => {
    // Paint and placement are applied to a solved path; re-solving for them
    // would throw away the cache on every colour tweak and every drag.
    const base = object()
    const before = fitKey(base, true)

    const same: Array<[string, Partial<TypographyObject>]> = [
      ['text colour', { appearance: { ...base.appearance, textFill: '#abcdef' } }],
      ['shape colour', { appearance: { ...base.appearance, containerFill: '#abcdef' } }],
      ['opacity', { appearance: { ...base.appearance, opacity: 0.4 } }],
      ['position', { transform: { ...base.transform, x: 400, y: 90 } }],
      ['name', { name: 'renamed' }],
      ['animation', { animation: { ...base.animation, preset: 'wave' } }],
    ] as Array<[string, Partial<TypographyObject>]>

    for (const [label, patch] of same) {
      expect(fitKey({ ...base, ...patch } as TypographyObject, true), label).toBe(before)
    }
  })
})
