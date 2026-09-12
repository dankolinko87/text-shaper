import { askConfirm } from '../components/confirm'
import { useMemo, useState } from 'react'

import { Button, SegmentedControl, Slider, StrokeField } from '../components/controls'
import { PaintField, strokePaintField } from './PaintField'
import { beginCrop, cropTargetFor } from './cropTargets'
import { samePaint } from '../typography/paint'
import type { Paint } from '../types/paint'
import { Icon } from '../components/Icon'
import { FONTS } from '../fonts/manifest'
import { DEFAULT_OUTLINE, DEFAULT_STROKE } from '../geometry/stroke'
import { meshChars, meshColourTargets, meshCorners, meshSpacing } from '../mesh/layout'
import { latticeOf } from '../mesh/ops'
import { sameMeshGeometry } from '../mesh/dissection'
import { graphemeSupport } from '../mosaic/glyph'
import { documentDefaults } from '../state/defaults'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { MeshObject, PositionedStroke } from '../types/document'
import { MESH_DEFAULT_CORNERS, MESH_DEFAULT_SPACING, MESH_MAX_SIDE } from '../types/mesh'
import { DEFAULT_GLYPH_COLOUR } from '../types/mosaic'
import { GridSizeField } from './GridSizeField'
import { PaintChip, Section, StrokeChip } from './Section'
import { StatedBackgroundField } from './StatedBackgroundField'
import { StateTimingFields } from './StateTimingFields'
import { TilePicker } from './TilePicker'
import './panels.css'

/**
 * A mesh's panels: what every state shares, folded above the list in the rail;
 * and the state on show, in the properties panel.
 *
 * The mosaic's panels, section for section, on the fields the two kinds share
 * — the store actions behind these controls take either kind. What is not
 * here is what a mesh has not got: outer padding (rim nodes are dragged
 * instead), and the spacing maxima (a tile that cannot take an inset collapses
 * in the layout). What a mesh has that a mosaic has not is its lines.
 */

const commitWith = (label: string) => () => useDocumentStore.getState().commit(label)

export function MeshSettings({ object }: { object: MeshObject }) {
  const [open, setOpen] = useState(false)
  const store = () => useDocumentStore.getState()
  const snapCeiling = Math.max(
    10,
    Math.round(Math.min(object.localBounds.width, object.localBounds.height) / 4),
  )

  return (
    <div className="panel__grid-section">
      <Section
        title="Mesh settings"
        summary={`${object.seed.columns} × ${object.seed.rows} · ${Math.round(object.speed * 10) / 10}×`}
        open={open}
        onToggle={() => setOpen((was) => !was)}
      >
        {/* Reseeds the grid: letters and colours carry in reading order, positions start over. */}
        <GridSizeField
          columns={object.seed.columns}
          rows={object.seed.rows}
          onChange={(columns, rows) => {
            const clamp = (n: number): number => Math.max(1, Math.min(MESH_MAX_SIDE, Math.round(n)))
            if (store().resizeMeshGrid(object.id, clamp(columns), clamp(rows))) {
              store().commit('Resize grid')
            }
          }}
        />
        <Slider
          label="Snap"
          value={object.snapStep}
          min={0}
          max={snapCeiling}
          step={1}
          editable
          tip="Hold Alt to drag past the grid"
          onChange={(step) => store().setMosaicSnap(object.id, step)}
          onCommit={commitWith('Change snap')}
        />
        <Slider
          label="Speed"
          value={object.speed}
          min={0.1}
          max={4}
          step={0.1}
          editable
          suffix="×"
          onChange={(speed) => store().setMosaicSpeed(object.id, speed)}
          onCommit={commitWith('Change speed')}
        />
        <StatedBackgroundField object={object} />
        {/* The whole box behind the mesh, as a mosaic has — or a backdrop cut to the tiles' rim. */}
        <SegmentedControl<'box' | 'silhouette'>
          label="Background fills"
          value={object.backdrop}
          options={[
            { value: 'box', label: 'Whole frame' },
            { value: 'silhouette', label: 'Silhouette' },
          ]}
          onChange={(choice) => {
            store().setMeshBackdrop(object.id, choice)
            store().commit(choice === 'box' ? 'Backdrop fills the frame' : 'Backdrop follows the rim')
          }}
        />
        {/* Back to the grid it was MADE as, every state — the mosaic's Rebuild, with the same warning. */}
        <div className="field">
          <span className="field__label">Rebuild</span>
          <Button
            variant="ghost"
            onClick={async () => {
              const differing = object.states.some(
                (each, i) => i > 0 && !sameMeshGeometry(each, object.states[0] as MeshObject['states'][number]),
              )
              const losing = Math.max(0, object.tiles.length - object.seed.columns * object.seed.rows)
              const message = differing
                ? 'Every state goes back to it, so the animation you have authored is flattened.'
                : losing > 0
                  ? `The last ${losing} tile${losing === 1 ? '' : 's'} go with it.`
                  : 'Every state goes back to the grid.'
              const sure = await askConfirm({
                title: `Rebuild the whole mesh as a ${object.seed.columns} × ${object.seed.rows} grid?`,
                message,
                confirmLabel: 'Rebuild',
                danger: true,
              })
              if (!sure) return
              if (store().rebuildMeshGrid(object.id)) store().commit('Rebuild grid')
            }}
          >
            Rebuild every state
          </Button>
        </div>
      </Section>
    </div>
  )
}

/** What the tiles being worked on say about a colour, as one answer or as "they disagree". */
function useMeshColours(object: MeshObject, at: number) {
  const selection = useUiStore((s) => s.mosaicSelection)
  const previewing = useUiStore(
    (s) => s.mosaicPlayback?.object === object.id || (s.playing && object.states.length > 1),
  )
  const state = object.states[at]
  const targets = useMemo(() => meshColourTargets(object, at, selection), [object, at, selection])

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
    previewing,
    targets,
    letter: read((leaf) => state?.glyphColour[leaf] ?? DEFAULT_GLYPH_COLOUR),
    background: read((leaf) => state?.tileColour[leaf] ?? null),
    locked: previewing || targets.length === 0,
  }
}

type Part = 'tiles' | 'glyphs' | 'backdrop' | 'border' | 'timing'

export function MeshStatePanel({ object, at }: { object: MeshObject; at: number }) {
  const [openParts, setOpenParts] = useState<ReadonlySet<Part>>(() => new Set<Part>(['tiles']))
  const state = object.states[at]
  const store = () => useDocumentStore.getState()
  const { targets, letter, background, locked, previewing } = useMeshColours(object, at)
  const selection = useUiStore((s) => s.mosaicSelection)
  const spacing = meshSpacing(object, at)
  const corners = meshCorners(object, at)
  const written = meshChars(object, at)
  const font = state?.font ?? documentDefaults.font
  const family = FONTS.find((each) => each.id === font.fontId)?.family ?? 'This font'
  const unsupported = useMemo(
    () =>
      object.tiles.filter(
        (tile) => written[tile.id] && graphemeSupport(font.fontId, written[tile.id] as string) === 'missing',
      ).length,
    [object.tiles, written, font.fontId],
  )
  // Sliders reach as far as a quarter of the mesh; past that a tile collapses anyway.
  const reach = Math.max(1, Math.min(object.localBounds.width, object.localBounds.height) / 4)
  const radiusMax = Math.max(1, Math.min(object.localBounds.width, object.localBounds.height) / 2)

  if (!state) return null
  const isOpen = (part: Part): boolean => openParts.has(part)
  const lattice = latticeOf(object.tiles)
  const chosen = targets.filter((id) => object.tiles.some((tile) => tile.id === id))
  const canRemove = selection.length > 0 && chosen.length < object.tiles.length
  const toggle = (part: Part) => () =>
    setOpenParts((was) => {
      const next = new Set(was)
      if (next.has(part)) next.delete(part)
      else next.add(part)
      return next
    })
  const backdrop = state.background ?? null

  return (
    <>
      <Section
        title="Tiles"
        summary={<PaintChip value={background.mixed ? null : background.value} />}
        open={isOpen('tiles')}
        onToggle={toggle('tiles')}
      >
        <TilePicker object={object} at={at} />
        <PaintField
          label="Background"
          value={background.value}
          mixed={background.mixed || (!background.anyColoured && targets.length > 0)}
          disabled={locked}
          onChange={(paint) => store().setMosaicTileColour(object.id, at, targets, paint)}
          onCommit={(label) => store().commit(label)}
          onCrop={() => beginCrop(cropTargetFor(object.id, 'tile', at, targets))}
          removeLabel="Clear background"
          onRemove={() => {
            store().setMosaicTileColour(object.id, at, targets, null)
            store().commit('Clear tile background')
          }}
        />
        <Slider
          label="Corners"
          value={corners.tileRadius}
          min={0}
          max={radiusMax}
          step={0.5}
          editable
          onChange={(value) => store().setMosaicCorners(object.id, { tileRadius: value }, at)}
          onCommit={commitWith('Round tiles')}
        />
        <Slider
          label="Gap"
          value={spacing.gap}
          min={0}
          max={reach}
          step={0.5}
          editable
          onChange={(value) => store().setMosaicSpacing(object.id, { gap: value }, at)}
          onCommit={commitWith('Change gap')}
        />
        <div className="field">
          <span className="field__label">Shape</span>
          <div className="button-row">
            <Button
              variant="ghost"
              disabled={!canRemove || previewing}
              onClick={() => {
                if (!store().removeMeshTiles(object.id, chosen)) return
                store().commit(chosen.length === 1 ? 'Remove tile' : 'Remove tiles')
                useUiStore.getState().setMosaicSelection([])
              }}
            >
              Remove {chosen.length === 1 ? 'tile' : 'tiles'}
            </Button>
            {/* Back to the grid the tiles still form; a cut or an extrusion means Rebuild instead. */}
            <Button
              variant="ghost"
              disabled={!lattice || previewing}
              onClick={() => {
                if (store().resetMeshGrid(object.id, at)) store().commit('Reset state layout')
              }}
            >
              Reset this state
            </Button>
          </div>
        </div>
        <p className="panel__note">
          Drag a point or an edge. Double-click an edge for a point; ⌫ takes a picked point out.
          ⌘-drag a rim edge to grow a cell; ⌘-drag across a cell to cut it; ⌘⌫ removes selected cells.
        </p>
      </Section>

      <Section title="Glyphs" summary={family} open={isOpen('glyphs')} onToggle={toggle('glyphs')}>
        <div className="field">
          <label className="field__label" htmlFor={`mesh-font-${object.id}`}>
            Font
          </label>
          <select
            id={`mesh-font-${object.id}`}
            className="input"
            value={font.fontId}
            onChange={(e) => {
              store().setMosaicFont(object.id, { ...font, fontId: e.target.value }, at)
              store().commit('Change font')
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
          onChange={(paint) => store().setMosaicGlyphColour(object.id, at, targets, paint)}
          onCommit={(label) => store().commit(label)}
          onCrop={() => beginCrop(cropTargetFor(object.id, 'glyph', at, targets))}
        />
        <Slider
          label="Inset"
          value={spacing.glyphInset}
          min={0}
          max={reach}
          step={0.5}
          editable
          onChange={(value) => store().setMosaicSpacing(object.id, { glyphInset: value }, at)}
          onCommit={commitWith('Change glyph inset')}
        />
      </Section>

      <Section
        title="Background"
        summary={<PaintChip value={backdrop} />}
        open={isOpen('backdrop')}
        onToggle={toggle('backdrop')}
      >
        <PaintField
          label="Background"
          value={backdrop}
          emptyLabel="None"
          disabled={previewing}
          onChange={(paint) => store().setMosaicBackground(object.id, at, paint)}
          onCommit={(label) => store().commit(label)}
          onCrop={() => beginCrop(cropTargetFor(object.id, 'background', at))}
          removeLabel="Clear background"
          onRemove={() => {
            store().setMosaicBackground(object.id, at, null)
            store().commit('Clear background')
          }}
        />
        {/* How far the backdrop and the silhouette reach past the rim — where a backdrop shows once the tiles are filled. */}
        <Slider
          label="Padding"
          value={spacing.outerPadding ?? 0}
          min={0}
          max={reach}
          step={0.5}
          editable
          onChange={(value) => store().setMosaicSpacing(object.id, { outerPadding: value }, at)}
          onCommit={commitWith('Change outer padding')}
        />
        <Slider
          label="Corners"
          value={corners.outerRadius}
          min={0}
          max={radiusMax}
          step={0.5}
          editable
          onChange={(value) => store().setMosaicCorners(object.id, { outerRadius: value }, at)}
          onCommit={commitWith('Round mesh')}
        />
        <div className="field">
          <span className="field__label">Reset</span>
          <div className="button-row">
            <Button
              variant="ghost"
              onClick={() => {
                store().setMosaicSpacing(object.id, { ...MESH_DEFAULT_SPACING }, at)
                store().commit('Reset spacing')
              }}
            >
              Spacing
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                store().setMosaicCorners(object.id, MESH_DEFAULT_CORNERS, at)
                store().commit('Reset corners')
              }}
            >
              Corners
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title="Border"
        summary={<StrokeChip value={state.stroke ?? state.lines ?? null} />}
        open={isOpen('border')}
        onToggle={toggle('border')}
      >
        <StrokeField
          value={state.stroke ?? null}
          defaults={DEFAULT_OUTLINE}
          paint={strokePaintField}
          disabled={previewing}
          onChange={(next) => store().setMosaicStroke(object.id, at, next as PositionedStroke | null)}
          onCommit={(label) => store().commit(label)}
        />
        {/* The grid's own lines, kept as artwork: every edge once, down its centre. */}
        <StrokeField
          label="Lines"
          addLabel="Add lines"
          value={state.lines ?? null}
          defaults={DEFAULT_STROKE}
          paint={strokePaintField}
          positions={false}
          disabled={previewing}
          onChange={(next) =>
            store().setMeshLines(
              object.id,
              at,
              next ? { colour: next.colour, width: next.width, dash: next.dash } : null,
            )
          }
          onCommit={(label) => store().commit(label)}
        />
      </Section>

      <Section
        title="Timing"
        summary={`${Math.round(state.holdMs)} · ${Math.round(state.transitionMs)} ms`}
        open={isOpen('timing')}
        onToggle={toggle('timing')}
      >
        <StateTimingFields object={object} at={at} />
      </Section>
    </>
  )
}
