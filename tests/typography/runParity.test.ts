import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { documentDefaults } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'

/**
 * The artwork, pinned.
 *
 * A ring and a spiral were the same fit written twice, and merging them into one
 * is a refactor: the drawings must come out of the merged engine byte for byte
 * as they came out of the two. Nothing else in the suite can say that. The other
 * tests are written against BEHAVIOUR — the text fits, the letters do not cross,
 * the band tracks the ink — and a merge that quietly shifted every glyph by a
 * unit would satisfy all of them.
 *
 * So the paths are hashed and the hashes committed. Regenerate with
 * `PARITY=record npx vitest run runParity`, and only ever when the artwork is
 * MEANT to change — a diff here with no intended visual change is the bug this
 * file exists to catch.
 */

const FIXTURE = fileURLToPath(new URL('./runParity.fixture.json', import.meta.url))
const RECORD = process.env['PARITY'] === 'record'

const ELLIPSE = PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600)
const RECTANGLE = PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600)
const BLOB = smoothPath(
  'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
)

const SHORT = 'RONESHA IS THE VERY BEST'
const LONG =
  'The Easter Bunny goes like hop! hop! hop! and then he stops to think about ' +
  'whether a carrot is really the best thing to eat before a long day of hiding ' +
  'eggs in the tall wet grass, and decides that it very probably is.'

beforeAll(async () => {
  await initClipper()
  const path = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const bytes = readFileSync(path)
  registerFont(
    'anton',
    opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  )
})

afterEach(() => {
  resetPaperScope()
})

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

/**
 * `mode` names the CASE, not the fitting mode.
 *
 * A lap and a spiral are one mode now, told apart by `turns` — which is the
 * change this file exists to police. The keys keep the old names so a diff
 * against the recorded fixture still reads as "the spiral moved".
 */
function draw(mode: 'ring' | 'spiral', shape: string, text: string, extra: Record<string, unknown>) {
  const result = fitTextToShape({
    text,
    shapePath: shape,
    fontId: 'anton',
    flowMode: 'word',
    lineSpacing: documentDefaults.typography.lineSpacing,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'ring',
    turns: mode === 'spiral' ? 'many' : 'one',
    distortion: { ...documentDefaults.distortion },
    seed: 5,
    ...extra,
  } as Parameters<typeof fitTextToShape>[0])
  if (!result.ok) return { ok: false as const, reason: result.reason }
  return {
    ok: true as const,
    size: Math.round(result.lines[0]!.size * 1000) / 1000,
    lines: result.lineCount,
    path: digest(result.path),
    band: result.band ? digest(result.band) : null,
  }
}

/** Every combination that has its own arithmetic, at both letter settings. */
function everyCase(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const shapes = [
    ['ellipse', ELLIPSE],
    ['rectangle', RECTANGLE],
    ['blob', BLOB],
  ] as const

  for (const [name, shape] of shapes) {
    for (const rigid of [false, true]) {
      const letters = rigid ? 'set' : 'wrap'
      for (const text of [SHORT, LONG]) {
        const length = text === SHORT ? 'short' : 'long'
        out[`spiral/${name}/${letters}/${length}`] = draw('spiral', shape, text, { rigid })
        out[`ring/${name}/${letters}/${length}`] = draw('ring', shape, text, { rigid })
      }
    }
  }

  // The settings that change the sums rather than just the inputs.
  out['spiral/hole'] = draw('spiral', ELLIPSE, LONG, { centreHole: 0.4 })
  out['spiral/outward'] = draw('spiral', ELLIPSE, LONG, { outward: true })
  out['spiral/upright'] = draw('spiral', ELLIPSE, SHORT, { upright: true })
  out['spiral/banner'] = draw('spiral', ELLIPSE, LONG, { band: true, lineHeight: 1.8 })
  out['spiral/thin'] = draw('spiral', ELLIPSE, LONG, { band: true, lineHeight: 0.3 })
  out['ring/outside'] = draw('ring', ELLIPSE, SHORT, { side: -1 })
  out['ring/centred'] = draw('ring', ELLIPSE, SHORT, { side: 0 })
  out['ring/split'] = draw('ring', ELLIPSE, SHORT, { split: true, gap: 0.13 })
  out['ring/banner'] = draw('ring', ELLIPSE, SHORT, { band: true, lineHeight: 1.8 })
  out['ring/split-banner'] = draw('ring', ELLIPSE, SHORT, { band: true, split: true, gap: 0.13 })
  out['ring/upright'] = draw('ring', ELLIPSE, SHORT, { upright: true })
  out['ring/shift'] = draw('ring', ELLIPSE, SHORT, { baselineShift: -0.3 })
  return out
}

describe('the artwork a run mode draws', () => {
  it('comes out exactly as it was recorded', () => {
    const current = everyCase()

    if (RECORD || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`)
      expect(RECORD, 'fixture written — rerun without PARITY=record').toBe(true)
      return
    }

    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
    // Compared key by key: a whole-object diff on 30 cases is unreadable, and
    // which case moved is the first thing worth knowing.
    expect(Object.keys(current).sort()).toEqual(Object.keys(recorded).sort())
    for (const key of Object.keys(recorded)) {
      expect(current[key], key).toEqual(recorded[key])
    }
  })
})
