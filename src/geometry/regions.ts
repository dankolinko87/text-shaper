/**
 * paper's `PathItem` type omits `area`, even though both `Path` and
 * `CompoundPath` provide it. This narrows that gap in one place rather than
 * scattering casts across the geometry modules.
 *
 * The value is SIGNED: positive for an outer contour, negative for a hole.
 */
export function itemArea(item: paper.PathItem): number {
  return (item as paper.PathItem & { area: number }).area
}

export interface RegionFilterOptions {
  /** Positive-area regions smaller than this fraction of the largest are discarded. */
  minAreaRatio: number
  /** Keep only the single largest outer region (the MVP behaviour for disconnected shapes). */
  keepLargestOnly: boolean
}

export interface RegionFilterResult {
  item: paper.PathItem
  /** True when disconnected outer regions were discarded — the caller surfaces a warning. */
  discardedRegions: boolean
}

/**
 * Filter the children of a boolean-op result.
 *
 * The critical distinction: in paper.js a compound path's children carry SIGNED
 * area. Negative-area children are HOLES (counters) and must be preserved —
 * dropping them would fill in the middle of a donut. Only small POSITIVE-area
 * children are disconnected fragments, and those are what we discard.
 */
export function keepSignificantRegions(
  item: paper.PathItem,
  options: RegionFilterOptions,
): RegionFilterResult {
  const compound = item as paper.CompoundPath
  const children = compound.children as paper.PathItem[] | undefined
  if (!children || children.length <= 1) {
    return { item, discardedRegions: false }
  }

  const outers = children.filter((child) => itemArea(child) > 0)
  const holes = children.filter((child) => itemArea(child) <= 0)

  if (outers.length === 0) return { item, discardedRegions: false }

  let largestArea = 0
  for (const outer of outers) {
    const area = itemArea(outer)
    if (area > largestArea) largestArea = area
  }

  const threshold = largestArea * options.minAreaRatio
  const keptOuters = options.keepLargestOnly
    ? outers.filter((outer) => itemArea(outer) === largestArea)
    : outers.filter((outer) => itemArea(outer) >= threshold)

  const discardedRegions = keptOuters.length < outers.length

  if (!discardedRegions && holes.length === children.length - outers.length) {
    return { item, discardedRegions: false }
  }

  // Keep every hole that lies inside a surviving outer region.
  const keptHoles = holes.filter((hole) => {
    const probe = hole.bounds.center
    return keptOuters.some((outer) => outer.contains(probe))
  })

  for (const child of children) {
    if (!keptOuters.includes(child) && !keptHoles.includes(child)) {
      child.remove()
    }
  }

  return { item, discardedRegions }
}

/** Total absolute area of a path item — used for the degenerate-stroke gate. */
export function absoluteArea(item: paper.PathItem): number {
  return Math.abs(itemArea(item))
}
