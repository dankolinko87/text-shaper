import { glyphCommands, graphemeSupport } from '../mosaic/glyph'
import { inkBoxIn } from '../mosaic/glyphFit'
import { getLoadedFont, isFontLoaded, measureInkExtent } from '../typography/fontRegistry'
import type { Rect, Vec2 } from '../types/document'
import type { PathCommand } from './mesh'

/**
 * A letter as a mesh tile pours it: the outline at rest in the unit square,
 * ready to be mapped through a cell.
 *
 * The mosaic cuts each letter as a path STRING stretched into its rectangle,
 * and moves it with a transform. A mesh cell is not a rectangle, so its letter
 * has to be mapped point by point — and mapped again every frame while the
 * cell moves. So the outline is kept as NUMBERS: opentype's own commands
 * placed into the unit square exactly as `glyphInRect` would place them into
 * a tile (the ink box filling it, narrow and short glyphs held back), and
 * subdivided ONCE into short straight pieces, so that a straight stem follows
 * a sloped side instead of cutting across it — the same rule the typography
 * emitter has for the same reason. Curves become a few pieces each; straight
 * runs are split by their extent. The count is then fixed for the letter's
 * life, which is what lets playback rewrite the numbers of an existing path
 * in place, without allocating and without parsing anything.
 */

export interface RestPoint {
  type: 'M' | 'L' | 'Z'
  x: number
  y: number
}

/** A letter's outline, subdivided, in the unit square. */
export interface GlyphRest {
  points: RestPoint[]
}

const UNIT: Rect = { x: 0, y: 0, width: 1, height: 1 }
/** Pieces a curve becomes. Four keeps a display capital under three hundred points. */
const CURVE_STEPS = 4
/** How much of the square a straight piece may span before it is split. */
const MAX_SEGMENT = 1 / 6
const MAX_LINE_STEPS = 32
/** How thick the missing-glyph frame is, as a share of the square. */
const TOFU_WEIGHT = 0.08

/** Outlines never change once a font has arrived, so one per (font, letter). */
const cache = new Map<string, GlyphRest>()

/**
 * The rest outline of one character, or null when there is nothing to draw:
 * no font yet, an empty character, or one that inks nothing. A character the
 * font cannot draw gets a tofu, so a hole in the font never looks empty.
 */
export function glyphRest(fontId: string, char: string): GlyphRest | null {
  if (!char || !isFontLoaded(fontId)) return null
  const key = `${fontId}|${char}`
  const seen = cache.get(key)
  if (seen) return seen

  const rest = buildRest(fontId, char)
  if (rest) cache.set(key, rest)
  return rest
}

function buildRest(fontId: string, char: string): GlyphRest | null {
  const font = getLoadedFont(fontId)
  if (!font) return null

  const support = graphemeSupport(fontId, char)
  if (support === 'blank') return null
  if (support === 'missing') return tofuRest()

  const ink = measureInkExtent(fontId, char)
  if (!(ink.width > 0) || !(ink.height > 0)) return null

  const commands = glyphCommands(font, char, 1)
  if (!commands) return tofuRest()

  // The ink box on the unit square — the whole of it for a letter and less for
  // a mark — and the same stretch a tile gives, applied to every point.
  const box = inkBoxIn(fontId, char, UNIT)
  const scaleX = box.width / ink.width
  const scaleY = box.height / ink.height
  const place = (x: number, y: number): Vec2 => ({
    x: box.x + (x - ink.left) * scaleX,
    y: box.y + (y - ink.top) * scaleY,
  })

  const points: RestPoint[] = []
  let current: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = { x: 0, y: 0 }

  const straightTo = (to: Vec2, includeEnd: boolean): void => {
    const extent = Math.max(Math.abs(to.x - current.x), Math.abs(to.y - current.y))
    const steps = extent > MAX_SEGMENT ? Math.min(MAX_LINE_STEPS, Math.ceil(extent / MAX_SEGMENT)) : 1
    const last = includeEnd ? steps : steps - 1
    for (let i = 1; i <= last; i++) {
      const t = i / steps
      points.push({
        type: 'L',
        x: current.x + (to.x - current.x) * t,
        y: current.y + (to.y - current.y) * t,
      })
    }
  }

  for (const command of commands) {
    if (command.type === 'M') {
      const p = place(command.x, command.y)
      points.push({ type: 'M', x: p.x, y: p.y })
      current = p
      start = p
    } else if (command.type === 'L') {
      const p = place(command.x, command.y)
      straightTo(p, true)
      current = p
    } else if (command.type === 'Q') {
      const c = place(command.x1, command.y1)
      const p = place(command.x, command.y)
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS
        const u = 1 - t
        points.push({
          type: 'L',
          x: u * u * current.x + 2 * u * t * c.x + t * t * p.x,
          y: u * u * current.y + 2 * u * t * c.y + t * t * p.y,
        })
      }
      current = p
    } else if (command.type === 'C') {
      const c1 = place(command.x1, command.y1)
      const c2 = place(command.x2, command.y2)
      const p = place(command.x, command.y)
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS
        const u = 1 - t
        points.push({
          type: 'L',
          x: u * u * u * current.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x,
          y: u * u * u * current.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y,
        })
      }
      current = p
    } else {
      // `Z` draws a straight piece back to the contour's start; walk it out so
      // it follows the cell like every other side, then close over the rest.
      straightTo(start, false)
      points.push({ type: 'Z', x: 0, y: 0 })
      current = start
    }
  }

  return points.length > 0 ? { points } : null
}

/** Four bars round the square — the box a browser shows for a glyph the font lacks. */
function tofuRest(): GlyphRest {
  const t = TOFU_WEIGHT
  const points: RestPoint[] = []
  const bar = (x: number, y: number, w: number, h: number): void => {
    points.push({ type: 'M', x, y })
    points.push({ type: 'L', x: x + w, y })
    points.push({ type: 'L', x: x + w, y: y + h })
    points.push({ type: 'L', x, y: y + h })
    points.push({ type: 'Z', x: 0, y: 0 })
  }
  bar(0, 0, 1, t)
  bar(0, 1 - t, 1, t)
  bar(0, t, t, 1 - 2 * t)
  bar(1 - t, t, t, 1 - 2 * t)
  return { points }
}

/**
 * Write the letter through a cell map into an existing command array,
 * reusing its arrays where they are the right shape — nothing is allocated
 * on a frame where the array was written before.
 */
export function emitGlyph(
  rest: GlyphRest,
  map: (u: number, v: number) => Vec2,
  out: PathCommand[],
): void {
  const points = rest.points
  out.length = points.length
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as RestPoint
    const existing = out[i]
    if (p.type === 'Z') {
      if (!existing || existing.length !== 1) out[i] = ['Z']
      continue
    }
    const q = map(p.x, p.y)
    if (existing && existing.length === 3) {
      existing[0] = p.type
      existing[1] = q.x
      existing[2] = q.y
    } else {
      out[i] = [p.type, q.x, q.y]
    }
  }
}

/** The letter through a cell map, as fresh commands. */
export function glyphCommandsThrough(rest: GlyphRest, map: (u: number, v: number) => Vec2): PathCommand[] {
  const out: PathCommand[] = []
  emitGlyph(rest, map, out)
  return out
}

/** The same as an SVG `d` string, for the thumbnails. */
export function glyphPathString(
  rest: GlyphRest,
  map: (u: number, v: number) => Vec2,
  places = 3,
): string {
  const n = (v: number): string => Number(v.toFixed(places)).toString()
  const out: string[] = []
  for (const p of rest.points) {
    if (p.type === 'Z') {
      out.push('Z')
      continue
    }
    const q = map(p.x, p.y)
    out.push(`${p.type}${n(q.x)} ${n(q.y)}`)
  }
  return out.join('')
}

/** The same drawn straight onto a 2D context, for the GIF. */
export function glyphPath2D(
  rest: GlyphRest,
  map: (u: number, v: number) => Vec2,
  ctx: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void },
): void {
  for (const p of rest.points) {
    if (p.type === 'Z') {
      ctx.closePath()
      continue
    }
    const q = map(p.x, p.y)
    if (p.type === 'M') ctx.moveTo(q.x, q.y)
    else ctx.lineTo(q.x, q.y)
  }
}
