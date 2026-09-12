import { svgPaints } from './svgPaint'
import { useMemo, type ReactElement } from 'react'

import { strokeBand, strokeReach } from '../geometry/stroke'
import { glyphInRect } from '../mosaic/glyph'
import { useDocumentStore } from '../state/documentStore'
import { mosaicChars, mosaicCorners, mosaicTiles } from '../mosaic/tiles'
import type { LetterMosaicObject } from '../types/document'
import { DEFAULT_GLYPH_COLOUR, type MosaicState } from '../types/mosaic'

/**
 * One state of a mosaic, drawn small.
 *
 * A real render rather than a schematic. A row of numbers, or a grid of grey
 * boxes, hides the one thing a mosaic is actually about — that the lines are in
 * different places in every state, and the letters move with them. Told apart by
 * their compositions, the states in the list need no labelling at all.
 *
 * Built the way `mosaicGif.ts` composites a frame, from the same functions: the
 * tile rectangles from `mosaicTiles`, the letters from `glyphInRect`, the state's
 * own colours and radii. Anything else would be a second renderer to keep in
 * step with the first.
 *
 * SVG rather than canvas because it costs nothing to keep — no context, no
 * device pixel ratio, no redraw on resize — and there are at most twelve of them.
 */
export function StateThumbnail({
  object,
  at,
  size,
}: {
  object: LetterMosaicObject
  at: number
  size: number
}) {
  const state = object.states[at]
  const page = useDocumentStore((s) => s.doc.artboard.background)

  /*
   * Rebuilt only when THIS state changes.
   *
   * Cutting a dozen glyph outlines is not free, and a list of twelve states
   * would otherwise cut them all again on every keystroke into any one of them.
   * The state object is a fresh value whenever the store rewrites it, so it is
   * the whole dependency — plus the tiles, which every state shares.
   */
  const body = useMemo(
    () => (state ? draw(object, at, state) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, object.tiles, object.localBounds, at],
  )

  const box = object.localBounds
  if (!body) return <span className="thumb thumb--empty" style={{ width: size, height: size }} />

  return (
    <svg
      className="thumb"
      /*
       * On the PAGE's colour, not the panel's.
       *
       * A mosaic with no backdrop of its own is transparent, so what is behind
       * it in the thumbnail has to be what is behind it on the artboard —
       * otherwise dark letters on a light page render as dark on dark here and
       * the preview shows an empty box.
       */
      style={{ width: size, height: size, background: page }}
      /*
       * Grown by the border's reach, or an outside band would be cropped at the
       * edge of the preview — the same sum the canvas clip and the export frame
       * both use.
       */
      viewBox={(() => {
        const reach = strokeReach(state?.stroke ?? null)
        return `${box.x - reach} ${box.y - reach} ${box.width + reach * 2} ${
          box.height + reach * 2
        }`
      })()}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  )
}

function draw(object: LetterMosaicObject, at: number, state: MosaicState) {
  const box = object.localBounds
  const tiles = mosaicTiles(object, at)
  const chars = mosaicChars(object, at)
  const corners = mosaicCorners(object, at)
  const clip = `thumb-clip-${object.id}-${at}`
  const outer = fit(corners.outerRadius, box.width, box.height)

  const band =
    state.stroke && state.stroke.width > 0 ? strokeBand(box, outer, state.stroke) : null
  const paints = svgPaints(`thumb-${object.id}-${at}`, useDocumentStore.getState().doc.assets)

  const cells: ReactElement[] = []
  for (const tile of object.tiles) {
    const layout = tiles.get(tile.id)
    if (!layout) continue

    const fill = state.tileColour[tile.id] ?? null
    if (fill) {
      cells.push(
        <rect
          key={`t-${tile.id}`}
          x={layout.visible.x}
          y={layout.visible.y}
          width={layout.visible.width}
          height={layout.visible.height}
          rx={fit(corners.tileRadius, layout.visible.width, layout.visible.height)}
          fill={paints.fill(fill, layout.visible)}
        />,
      )
    }

    const char = chars[tile.id]
    if (!char) continue
    const rect = layout.glyph
    if (!(rect.width > 0) || !(rect.height > 0)) continue
    /*
     * Cut straight into the tile's own rectangle.
     *
     * The canvas and the exporter cut once at a reference size and map the
     * result into each frame, because they redraw the same letter dozens of
     * times a second. Nothing here animates, so the indirection would only be a
     * way to get the arithmetic wrong.
     */
    const data = glyphInRect(state.font.fontId, char, rect)
    if (!data) continue
    cells.push(
      <path
        key={`g-${tile.id}`}
        d={data}
        fill={paints.fill(state.glyphColour[tile.id] ?? DEFAULT_GLYPH_COLOUR, rect)}
      />,
    )
  }

  return (
    <>
      <defs>{paints.defs()}</defs>
      {outer > 0 ? (
        <defs>
          <clipPath id={clip}>
            <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={outer} />
          </clipPath>
        </defs>
      ) : null}
      <g clipPath={outer > 0 ? `url(#${clip})` : undefined}>
        {/* The ground no tile covers: the outer padding and the gaps. */}
        {state.background ? (
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={paints.fill(state.background, box)}
          />
        ) : null}
        {cells}
        {/*
          The composition's own edge, inside the same clip the canvas uses — so
          a border reads in the preview exactly as far in as it does on the
          artboard. Double width for the same reason: the clip takes the outer
          half.
        */}
      </g>
      {/*
        The border, OUTSIDE the clip — a centred or outside band lies partly
        beyond the silhouette, and the clip that cuts the composition would cut
        it away. Its own rectangle comes from the same sum the canvas uses.
      */}
      {band && state.stroke ? (
        <rect
          x={band.box.x}
          y={band.box.y}
          width={band.box.width}
          height={band.box.height}
          rx={band.radius}
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

/** A radius cannot exceed half the shorter side, or it folds through itself. */
function fit(radius: number, width: number, height: number): number {
  return Math.max(0, Math.min(radius, Math.min(width, height) / 2))
}
