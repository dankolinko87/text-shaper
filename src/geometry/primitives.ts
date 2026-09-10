import type { PathData } from '../types/document'

/**
 * Ready-made container outlines.
 *
 * Drawing freehand is the tool's own gesture, but a lot of the work starts from
 * an ordinary form — a circle, an arch, a hexagon — and hand-drawing one is
 * fiddly and never quite symmetrical. These are exact.
 *
 * Every outline is built centred on the origin and closed, in the same
 * vocabulary the freehand tracer emits (M/L/C/Q/Z, no arcs), so everything
 * downstream — the scanline sampler, the clipper, the boundary editor — treats
 * a preset and a drawn shape identically.
 */

export type PrimitiveId =
  | 'ellipse'
  | 'rectangle'
  | 'rounded'
  | 'arch'
  | 'triangle'
  | 'hexagon'

export interface PrimitiveShape {
  id: PrimitiveId
  label: string
  /**
   * Height as a share of width at which this shape is its REGULAR self — a
   * circle rather than an ellipse, an equilateral triangle rather than a squat
   * one.
   *
   * It lives on the shape because only the shape knows it. Most of these are
   * regular in a square box, but a triangle is not: an equilateral one standing
   * on a base of `w` is `w·√3/2` tall, and a caller dropping every preset into
   * the same box would quietly produce a leaning approximation of one. A hexagon
   * is the opposite trap — regular at 1, even though the box it then FILLS is
   * wider than it is tall.
   */
  aspect: number
  /** Closed outline centred on the origin, spanning `width` by `height`. */
  build: (width: number, height: number) => PathData
}

/** Control-point distance that makes a cubic match a quarter ellipse. */
const KAPPA = 0.5522847498307936

function n(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function polygon(points: readonly (readonly [number, number])[]): PathData {
  return (
    points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('') + 'Z'
  )
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathData {
  const ox = rx * KAPPA
  const oy = ry * KAPPA
  return (
    `M${n(cx - rx)} ${n(cy)}` +
    `C${n(cx - rx)} ${n(cy - oy)} ${n(cx - ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)}` +
    `C${n(cx + ox)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - oy)} ${n(cx + rx)} ${n(cy)}` +
    `C${n(cx + rx)} ${n(cy + oy)} ${n(cx + ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)}` +
    `C${n(cx - ox)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + oy)} ${n(cx - rx)} ${n(cy)}` +
    'Z'
  )
}

export const PRIMITIVES: readonly PrimitiveShape[] = [
  {
    id: 'ellipse',
    label: 'Ellipse',
    // Equal radii: a circle.
    aspect: 1,
    build: (w, h) => ellipsePath(0, 0, w / 2, h / 2),
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    // A square.
    aspect: 1,
    build: (w, h) =>
      polygon([
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]),
  },
  {
    id: 'rounded',
    label: 'Rounded rectangle',
    // A square, and its corner radius is a share of the shorter side, so all
    // four corners come out equal.
    aspect: 1,
    build: (w, h) => {
      const r = Math.min(w, h) * 0.2
      const x0 = -w / 2
      const x1 = w / 2
      const y0 = -h / 2
      const y1 = h / 2
      return (
        `M${n(x0 + r)} ${n(y0)}` +
        `L${n(x1 - r)} ${n(y0)}Q${n(x1)} ${n(y0)} ${n(x1)} ${n(y0 + r)}` +
        `L${n(x1)} ${n(y1 - r)}Q${n(x1)} ${n(y1)} ${n(x1 - r)} ${n(y1)}` +
        `L${n(x0 + r)} ${n(y1)}Q${n(x0)} ${n(y1)} ${n(x0)} ${n(y1 - r)}` +
        `L${n(x0)} ${n(y0 + r)}Q${n(x0)} ${n(y0)} ${n(x0 + r)} ${n(y0)}` +
        'Z'
      )
    },
  },
  {
    id: 'arch',
    label: 'Arch',
    /*
     * A true semicircle standing on straight sides of its own height.
     *
     * There is no regular polygon to appeal to here, so the thing worth getting
     * right is that the top is a SEMICIRCLE and not a squashed one: the cap's
     * radius is capped at `h * 0.55`, so anything much shorter than this flattens
     * it.
     */
    aspect: 1,
    build: (w, h) => {
      // Flat base, semicircular top — the classic poster silhouette, and a
      // shape whose upper boundary is a curve while its sides stay straight.
      const rx = w / 2
      const ry = Math.min(w / 2, h * 0.55)
      const top = -h / 2 + ry
      const ox = rx * KAPPA
      const oy = ry * KAPPA
      return (
        `M${n(-rx)} ${n(h / 2)}` +
        `L${n(-rx)} ${n(top)}` +
        `C${n(-rx)} ${n(top - oy)} ${n(-ox)} ${n(top - ry)} 0 ${n(top - ry)}` +
        `C${n(ox)} ${n(top - ry)} ${n(rx)} ${n(top - oy)} ${n(rx)} ${n(top)}` +
        `L${n(rx)} ${n(h / 2)}` +
        'Z'
      )
    },
  },
  {
    id: 'triangle',
    label: 'Triangle',
    // Equilateral: a triangle on a base of `w` is `w·√3/2` tall.
    aspect: Math.sqrt(3) / 2,
    build: (w, h) =>
      polygon([
        [0, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]),
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    /*
     * Regular at 1, not at the ratio of the box it ends up filling.
     *
     * The vertices are placed on an ellipse of radii `w/2` by `h/2`, so equal
     * radii put them on a circle and every side comes out the same length. The
     * BOUNDS are then wider than they are tall — `2R` by `√3·R` — which is what
     * a regular hexagon's bounds are, and not something to correct for.
     */
    aspect: 1,
    build: (w, h) => {
      const points: [number, number][] = []
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i
        points.push([(w / 2) * Math.cos(a), (h / 2) * Math.sin(a)])
      }
      return polygon(points)
    },
  },
]

export function primitiveById(id: PrimitiveId): PrimitiveShape | undefined {
  return PRIMITIVES.find((p) => p.id === id)
}
