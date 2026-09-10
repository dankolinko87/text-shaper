import * as clipperLib from 'js-angusj-clipper'
import { ClipType, EndType, JoinType, PolyFillType } from 'js-angusj-clipper'

import type { PathData } from '../types/document'
import { withPaper } from './paperContext'
import { applyToPaths } from './path'

/**
 * Polygon offsetting, used for the padded inset region that typography is
 * fitted into.
 *
 * Why this library rather than the `clipper2-js` package the spec suggested:
 * clipper2-js 1.2.4's negative offset is broken. Insetting a 0..100 square by
 * 10 returns a bbox of [10, 1.785, 109.231, 100] instead of [10, 10, 90, 90],
 * at every coordinate scale, and both the reverse-path and complement-outset
 * workarounds fail too. js-angusj-clipper returns exactly [10, 10, 90, 90],
 * outsets correctly, and correctly collapses to zero paths when over-inset —
 * which is the "padding collapses the interior" case the spec requires.
 *
 * Clipper works in 64-bit integers, so all coordinates are scaled by SCALE on
 * the way in and divided back out on the way out. No caller deals with this.
 */

const SCALE = 1000

/** Flattening tolerance when converting Béziers to polygons, in artboard units. */
const FLATTEN_TOLERANCE = 0.25

type ClipperInstance = Awaited<ReturnType<typeof clipperLib.loadNativeClipperLibInstanceAsync>>

let instance: ClipperInstance | null = null
let loading: Promise<ClipperInstance> | null = null

/**
 * The WASM module loads asynchronously and must be awaited once before any
 * offsetting runs. A module-level promise singleton means concurrent callers
 * share one load and no code path can use it uninitialised.
 */
export async function initClipper(): Promise<ClipperInstance> {
  if (instance) return instance
  if (!loading) {
    loading = clipperLib
      .loadNativeClipperLibInstanceAsync(clipperLib.NativeClipperLibRequestedFormat.WasmWithAsmJsFallback)
      .then((loaded) => {
        instance = loaded
        return loaded
      })
  }
  return loading
}

export function isClipperReady(): boolean {
  return instance !== null
}

function requireClipper(): ClipperInstance {
  if (!instance) {
    throw new Error('Clipper is not initialised — await initClipper() during startup.')
  }
  return instance
}

interface IntPoint {
  x: number
  y: number
}

/** Flatten path data into integer polygons for the clipper. */
function pathDataToPolygons(data: PathData): IntPoint[][] {
  return withPaper((scope) => {
    const item = new scope.CompoundPath(data)
    const polygons: IntPoint[][] = []
    applyToPaths(item, (path) => {
      const flattened = path.clone({ insert: false }) as paper.Path
      flattened.flatten(FLATTEN_TOLERANCE)
      const ring: IntPoint[] = flattened.segments.map((segment) => ({
        x: Math.round(segment.point.x * SCALE),
        y: Math.round(segment.point.y * SCALE),
      }))
      flattened.remove()
      if (ring.length >= 3) polygons.push(ring)
    })
    item.remove()
    return polygons
  })
}

/** Rebuild path data from integer polygons. */
function polygonsToPathData(polygons: readonly (readonly IntPoint[])[]): PathData {
  return withPaper((scope) => {
    const compound = new scope.CompoundPath({})
    for (const ring of polygons) {
      if (ring.length < 3) continue
      const path = new scope.Path({
        segments: ring.map((p) => new scope.Point(p.x / SCALE, p.y / SCALE)),
        closed: true,
      })
      compound.addChild(path)
    }
    const out = compound.pathData
    compound.remove()
    return out
  })
}

export interface InsetResult {
  /** `null` when the padding collapses the interior entirely. */
  path: PathData | null
  collapsed: boolean
}

/**
 * Inset a shape by `padding` to produce the usable typography region.
 * A negative `padding` outsets instead.
 */
export function insetPath(data: PathData, padding: number): InsetResult {
  if (padding === 0) return { path: data, collapsed: false }

  const clipper = requireClipper()
  const polygons = pathDataToPolygons(data)
  if (polygons.length === 0) return { path: null, collapsed: true }

  const offset = clipper.offsetToPaths({
    delta: -padding * SCALE,
    offsetInputs: polygons.map((polygon) => ({
      data: polygon,
      joinType: JoinType.Round,
      endType: EndType.ClosedPolygon,
    })),
    arcTolerance: 0.25 * SCALE,
  })

  if (!offset || offset.length === 0) return { path: null, collapsed: true }

  const result = polygonsToPathData(offset)
  if (!result || result.length === 0) return { path: null, collapsed: true }
  return { path: result, collapsed: false }
}

/** Boolean union — the Add brush in Phase 4. */
export function unionPaths(a: PathData, b: PathData): PathData | null {
  return booleanOp(a, b, ClipType.Union)
}

/** Boolean difference — the Erase brush in Phase 4. */
export function differencePaths(a: PathData, b: PathData): PathData | null {
  return booleanOp(a, b, ClipType.Difference)
}

function booleanOp(a: PathData, b: PathData, clipType: ClipType): PathData | null {
  const clipper = requireClipper()
  const subject = pathDataToPolygons(a)
  const clip = pathDataToPolygons(b)
  if (subject.length === 0) return clipType === ClipType.Union ? b : null

  const result = clipper.clipToPaths({
    clipType,
    subjectInputs: [{ data: subject, closed: true }],
    clipInputs: [{ data: clip }],
    subjectFillType: PolyFillType.NonZero,
  })

  if (!result || result.length === 0) return null
  const out = polygonsToPathData(result)
  return out && out.length > 0 ? out : null
}
