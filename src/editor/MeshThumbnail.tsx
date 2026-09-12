import { svgPaints } from './svgPaint'
import { useMemo, type ReactElement } from 'react'

import { strokeReach } from '../geometry/stroke'
import { glyphPathString, glyphRest } from '../mesh/glyph'
import { meshChars, meshCorners, meshTiles } from '../mesh/layout'
import { polygonBounds, cellMap, commandsToPath, edgesOf, roundedPolygonCommands } from '../mesh/mesh'
import { silhouetteCommands } from './meshPlayback'
import { useDocumentStore } from '../state/documentStore'
import type { MeshObject } from '../types/document'
import type { MeshState } from '../types/mesh'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'

/**
 * One state of a mesh, drawn small — the mesh's `StateThumbnail`, from the
 * same functions the canvas draws with: the polygons from `meshTiles`, the
 * letters poured through each cell's map, the rim as the clip and the border.
 */
export function MeshThumbnail({ object, at, size }: { object: MeshObject; at: number; size: number }) {
  const state = object.states[at]
  const page = useDocumentStore((s) => s.doc.artboard.background)

  const body = useMemo(
    () => (state ? draw(object, at, state) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, object.tiles, object.localBounds, at],
  )

  const box = object.localBounds
  if (!body) return <span className="thumb thumb--empty" style={{ width: size, height: size }} />

  const reach = strokeReach(state?.stroke ?? null) + (state?.outerPadding ?? 0)
  return (
    <svg
      className="thumb"
      style={{ width: size, height: size, background: page }}
      viewBox={`${box.x - reach} ${box.y - reach} ${box.width + reach * 2} ${box.height + reach * 2}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  )
}

function draw(object: MeshObject, at: number, state: MeshState) {
  const tiles = meshTiles(object, at)
  const chars = meshChars(object, at)
  const corners = meshCorners(object, at)
  const clip = `thumb-clip-${object.id}-${at}`
  const nodes = state.nodes
  const paints = svgPaints(`thumb-${object.id}-${at}`, useDocumentStore.getState().doc.assets)

  // The silhouette, grown by the padding: the clip, the border and the backdrop.
  const rim = commandsToPath(
    silhouetteCommands(object.backdrop, object.tiles, nodes, corners.outerRadius, state.outerPadding),
  )

  const cells: ReactElement[] = []
  for (const tile of object.tiles) {
    const layout = tiles.get(tile.id)
    if (!layout) continue

    const fill = state.tileColour[tile.id] ?? null
    if (fill) {
      cells.push(
        <path
          key={`t-${tile.id}`}
          d={commandsToPath(roundedPolygonCommands(layout.visible, corners.tileRadius))}
          fill={paints.fill(fill, polygonBounds(layout.visible))}
        />,
      )
    }

    const char = chars[tile.id]
    if (!char) continue
    const rest = glyphRest(state.font.fontId, char)
    const map = cellMap(layout)
    if (!rest || !map) continue
    cells.push(
      <path
        key={`g-${tile.id}`}
        d={glyphPathString(rest, map)}
        fill={paints.fill(state.glyphColour[tile.id] ?? DEFAULT_GLYPH_COLOUR, polygonBounds(layout.glyph))}
      />,
    )
  }

  const lines: string[] = []
  if (state.lines && state.lines.width > 0) {
    for (const edge of edgesOf(object.tiles).values()) {
      const a = nodes[edge.a]
      const b = nodes[edge.b]
      if (a && b) lines.push(`M${a.x} ${a.y}L${b.x} ${b.y}`)
    }
  }

  return (
    <>
      <defs>{paints.defs()}</defs>
      <defs>
        <clipPath id={clip} clipRule="evenodd">
          <path d={rim} clipRule="evenodd" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {state.background ? <path d={rim} fill={paints.fill(state.background, object.localBounds)} fillRule="evenodd" /> : null}
        {cells}
        {lines.length > 0 && state.lines ? (
          <path
            d={lines.join(' ')}
            fill="none"
            stroke={paints.fill(state.lines.colour)}
            strokeWidth={state.lines.width}
            strokeDasharray={
              state.lines.dash ? `${state.lines.dash.length} ${state.lines.dash.gap}` : undefined
            }
          />
        ) : null}
      </g>
      {state.stroke && state.stroke.width > 0 ? (
        <path
          d={rim}
          fill="none"
          stroke={paints.fill(state.stroke.colour)}
          strokeWidth={state.stroke.width}
          strokeDasharray={
            state.stroke.dash ? `${state.stroke.dash.length} ${state.stroke.dash.gap}` : undefined
          }
        />
      ) : null}
    </>
  )
}
