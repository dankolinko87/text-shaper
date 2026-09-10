import { describe, expect, it } from 'vitest'

import { layoutMosaic } from '../../src/mosaic/layout'
import {
  MINIMUM_VISIBLE,
  clampSpacing,
  isDegenerate,
  maximumGap,
  maximumGlyphInset,
  maximumOuterPadding,
} from '../../src/mosaic/spacing'
import { seedMosaic } from '../../src/mosaic/dissection'
import type { Rect } from '../../src/types/document'
import type { MosaicSpacing, MosaicTile } from '../../src/types/mosaic'

/**
 * How much spacing a mosaic can take.
 *
 * Two things have to be true and they pull against each other. Every maximum
 * must be genuinely reachable — a control that stops short of a legal value is
 * a control that lies about the tool — and one step past it must actually be
 * illegal, or the maximum is not the maximum. So most of what is here checks
 * both sides of the same number.
 *
 * The third property is the one that makes the controls usable at all: the three
 * maxima have to agree with each other, so that setting each to its own maximum
 * in any order still leaves every rectangle legal.
 */

const BOX: Rect = { x: -300, y: -300, width: 600, height: 600 }
const NONE: MosaicSpacing = { gap: 0, outerPadding: 0, glyphInset: 0 }

interface Fixture {
  list: MosaicTile[]
  x: Record<string, number>
  y: Record<string, number>
}

const grid = (cols: number, rows: number): Fixture => {
  const s = seedMosaic(cols, rows)
  return { list: s.tiles, x: s.x, y: s.y }
}

/** The coordinate sets the helpers take: one per state, one state today. */
const setsOf = (f: Fixture) => [{ x: f.x, y: f.y }]

/**
 * The same tiles with the lines shoved about, which is where limits bite.
 *
 * The SAME tiles deliberately: coordinates are keyed by id, so a set built from
 * a differently seeded mosaic would key nothing and quietly fall back to the
 * rim — a test that then proves the opposite of what it says.
 */
function skew(f: Fixture): Fixture {
  const shove = (values: Record<string, number>): Record<string, number> => {
    const interior = Object.entries(values)
      .filter(([, v]) => v > 0 && v < 1)
      .sort((a, b) => a[1] - b[1])
    const step = 0.06
    return Object.fromEntries(interior.map(([id], i) => [id, step * (i + 1)]))
  }
  return { list: f.list, x: shove(f.x), y: shove(f.y) }
}

const spacing = (patch: Partial<MosaicSpacing>): MosaicSpacing => ({ ...NONE, ...patch })

/** Every visible rectangle, for a mosaic laid out with these spacings. */
const visibles = (f: Fixture, space: MosaicSpacing, box: Rect = BOX): Rect[] =>
  [...layoutMosaic(f.list, f.x, f.y, box, space).values()].map((tile) => tile.visible)

const glyphs = (f: Fixture, space: MosaicSpacing, box: Rect = BOX): Rect[] =>
  [...layoutMosaic(f.list, f.x, f.y, box, space).values()].map((tile) => tile.glyph)

const allLegal = (rects: Rect[], minimum = MINIMUM_VISIBLE): boolean =>
  rects.every((r) => !isDegenerate(r, minimum))

const smallestSide = (rects: Rect[]): number =>
  Math.min(...rects.map((r) => Math.min(r.width, r.height)))

const CASES: [string, Fixture][] = [
  ['a 1×1 mosaic', grid(1, 1)],
  ['a regular 3×4 grid', grid(3, 4)],
  ['a 6×6 grid', grid(6, 6)],
  ['an irregular mosaic', skew(grid(4, 3))],
]

/** The cases where the gap has anything to act on. A lone tile has no seams. */
const MANY = CASES.slice(1)

describe('the widest gap', () => {
  it.each(CASES)('is legal at its maximum, for %s', (_name, f) => {
    const max = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 0 })
    expect(max).toBeGreaterThan(0)
    expect(Number.isFinite(max)).toBe(true)
    expect(allLegal(visibles(f, spacing({ gap: max })))).toBe(true)
  })

  it.each(MANY)('is the LAST legal value, for %s', (_name, f) => {
    const max = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 0 })
    // A whole unit past it, so this is not a test of floating-point residue.
    expect(allLegal(visibles(f, spacing({ gap: max + 1 })))).toBe(false)
  })

  it('is bounded by the box when a mosaic has no seams at all', () => {
    // One leaf has no interior edge, so no tile constrains the gap. Without a
    // bound of its own the maximum would come back Infinity and the slider with
    // it — a control with no end is worse than one that stops somewhere sane.
    const f = grid(1, 1)
    const max = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 0 })
    // Within the margin the maxima deliberately stop short by, so that the value
    // they report is one the layout will actually accept.
    expect(max).toBeCloseTo(BOX.width - MINIMUM_VISIBLE, 4)
  })

  it('shrinks as the padding grows, because the tiles have less to give', () => {
    const f = grid(3, 4)
    const loose = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 0 })
    const tight = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 100 })
    expect(tight).toBeLessThan(loose)
    expect(allLegal(visibles(f, spacing({ gap: tight, outerPadding: 100 })))).toBe(true)
  })

  it('takes the strictest answer across several states', () => {
    /*
     * One state's proportions can be roomy and the next one's cramped. A gap
     * legal in the state on show but not in the one after it would produce a
     * collapsed tile partway through an animation, which is precisely what the
     * shared-easing proof is meant to rule out — so the limit is the minimum
     * over every state, not the current one.
     */
    const f = grid(3, 4)
    const cramped = skew(f)
    const alone = maximumGap(f.list, setsOf(f), BOX, { outerPadding: 0 })
    const both = maximumGap(f.list, [...setsOf(f), ...setsOf(cramped)], BOX, { outerPadding: 0 })
    expect(both).toBeLessThan(alone)
    expect(allLegal(visibles(cramped, spacing({ gap: both })))).toBe(true)
    expect(allLegal(visibles(f, spacing({ gap: both })))).toBe(true)
  })
})

describe('zero gap', () => {
  it('gives touching tiles', () => {
    const f = grid(3, 4)
    const rects = visibles(f, NONE)
    const total = rects.reduce((sum, r) => sum + r.width * r.height, 0)
    // Touching means the visible rectangles still tile the box exactly.
    expect(total).toBeCloseTo(BOX.width * BOX.height, 4)
  })
})

describe('one gap between neighbours', () => {
  /**
   * The smallest space between any two tiles that are not the same tile.
   *
   * Measured by looking for the closest approach along each axis between rects
   * that overlap on the other one — which is what "neighbouring" means when the
   * tree cannot be asked.
   */
  function narrowestSeam(rects: Rect[]): number {
    let seam = Infinity
    for (const a of rects) {
      for (const b of rects) {
        if (a === b) continue
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        if (overlapY > 1e-6) seam = Math.min(seam, Math.abs(b.x - (a.x + a.width)))
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        if (overlapX > 1e-6) seam = Math.min(seam, Math.abs(b.y - (a.y + a.height)))
      }
    }
    return seam
  }

  it.each(MANY)('is exactly the gap, everywhere in %s', (_name, f) => {
    // Including where a tile meets two others, which a shoved-about mosaic has
    // plenty of.
    for (const gap of [4, 20]) {
      expect(narrowestSeam(visibles(f, spacing({ gap }))), `gap ${gap}`).toBeCloseTo(gap, 6)
    }
  })

  it('is unchanged by padding and by the glyph inset', () => {
    const f = grid(4, 4)
    const plain = narrowestSeam(visibles(f, spacing({ gap: 12 })))
    const padded = narrowestSeam(visibles(f, spacing({ gap: 12, outerPadding: 40 })))
    const inset = narrowestSeam(visibles(f, spacing({ gap: 12, glyphInset: 9 })))
    expect(padded).toBeCloseTo(plain, 6)
    expect(inset).toBeCloseTo(plain, 6)
  })
})

describe('outer padding', () => {
  it('applies before the partition, so every tile shrinks and not just the outer ones', () => {
    const f = grid(3, 4)
    const before = visibles(f, NONE)
    const after = visibles(f, spacing({ outerPadding: 60 }))

    const shrink = BOX.width === BOX.height ? (BOX.width - 120) / BOX.width : 0
    expect(shrink).toBeGreaterThan(0)
    for (let i = 0; i < before.length; i++) {
      const a = before[i] as Rect
      const b = after[i] as Rect
      // Every tile keeps its share of a smaller box: the same ratio, throughout.
      expect(b.width / a.width, `tile ${i} width`).toBeCloseTo(shrink, 6)
      expect(b.height / a.height, `tile ${i} height`).toBeCloseTo(shrink, 6)
    }
  })

  it.each(CASES)('has a maximum that is reachable and final, for %s', (_name, f) => {
    const max = maximumOuterPadding(f.list, setsOf(f), BOX, { gap: 0 })
    expect(max).toBeGreaterThan(0)
    expect(allLegal(visibles(f, spacing({ outerPadding: max })))).toBe(true)
    expect(allLegal(visibles(f, spacing({ outerPadding: max + 1 })))).toBe(false)
  })

  it('leaves room for the gap it was given', () => {
    const f = grid(3, 4)
    const max = maximumOuterPadding(f.list, setsOf(f), BOX, { gap: 30 })
    expect(allLegal(visibles(f, spacing({ outerPadding: max, gap: 30 })))).toBe(true)
  })
})

describe('the glyph inset', () => {
  it('affects glyph rectangles and leaves the tiles alone', () => {
    const f = grid(3, 4)
    const withInset = layoutMosaic(f.list, f.x, f.y, BOX, spacing({ gap: 10, glyphInset: 12 }))
    const without = layoutMosaic(f.list, f.x, f.y, BOX, spacing({ gap: 10 }))

    for (const [id, tile] of withInset) {
      const plain = without.get(id)
      expect(plain).toBeTruthy()
      if (!plain) continue
      expect(tile.visible).toEqual(plain.visible)
      expect(tile.structural).toEqual(plain.structural)
      expect(tile.glyph.width).toBeCloseTo(plain.visible.width - 24, 6)
      expect(tile.glyph.height).toBeCloseTo(plain.visible.height - 24, 6)
    }
  })

  it.each(CASES)('has a maximum that is reachable and final, for %s', (_name, f) => {
    const max = maximumGlyphInset(f.list, setsOf(f), BOX, { gap: 8, outerPadding: 10 })
    expect(max).toBeGreaterThan(0)
    const at = spacing({ gap: 8, outerPadding: 10, glyphInset: max })
    expect(allLegal(glyphs(f, at))).toBe(true)
    expect(allLegal(glyphs(f, { ...at, glyphInset: max + 1 }))).toBe(false)
  })

  it('is measured across empty tiles too, so typing never changes the limit', () => {
    // The tiles carry the characters and the layout never reads them, which is
    // what makes this true by construction — asserted so it stays that way.
    const f = grid(3, 4)
    const max = maximumGlyphInset(f.list, setsOf(f), BOX, { gap: 6, outerPadding: 0 })
    const smallest = smallestSide(visibles(f, spacing({ gap: 6 })))
    expect(max).toBeCloseTo((smallest - MINIMUM_VISIBLE) / 2, 4)
  })
})

describe('the three maxima together', () => {
  it.each(CASES)('agree, in any order of adjustment, for %s', (_name, f) => {
    /*
     * The property the panel rests on. Each maximum is computed holding the
     * other two where they are, so pushing one control to its end can never make
     * another value illegal — whichever order the controls are touched in.
     */
    let gap = 0
    let outerPadding = 0
    let glyphInset = 0

    const orders: ('gap' | 'padding' | 'inset')[][] = [
      ['gap', 'padding', 'inset'],
      ['padding', 'gap', 'inset'],
      ['inset', 'padding', 'gap'],
    ]

    for (const order of orders) {
      gap = 0
      outerPadding = 0
      glyphInset = 0
      for (const which of order) {
        // Each maximum is asked with the other two exactly where they are — the
        // way the panel asks. The glyph inset is the one that used to be left
        // out, and leaving it out is what made the order matter.
        if (which === 'gap') {
          gap = maximumGap(f.list, setsOf(f), BOX, { outerPadding, glyphInset })
        }
        if (which === 'padding') {
          outerPadding = maximumOuterPadding(f.list, setsOf(f), BOX, { gap, glyphInset })
        }
        if (which === 'inset') {
          glyphInset = maximumGlyphInset(f.list, setsOf(f), BOX, { gap, outerPadding })
        }
      }

      const at = spacing({ gap, outerPadding, glyphInset })
      expect(allLegal(visibles(f, at)), `visible after ${order.join(' → ')}`).toBe(true)
      expect(allLegal(glyphs(f, at)), `glyph after ${order.join(' → ')}`).toBe(true)
    }
  })
})

describe('clamping a document that arrived illegal', () => {
  it('brings all three back into range', () => {
    const f = grid(3, 4)
    const wild = spacing({ gap: 9000, outerPadding: 4000, glyphInset: 700 })
    const fixed = clampSpacing(f.list, setsOf(f), BOX, wild)

    expect(fixed.gap).toBeLessThan(wild.gap)
    expect(fixed.outerPadding).toBeLessThan(wild.outerPadding)
    expect(allLegal(visibles(f, fixed))).toBe(true)
    expect(allLegal(glyphs(f, fixed))).toBe(true)
  })

  it('leaves a legal document exactly as it was', () => {
    const f = grid(3, 4)
    const fine = spacing({ gap: 6, outerPadding: 0, glyphInset: 6 })
    expect(clampSpacing(f.list, setsOf(f), BOX, fine)).toEqual(fine)
  })

  it('refuses negative and non-finite values', () => {
    const f = grid(3, 4)
    const bad = spacing({ gap: -20, outerPadding: Number.NaN, glyphInset: -1 })
    const fixed = clampSpacing(f.list, setsOf(f), BOX, bad)
    expect(fixed).toMatchObject({ gap: 0, outerPadding: 0, glyphInset: 0 })
  })
})

describe('a mosaic too small to space at all', () => {
  it('reports a maximum of zero rather than a negative one', () => {
    const f = grid(4, 4)
    const tiny: Rect = { x: 0, y: 0, width: 6, height: 6 }
    expect(maximumGap(f.list, setsOf(f), tiny, { outerPadding: 0 })).toBe(0)
    expect(maximumOuterPadding(f.list, setsOf(f), tiny, { gap: 0 })).toBe(0)
    expect(maximumGlyphInset(f.list, setsOf(f), tiny, { gap: 0, outerPadding: 0 })).toBe(0)
  })
})
