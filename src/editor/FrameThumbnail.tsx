import { solidOf } from '../typography/paint'
import { svgPaints } from './svgPaint'
import { useMemo, type ReactElement } from 'react'

import { memberAtState, stateShape, valuesFor } from '../frame/frame'
import { dashArrayFor, strokePaint } from '../geometry/stroke'
import { useDocumentStore } from '../state/documentStore'
import { fitObject, frameAt, pourThrough, stillFrame } from '../typography/objectFit'
import { isFontLoaded } from '../typography/fontRegistry'
import type { FillPaint } from '../typography/colour'
import type { FrameObject, TypographyObject } from '../types/document'
import type { FrameMember, FrameState } from '../types/frame'

/**
 * One state of a frame, drawn small — and drawn for real.
 *
 * The mosaic's `StateThumbnail`, for the other thing that has states, and for
 * the same reason it is a render rather than a schematic: a row of grey boxes
 * hid the one thing a frame's states are about, that the objects are somewhere
 * else, some other colour, some other shape in each of them. Boxes also could
 * not show a rotation, a flip or the backdrop, so two states differing in
 * exactly those looked identical in the list.
 *
 * Built the way the canvas draws a member: the member AS THE STATE HAS IT
 * through `memberAtState`, fitted by the same `fitObject`, and — where the
 * state reshaped it — poured through the state's outline with the layout held
 * still, which is exactly what the canvas does. Anything else would be a second
 * renderer to keep in step with the first.
 *
 * SVG, because it costs nothing to keep and there are at most twelve of them.
 */
export function FrameThumbnail({
  object,
  at,
  size,
}: {
  object: FrameObject
  at: number
  size: number
}) {
  const state = object.states[at]
  const page = useDocumentStore((s) => s.doc.artboard.background)

  /*
   * Rebuilt only when THIS state changes, or the members do.
   *
   * Fitting type is not free, and a list of twelve states would otherwise fit
   * every member twelve times on every keystroke into any one of them. The
   * state object is a fresh value whenever the store rewrites it, and so is the
   * members array whenever a member's own object changes.
   */
  const drawn = useMemo(
    () => (state ? draw(object, state) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, object.members, object.localBounds],
  )

  const box = object.localBounds
  if (!drawn) return <span className="thumb thumb--empty" style={{ width: size, height: size }} />

  return (
    <svg
      className="thumb"
      // On the PAGE's colour, so a frame with no backdrop of its own shows its
      // members over what is actually behind them on the artboard.
      style={{ width: size, height: size, background: page }}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {drawn}
    </svg>
  )
}

/** Everything a thumbnail draws for one member, as path data and paints. */
export interface MemberArtwork {
  memberId: string
  /** The container's own outline, as the state has it. */
  container: string
  containerFill: string | null
  stroke: { colour: string; width: number; dash: number[] | null } | null
  /** The type, as fitted and — if the state reshaped the member — poured. */
  text: string | null
  textFill: string | null
  band: string | null
  bandFill: string | null
  transform: FrameMember['object']['transform']
  opacity: number
}

/**
 * The artwork for every member of one state, in painting order.
 *
 * Pure and exported, so a test can hold it against what the canvas fits and
 * pours for the same state. A member that is not typography draws its own box
 * rather than nothing, so it still says where it is.
 */
export function frameStateArtwork(object: FrameObject, state: FrameState): MemberArtwork[] {
  return object.members.map((member) => {
    const values = valuesFor(member, state)
    const drawn = memberAtState(member, values)
    if (drawn.kind !== 'typography') {
      const b = member.object.localBounds
      return {
        memberId: member.id,
        container: `M${b.x} ${b.y}h${b.width}v${b.height}h${-b.width}Z`,
        containerFill: 'var(--text-secondary)',
        stroke: null,
        text: null,
        textFill: null,
        band: null,
        bandFill: null,
        transform: values.transform,
        opacity: values.opacity,
      }
    }
    return artworkFor(member, drawn, values)
  })
}

function artworkFor(
  member: FrameMember,
  drawn: TypographyObject,
  values: ReturnType<typeof valuesFor>,
): MemberArtwork {
  const border = drawn.appearance.containerStroke
  const stroke =
    border && border.width > 0
      ? { colour: solidOf(border.colour), width: strokePaint(border).width, dash: dashArrayFor(border) }
      : null

  const base: MemberArtwork = {
    memberId: member.id,
    container: drawn.currentSourcePath,
    containerFill: drawn.appearance.containerFill ? solidOf(drawn.appearance.containerFill) : null,
    stroke,
    text: null,
    textFill: null,
    band: null,
    bandFill: null,
    transform: values.transform,
    opacity: values.opacity * drawn.appearance.opacity,
  }

  // Its font has not arrived yet, or there is nothing to set: the shape alone.
  if (drawn.text.trim().length === 0 || !isFontLoaded(drawn.font.fontId)) return base
  const fitted = fitObject(drawn)
  if (!fitted.ok) return base

  /*
   * Reshaped by the state: the type is POURED through the state's outline with
   * the layout held still — the same call the canvas makes, so the words sit
   * where they sit on screen. Otherwise the still frame, which is what the
   * canvas draws at rest.
   */
  const shape = stateShape(member, values)?.currentSourcePath
  const source = shape ? pourThrough(drawn, fitted, shape) : null
  const frame = source ? frameAt(drawn, source, 0) : stillFrame(drawn, fitted)
  if (!frame) return base

  return {
    ...base,
    text: frame.path,
    textFill: solid(frame.textFill) ?? solidOf(drawn.appearance.textFill),
    band: frame.bandPath,
    bandFill: frame.bandFill ? (solid(frame.bandFill) ?? solidOf(drawn.appearance.lineFill)) : null,
  }
}

/** A paint as one colour; a gradient answers with the colour it starts from. */
function solid(paint: FillPaint | null | undefined): string | null {
  if (!paint) return null
  if (paint.kind === 'solid') return paint.colour
  if (paint.kind === 'image') return '#888888'
  return paint.stops[0]?.colour ?? null
}

function draw(object: FrameObject, state: FrameState): ReactElement {
  const box = object.localBounds
  const artwork = frameStateArtwork(object, state)
  const paints = svgPaints(`thumb-${object.id}-${state.id}`, useDocumentStore.getState().doc.assets)
  return (
    <>
      <defs>{paints.defs()}</defs>
      {state.background ? (
        <rect x={box.x} y={box.y} width={box.width} height={box.height} fill={paints.fill(state.background, box)} />
      ) : null}
      {artwork.map((each) => {
        const t = each.transform
        const sx = t.scaleX * (t.flipX ? -1 : 1)
        const sy = t.scaleY * (t.flipY ? -1 : 1)
        return (
          <g
            key={each.memberId}
            transform={`translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${sx} ${sy})`}
            opacity={each.opacity}
          >
            {each.containerFill ? <path d={each.container} fill={each.containerFill} /> : null}
            {each.stroke ? (
              <path
                d={each.container}
                fill="none"
                stroke={each.stroke.colour}
                strokeWidth={each.stroke.width}
                strokeDasharray={each.stroke.dash ? each.stroke.dash.join(' ') : undefined}
              />
            ) : null}
            {each.band && each.bandFill ? <path d={each.band} fill={each.bandFill} /> : null}
            {each.text && each.textFill ? <path d={each.text} fill={each.textFill} /> : null}
          </g>
        )
      })}
    </>
  )
}
