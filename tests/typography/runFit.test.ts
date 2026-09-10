import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import opentype from 'opentype.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { initClipper } from '../../src/geometry/clipper'
import { resetPaperScope } from '../../src/geometry/paperContext'
import { pathBounds, smoothPath } from '../../src/geometry/path'
import { PRIMITIVES } from '../../src/geometry/primitives'
import { documentDefaults } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { registerFont } from '../../src/typography/fontRegistry'
import { MAX_STRETCH } from '../../src/typography/runFit'
import { runHeadings } from '../../src/geometry/run'
import { measureUnitWidth } from '../../src/typography/fontRegistry'
const FONT_ID = 'anton'
import { animationById, defaultConfig } from '../../src/typography/animation'
import { renderBandFrame, renderFrame } from '../../src/typography/frame'
import { HEADING_CHORD } from '../../src/typography/runWarp'

/**
 * How wide the letters come out, everywhere.
 *
 * The one thing that has broken this mode over and over, and it broke silently:
 * every other test asks whether the text fits, whether it is all there, whether
 * the band tracks it — and a line of letters stretched to two and a half times
 * their designed width satisfies all of them. It has to be measured directly.
 */

const SHAPES = {
  ellipse: PRIMITIVES.find((p) => p.id === 'ellipse')!.build(680, 600),
  rectangle: PRIMITIVES.find((p) => p.id === 'rectangle')!.build(680, 600),
  triangle: PRIMITIVES.find((p) => p.id === 'triangle')!.build(680, 600),
  blob: smoothPath(
    'M-320 -170L-180 -290L40 -300L230 -210L320 -30L280 160L120 300L-90 310L-270 210L-330 40Z',
  ),
}

const TEXTS = {
  // Two words on a big shape is the case that stretches hardest.
  tiny: 'GO',
  short: 'RONESHA IS THE VERY BEST',
  long:
    'The Easter Bunny goes like hop! hop! hop! and then he stops to think about ' +
    'whether a carrot is really the best thing to eat before a long day of hiding ' +
    'eggs in the tall wet grass, and decides that it very probably is.',
}

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

function fit(
  shapePath: string,
  text: string,
  turns: 'one' | 'many',
  rigid: boolean,
  lineSpacing: number,
  extra: Record<string, unknown> = {},
) {
  return fitTextToShape({
    text,
    shapePath,
    fontId: 'anton',
    flowMode: 'word',
    lineSpacing,
    letterSpacing: 0,
    quality: 'final',
    fittingMode: 'ring',
    turns,
    rigid,
    distortion: { ...documentDefaults.distortion },
    seed: 5,
    ...extra,
  } as Parameters<typeof fitTextToShape>[0])
}

/**
 * How wide the drawn letters are against how they were designed.
 *
 * `scaleX / scaleY` and nothing else: the packer gives every character its own
 * pair, and their ratio IS how far the letterform has been pulled out of shape.
 * A value of 1 is the face as drawn.
 */
function stretch(result: ReturnType<typeof fit>): number {
  if (!result.ok) return 1
  const slot = result.layout!.lines[0]!.slots.find((s) => !s.blank)
  return slot ? slot.scaleX / slot.scaleY : 1
}

describe('how far a run may stretch its letters', () => {
  it('never pulls a letter past the ceiling, on any shape at any setting', () => {
    /*
     * 192 combinations, because the failure was never in one of them. It came
     * from the type size being decided by the SHAPE rather than by the text —
     * a spiral that could not wind twice at a larger size, a centre hole that
     * left room for only the smallest type — and then the packer filling a run
     * far longer than the words with whatever it had. On the drawn blob that
     * reached 1.9 times the designed width, on an ellipse 2.4, and with a hole
     * of 80% it reached 6.6.
     */
    let worst = 0
    let worstAt = ''
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      for (const [textName, text] of Object.entries(TEXTS)) {
        for (const turns of ['one', 'many'] as const) {
          // Every line spacing the slider offers, because the pitch decides how
          // long the run comes out and the run is what gets filled.
          for (const spacing of [0.5, 1.14, 4]) {
            for (const hole of [0, 0.4, 0.8]) {
              const result = fit(shape, text, turns, false, spacing, { centreHole: hole })
              const wide = stretch(result)
              if (wide > worst) {
                worst = wide
                worstAt = `${shapeName}/${textName}/${turns}/spacing ${spacing}/hole ${hole}`
              }
            }
          }
        }
      }
    }
    expect(worst, `worst at ${worstAt}`).toBeLessThanOrEqual(MAX_STRETCH + 1e-9)
    // And it does reach the ceiling somewhere, or the bound is not being tested.
    expect(worst).toBeGreaterThan(MAX_STRETCH * 0.9)
    // 216 fits, and each one winds a spiral. Worth the seconds: this is the
    // failure that has come back three times, and only breadth catches it.
  }, 30_000)

  it('leaves set letters at exactly their drawn proportions', () => {
    // The other half of the same guarantee. Set letters are never stretched at
    // all — the run decides only where they sit and which way they face.
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      for (const [textName, text] of Object.entries(TEXTS)) {
        for (const turns of ['one', 'many'] as const) {
          const result = fit(shape, text, turns, true, 1.14)
          if (!result.ok) continue
          expect(stretch(result), `${shapeName}/${textName}/${turns}`).toBeCloseTo(1, 6)
        }
      }
    }
  }, 30_000)

  it('sets the type at the size it is given, and covers less of the run for it', () => {
    /*
     * A real size in the object's own units, not a share of anything. Its
     * ceiling is the largest the words actually fit at, which the fit reports so
     * a control can offer that range and no more.
     *
     * What the words give up going smaller is REACH along the run, not shape:
     * the run they do not cover is simply not drawn.
     */
    for (const turns of ['one', 'many'] as const) {
      const auto = fit(SHAPES.ellipse, TEXTS.short, turns, true, 1.14)
      expect(auto.ok, turns).toBe(true)
      if (!auto.ok) continue

      const ceiling = auto.autoSize!
      expect(ceiling, turns).toBeCloseTo(auto.lines[0]!.size, 6)

      const half = fit(SHAPES.ellipse, TEXTS.short, turns, true, 1.14, {
        fontSize: ceiling / 2,
      })
      expect(half.ok, turns).toBe(true)
      if (!half.ok) continue

      // Exactly the size asked for, and still the letters as drawn.
      expect(half.lines[0]!.size, turns).toBeCloseTo(ceiling / 2, 6)
      expect(stretch(half), turns).toBeCloseTo(1, 6)

      const covered = (r: typeof auto): number => {
        if (!r.ok) return 0
        const line = r.layout!.lines[0]!
        const slots = line.slots
        return (slots[slots.length - 1]!.x - slots[0]!.x) / line.run!.run.total
      }
      expect(covered(half), turns).toBeLessThan(covered(auto))
    }
  }, 30_000)

  it('refuses to go bigger than the shape can hold', () => {
    /*
     * The ceiling is real, and it is not the same in the two modes. A lap
     * SHORTENS as the type grows — the band pushes further inside the outline —
     * and a spiral loses whole turns, because the pitch is the line height and
     * wider letters push the turns apart until there is nothing left to wind
     * into. Measured on this ellipse: 40 units winds four turns, 60 winds two,
     * 67 winds one, and at 90 no spiral exists at all.
     *
     * So asking for more than fits gets what fits, rather than words that spill
     * over themselves or letters that quietly go undrawn.
     */
    for (const turns of ['one', 'many'] as const) {
      const auto = fit(SHAPES.ellipse, TEXTS.short, turns, true, 1.14)
      if (!auto.ok) continue
      const huge = fit(SHAPES.ellipse, TEXTS.short, turns, true, 1.14, { fontSize: 10_000 })
      expect(huge.ok, turns).toBe(true)
      if (!huge.ok) continue
      expect(huge.lines[0]!.size, turns).toBeCloseTo(auto.lines[0]!.size, 6)
      expect(huge.path, turns).toBe(auto.path)
    }
  }, 30_000)

  it('draws exactly the same artwork at full size as with no control at all', () => {
    // The default has to be the old behaviour to the last decimal, or every
    // document anyone has already made shifts the day the control lands.
    for (const [name, shape] of Object.entries(SHAPES)) {
      for (const turns of ['one', 'many'] as const) {
        const bare = fit(shape, TEXTS.short, turns, false, 1.14)
        const asked = fit(shape, TEXTS.short, turns, false, 1.14, { fontSize: 0 })
        expect(bare.ok && asked.ok).toBe(true)
        if (!bare.ok || !asked.ok) continue
        expect(asked.path, `${name}/${turns}`).toBe(bare.path)
      }
    }
  }, 30_000)

  it('follows the run no more sharply than the shape actually turns', () => {
    /*
     * The bug this is here for looked like broken glyphs — a notch bitten out of
     * the top of an O, a chip off the shoulder of a C — and it was not the
     * glyphs at all. It was the run's DIRECTION.
     *
     * These runs come off an integer-grid polygon offsetter. The resampling
     * after it is perfectly even — segment lengths on a measured lap vary by
     * less than a thousandth — but the direction from one sample to the next
     * still kinks. A point sitting ON the run does not care. A point standing
     * OFF it is thrown sideways by the kink times its reach, and the type stands
     * a long way off: on the drawing this was reported from, a kink of 0.06
     * radians at 153 units of reach threw a point nine units out.
     *
     * Measured as how much sharper the worst turn is than the average one, which
     * is scale-free. Sample to sample an ellipse's lap comes out at 3.3 and a
     * drawn blob's at 4.5; across the chord the warp uses, 1.4 and 2.9. A
     * rectangle and a triangle barely move, and should not: their edges are
     * straight, so there is no offsetter roughness to average away, and what
     * turn they have is a corner the shape really has.
     */
    for (const [name, shape] of Object.entries(SHAPES)) {
      const result = fit(shape, TEXTS.short, 'one', false, 1.14)
      expect(result.ok, name).toBe(true)
      if (!result.ok) continue

      const line = result.layout!.lines[0]!
      const run = line.run!.run
      const reach = Math.max(Math.abs(line.bandTop), Math.abs(line.bandBottom))

      /** The sharpest turn between neighbouring headings, and the average one. */
      const turning = (chord: number): { peak: number; even: number } => {
        const headings = runHeadings(run, chord)
        const n = headings.length / 2
        let total = 0
        let peak = 0
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          const cross =
            (headings[i * 2] as number) * (headings[j * 2 + 1] as number) -
            (headings[i * 2 + 1] as number) * (headings[j * 2] as number)
          const dot =
            (headings[i * 2] as number) * (headings[j * 2] as number) +
            (headings[i * 2 + 1] as number) * (headings[j * 2 + 1] as number)
          const turn = Math.abs(Math.atan2(cross, dot))
          total += turn
          peak = Math.max(peak, turn)
        }
        return { peak, even: total / n }
      }

      const raw = turning(0)
      const chord = turning(Math.max(2, reach * HEADING_CHORD))

      // Never rougher than taking it sample to sample.
      expect(chord.peak, `${name} peak`).toBeLessThanOrEqual(raw.peak + 1e-9)

      /*
       * And on a shape whose edges CURVE, markedly smoother — not incidentally
       * so. Named rather than detected: a triangle's headings are rough by the
       * same measure, and that roughness is a corner the shape really has. No
       * statistic told the two apart, and one that appeared to would have been
       * a guess dressed up as a test.
       */
      if (name === 'ellipse' || name === 'blob') {
        expect(raw.peak / chord.peak, `${name} smoothing`).toBeGreaterThan(1.5)
      }
    }
  })

  it('carries the words round a lap and leaves the banner where it is', () => {
    /*
     * The one preset that goes in ONE direction and still closes its loop.
     * Everything else has to come back the way it went, because a run with two
     * ends cannot carry words past them. A lap has none: the words go round and
     * arrive where they began, so a whole number of laps per loop repeats
     * seamlessly.
     *
     * And the banner does not go with them. It is drawn from the run itself
     * rather than from where the words sit, so the words move THROUGH it — which
     * is the whole look, and would be lost if the two travelled together.
     */
    const result = fit(SHAPES.ellipse, TEXTS.short, 'one', false, 1.14, { band: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const layout = result.layout!
    const preset = animationById('travel')
    const config = defaultConfig('travel')
    const frames = [0, 0.25, 0.5, 0.75].map((phase) =>
      renderFrame(layout, preset.frame(config, phase, 0)),
    )

    // It moves, and every quarter of the loop is its own drawing.
    expect(new Set(frames).size, 'travel is not moving the words').toBe(4)
    // And closes: a whole lap on and the words are back where they started.
    expect(renderFrame(layout, preset.frame(config, 1, 0))).toBe(frames[0])

    // The banner is the same path at every point in the loop.
    const banners = [0, 0.25, 0.5, 0.75].map(() => renderBandFrame(layout))
    expect(new Set(banners).size, 'the banner moved with the words').toBe(1)
  })

  it('carries the words along a run with two ends without walking them off it', () => {
    /*
     * A spiral has two ends and the words travel it anyway.
     *
     * They used not to, and the reason was never really about ends: travel was
     * added where the run is READ, and `runAt` clamps past the end, so every
     * point of a letter beyond it landed on the same spot. Carrying the SLOTS
     * instead moves the words a level up, where a letter is still a letter — it
     * is placed whole wherever it fits, and the one letter at a time that would
     * have to straddle the seam is left out rather than smeared.
     *
     * So the property is not "nothing moved", it is "everything that moved is
     * still on the run".
     */
    const result = fit(SHAPES.ellipse, TEXTS.short, 'many', false, 1.14, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const preset = animationById('travel')
    const config = defaultConfig('travel')
    const resting = pathBounds(result.path)

    for (const phase of [0.2, 0.4, 0.6, 0.8]) {
      const moved = renderFrame(result.layout!, preset.frame(config, phase, 0))
      expect(moved, `phase ${phase} did not move the words`).not.toBe(result.path)
      // A letter left straddling the seam would be drawn as a streak from one
      // end of the run to the other, which shows up here as a blown-out box.
      const box = pathBounds(moved)
      expect(box.width, `phase ${phase} width`).toBeLessThan(resting.width * 1.2)
      expect(box.height, `phase ${phase} height`).toBeLessThan(resting.height * 1.2)
    }
  })

  it('still refuses to carry the words round a lap that has been cut open', () => {
    // They would travel out through the banner's opening onto bare shape. This
    // is the one refusal left, and it is about the banner rather than the run.
    const result = fit(SHAPES.ellipse, TEXTS.short, 'one', false, 1.14, {
      split: true,
      gap: 0.13,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const preset = animationById('travel')
    const moved = renderFrame(result.layout!, preset.frame(defaultConfig('travel'), 0.4, 0))
    expect(moved, 'a split lap carried the words through its opening').toBe(result.path)
  })

  it('lays a crossing ribbon down in order, so it covers what it passes', () => {
    /*
     * A run that crosses itself has to be painted like a ribbon: where it passes
     * over its own earlier self the banner covers what is underneath, words and
     * all. Drawn as two whole paths — the banner, then every word on top of it —
     * it cannot, and the first pass's words show through the second pass's
     * banner, which reads as two flat layers rather than one strip.
     *
     * The slices are what make that possible, and two things about them matter:
     * every word appears in exactly one of them, and each slice's banner spans
     * exactly the words it carries. A slice that ended at a letter's START
     * rather than its end left the far half of that letter for the next slice's
     * banner to paint over — letters came out with their tails bitten off, one
     * at every boundary.
     */
    const result = fit(SHAPES.ellipse, TEXTS.short, 'one', true, 1.14, { band: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const ribbon = result.ribbon!
    expect(ribbon.length, 'the ribbon was not cut into slices').toBeGreaterThan(1)

    // Every slice draws something, and every letter is in exactly one of them:
    // the slices together are the same drawing as the whole.
    for (const slice of ribbon) {
      expect(slice.band.length).toBeGreaterThan(0)
      expect(slice.text.length).toBeGreaterThan(0)
    }
    const joined = ribbon.map((s) => s.text).join('')
    expect(joined).toBe(result.path)

    /*
     * And every slice's banner spans the letters it carries, end to end. This is
     * the one that catches the bitten-off tails: a slice cut at a letter's start
     * still draws all the text, so the joined paths above are identical either
     * way — what changes is that the banner stops half a letter short and the
     * next slice's banner paints over the rest.
     */
    const line = result.layout!.lines[0]!
    for (const slice of ribbon) {
      const firstSlot = line.slots[slice.first]!
      const lastSlot = line.slots[slice.last]!
      const advance =
        measureUnitWidth(FONT_ID, line.characters[lastSlot.index] as string) * lastSlot.scaleX
      expect(slice.from, `slice ${slice.first} starts after its first letter`)
        .toBeLessThanOrEqual(firstSlot.x - line.span.x0 + 1e-6)
      expect(slice.to, `slice ${slice.first} ends before its last letter`)
        .toBeGreaterThanOrEqual(lastSlot.x - line.span.x0 + advance - 1e-6)
    }

    // The slices tile the run: each picks up exactly where the last left off.
    for (let i = 1; i < ribbon.length; i++) {
      expect(ribbon[i]!.from).toBeCloseTo(ribbon[i - 1]!.to, 6)
      expect(ribbon[i]!.first).toBe(ribbon[i - 1]!.last + 1)
    }
  })

  it('stretches a lap and a spiral by the same rule', () => {
    /*
     * They were the same fit written twice, and Wrap was the place the two
     * copies diverged most: a lap's size search filled its run exactly, while a
     * spiral's depth scan traded size for turns and left the packer to make up
     * the difference. One mode drew the face, the other drew ribbons.
     */
    for (const [name, shape] of Object.entries(SHAPES)) {
      const lap = stretch(fit(shape, TEXTS.short, 'one', false, 1.14))
      const wound = stretch(fit(shape, TEXTS.short, 'many', false, 1.14))
      expect(lap, `${name} lap`).toBeLessThanOrEqual(MAX_STRETCH + 1e-9)
      expect(wound, `${name} spiral`).toBeLessThanOrEqual(MAX_STRETCH + 1e-9)
    }
  })
})
