import {
  MOSAIC_DEFAULT_EASING,
  MOSAIC_DEFAULT_HOLD_MS,
  MOSAIC_DEFAULT_SPACING,
  MOSAIC_DEFAULT_TRANSITION_MS,
  RIM,
  X_MAX,
  X_MIN,
  Y_MAX,
  Y_MIN,
  isRim,
  MOSAIC_DEFAULT_CORNERS,
} from '../types/mosaic'
import type { Coordinate, MosaicState, MosaicTile } from '../types/mosaic'
import type { FontSettings } from '../types/document'
import { sameStroke } from '../geometry/stroke'
import { createId } from '../utils/id'

/**
 * The set of tiles and the lines that bound them: seeding, walking, and pulling
 * one line apart from another.
 *
 * No geometry here — a tile knows which four coordinates bound it and nothing
 * about where they are. The numbers live in the states and rectangles are worked
 * out in `layout.ts`, which is what lets every state share one set of tiles.
 */

/** Ids are unique across the whole document, not just within their object. */
const tileId = (): string => createId('mt')
const coordId = (): string => createId('mc')
const stateId = (): string => createId('mst')

export interface Seeded {
  tiles: MosaicTile[]
  x: Record<string, Coordinate>
  y: Record<string, Coordinate>
}

/**
 * A fresh mosaic: a plain `columns × rows` grid.
 *
 * Every tile in a column names the same left and right coordinate, and every
 * tile in a row the same top and bottom, so a new mosaic is fully aligned —
 * dragging one line moves the whole column or row, which is what a grid should
 * do. Pulling a single tile out of that alignment is `forkCoordinate`, and it is
 * something the user asks for rather than something a drag does by accident.
 */
export function seedMosaic(columns: number, rows: number): Seeded {
  const cols = Math.max(1, Math.floor(columns))
  const count = Math.max(1, Math.floor(rows))

  const xs: string[] = [X_MIN]
  const x: Record<string, Coordinate> = { [X_MIN]: 0, [X_MAX]: 1 }
  for (let i = 1; i < cols; i++) {
    const id = coordId()
    xs.push(id)
    x[id] = i / cols
  }
  xs.push(X_MAX)

  const ys: string[] = [Y_MIN]
  const y: Record<string, Coordinate> = { [Y_MIN]: 0, [Y_MAX]: 1 }
  for (let j = 1; j < count; j++) {
    const id = coordId()
    ys.push(id)
    y[id] = j / count
  }
  ys.push(Y_MAX)

  const tiles: MosaicTile[] = []
  // Row by row, so tree order is reading order for a fresh mosaic.
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < cols; i++) {
      tiles.push({
        id: tileId(),
        left: xs[i] as string,
        right: xs[i + 1] as string,
        top: ys[j] as string,
        bottom: ys[j + 1] as string,
      })
    }
  }

  return { tiles, x, y }
}

/** Every coordinate the tiles actually name, on one axis, plus the rim. */
export function coordinatesUsed(tiles: readonly MosaicTile[], axis: 'x' | 'y'): string[] {
  const seen = new Set<string>(axis === 'x' ? [X_MIN, X_MAX] : [Y_MIN, Y_MAX])
  for (const tile of tiles) {
    if (axis === 'x') {
      seen.add(tile.left)
      seen.add(tile.right)
    } else {
      seen.add(tile.top)
      seen.add(tile.bottom)
    }
  }
  return [...seen]
}

/**
 * A coordinate's value, with the rim answered without being stored.
 *
 * The rim never moves, so keeping it out of the stored maps means a state can
 * never disagree with itself about where the edge of the mosaic is.
 */
export function valueOf(values: Record<string, Coordinate>, id: string): Coordinate {
  const rim = RIM[id]
  if (rim !== undefined) return rim
  const value = values[id]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function findTile(tiles: readonly MosaicTile[], id: string): MosaicTile | null {
  return tiles.find((tile) => tile.id === id) ?? null
}

/**
 * Fill a mosaic's tiles from a string, in order.
 *
 * Anything past the end of the string is left empty, which is a real state
 * rather than a missing one.
 */
/**
 * Text laid into a mosaic's tiles, in tree order, as a state's letters.
 *
 * Returns the MAP a state holds rather than new tiles: what is written belongs
 * to the composition, and a tile is only the place it is written.
 */
export function withCharacters(
  tiles: readonly MosaicTile[],
  text: string,
): Record<string, string> {
  const chars = [...text]
  const out: Record<string, string> = {}
  tiles.forEach((tile, at) => {
    const char = chars[at]
    if (char) out[tile.id] = char
  })
  return out
}

/**
 * A copy of a mosaic's tiles and states with entirely fresh ids.
 *
 * NOT a deep copy. Ids are unique across the document, so a duplicate that kept
 * them would give two objects the same tile and coordinate ids — and every state
 * keys its numbers and colours BY those ids. Nothing downstream namespaces a
 * lookup by object, so the two would read each other's entries, and the failure
 * would look like a duplicate that mysteriously moves when you edit the original.
 *
 * The rim ids are shared on purpose: they are constants, not identity.
 */
export function copyMosaicIdentity(
  tiles: readonly MosaicTile[],
  states: readonly MosaicState[],
): { tiles: MosaicTile[]; states: MosaicState[] } {
  const coords = new Map<string, string>()
  const ids = new Map<string, string>()

  const coord = (id: string): string => {
    if (isRim(id)) return id
    const existing = coords.get(id)
    if (existing) return existing
    const fresh = coordId()
    coords.set(id, fresh)
    return fresh
  }

  const copied = tiles.map((tile) => {
    const id = tileId()
    ids.set(tile.id, id)
    return {
      ...tile,
      id,
      left: coord(tile.left),
      right: coord(tile.right),
      top: coord(tile.top),
      bottom: coord(tile.bottom),
    }
  })

  const remap = <T>(from: Record<string, T>, map: Map<string, string>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [key, value] of Object.entries(from)) {
      const id = map.get(key)
      if (id) out[id] = value
    }
    return out
  }

  return {
    tiles: copied,
    states: states.map((state) => ({
      ...state,
      id: stateId(),
      x: remap(state.x, coords),
      y: remap(state.y, coords),
      glyphColour: remap(state.glyphColour, ids),
      // Letters are keyed by tile too, so they are remapped like the colours —
      // left out, a duplicate would come out blank.
      chars: remap(state.chars, ids),
      tileColour: remap(state.tileColour, ids),
    })),
  }
}

/**
 * The first state of a new mosaic: the coordinates it was seeded with.
 *
 * Passed in rather than worked out again, so there is one description of what a
 * fresh mosaic looks like rather than two that can disagree.
 */
export function initialState(
  x: Record<string, Coordinate>,
  y: Record<string, Coordinate>,
  font: FontSettings,
): MosaicState {
  return {
    id: stateId(),
    x: stripRim(x),
    y: stripRim(y),
    glyphColour: {},
    tileColour: {},
    background: null,
    // No border until one is added, so a new mosaic looks exactly as it always
    // did — the same rule the backdrop above it follows.
    stroke: null,
    chars: {},
    holdMs: MOSAIC_DEFAULT_HOLD_MS,
    transitionMs: MOSAIC_DEFAULT_TRANSITION_MS,
    easing: MOSAIC_DEFAULT_EASING,
    font: { ...font },
    ...MOSAIC_DEFAULT_SPACING,
    ...MOSAIC_DEFAULT_CORNERS,
  }
}

const stripRim = (values: Record<string, Coordinate>): Record<string, Coordinate> =>
  Object.fromEntries(Object.entries(values).filter(([id]) => !isRim(id)))

/**
 * A state copied for a new one to start from.
 *
 * Fresh id, cloned maps. Copying rather than seeding is what makes a new state
 * continuous with the one before it: the mosaic does not jump when a state is
 * added, it simply has somewhere new to be moved to.
 */
export function copyState(state: MosaicState): MosaicState {
  return {
    ...state,
    id: stateId(),
    x: { ...state.x },
    y: { ...state.y },
    glyphColour: { ...state.glyphColour },
    tileColour: { ...state.tileColour },
    chars: { ...state.chars },
  }
}

/**
 * Whether two states describe the same picture.
 *
 * Everything that shows: where the lines sit, how far apart the tiles are, what
 * the letters are set in, and what colour they and their backgrounds are. Not
 * timing or easing — those are how a state is reached, not what it looks like,
 * and two states a second apart still look identical.
 *
 * Two things lean on this. Removing a state asks first only when the states
 * being lost differ, which is what separates a silent deletion from a question;
 * and an edit carries forward through the states that are still copies, which is
 * what stops a mosaic animating the moment it is first touched. Both would be
 * wrong if spacing or font were left out — a state given its own gap is
 * authored, and must neither be overwritten nor thrown away without asking.
 */
export function sameGeometry(a: MosaicState, b: MosaicState, tolerance = 1e-9): boolean {
  if (
    Math.abs(a.gap - b.gap) > tolerance ||
    Math.abs(a.outerPadding - b.outerPadding) > tolerance ||
    Math.abs(a.glyphInset - b.glyphInset) > tolerance ||
    // Corners show, so they count. A state rounded differently is authored, and
    // must neither be overwritten by an edit carrying forward nor thrown away
    // without asking.
    Math.abs(a.tileRadius - b.tileRadius) > tolerance ||
    Math.abs(a.outerRadius - b.outerRadius) > tolerance
  ) {
    return false
  }
  if (
    a.font.fontId !== b.font.fontId ||
    a.font.weight !== b.font.weight ||
    a.font.italic !== b.font.italic
  ) {
    return false
  }

  /*
   * Colour counts too. Left out, a state whose only difference was a colour
   * would read as an untouched copy — so the next edit would overwrite it, and
   * deleting it would not think to ask.
   */
  /*
   * The letters count as much as the colours do. A state that says something
   * different is authored, and must neither be overwritten by an edit carrying
   * forward nor thrown away without asking.
   */
  const written = (state: MosaicState): string =>
    Object.entries(state.chars)
      .filter(([, char]) => char !== '')
      .sort(([one], [two]) => (one < two ? -1 : 1))
      .map(([id, char]) => `${id}:${char}`)
      .join('|')
  if (written(a) !== written(b)) return false

  // The backdrop shows as much as any tile's does, so a state that has one is
  // authored and must not be overwritten by an edit carrying forward.
  if ((a.background ?? null) !== (b.background ?? null)) return false

  // And its border, for exactly the reason the corners are counted above: it
  // shows. A state given an edge of its own has been authored, and neither an
  // edit carrying forward nor a delete may treat it as an untouched copy.
  if (!sameStroke(a.stroke ?? null, b.stroke ?? null, tolerance)) return false

  for (const map of ['glyphColour', 'tileColour'] as const) {
    const left = a[map] as Record<string, string | null>
    const right = b[map] as Record<string, string | null>
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if ((left[key] ?? null) !== (right[key] ?? null)) return false
    }
  }

  for (const axis of ['x', 'y'] as const) {
    const left = a[axis]
    const right = b[axis]
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      const one = left[key]
      const other = right[key]
      if (one === undefined || other === undefined) return false
      if (Math.abs(one - other) > tolerance) return false
    }
  }
  return true
}

/**
 * A run along one axis, in coordinate units.
 *
 * Detachment is described by a LIST of these rather than one range: a selection
 * can have gaps, and a bounding range would sweep the tiles in them along with
 * it.
 */
export interface Span {
  from: number
  to: number
}

export interface ForkResult {
  tiles: MosaicTile[]
  /** The coordinate that was minted, and the value it starts at. */
  created: string
  value: Coordinate
  /** How far each run of the detachment actually reached, after swallowing whole tiles. */
  covers: Span[]
}

/**
 * Pull one line apart from the tiles that share it.
 *
 * Tiles sharing a coordinate are aligned, and moving it moves all of them —
 * which is what keeps a grid a grid, and what should happen by default. This is
 * how a tile stops being aligned: a new coordinate with the same value, and the
 * tiles the selection covers repointed at it. Nothing moves, nothing is created
 * or destroyed; afterwards those tiles have an edge of their own.
 *
 * `spans` are the runs along the OTHER axis that the selection covers. Every
 * tile touching the line inside one of them is repointed — both sides of it, or
 * the two halves would come apart and leave a gap.
 *
 * A LIST of runs rather than one range, because a selection need not be
 * contiguous. Asked for a single bounding range, picking the two end tiles of a
 * row and dragging their shared line resized the tile between them as well: it
 * fell inside the bounds, so it was repointed along with the rest and followed
 * the drag. The runs say "these tiles and not the one in the gap", which a
 * bounding range cannot. One coordinate is minted for all of them together, so
 * the runs still move as one line.
 *
 * A tile that only PARTLY overlaps a run cannot be repointed as it is: moving
 * one of its corners and not the other would tear it in half. So each run grows
 * to swallow that tile whole, and keeps growing until nothing is left
 * straddling. The result reaches a little further than was asked for — which is
 * why the caller is told, through `covers` — but it is the smallest detachment
 * that does not tear anything, and it is always far smaller than leaving the
 * line shared with the whole row.
 *
 * The growth terminates: a run only ever widens, and the line is finite.
 */
export function forkCoordinate(
  tiles: readonly MosaicTile[],
  values: Record<string, Coordinate>,
  axis: 'x' | 'y',
  id: string,
  spans: Span | readonly Span[],
  perpendicular: Record<string, Coordinate>,
): ForkResult | null {
  const tolerance = 1e-9
  const low = (tile: MosaicTile): number =>
    valueOf(perpendicular, axis === 'x' ? tile.top : tile.left)
  const high = (tile: MosaicTile): number =>
    valueOf(perpendicular, axis === 'x' ? tile.bottom : tile.right)
  const touches = (tile: MosaicTile): boolean =>
    axis === 'x' ? tile.left === id || tile.right === id : tile.top === id || tile.bottom === id

  const touching = tiles.filter(touches)
  if (touching.length === 0) return null

  // Widen each run until no tile is left half in and half out of it.
  const covers = (Array.isArray(spans) ? spans : [spans as Span]).map((span) => {
    let { from, to } = span
    for (let pass = 0; pass < touching.length + 1; pass++) {
      let grew = false
      for (const tile of touching) {
        const a = low(tile)
        const b = high(tile)
        const outside = b <= from + tolerance || a >= to - tolerance
        if (outside) continue
        if (a < from - tolerance) {
          from = a
          grew = true
        }
        if (b > to + tolerance) {
          to = b
          grew = true
        }
      }
      if (!grew) break
    }
    return { from, to }
  })

  const within = (tile: MosaicTile): boolean =>
    covers.some(
      (run) => low(tile) >= run.from - tolerance && high(tile) <= run.to + tolerance,
    )
  const affected = touching.filter(within)
  if (affected.length === 0) return null

  const created = coordId()
  const value = valueOf(values, id)
  const chosen = new Set(affected.map((tile) => tile.id))

  return {
    covers,
    tiles: tiles.map((tile) => {
      if (!chosen.has(tile.id)) return tile
      if (axis === 'x') {
        return {
          ...tile,
          left: tile.left === id ? created : tile.left,
          right: tile.right === id ? created : tile.right,
        }
      }
      return {
        ...tile,
        top: tile.top === id ? created : tile.top,
        bottom: tile.bottom === id ? created : tile.bottom,
      }
    }),
    created,
    value,
  }
}

export interface MergeResult {
  tiles: MosaicTile[]
  /** Coordinates no tile names any more. Drop these from every state. */
  retired: string[]
}

/**
 * Put back together the lines that a fork pulled apart.
 *
 * Forking is how a drag stops a whole column following one tile: it mints a
 * second coordinate at the same value and repoints the tiles on the selection's
 * side. That happens silently on almost every drag, and until now it only ever
 * happened in one direction — so a mosaic accumulated coordinates and slowly
 * stopped being a grid, with lines a fraction of a unit apart that looked level
 * and could never move together again.
 *
 * Two coordinates on an axis holding the same value ARE the same line: the
 * layout they produce is identical either way, so unifying them cannot move
 * anything. All it changes is the future — the tiles now share a number, so the
 * next drag moves them as one. That is the grid healing itself, and it is only
 * reachable at all because snapping makes two separate drags land on the very
 * same value. See `snap.ts`.
 *
 * Every state has to agree before two lines are unified. A state says where the
 * lines of a given set of tiles sit; two that coincide in the state on show but
 * part company in another are genuinely different lines, and merging them would
 * quietly flatten an animation into a still.
 */
export function mergeCoordinates(
  tiles: readonly MosaicTile[],
  perState: readonly Record<string, Coordinate>[],
  axis: 'x' | 'y',
  /**
   * Restrict to lines a gesture actually wrote. Without it every coincidence in
   * the mosaic is fair game, so dragging one line could silently join two others
   * on the far side — true to the model, but not to what anyone just did.
   */
  only?: ReadonlySet<string>,
  tolerance = 1e-9,
): MergeResult | null {
  if (perState.length === 0) return null

  const named = new Set<string>()
  for (const tile of tiles) {
    named.add(axis === 'x' ? tile.left : tile.top)
    named.add(axis === 'x' ? tile.right : tile.bottom)
  }
  // The rim is answered from constants rather than stored, so it is nobody's to
  // merge — and a stored line that reached it would be a collapsed mosaic.
  const ids = [...named].filter((id) => !isRim(id))
  if (ids.length < 2) return null

  const agrees = (a: string, b: string): boolean =>
    perState.every((state) => Math.abs(valueOf(state, a) - valueOf(state, b)) <= tolerance)

  const first = perState[0] as Record<string, Coordinate>
  // Sorted by value so equal lines are adjacent; by id after that, so the same
  // mosaic always merges the same way whatever order the tiles arrived in.
  const sorted = [...ids].sort(
    (a, b) => valueOf(first, a) - valueOf(first, b) || (a < b ? -1 : a > b ? 1 : 0),
  )

  const groups: string[][] = []
  for (const id of sorted) {
    const open = groups[groups.length - 1]
    // Against the group's FIRST member, never its last: comparing in a chain
    // lets a run of near-equal lines drift arbitrarily far from where it began.
    if (open && agrees(open[0] as string, id)) open.push(id)
    else groups.push([id])
  }

  const survivorOf = new Map<string, string>()
  const retired: string[] = []
  for (const group of groups) {
    if (group.length < 2) continue
    if (only && !group.some((id) => only.has(id))) continue
    /*
     * The line that was already there outlives the one just dragged onto it, so
     * a fork dissolves back into what it was forked from rather than replacing
     * it. Geometrically the choice is free — the values are equal — but it keeps
     * ids stable for everything else that holds one.
     */
    const keep = (only ? group.find((id) => !only.has(id)) : undefined) ?? (group[0] as string)
    for (const id of group) {
      if (id === keep) continue
      survivorOf.set(id, keep)
      retired.push(id)
    }
  }
  if (retired.length === 0) return null

  const repoint = (id: string): string => survivorOf.get(id) ?? id
  return {
    retired,
    tiles: tiles.map((tile) =>
      axis === 'x'
        ? { ...tile, left: repoint(tile.left), right: repoint(tile.right) }
        : { ...tile, top: repoint(tile.top), bottom: repoint(tile.bottom) },
    ),
  }
}

export interface Reseeded {
  tiles: MosaicTile[]
  x: Record<string, Coordinate>
  y: Record<string, Coordinate>
  /** Letters with nowhere to go, because the grid is smaller than what was there. */
  dropped: string[]
}

/**
 * Put a mosaic back to the grid it was seeded as.
 *
 * "Reset" means the shape it had before anyone dragged anything — not an even
 * redistribution of whatever lines happen to exist now. The difference matters
 * because dragging FORKS lines: pull one tile's edge and the line it sat on
 * splits in two, so a mosaic that began as four columns can be holding seven
 * coordinates by the time it looks wrong. Spreading those seven out evenly
 * would produce a tidy mosaic that is not the one that was made. Rebuilding
 * from the seed drops every fork by construction, because it starts again from
 * columns and rows.
 *
 * Tile ids and letters are carried across in the order given — pass them in
 * reading order — so the caret, the selection and every colour keyed by tile id
 * survive a reset. Ids run out in whichever direction the counts differ: a
 * mosaic with more tiles than its seed had (someone split one) loses the
 * overflow, and one with fewer gains fresh empty tiles.
 */
export function reseedMosaic(
  ordered: readonly MosaicTile[],
  columns: number,
  rows: number,
): Reseeded {
  const fresh = seedMosaic(columns, rows)
  const tiles = fresh.tiles.map((tile, at) => {
    const was = ordered[at]
    return was ? { ...tile, id: was.id } : tile
  })
  return {
    tiles,
    x: fresh.x,
    y: fresh.y,
    dropped: ordered.slice(fresh.tiles.length).map((tile) => tile.id),
  }
}

/**
 * How many cells of the seeded grid lie before each line, read off the tiles.
 *
 * This is what "back to the original grid" actually means, and it cannot be
 * worked out from a line's VALUE. Dragging forks lines: a mosaic seeded with a
 * line at a fifth can be holding two of them, and if one was dragged past the
 * next seed position, sending each to the nearest one puts it on top of its
 * neighbour and collapses the tile between. The line's own number has forgotten
 * where it came from.
 *
 * The tiles have not. Every tile says `left` comes before `right`, so the lines
 * form a chain from one side of the mosaic to the other, and a line's place in
 * that chain is the number of cells to its left. Two halves of a fork sit at the
 * same depth — nothing separates them, because a fork puts no tile between them
 * — so they come home to the same position, which is exactly the line they were
 * forked from.
 *
 * Null when the chain does not fit the seeded grid, which is what a SPLIT tile
 * does: it adds a line between two seeded ones and makes the mosaic one cell
 * deeper than the grid it was made as. There is no honest place to send that
 * line, so the caller refuses rather than collapsing something.
 */
export function gridRanks(
  tiles: readonly MosaicTile[],
  axis: 'x' | 'y',
): Map<string, number> | null {
  const low = axis === 'x' ? X_MIN : Y_MIN
  const high = axis === 'x' ? X_MAX : Y_MAX

  const after = new Map<string, string[]>()
  const waiting = new Map<string, number>()
  const nodes = new Set<string>([low, high])

  for (const tile of tiles) {
    const from = axis === 'x' ? tile.left : tile.top
    const to = axis === 'x' ? tile.right : tile.bottom
    nodes.add(from)
    nodes.add(to)
    const list = after.get(from)
    if (list) list.push(to)
    else after.set(from, [to])
    waiting.set(to, (waiting.get(to) ?? 0) + 1)
  }

  // Longest path from the near rim: a line is as deep as the deepest route to
  // it, which is the number of cells that must fit before it.
  const rank = new Map<string, number>()
  for (const node of nodes) rank.set(node, 0)

  const ready: string[] = []
  for (const node of nodes) if ((waiting.get(node) ?? 0) === 0) ready.push(node)

  let seen = 0
  while (ready.length > 0) {
    const node = ready.pop() as string
    seen++
    for (const next of after.get(node) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(node) ?? 0) + 1))
      const left = (waiting.get(next) ?? 0) - 1
      waiting.set(next, left)
      if (left === 0) ready.push(next)
    }
  }
  // A cycle would mean a tile whose left is also its right, by some route: not a
  // dissection at all. Nothing should be able to build one, so this is a guard.
  if (seen !== nodes.size) return null

  return rank
}
