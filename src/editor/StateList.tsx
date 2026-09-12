import { useMemo, useRef, useState } from 'react'

import { Button, Slider, StrokeField, Tooltip } from '../components/controls'
import { PaintField, strokePaintField } from './PaintField'
import { beginCrop, cropTargetFor } from './cropTargets'
import { samePaint } from '../typography/paint'
import type { Paint } from '../types/paint'
import { Icon } from '../components/Icon'
import { FONTS } from '../fonts/manifest'
import { canReshape } from '../mosaic/boundaries'
import { gridRanks, sameGeometry } from '../mosaic/dissection'
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
import { documentDefaults } from '../state/defaults'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { LetterMosaicObject } from '../types/document'
import type { PositionedStroke } from '../types/document'
import type { MosaicCorners, MosaicState } from '../types/mosaic'
import {
  DEFAULT_GLYPH_COLOUR,
  MOSAIC_DEFAULT_CORNERS,
  MOSAIC_DEFAULT_SPACING,
  X_MAX,
  Y_MAX,
} from '../types/mosaic'
import { GridSizeField } from './GridSizeField'
import { Section, PaintChip, StrokeChip } from './Section'
import { StatedBackgroundField } from './StatedBackgroundField'
import { StateTimingFields } from './StateTimingFields'
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
type SpacingKey = 'gap' | 'outerPadding' | 'glyphInset'
type Part = 'tiles' | 'glyphs' | 'backdrop' | 'border' | 'timing'

/**
 * What every state shares — the grid the states are cut from and the clock
 * they play to — folded above the list in the rail. Shut by default: these
 * are set once, and the states are what the rail is for.
 */
export function MosaicSettings({ object }: { object: LetterMosaicObject }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="panel__grid-section">
      <Section
        title="Mosaic settings"
        summary={`${object.seed.columns} × ${object.seed.rows} · ${Math.round(object.speed * 10) / 10}×`}
        open={open}
        onToggle={() => setOpen((was) => !was)}
      >
        <GridSection object={object} />
        <PlaybackSection object={object} />
      </Section>
    </div>
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
    <>
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
        <StatedBackgroundField object={object} />
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
    </>
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

  return (
    <>
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
    </>
  )
}

/**
 * The state on show, as the properties panel describes it: its tiles, its
 * glyphs, its backdrop, its border, its timing. This used to unfold inside
 * the state's card, which made the list a place to edit in and a place to
 * read at once and did neither well; the card now names the state, and this
 * is where the state is worked on.
 */
export function MosaicStatePanel({ object, at }: { object: LetterMosaicObject; at: number }) {
  const [openParts, setOpenParts] = useState<ReadonlySet<Part>>(() => new Set<Part>(['tiles']))
  const state = object.states[at]
  if (!state) return null
  const isOpen = (part: Part): boolean => openParts.has(part)
  const toggle = (part: Part) => () =>
    setOpenParts((was) => {
      const next = new Set(was)
      if (next.has(part)) next.delete(part)
      else next.add(part)
      return next
    })

  return (
    <>
      <TilesSection object={object} at={at} open={isOpen('tiles')} onToggle={toggle('tiles')} />
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
    </>
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
    of: (leaf: string) => Paint | null,
  ): { value: Paint | null; mixed: boolean; anyColoured: boolean } => {
    if (!state || targets.length === 0) {
      return { value: DEFAULT_GLYPH_COLOUR, mixed: false, anyColoured: false }
    }
    const seen = targets.map(of)
    const first = seen[0] ?? null
    return {
      value: first,
      mixed: seen.some((each) => !samePaint(each, first)),
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
      summary={<PaintChip value={background.mixed ? null : background.value} />}
      open={open}
      onToggle={onToggle}
    >
      <TilePicker object={object} at={at} />


      {/*
        Its "mixed" does more work than the letter's: a tile with no background
        at all has no value to show, so a selection where none of them is
        coloured reads as mixed rather than as some colour nobody chose.
      */}
      <PaintField
        label="Background"
        value={background.value}
        mixed={background.mixed || (!background.anyColoured && targets.length > 0)}
        disabled={locked}
        onChange={(paint) =>
          useDocumentStore.getState().setMosaicTileColour(object.id, at, targets, paint)
        }
        onCommit={(label) => useDocumentStore.getState().commit(label)}
        onCrop={() => beginCrop(cropTargetFor(object.id, 'tile', at, targets))}
        removeLabel="Clear background"
        onRemove={() => {
          const store = useDocumentStore.getState()
          store.setMosaicTileColour(object.id, at, targets, null)
          store.commit('Clear tile background')
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

      <PaintField
        label="Fill"
        value={letter.value}
        mixed={letter.mixed}
        disabled={locked}
        onChange={(paint) =>
          useDocumentStore.getState().setMosaicGlyphColour(object.id, at, targets, paint)
        }
        onCommit={(label) => useDocumentStore.getState().commit(label)}
        onCrop={() => beginCrop(cropTargetFor(object.id, 'glyph', at, targets))}
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
      title="Background"
      summary={<PaintChip value={backdrop} />}
      open={open}
      onToggle={onToggle}
    >
      {/*
        Its reach is different from the two above: they follow the tile
        selection, this one never does. It is one paint for the composition,
        whatever is picked out.
      */}
      <PaintField
        label="Background"
        value={backdrop}
        emptyLabel="None"
        disabled={previewing}
        onChange={(paint) => useDocumentStore.getState().setMosaicBackground(object.id, at, paint)}
        onCommit={(label) => useDocumentStore.getState().commit(label)}
        onCrop={() => beginCrop(cropTargetFor(object.id, 'background', at))}
        removeLabel="Clear background"
        onRemove={() => {
          const store = useDocumentStore.getState()
          store.setMosaicBackground(object.id, at, null)
          store.commit('Clear background')
        }}
      />


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
        paint={strokePaintField}
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
  return (
    <Section
      title="Timing"
      summary={`${Math.round(state.holdMs)} · ${Math.round(state.transitionMs)} ms`}
      open={open}
      onToggle={onToggle}
    >
      <StateTimingFields object={object} at={at} />
    </Section>
  )
}
