import { useEffect, useMemo, useRef, useState } from 'react'

import { Button, ColorField, IconButton, Slider, StrokeField, Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { FONTS } from '../fonts/manifest'
import { canReshape } from '../mosaic/boundaries'
import { gridRanks, sameGeometry } from '../mosaic/dissection'
import { EASING_LABELS, EASING_PRESETS } from '../anim/easing'
import { graphemeSupport } from '../mosaic/glyph'
import { contentBounds } from '../mosaic/layout'
import { maximumGap, maximumGlyphInset, maximumOuterPadding } from '../mosaic/spacing'
import {
  allTiles,
  colourTargets,
  mosaicChars,
  mosaicCorners,
  mosaicSpacing,
} from '../mosaic/tiles'
import { DEFAULT_OUTLINE } from '../geometry/stroke'
import { formatDuration, playbackDuration } from '../mosaic/timeline'
import { documentDefaults } from '../state/defaults'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { LetterMosaicObject } from '../types/document'
import type { PositionedStroke } from '../types/document'
import type { MosaicCorners, MosaicEasing, MosaicState } from '../types/mosaic'
import {
  DEFAULT_GLYPH_COLOUR,
  MOSAIC_DEFAULT_CORNERS,
  MOSAIC_DEFAULT_SPACING,
  MOSAIC_MAX_STATES,
  MOSAIC_MIN_STATES,
  MOSAIC_MIN_TRANSITION_MS,
  X_MAX,
  Y_MAX,
} from '../types/mosaic'
import { GridSizeField } from './GridSizeField'
import { deleteStateAt, duplicateStateAt, moveStateTo, showMosaicState } from './mosaicStates'
import { Section, ColourChip, StrokeChip } from './Section'
import { StateThumbnail } from './StateThumbnail'
import { TilePicker } from './TilePicker'
import './panels.css'

/**
 * A mosaic's panel: the grid it is made of, then its states.
 *
 * This replaces three tabs, and the reason is that they were the wrong cut.
 * Design, Colour and Animate sliced a mosaic by KIND of property, but almost
 * every property of a mosaic belongs to a STATE — where its lines sit, its
 * spacing, its corners, its colours, its letters, its font, its timing. So the
 * state picker had to be hoisted above the tabs to govern all three, and each
 * tab was then quietly editing a state named somewhere else.
 *
 * Turning it inside out, the state is the container and the properties are its
 * contents. Opening a card shows that composition on the canvas, so the open
 * card IS the state indicator; there is nothing else to keep in step.
 *
 * The one thing that is NOT per state is which tiles exist — every state shares
 * one partition, or there would be nothing to interpolate between them — so that
 * is the one thing above the list.
 */

/** How long the accent stays on a control that refused a value. */
const LIMIT_FLASH_MS = 900
/**
 * How far a press on a state's row must travel before it is a reorder.
 *
 * The row is both the thing you press to open a state and the thing you grab to
 * move one, so the press cannot decide on its own — the same rule the canvas
 * uses for a press that might be a click or might be a resize.
 */
const DRAG_SLOP_PIXELS = 4
/**
 * The preview, in pixels.
 *
 * Big enough that the letters read. Below about fifty a glyph is five pixels of
 * mush and the thumbnail says only "a mosaic", which the panel already said.
 */
const THUMB = 64

type SpacingKey = 'gap' | 'outerPadding' | 'glyphInset'
type Part = 'tiles' | 'glyphs' | 'backdrop' | 'border' | 'timing'

export function StateList({ object }: { object: LetterMosaicObject }) {
  const shown = useUiStore((s) => s.mosaicStates[object.id] ?? 0)
  const count = object.states.length
  const at = Math.min(Math.max(0, shown), count - 1)

  /*
   * What is unfolded, kept apart from what is SHOWN.
   *
   * These were the same thing to begin with — the open card was the state on
   * the canvas — which made the list an accordion: one card was always open and
   * there was no way to close the last one, because clicking it only asked to
   * show a state that was already showing.
   *
   * So opening a card still shows its state, but closing one leaves the canvas
   * where it is, and every card can be shut at once. Which state is on show is
   * then marked on the card itself rather than implied by its being open.
   *
   * Held by state ID rather than index, so duplicating or deleting a state does
   * not silently transfer "open" to whichever state slid into that slot.
   */
  const [openStates, setOpenStates] = useState<ReadonlySet<string>>(
    () => new Set(object.states[at] ? [object.states[at].id] : []),
  )
  const [openParts, setOpenParts] = useState<ReadonlySet<string>>(
    () => new Set(object.states[at] ? [`${object.states[at].id}:tiles`] : []),
  )

  const toggleState = (id: string, index: number): void => {
    /*
     * The canvas is told OUTSIDE the updater, not inside it.
     *
     * A state updater is called during render, and React may call it twice —
     * so writing to another store from in there is a store write in the render
     * phase, which React reports as updating one component while rendering
     * another. Decide here, where this is an event handler and the write is
     * plainly an effect of the click.
     */
    const opening = !openStates.has(id)
    setOpenStates((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // Opening one is asking to work on it, so the canvas follows. Closing is
    // not — it says nothing about which state you want to look at.
    if (opening) showMosaicState(object, index)
    // A card opened for the first time lands on Tiles rather than on four shut
    // lids, which is a card that has told you nothing for the click.
    setOpenParts((was) =>
      [...was].some((key) => key.startsWith(`${id}:`)) ? was : new Set([...was, `${id}:tiles`]),
    )
  }

  /*
   * Navigating on the canvas carries the open card with it.
   *
   * Stepping through states with the pill under the mosaic is how you compare
   * compositions, and arriving at one whose card is shut means opening it by
   * hand every time — which is what the accordion did for you.
   *
   * Only when something is already open, though. With the list collapsed,
   * stepping through is LOOKING, and forcing a card open would undo the
   * collapse the moment you used the canvas.
   *
   * The state being left is the one that closes, so cards opened deliberately
   * beside it stay where they are, and whichever sections were open travel
   * across — arrow through with Timing unfolded and you are comparing timings.
   */
  const previous = useRef(at)
  useEffect(() => {
    const from = previous.current
    if (from === at) return
    previous.current = at
    const left = object.states[from]?.id
    const arrived = object.states[at]?.id
    if (!arrived) return

    setOpenStates((was) => {
      if (was.size === 0) return was
      const next = new Set(was)
      if (left) next.delete(left)
      next.add(arrived)
      return next
    })

    setOpenParts((was) => {
      if (!left) return was
      const mine = [...was].filter((key) => key.startsWith(`${left}:`))
      if (mine.length === 0) return was
      const next = new Set([...was].filter((key) => !key.startsWith(`${left}:`)))
      for (const key of mine) next.add(`${arrived}:${key.slice(left.length + 1)}`)
      return next
    })
  }, [at, object.states])

  /*
   * A drag in flight: which card was picked up, and where it would land.
   *
   * Owned by the LIST rather than by a card, because a drag is a relationship
   * between two of them — the card being dragged cannot know what it is over,
   * and the card underneath cannot know what is coming.
   *
   * `into` is an insertion POINT, not a card index: it runs 0…count, so the
   * gap after the last card is expressible. Turning that into a destination
   * index is `landing()` below, and the two differ whenever a card is moved
   * downward, because removing it first shifts everything after it up one.
   */
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ from: number; startY: number; moved: boolean } | null>(null)
  const [into, setInto] = useState<number | null>(null)
  /*
   * A drag that has actually moved must not also count as a click.
   *
   * The row is both the thing you press to open a state and the thing you grab
   * to move one, and `click` fires after `pointerup` — so without this, letting
   * go of a card you just dragged would open it as well.
   */
  const draggedRef = useRef(false)

  /** Which gap the pointer is in: 0 is above the first card, `count` past the last. */
  const gapAt = (y: number): number => {
    const cards = [...(listRef.current?.children ?? [])] as HTMLElement[]
    for (let i = 0; i < cards.length; i++) {
      // The ROW's midpoint, not the card's. An open card is several hundred
      // pixels tall, and measuring its middle would put the gap above it
      // somewhere down inside its own controls.
      const card = cards[i]
      if (!card) continue
      const box = (card.firstElementChild ?? card).getBoundingClientRect()
      if (y < box.top + box.height / 2) return i
    }
    return cards.length
  }

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent): void => {
      if (!drag.moved) {
        // Held, not started — the same rule the canvas uses for a press that
        // might be a click. Below this it was a press on the row.
        if (Math.abs(e.clientY - drag.startY) < DRAG_SLOP_PIXELS) return
        setDrag((was) => (was ? { ...was, moved: true } : was))
        draggedRef.current = true
      }
      setInto(gapAt(e.clientY))
    }

    const abandon = (): void => {
      setDrag(null)
      setInto(null)
    }

    const finish = (): void => {
      // `into` is an insertion POINT in the list as it stands; the destination
      // index is one lower when the card is moving down, because taking it out
      // first shifts everything after it up.
      if (drag.moved && into !== null) {
        moveStateTo(object, drag.from, into > drag.from ? into - 1 : into)
      }
      abandon()
    }

    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      /*
       * And it stops here.
       *
       * Escape means "call off the thing in flight", and the thing in flight is
       * this drag. Left to carry on, it also reached the editor's own Escape —
       * which clears the selection — so calling off a reorder threw away the
       * mosaic you were working on and took the panel with it.
       *
       * Capture phase for the same reason: the editor's handler was bound first
       * and would otherwise have run before this one had a chance to stop it.
       */
      e.stopPropagation()
      abandon()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    /*
     * A cancelled pointer ABANDONS rather than commits.
     *
     * `pointercancel` is the browser saying it has taken the pointer away — a
     * system gesture, a scroll it decided to own — and it carries no position
     * anybody chose. Reordering the animation on the strength of that would be
     * acting on an intent the user never expressed. Escape says the same thing
     * deliberately, which is how every other drag in this editor is called off.
     */
    window.addEventListener('pointercancel', abandon)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', abandon)
      window.removeEventListener('keydown', key, true)
    }
  }, [drag, into, object])

  const togglePart = (key: string): void =>
    setOpenParts((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <>
      <div className="states">
        <header className="states__header">
          <h3 className="panel__section-title">States</h3>
          {/*
            How long a lap takes to WATCH, which is what the play button and an
            export both produce — so it is the speed's answer, not the sum of
            the states' own timings. The rate that made it differ is on the
            Playback lid above, which is also where it is changed.
          */}
          <span className="states__length">{formatDuration(playbackDuration(object))}</span>
          {/*
            One press back to a list you can read. With a dozen states open the
            panel is a scroll, and shutting them one at a time is the tax for
            having looked.
          */}
          {openStates.size > 0 ? (
            <IconButton
              icon="chevronUp"
              label="Collapse every state"
              tooltipSide="top"
              small
              onClick={() => {
                setOpenStates(new Set())
                setOpenParts(new Set())
              }}
            />
          ) : null}
          <IconButton
            icon="plus"
            label={
              count >= MOSAIC_MAX_STATES
                ? `A mosaic holds at most ${MOSAIC_MAX_STATES} states`
                : 'Add a state'
            }
            tooltipSide="top"
            small
            disabled={count >= MOSAIC_MAX_STATES}
            /*
             * A copy of the one on show, not an empty one. A new state is nearly
             * always "this again, then I change something", and an empty state
             * would animate every letter out and back for no reason.
             */
            onClick={() => duplicateStateAt(object, at)}
          />
        </header>

        <ul className="states__list" ref={listRef}>
          {object.states.map((state, index) => (
            <StateCard
              key={state.id}
              object={object}
              at={index}
              state={state}
              open={openStates.has(state.id)}
              shown={index === at}
              openParts={openParts}
              onTogglePart={togglePart}
              onToggle={() => toggleState(state.id, index)}
              dragging={drag?.moved === true && drag.from === index}
              /*
               * Which edge of THIS card the line is drawn on. An insertion
               * point of `index` is the gap above it; `index + 1` is the gap
               * below, and only the last card draws that one — otherwise every
               * gap would be claimed by two neighbours and drawn twice.
               */
              dropEdge={
                drag?.moved !== true || into === null
                  ? null
                  : into === index
                    ? 'above'
                    : into === index + 1 && index === object.states.length - 1
                      ? 'below'
                      : null
              }
              onPickUp={(startY) => {
                draggedRef.current = false
                setDrag({ from: index, startY, moved: false })
                setInto(index)
              }}
              wasDragged={() => draggedRef.current}
              onNudge={(by) => moveStateTo(object, index, index + by)}
            />
          ))}
        </ul>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ the grid */

/**
 * What every state shares: which tiles exist.
 *
 * Shut by default, and the lid carries the size — which is the thing worth
 * checking often, so opening it is for changing rather than for looking.
 */
/**
 * What every state shares — the grid — on the object's own panel. Exported
 * because the states themselves now live in the rail on the other side.
 */
export function GridSection({ object }: { object: LetterMosaicObject }) {
  const [open, setOpen] = useState(false)
  const shown = useUiStore((s) => s.mosaicStates[object.id] ?? 0)
  const at = Math.min(Math.max(0, shown), object.states.length - 1)
  const state = object.states[at]
  const spacing = mosaicSpacing(object, at)
  const content = contentBounds(object.localBounds, spacing.outerPadding)
  /*
   * A step larger than a quarter of the shorter side would put fewer than four
   * stops across the mosaic, which is a grid in name only.
   */
  const snapCeiling = Math.round(Math.min(content.width, content.height) / 4)

  /** Tiles a rebuild would have nowhere to put, because someone split one. */
  const losing = Math.max(0, object.tiles.length - object.seed.columns * object.seed.rows)

  /*
   * Whether the tiles still form the grid this mosaic was made as. Forking does
   * not change the answer — two halves of a line sit at the same depth — but a
   * SPLIT does, because it makes the mosaic one cell deeper than the seed.
   */
  const fitsTheGrid =
    gridRanks(object.tiles, 'x')?.get(X_MAX) === object.seed.columns &&
    gridRanks(object.tiles, 'y')?.get(Y_MAX) === object.seed.rows

  /*
   * Whether the spacing leaves any room to reshape in. A document can arrive
   * holding spacing that leaves none, and the layout draws it rather than
   * refusing to — so it is said out loud, and the spacing controls inside each
   * state are the repair.
   */
  const reshapable = canReshape(
    object.tiles,
    state?.x ?? {},
    state?.y ?? {},
    object.localBounds,
    spacing,
  )

  return (
    <div className="panel__grid-section">
      <Section
        title="Grid"
        summary={`${object.seed.columns} × ${object.seed.rows}`}
        open={open}
        onToggle={() => setOpen((was) => !was)}
      >
        {!reshapable ? (
          <p className="warning" role="status" aria-live="polite">
            <Icon name="warning" size={13} />
            This mosaic&rsquo;s spacing leaves its tiles no room, so its edges cannot be dragged.
            Reduce the gap, padding or glyph inset in a state to repair it.
          </p>
        ) : null}

        {/*
          Global rather than per state, and that is the model rather than a
          shortcut: every state shares one set of tiles, and a frame between two
          of them blends those tiles' coordinates. Two states with different
          grids would have no tiles in common to blend — the letters themselves
          would appear and vanish.
        */}
        <GridSizeField
          columns={object.seed.columns}
          rows={object.seed.rows}
          onChange={(columns, rows) => {
            const store = useDocumentStore.getState()
            if (!store.resizeMosaicGrid(object.id, columns, rows)) return
            store.commit('Resize grid')
          }}
        />

        {/*
          Not a spacing control: it changes nothing about how the mosaic draws.
          It decides where a dragged line may come to rest, and so whether two
          lines dragged to the same place hold the same number — which is what
          lets them become one line again instead of drifting apart for good.
        */}
        <Slider
          label="Snap"
          tip="Hold Alt to drag past the grid"
          value={object.snapStep}
          min={0}
          max={Math.max(1, snapCeiling)}
          step={1}
          editable
          onChange={(step) => useDocumentStore.getState().setMosaicSnap(object.id, step)}
          onCommit={() => useDocumentStore.getState().commit('Change snap grid')}
        />
        {!fitsTheGrid ? (
          <>
            <div className="field">
              <span className="field__label">Rebuild</span>
              <Button
                variant="ghost"
                onClick={() => {
                  const store = useDocumentStore.getState()
                  const differing = object.states.some(
                    (each, i) => i > 0 && !sameGeometry(each, object.states[0] as MosaicState),
                  )
                  const message = differing
                    ? `Rebuild the whole mosaic as a ${object.seed.columns} × ${object.seed.rows} grid? ` +
                      'Every state goes back to it, so the animation you have authored is flattened.'
                    : `Rebuild the whole mosaic as a ${object.seed.columns} × ${object.seed.rows} grid?` +
                      (losing > 0
                        ? ` The last ${losing} tile${losing === 1 ? '' : 's'} go with it.`
                        : '')
                  if (!window.confirm(message)) return
                  if (store.rebuildMosaicGrid(object.id)) store.commit('Rebuild grid')
                }}
              >
                Rebuild every state
              </Button>
            </div>
          </>
        ) : null}
      </Section>
    </div>
  )
}

/* ------------------------------------------------------------------ playback */

/**
 * How fast the whole timeline runs.
 *
 * Object-level, beside the grid, because it is the other thing that is not per
 * state — and it must not be inside a card, where it would read as that state's
 * speed and invite you to set a different one for each.
 *
 * A RATE rather than a duration, which is the whole reason it exists: it runs
 * an authored sequence faster or slower without rewriting a single state's hold
 * or transition, and `setMosaicSpeed` never touches them. That is also why the
 * lid says `2.6×` rather than a number of milliseconds.
 */
/** The clock every state is read against — the object's, not any state's. */
export function PlaybackSection({ object }: { object: LetterMosaicObject }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="panel__grid-section">
      <Section
        title="Playback"
        summary={`${Math.round(object.speed * 10) / 10}×`}
        open={open}
        onToggle={() => setOpen((was) => !was)}
      >
        <Slider
          label="Speed"
          value={object.speed}
          min={0.1}
          max={4}
          step={0.1}
          editable
          suffix="×"
          onChange={(speed) => useDocumentStore.getState().setMosaicSpeed(object.id, speed)}
          onCommit={commitWith('Change speed')}
        />
      </Section>
    </div>
  )
}

/* ----------------------------------------------------------------- one state */

function StateCard({
  object,
  at,
  state,
  open,
  shown,
  openParts,
  onTogglePart,
  onToggle,
  dragging,
  dropEdge,
  onPickUp,
  wasDragged,
  onNudge,
}: {
  object: LetterMosaicObject
  at: number
  state: MosaicState
  open: boolean
  /** On the canvas right now — which is no longer the same as being unfolded. */
  shown: boolean
  openParts: ReadonlySet<string>
  onTogglePart: (key: string) => void
  onToggle: () => void
  /** This card is the one being carried. */
  dragging: boolean
  /** Which edge the insertion line belongs on, if any. */
  dropEdge: 'above' | 'below' | null
  onPickUp: (startY: number) => void
  /** Whether the press that is ending turned into a drag, so a click is not one. */
  wasDragged: () => boolean
  onNudge: (by: number) => void
}) {
  const count = object.states.length
  const isOpen = (part: Part): boolean => openParts.has(`${state.id}:${part}`)
  const toggle = (part: Part) => () => onTogglePart(`${state.id}:${part}`)

  return (
    <li
      className="state-card"
      data-open={open}
      data-shown={shown}
      data-dragging={dragging}
      data-drop={dropEdge ?? undefined}
    >
      {/*
        The whole row is the handle, not just the grip.
        
        A list of cards is grabbed wherever you land on it — the grip is there
        to SAY that, not to be the only way in. Pointer events rather than HTML5
        drag-and-drop: this is the idiom the rest of the editor uses, it works
        the same on a trackpad and under a finger, and a press only becomes a
        drag once it has travelled, so the row still opens on a plain click.
        
        The buttons at the right opt out below — a press on delete that slid a
        few pixels should still be a press on delete.
      */}
      <div
        className="state-card__row"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          onPickUp(e.clientY)
        }}
      >
        <span className="state-card__grip" aria-hidden="true">
          <Icon name="grip" size={13} />
        </span>
        <button
          type="button"
          className="state-card__open"
          aria-expanded={open}
          onClick={() => {
            // The click that ends a real drag is not a click on the row.
            if (wasDragged()) return
            onToggle()
          }}
          /*
           * Reorderable without a mouse. A drag is the only way to say "put
           * this third" with a pointer, but it must not be the only way at all
           * — so the row that opens a state also moves it, one place per press.
           */
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            if (!e.altKey) return
            e.preventDefault()
            onNudge(e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <span className="lid-chevron" data-open={open}>
            <Icon name="chevronRight" size={13} />
          </span>
          <StateThumbnail object={object} at={at} size={THUMB} />
          <span className="state-card__meta">
            <span className="state-card__name">State {at + 1}</span>
            <span className="state-card__timing">
              {Math.round(state.holdMs)} · {Math.round(state.transitionMs)} ms
            </span>
            <span className="state-card__easing">{EASING_LABELS[state.easing]}</span>
          </span>
        </button>

        {/*
          On the row, because they act on the state the row names. Buried in a
          tab they were unreachable from the other two and read as animation
          settings; here they cost no expansion at all.
        */}
        <div className="state-card__actions" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton
            icon="duplicate"
            label={
              count >= MOSAIC_MAX_STATES
                ? `A mosaic holds at most ${MOSAIC_MAX_STATES} states`
                : 'Duplicate this state'
            }
            tooltipSide="top"
            small
            disabled={count >= MOSAIC_MAX_STATES}
            onClick={() => duplicateStateAt(object, at)}
          />
          <IconButton
            icon="trash"
            label={
              count <= MOSAIC_MIN_STATES
                ? `An animation needs at least ${MOSAIC_MIN_STATES} states`
                : 'Delete this state'
            }
            tooltipSide="top"
            small
            disabled={count <= MOSAIC_MIN_STATES}
            onClick={() => deleteStateAt(object, at)}
          />
        </div>
      </div>

      {open ? (
        <div className="state-card__body">
          <TilesSection
            object={object}
            at={at}
            open={isOpen('tiles')}
            onToggle={toggle('tiles')}
          />
          <GlyphsSection
            object={object}
            at={at}
            state={state}
            open={isOpen('glyphs')}
            onToggle={toggle('glyphs')}
          />
          <BackdropSection
            object={object}
            at={at}
            state={state}
            open={isOpen('backdrop')}
            onToggle={toggle('backdrop')}
          />
          <BorderSection
            object={object}
            at={at}
            state={state}
            open={isOpen('border')}
            onToggle={toggle('border')}
          />
          <TimingSection
            object={object}
            at={at}
            state={state}
            open={isOpen('timing')}
            onToggle={toggle('timing')}
          />
        </div>
      ) : null}
    </li>
  )
}

/* ------------------------------------------------------- shared computations */

/**
 * The three spacing sliders' legal ranges, in the state being edited.
 *
 * Nothing here is a free number: a gap wider than the narrowest tile leaves
 * tiles with no width that still take up their share of the partition and still
 * take the caret. Each maximum is worked out holding the other two where they
 * are, which is what makes the three independent in use — pushing any one to its
 * end can never make another illegal, whatever order they are touched in.
 */
function useSpacing(object: LetterMosaicObject, at: number) {
  const [limited, setLimited] = useState<SpacingKey | null>(null)
  const timer = useRef<number | null>(null)
  const state = object.states[at]
  const spacing = mosaicSpacing(object, at)
  const sets = useMemo(() => [{ x: state?.x ?? {}, y: state?.y ?? {} }], [state])

  const limits = useMemo(
    () => ({
      gap: maximumGap(object.tiles, sets, object.localBounds, {
        outerPadding: spacing.outerPadding,
        glyphInset: spacing.glyphInset,
      }),
      outerPadding: maximumOuterPadding(object.tiles, sets, object.localBounds, {
        gap: spacing.gap,
        glyphInset: spacing.glyphInset,
      }),
      glyphInset: maximumGlyphInset(object.tiles, sets, object.localBounds, {
        gap: spacing.gap,
        outerPadding: spacing.outerPadding,
      }),
    }),
    [object.tiles, object.localBounds, sets, spacing.gap, spacing.outerPadding, spacing.glyphInset],
  )

  /**
   * Ask for a value; get the legal one.
   *
   * The store clamps whatever arrives, so the request is compared with the
   * maximum here only to decide whether to say anything about it. A slider
   * cannot exceed its own range; the number field can be typed anything at all.
   */
  const write = (key: SpacingKey) => (requested: number) => {
    if (requested > limits[key] + 1e-6) {
      setLimited(key)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setLimited(null), LIMIT_FLASH_MS)
    }
    useDocumentStore.getState().setMosaicSpacing(object.id, { [key]: requested }, at)
  }

  return { spacing, limits, limited, write }
}

/**
 * What the tiles being worked on say about a colour, as one answer or as
 * "they disagree".
 *
 * A tile with no entry of its own is not undecided — it is the default — so a
 * selection of one coloured tile and one bare one genuinely IS mixed.
 */
function useColours(object: LetterMosaicObject, at: number) {
  const selection = useUiStore((s) => s.mosaicSelection)
  const previewing = useUiStore(
    (s) => s.mosaicPlayback?.object === object.id || (s.playing && object.states.length > 1),
  )
  const state = object.states[at]
  const everyTile = useMemo(() => allTiles(object, at), [object, at])
  const targets = useMemo(() => colourTargets(object, at, selection), [object, at, selection])

  const read = (
    of: (leaf: string) => string | null,
  ): { value: string; mixed: boolean; anyColoured: boolean } => {
    if (!state || targets.length === 0) {
      return { value: DEFAULT_GLYPH_COLOUR, mixed: false, anyColoured: false }
    }
    const seen = targets.map(of)
    const first = seen[0] ?? null
    return {
      value: (first ?? '#ffffffff') as string,
      mixed: seen.some((each) => each !== first),
      anyColoured: seen.some((each) => each !== null),
    }
  }

  return {
    selection,
    previewing,
    everyTile,
    targets,
    letter: read((leaf) => state?.glyphColour[leaf] ?? DEFAULT_GLYPH_COLOUR),
    background: read((leaf) => state?.tileColour[leaf] ?? null),
    // Only a preview frame locks these: with no tiles picked out there is still
    // something to colour — all of them.
    locked: previewing || targets.length === 0,
  }
}

const commitWith = (label: string) => () => useDocumentStore.getState().commit(label)


/* -------------------------------------------------------------------- tiles */

function TilesSection({
  object,
  at,
  open,
  onToggle,
}: {
  object: LetterMosaicObject
  at: number
  open: boolean
  onToggle: () => void
}) {
  const { spacing, limits, limited, write } = useSpacing(object, at)
  const { targets, background, locked } = useColours(object, at)
  const corners = mosaicCorners(object, at)
  const radiusMax = Math.max(
    1,
    Math.min(object.localBounds.width, object.localBounds.height) / 2,
  )

  const round = (key: keyof MosaicCorners) => (value: number) =>
    useDocumentStore.getState().setMosaicCorners(object.id, { [key]: value }, at)

  /*
   * Whether the tiles still form the grid this mosaic was made as. A state can
   * only be reset on its own while they do — a split makes the mosaic a cell
   * deeper than the seed, and no line can go home without collapsing something.
   */
  const fitsTheGrid =
    gridRanks(object.tiles, 'x')?.get(X_MAX) === object.seed.columns &&
    gridRanks(object.tiles, 'y')?.get(Y_MAX) === object.seed.rows

  return (
    <Section
      title="Tiles"
      summary={<ColourChip value={background.mixed ? null : background.value} />}
      open={open}
      onToggle={onToggle}
    >
      <TilePicker object={object} at={at} />


      {/*
        Its "mixed" does more work than the letter's: a tile with no background
        at all has no value to show, so a selection where none of them is
        coloured reads as mixed rather than as some colour nobody chose.
      */}
      <ColorField
        label="Background"
        value={background.value}
        mixed={background.mixed || (!background.anyColoured && targets.length > 0)}
        disabled={locked}
        onChange={(colour) =>
          useDocumentStore.getState().setMosaicTileColour(object.id, at, targets, colour)
        }
        onCommit={commitWith('Colour tiles')}
        removeLabel="Clear background"
        onRemove={() => {
          const store = useDocumentStore.getState()
          store.setMosaicTileColour(object.id, at, targets, null)
          store.commit('Clear tile colour')
        }}
      />

      {/*
        Each tile's own rectangle. With a gap between tiles this is the one that
        shows; with no gap the tiles round away from each other and the mosaic
        reads as separate stones rather than a cut block.
      */}
      <Slider
        label="Corners"
        value={corners.tileRadius}
        min={0}
        max={radiusMax}
        step={0.5}
        editable
        onChange={round('tileRadius')}
        onCommit={commitWith('Round tiles')}
      />

      {/*
        Between neighbouring tiles. One number for both directions: two would be
        two ways to say the same thing at a T-junction, where a tile's horizontal
        neighbour is another tile's vertical one.
      */}
      <Slider
        label="Gap"
        value={spacing.gap}
        min={0}
        max={Math.max(1, limits.gap)}
        step={0.5}
        editable
        limited={limited === 'gap'}
        onChange={write('gap')}
        onCommit={commitWith('Change gap')}
      />

      {/*
        Back to the grid it was MADE as, rather than an evening-out of the lines
        it holds now — dragging forks them, so a reshaped mosaic carries lines its
        seed never had, and spreading those evenly would give a tidy mosaic that
        is not the one that was made.
      */}
      <div className="field">
        {fitsTheGrid ? (
          <span className="field__label">Reset</span>
        ) : (
          <Tooltip label="Tiles were split — rebuild the grid first" side="top">
            <span className="field__label">Reset</span>
          </Tooltip>
        )}
        <Button
          variant="ghost"
          disabled={!fitsTheGrid}
          onClick={() => {
            const store = useDocumentStore.getState()
            if (store.resetMosaicGrid(object.id, at)) store.commit('Reset state layout')
          }}
        >
          This state to a {object.seed.columns} × {object.seed.rows} grid
        </Button>
      </div>

    </Section>
  )
}

/* ------------------------------------------------------------------- glyphs */

function GlyphsSection({
  object,
  at,
  state,
  open,
  onToggle,
}: {
  object: LetterMosaicObject
  at: number
  state: MosaicState
  open: boolean
  onToggle: () => void
}) {
  const { spacing, limits, limited, write } = useSpacing(object, at)
  const { targets, letter, locked } = useColours(object, at)

  const font = state?.font ?? documentDefaults.font
  const written = mosaicChars(object, at)
  const family = FONTS.find((each) => each.id === font.fontId)?.family ?? 'This font'

  /** Tiles holding something this font has no glyph for. */
  const unsupported = useMemo(
    () =>
      object.tiles.filter(
        (leaf) =>
          written[leaf.id] &&
          graphemeSupport(font.fontId, written[leaf.id] as string) === 'missing',
      ).length,
    [object.tiles, written, font.fontId],
  )

  return (
    <Section title="Glyphs" summary={family} open={open} onToggle={onToggle}>
      <div className="field">
        <label className="field__label" htmlFor={`mosaic-font-${object.id}`}>
          Font
        </label>
        <select
          id={`mosaic-font-${object.id}`}
          className="input"
          value={font.fontId}
          onChange={(e) => {
            const store = useDocumentStore.getState()
            store.setMosaicFont(object.id, { ...font, fontId: e.target.value }, at)
            store.commit('Change font')
          }}
        >
          {FONTS.map((each) => (
            <option key={each.id} value={each.id}>
              {each.family} — {each.note}
            </option>
          ))}
        </select>
      </div>

      {unsupported > 0 ? (
        /*
         * Said out loud, because the tiles themselves show a box and a box is
         * not self-explanatory. The letters are still there and still theirs — a
         * font that can draw them puts them straight back.
         */
        <p className="warning" role="status">
          <Icon name="warning" size={13} />
          {unsupported} tile{unsupported === 1 ? '' : 's'} hold{unsupported === 1 ? 's' : ''} a
          character {family} cannot draw.
        </p>
      ) : null}

      <ColorField
        label="Colour"
        value={letter.value}
        mixed={letter.mixed}
        disabled={locked}
        onChange={(colour) =>
          useDocumentStore.getState().setMosaicGlyphColour(object.id, at, targets, colour)
        }
        onCommit={commitWith('Colour letters')}
      />


      {/* Glyphs only: the tile keeps its background and its whole hit area. */}
      <Slider
        label="Inset"
        value={spacing.glyphInset}
        min={0}
        max={Math.max(1, limits.glyphInset)}
        step={0.5}
        editable
        limited={limited === 'glyphInset'}
        onChange={write('glyphInset')}
        onCommit={commitWith('Change glyph inset')}
      />

    </Section>
  )
}

/* ----------------------------------------------------------------- backdrop */

function BackdropSection({
  object,
  at,
  state,
  open,
  onToggle,
}: {
  object: LetterMosaicObject
  at: number
  state: MosaicState
  open: boolean
  onToggle: () => void
}) {
  const { spacing, limits, limited, write } = useSpacing(object, at)
  const { previewing } = useColours(object, at)
  const corners = mosaicCorners(object, at)
  const radiusMax = Math.max(
    1,
    Math.min(object.localBounds.width, object.localBounds.height) / 2,
  )
  const backdrop = state?.background ?? null

  const round = (key: keyof MosaicCorners) => (value: number) =>
    useDocumentStore.getState().setMosaicCorners(object.id, { [key]: value }, at)

  return (
    <Section
      title="Backdrop"
      summary={<ColourChip value={backdrop} />}
      open={open}
      onToggle={onToggle}
    >
      {/*
        Its reach is different from the two above: they follow the tile
        selection, this one never does. It is one colour for the composition,
        whatever is picked out.
      */}
      <ColorField
        label="Colour"
        value={backdrop ?? '#ffffffff'}
        mixed={backdrop === null}
        emptyLabel="None"
        disabled={previewing}
        onChange={(colour) =>
          useDocumentStore.getState().setMosaicBackground(object.id, at, colour)
        }
        onCommit={commitWith('Colour backdrop')}
      />

      <div className="field">
        <Button
          variant="ghost"
          disabled={previewing || backdrop === null}
          onClick={() => {
            const store = useDocumentStore.getState()
            store.setMosaicBackground(object.id, at, null)
            store.commit('Clear backdrop')
          }}
        >
          Clear backdrop
        </Button>
      </div>


      {/*
        Applied to the box BEFORE the tree is laid into it, so the whole mosaic
        draws in smaller — rather than the outer tiles alone getting thinner
        while the middle stays where it was.
      */}
      <Slider
        label="Padding"
        value={spacing.outerPadding}
        min={0}
        max={Math.max(1, limits.outerPadding)}
        step={0.5}
        editable
        limited={limited === 'outerPadding'}
        onChange={write('outerPadding')}
        onCommit={commitWith('Change outer padding')}
      />

      {/*
        The outline of the whole composition, applied as a clip — so a letter
        that reaches the edge is cut by the same curve its tile is, and the
        corners round whether or not a tile happens to sit in them.
      */}
      <Slider
        label="Corners"
        value={corners.outerRadius}
        min={0}
        max={radiusMax}
        step={0.5}
        editable
        onChange={round('outerRadius')}
        onCommit={commitWith('Round mosaic')}
      />

      {/*
        Both resets, at the foot of the last section that holds any of their
        fields. They cover three sliders each, and those no longer sit together.
      */}
      <div className="field">
        <span className="field__label">Reset</span>
        <div className="button-row">
          <Button
            variant="ghost"
            onClick={() => {
              const store = useDocumentStore.getState()
              store.setMosaicSpacing(object.id, MOSAIC_DEFAULT_SPACING, at)
              store.commit('Reset spacing')
            }}
          >
            Spacing
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const store = useDocumentStore.getState()
              store.setMosaicCorners(object.id, MOSAIC_DEFAULT_CORNERS, at)
              store.commit('Reset corners')
            }}
          >
            Corners
          </Button>
        </div>
      </div>

    </Section>
  )
}

/* ------------------------------------------------------------------- border */

/**
 * The composition's own edge, in a section of its own.
 *
 * Beside the backdrop rather than inside it, for the same reason a shape's
 * border sits beside its fill: the two are peers. One is the ground the mosaic
 * stands on, the other is the line around it, and reaching for either should
 * not mean unfolding the other.
 *
 * All three positions, like a shape. The group's clip is grown by the border's
 * outward reach so that a centred or outside band has room — see `buildMosaic`.
 */
function BorderSection({
  object,
  at,
  state,
  open,
  onToggle,
}: {
  object: LetterMosaicObject
  at: number
  state: MosaicState
  open: boolean
  onToggle: () => void
}) {
  const { previewing } = useColours(object, at)

  return (
    <Section
      title="Border"
      summary={<StrokeChip value={state?.stroke ?? null} />}
      open={open}
      onToggle={onToggle}
    >
      <StrokeField
        value={state?.stroke ?? null}
        defaults={DEFAULT_OUTLINE}
        disabled={previewing}
        onChange={(next) =>
          useDocumentStore.getState().setMosaicStroke(object.id, at, next as PositionedStroke | null)
        }
        onCommit={(label) => useDocumentStore.getState().commit(label)}
      />

    </Section>
  )
}

/* ------------------------------------------------------------------- timing */

function TimingSection({
  object,
  at,
  state,
  open,
  onToggle,
}: {
  object: LetterMosaicObject
  at: number
  state: MosaicState
  open: boolean
  onToggle: () => void
}) {
  const store = () => useDocumentStore.getState()

  return (
    <Section
      title="Timing"
      summary={`${Math.round(state.holdMs)} · ${Math.round(state.transitionMs)} ms`}
      open={open}
      onToggle={onToggle}
    >
      {/*
        How long this composition rests before it starts moving. Zero is a mosaic
        that never stops, which is usually what you want.
      */}
      <Slider
        label="Hold"
        value={state.holdMs}
        min={0}
        max={4000}
        step={10}
        editable
        suffix="ms"
        onChange={(ms) => store().setMosaicStateTiming(object.id, at, { holdMs: ms })}
        onCommit={commitWith('Change hold')}
      />

      <Slider
        label="Transition"
        value={state.transitionMs}
        min={MOSAIC_MIN_TRANSITION_MS}
        max={4000}
        step={10}
        editable
        suffix="ms"
        onChange={(ms) => store().setMosaicStateTiming(object.id, at, { transitionMs: ms })}
        onCommit={commitWith('Change transition')}
      />

      <div className="field">
        <label className="field__label" htmlFor={`mosaic-easing-${object.id}-${at}`}>
          Easing
        </label>
        <select
          id={`mosaic-easing-${object.id}-${at}`}
          className="input"
          value={state.easing}
          onChange={(e) => {
            store().setMosaicEasing(object.id, at, e.target.value as MosaicEasing)
            store().commit('Change easing')
          }}
        >
          {EASING_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {EASING_LABELS[preset]}
            </option>
          ))}
        </select>
      </div>

    </Section>
  )
}
