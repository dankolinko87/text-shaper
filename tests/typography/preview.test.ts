/**
 * Not a test — a visual preview generator.
 *
 * Runs the real geometry and typography engines and writes standalone SVGs so
 * the fitted output can be inspected at full size. Run with:
 *   npx vitest run tests/preview.gen.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import opentype from 'opentype.js'
import { beforeAll, expect, it } from 'vitest'

import { initClipper, insetPath } from '../../src/geometry/clipper'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { registerFont } from '../../src/typography/fontRegistry'
import { defaultDistortionSettings } from '../../src/state/defaults'
import { fitTextToShape } from '../../src/typography/fit'
import { verifyExactText } from '../../src/typography/invariant'
import type { Vec2 } from '../../src/types/document'

const OUT = fileURLToPath(new URL('../../preview', import.meta.url))

beforeAll(async () => {
  const p = fileURLToPath(new URL('../../src/fonts/files/Anton-Regular.ttf', import.meta.url))
  const b = readFileSync(p)
  registerFont('anton', opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  await initClipper()
  mkdirSync(OUT, { recursive: true })
})

function blobStroke(cx: number, cy: number, rx: number, ry: number, lobes: number, amp: number): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2
    const k = 1 + amp * Math.sin(a * lobes)
    pts.push({ x: cx + rx * k * Math.cos(a), y: cy + ry * k * Math.sin(a) })
  }
  return pts
}

interface Case {
  name: string
  stroke: Vec2[]
  text: string
  flow: 'word' | 'character' | 'preserve-lines'
}

const CASES: Case[] = [
  {
    name: '01-ellipse',
    stroke: blobStroke(400, 300, 320, 220, 1, 0),
    text: 'Typography becomes the shape itself',
    flow: 'word',
  },
  {
    name: '02-blob',
    stroke: blobStroke(400, 300, 280, 250, 3, 0.16),
    text: 'The shape controls how the text is distributed but never what it says',
    flow: 'word',
  },
  {
    name: '03-short-text',
    stroke: blobStroke(400, 300, 300, 230, 1, 0),
    text: 'BOLD',
    flow: 'word',
  },
  {
    name: '04-long-text',
    stroke: blobStroke(400, 300, 300, 240, 2, 0.1),
    text: 'This is a considerably longer passage of text which must be broken across many more lines in order to fit within the very same container shape without ever repeating or truncating a single word',
    flow: 'word',
  },
  {
    name: '05-character-wrap',
    stroke: blobStroke(400, 300, 260, 250, 1, 0),
    text: 'SHAPED',
    flow: 'character',
  },
  {
    name: '06-tall-narrow',
    stroke: blobStroke(400, 300, 150, 280, 1, 0),
    text: 'Narrow column of set type',
    flow: 'word',
  },
  {
    // The case from the bug report: lowercase-heavy text stuffed with
    // ascenders and descenders, which used to push the last line out of the
    // bottom of the container.
    name: '07-descenders',
    stroke: blobStroke(400, 300, 300, 230, 2, 0.07),
    text: 'jh gckjcvljvhkvjcv ljgclc ljhvljh ljh v jvh',
    flow: 'word',
  },
]

it('fits every sample case without altering the text, and writes preview SVGs', () => {
  const summary: string[] = []

  for (const testCase of CASES) {
    const shape = strokeToShapePath(testCase.stroke)
    expect(shape.ok, `${testCase.name} shape`).toBe(true)
    if (!shape.ok) continue

    const inset = insetPath(shape.pathData, 18)
    const region = inset.collapsed || !inset.path ? shape.pathData : inset.path

    const fit = fitTextToShape({
      text: testCase.text,
      shapePath: region,
      fontId: 'anton',
      flowMode: testCase.flow,
      lineSpacing: 1,
      letterSpacing: 0,
      quality: 'final',
    })

    expect(fit.ok, `${testCase.name} fit`).toBe(true)
    if (!fit.ok) continue

    const check = verifyExactText(testCase.text, fit.lines.map((l) => l.text), testCase.flow)
    // The invariant must hold for every shape and every flow mode.
    expect(check.ok, `${testCase.name}: ${check.ok ? '' : check.detail}`).toBe(true)
    const b = shape.localBounds
    const pad = 40
    const vb = `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(b.width + pad * 2)}" height="${Math.round(b.height + pad * 2)}">
  <rect x="${b.x - pad}" y="${b.y - pad}" width="${b.width + pad * 2}" height="${b.height + pad * 2}" fill="#f4f4f2"/>
  <path d="${shape.pathData}" fill="none" stroke="#c9c9c4" stroke-width="1.5"/>
  <path d="${region}" fill="none" stroke="#e2e2dd" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="${fit.path}" fill="#101014" fill-rule="nonzero"/>
</svg>`

    writeFileSync(`${OUT}/${testCase.name}.svg`, svg)

    const scales = fit.lines.map((l) => l.horizontalScale.toFixed(2)).join(', ')
    summary.push(
      `${testCase.name}: ${fit.lineCount} lines | scales [${scales}] | exact=${check.ok} | extreme=${fit.extremeDistortion}\n    lines: ${fit.lines.map((l) => `"${l.text}"`).join(' / ')}`,
    )
  }

  console.log('\n' + summary.join('\n') + '\n')
})

/**
 * A composed artboard with several independent objects, mirroring what the
 * editor shows. Verifies that objects transform independently and that each
 * one's text is fitted to its own shape.
 */
/**
 * The warp grid. This phase is judged by eye, so the sweep exists to be looked
 * at: the same text and shape at increasing shape-following strength.
 */
it('writes a warp strength sweep for visual review', () => {
  const stroke = blobStroke(400, 300, 300, 230, 1, 0)
  const shape = strokeToShapePath(stroke)
  expect(shape.ok).toBe(true)
  if (!shape.ok) return

  const inset = insetPath(shape.pathData, 16)
  const region = inset.collapsed || !inset.path ? shape.pathData : inset.path
  const text = 'Typography becomes the shape'

  const neutral = {
    horizontal: 0,
    vertical: 0,
    boundaryInfluence: 0,
    glyphScaleVariation: 0,
    glyphRotation: 0,
    waveAmount: 0,
    waveFrequency: 1,
    shear: 0,
    noiseAmount: 0,
    noiseScale: 1,
  }

  for (const influence of [0, 0.35, 0.7, 1]) {
    const fit = fitTextToShape({
      text,
      shapePath: region,
      fontId: 'anton',
      flowMode: 'word',
      lineSpacing: 1,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'boundary-warp',
      distortion: { ...neutral, boundaryInfluence: influence },
      seed: 7,
    })
    expect(fit.ok, `influence ${influence}`).toBe(true)
    if (!fit.ok) continue
    expect(verifyExactText(text, fit.lines.map((l) => l.text), 'word').ok).toBe(true)

    const b = shape.localBounds
    const pad = 40
    const vb = `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(b.width + pad * 2)}" height="${Math.round(b.height + pad * 2)}">
  <rect x="${b.x - pad}" y="${b.y - pad}" width="${b.width + pad * 2}" height="${b.height + pad * 2}" fill="#f4f4f2"/>
  <path d="${shape.pathData}" fill="#dcdcd8"/>
  <path d="${fit.path}" fill="#101014" fill-rule="nonzero"/>
</svg>`
    writeFileSync(`${OUT}/warp-${String(Math.round(influence * 100)).padStart(3, '0')}.svg`, svg)
  }
})

/** Poster-style cases: text packed to fill a silhouette. */
it('writes packed poster previews', () => {
  const diamond = (rx: number, ry: number): Vec2[] => {
    const pts: Vec2[] = []
    for (let i = 0; i < 240; i++) {
      const a = (i / 240) * Math.PI * 2
      const k = 1 / (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)))
      pts.push({ x: 400 + rx * k * Math.cos(a), y: 300 + ry * k * Math.sin(a) })
    }
    return pts
  }

  const cases: { name: string; stroke: Vec2[]; text: string }[] = [
    { name: 'poster-diamond', stroke: diamond(330, 290), text: 'GREAT THINGS TAKE TIME' },
    { name: 'poster-diamond2', stroke: diamond(320, 300), text: 'START SMALL BUT START TODAY' },
    { name: 'poster-blob', stroke: blobStroke(400, 300, 300, 270, 3, 0.12), text: 'MAKE DOPE STUFF EVERY DAY' },
    { name: 'poster-wide', stroke: blobStroke(400, 300, 340, 240, 1, 0), text: 'GOODNESS SHOUTS EVIL WHISPERS' },
    {
      name: 'poster-lumpy',
      stroke: (() => {
        const p: Vec2[] = []
        for (let i = 0; i < 260; i++) {
          const a = (i / 260) * Math.PI * 2
          const k = 1 + 0.1 * Math.sin(a * 2 + 0.6) + 0.07 * Math.sin(a * 3 - 1.1) + 0.05 * Math.sin(a * 5)
          p.push({ x: 400 + 420 * k * Math.cos(a), y: 300 + 190 * k * Math.sin(a) })
        }
        return p
      })(),
      text: 'help me to find the right way to write deffernt things inside this cool shape',
    },
  ]

  for (const testCase of cases) {
    const shape = strokeToShapePath(testCase.stroke)
    expect(shape.ok).toBe(true)
    if (!shape.ok) continue

    const inset = insetPath(shape.pathData, 4)
    const region = inset.collapsed || !inset.path ? shape.pathData : inset.path

    const fit = fitTextToShape({
      text: testCase.text,
      shapePath: region,
      fontId: 'anton',
      flowMode: 'word',
      lineSpacing: 1.14,
      letterSpacing: 0,
      quality: 'final',
      fittingMode: 'boundary-warp',
      distortion: defaultDistortionSettings,
      seed: 11,
    })
    expect(fit.ok, testCase.name).toBe(true)
    if (!fit.ok) continue
    expect(verifyExactText(testCase.text, fit.lines.map((l) => l.text), 'word').ok).toBe(true)

    const b = shape.localBounds
    const pad = 30
    const vb = `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`
    // The container is drawn behind the type. Without it there is no way to
    // judge how completely the text fills the shape, which is the whole point.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(b.width + pad * 2)}" height="${Math.round(b.height + pad * 2)}">
  <rect x="${b.x - pad}" y="${b.y - pad}" width="${b.width + pad * 2}" height="${b.height + pad * 2}" fill="#f4f4f2"/>
  <path d="${shape.pathData}" fill="#d2d2cd"/>
  <path d="${region}" fill="none" stroke="#b9b9b2" stroke-width="1" stroke-dasharray="5 5"/>
  <path d="${fit.path}" fill="#101014" fill-rule="nonzero"/>
</svg>`
    writeFileSync(`${OUT}/${testCase.name}.svg`, svg)
  }
})

it('composes multiple independent objects onto one artboard', () => {
  const objects = [
    {
      stroke: blobStroke(330, 260, 230, 180, 1, 0),
      text: 'Typography becomes the shape',
      fill: '#101014',
    },
    {
      stroke: blobStroke(880, 300, 200, 175, 3, 0.14),
      text: 'Draw it. Fill it. Reshape it.',
      fill: '#101014',
    },
    {
      stroke: blobStroke(600, 630, 340, 120, 2, 0.08),
      text: 'The exact text appears once and only once',
      fill: '#1d4f45',
    },
  ]

  const parts: string[] = []
  for (const object of objects) {
    const shape = strokeToShapePath(object.stroke)
    expect(shape.ok).toBe(true)
    if (!shape.ok) continue

    const inset = insetPath(shape.pathData, 16)
    const region = inset.collapsed || !inset.path ? shape.pathData : inset.path

    const fit = fitTextToShape({
      text: object.text,
      shapePath: region,
      fontId: 'anton',
      flowMode: 'word',
      lineSpacing: 1,
      letterSpacing: 0,
      quality: 'final',
    })
    expect(fit.ok).toBe(true)
    if (!fit.ok) continue

    expect(verifyExactText(object.text, fit.lines.map((l) => l.text), 'word').ok).toBe(true)

    // Objects are placed by transform, exactly as the document model stores them.
    const { x, y } = shape.artboardCenter
    parts.push(
      `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">` +
        `<path d="${fit.path}" fill="${object.fill}" fill-rule="nonzero"/></g>`,
    )
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <rect width="1200" height="800" fill="#f4f4f2"/>
  ${parts.join('\n  ')}
</svg>`
  writeFileSync(`${OUT}/00-artboard.svg`, svg)
  expect(parts).toHaveLength(3)
})
