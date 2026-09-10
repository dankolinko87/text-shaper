import { afterEach, describe, expect, it } from 'vitest'

import { resetPaperScope, withPaper } from '../../src/geometry/paperContext'
import { itemArea, keepSignificantRegions } from '../../src/geometry/regions'

afterEach(() => {
  resetPaperScope()
})

describe('keepSignificantRegions', () => {
  it('preserves holes — a donut keeps its counter', () => {
    const totals = withPaper((scope) => {
      const outer = new scope.Path.Circle({ center: [300, 300], radius: 150 })
      const inner = new scope.Path.Circle({ center: [300, 300], radius: 70 })
      const donut = outer.subtract(inner)
      const before = itemArea(donut)

      const { item, discardedRegions } = keepSignificantRegions(donut, {
        minAreaRatio: 0.02,
        keepLargestOnly: false,
      })
      const after = itemArea(item)
      const childCount = (item.children as unknown[] | undefined)?.length ?? 1
      item.remove()
      return { before, after, childCount, discardedRegions }
    })

    // The hole must still be subtracted, so total area stays well below the
    // outer disc alone (pi * 150^2 = 70686).
    expect(totals.after).toBeCloseTo(totals.before, 3)
    expect(totals.after).toBeLessThan(70686 * 0.85)
    expect(totals.childCount).toBe(2)
    expect(totals.discardedRegions).toBe(false)
  })

  it('drops tiny disconnected fragments but keeps significant ones', () => {
    const result = withPaper((scope) => {
      const big = new scope.Path.Circle({ center: [100, 100], radius: 100 })
      const medium = new scope.Path.Circle({ center: [500, 100], radius: 60 })
      const sliver = new scope.Path.Circle({ center: [900, 100], radius: 3 })
      const combined = big.unite(medium).unite(sliver)

      const { item, discardedRegions } = keepSignificantRegions(combined, {
        minAreaRatio: 0.02,
        keepLargestOnly: false,
      })
      const childCount = (item.children as unknown[] | undefined)?.length ?? 1
      item.remove()
      return { childCount, discardedRegions }
    })

    // Big and medium survive; the 3px sliver is discarded.
    expect(result.childCount).toBe(2)
    expect(result.discardedRegions).toBe(true)
  })

  it('keeps only the largest region when asked (the Phase 4 erase-through rule)', () => {
    const result = withPaper((scope) => {
      const big = new scope.Path.Circle({ center: [100, 100], radius: 100 })
      const medium = new scope.Path.Circle({ center: [500, 100], radius: 60 })
      const combined = big.unite(medium)

      const { item, discardedRegions } = keepSignificantRegions(combined, {
        minAreaRatio: 0.02,
        keepLargestOnly: true,
      })
      const childCount = (item.children as unknown[] | undefined)?.length ?? 1
      item.remove()
      return { childCount, discardedRegions }
    })

    expect(result.childCount).toBe(1)
    expect(result.discardedRegions).toBe(true)
  })

  it('leaves a single simple region untouched', () => {
    const result = withPaper((scope) => {
      const circle = new scope.Path.Circle({ center: [100, 100], radius: 50 })
      const { item, discardedRegions } = keepSignificantRegions(circle, {
        minAreaRatio: 0.02,
        keepLargestOnly: true,
      })
      const area = Math.abs(itemArea(item))
      item.remove()
      return { area, discardedRegions }
    })
    // paper approximates a circle with four Béziers, so allow 0.5% deviation.
    const exact = Math.PI * 50 * 50
    expect(Math.abs(result.area - exact) / exact).toBeLessThan(0.005)
    expect(result.discardedRegions).toBe(false)
  })
})
