import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import { IconButton, Tooltip } from '../components/controls'
import { useDismiss } from '../components/useDismiss'
import { FlyoutMarker, Icon, type IconName } from '../components/Icon'
import { pathToOutline } from '../geometry/outline'
import { pathBounds } from '../geometry/path'
import { PRIMITIVES, type PrimitiveId, type PrimitiveShape } from '../geometry/primitives'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore, type ToolId } from '../state/uiStore'
import './panels.css'

interface ToolDescriptor {
  id: ToolId
  label: string
  icon: IconName
  shortcut: string
}

/**
 * Tools that actually work, and nothing else.
 *
 * Reshape (Add / Erase / Push-Pull / Smooth / Restore) is deliberately absent
 * until Phase 4 implements it — a visible control that does nothing is worse
 * than no control.
 */
/**
 * Pointing at things, and moving what you are pointing at them WITH.
 *
 * Select and Pan are the two tools that change nothing on the artboard: one
 * chooses what you are working on, the other changes where you are standing.
 * Neither makes a mark, so they share a slot, and Select leads because it is
 * where you spend almost all of your time.
 */
const VIEW_TOOLS: ToolDescriptor[] = [
  { id: 'select', label: 'Select', icon: 'cursor', shortcut: 'V' },
  // H picks it up; holding Space borrows it, which the tip need not say twice.
  { id: 'pan', label: 'Pan', icon: 'hand', shortcut: 'H' },
]

/**
 * The tools that stand on their own, with no choice hanging off them.
 *
 * Only one is left. Freehand shape moved in with the presets — it is one more
 * way of making a shape — and Edit grid went entirely: it was a button for a
 * mode you already enter by double-clicking the shape, wearing the same icon as
 * Fit artboard, so the rail and the view controls disagreed about what that
 * glyph meant. `G` still opens it for the selection.
 */
const TOOLS: ToolDescriptor[] = [
  { id: 'mosaic', label: 'Letter mosaic', icon: 'mosaic', shortcut: 'M' },
  // The mosaic's free-cornered cousin: letters in cells you can pull about.
  { id: 'mesh', label: 'Mesh', icon: 'mesh', shortcut: 'N' },
  /*
   * A place with states, drawn before it has anything in it.
   *
   * Its own tool rather than a verb on a selection, because a frame is a thing
   * you draw and then fill — you may well want one before you have made what
   * goes in it, and a frame with nothing in it is a perfectly good empty stage.
   */
  { id: 'frame', label: 'Frame', icon: 'frame', shortcut: 'F' },
]

/**
 * The two ways of drawing a path, as one control.
 *
 * They are the same job done two ways — put an open path on the artboard — and
 * which one you want depends on the drawing, not on the session. Two permanent
 * buttons spent two slots of a rail that also has to hold every other tool, and
 * asked a question at rest that only matters in the moment.
 *
 * The pen leads because it is the one you reach for deliberately; the pencil is
 * the quick one. Whichever was used last stays on the button, so the tool you
 * are working in is one click away and the other is two.
 */
const PATH_TOOLS: ToolDescriptor[] = [
  { id: 'pen', label: 'Pen', icon: 'pen', shortcut: 'P' },
  { id: 'line', label: 'Pencil', icon: 'pencil', shortcut: 'L' },
]

/**
 * Size a preset is created at, before the user resizes it.
 *
 * ONE number, not a width and a height. Every preset is dropped as its regular
 * self — a circle, a square, an equilateral triangle — so the height is the
 * shape's own `aspect` away from the width rather than a second free choice. A
 * fixed box for all of them made every one of them a stretched version of
 * itself.
 */
const PRESET_SIZE = 480

/**
 * Drop a preset shape at the middle of what the user is currently looking at.
 *
 * Placing it at a fixed artboard point would put it off-screen the moment the
 * canvas has been panned, and the canvas is endless — there is no page to fall
 * back to.
 */
function addPrimitive(shape: PrimitiveShape): void {
  const ui = useUiStore.getState()
  const zoom = ui.zoom || 1
  const artboardCenter = {
    x: (ui.stageWidth / 2 - ui.panX) / zoom,
    y: (ui.stageHeight / 2 - ui.panY) / zoom,
  }

  const pathData = shape.build(PRESET_SIZE, PRESET_SIZE * shape.aspect)
  const store = useDocumentStore.getState()
  store.createObjectFromGeometry({
    pathData,
    /*
     * A preset arrives node-editable, like everything else that can be drawn.
     *
     * Every outline here is built in the same vocabulary the freehand tracer
     * emits — cubics and lines, no arcs — so reading it back gives the corners
     * and quadrants it was written with, and not a point more. A rectangle comes
     * back as four corners, an ellipse as four smooth quadrants: exactly the
     * handles someone would expect to find if they went looking.
     */
    outline: pathToOutline(pathData) ?? undefined,
    // Measured rather than assumed: a triangle or hexagon does not fill the
    // box it was built in.
    localBounds: pathBounds(pathData),
    artboardCenter,
    // A preset is a container to fill, never a line to write along.
    open: false,
    name: shape.label,
  })
  store.commit(`Add ${shape.label.toLowerCase()}`)
  ui.setTool('select')
}

/**
 * A preset's own silhouette, drawn as its icon.
 *
 * Built at a nominal size and framed by the viewBox, so the icon is the real
 * shape rather than a hand-drawn approximation that could drift away from it.
 */
function ShapeGlyph({ shape, size = 16 }: { shape: PrimitiveShape; size?: number }) {
  return (
    <svg viewBox="-12 -12 24 24" width={size} height={size} aria-hidden="true">
      <path
        d={shape.build(20, 20 * shape.aspect)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Which flyout is open, as ONE value shared by every menu in the toolbar.
 *
 * An identity rather than a boolean per menu, and that is the whole fix: two
 * booleans can both be true, and they were. Each menu dismissed itself on a
 * press outside, but the chevrons stop the press propagating — they have to, or
 * opening the choice would also use the tool underneath — so a press on one
 * chevron never reached the other menu's listener and both stood open.
 *
 * Opening one now closes the rest by construction, with no event ordering to
 * get right.
 */
const OpenMenuContext = createContext<{
  openId: string | null
  setOpenId: (id: string | null) => void
}>({ openId: null, setOpenId: () => {} })

/** One menu's share of that: whether it is the open one, and how to become it. */
function useMenu(id: string): { open: boolean; toggle: () => void; close: () => void } {
  const { openId, setOpenId } = useContext(OpenMenuContext)
  const open = openId === id
  return {
    open,
    toggle: useCallback(() => setOpenId(openId === id ? null : id), [openId, id, setOpenId]),
    close: useCallback(() => setOpenId(null), [setOpenId]),
  }
}

/**
 * The caret that opens a tool's menu: a narrow button beside the tool, as
 * Figma has it, rather than a mark in the tool's corner.
 *
 * Two targets instead of one button with a corner: pressing the tool never
 * risks opening the menu, and pressing the caret never risks picking the tool
 * up — which is what the corner mark had to catch its own mousedown to avoid.
 */
function MenuChevron({
  open,
  label,
  onToggle,
}: {
  open: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="tool-menu__chevron"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <FlyoutMarker />
      </button>
    </Tooltip>
  )
}

/**
 * A group of tools behind one button, with a chevron for the rest.
 *
 * The button IS the tool it shows — pressing it picks that tool up, the way any
 * other tool button does. Only the chevron opens the choice.
 */
function ToolMenu({ tools }: { tools: ToolDescriptor[] }) {
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const { open: openMenu, toggle, close } = useMenu(`tools:${tools.map((t) => t.id).join(',')}`)
  const [picked, setPicked] = useState<ToolId>(tools[0]?.id ?? 'pen')
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismiss(openMenu, close, wrapRef)

  /*
   * What the button shows: the group's ACTIVE tool, or failing that the one last
   * picked. Reading only the stored choice would leave the button showing the
   * pen, unlit, while the pencil was the live tool — which is what happens the
   * moment someone reaches a tool by its keyboard shortcut instead.
   */
  const shown =
    tools.find((t) => t.id === tool) ??
    tools.find((t) => t.id === picked) ??
    (tools[0] as ToolDescriptor)

  return (
    <div className="tool-menu" ref={wrapRef}>
      <Tooltip label={shown.label} shortcut={shown.shortcut}>
        <button
          type="button"
          className="icon-button tool-menu__trigger"
          data-active={tool === shown.id}
          aria-label={shown.label}
          aria-pressed={tool === shown.id}
          onClick={() => setTool(shown.id)}
        >
          <Icon name={shown.icon} size={20} />
        </button>
      </Tooltip>
      <MenuChevron open={openMenu} label="More tools" onToggle={toggle} />

      {openMenu ? (
        <div className="tool-menu__flyout popover" role="menu" aria-label="Drawing tools">
          {tools.map((option) => (
            <button
              key={option.id}
              type="button"
              className="tool-menu__item"
              role="menuitem"
              data-active={tool === option.id}
              onClick={() => {
                setPicked(option.id)
                close()
                setTool(option.id)
              }}
            >
              <Icon name={option.icon} size={16} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Every way of putting a shape on the artboard, as one control.
 *
 * Six presets and the freehand tool are not seven things: they are one
 * intention — make a shape — with a choice of how. So the button does whichever
 * was last chosen and the chevron opens the rest, which puts the way you are
 * working one click away and everything else two.
 *
 * The entries are of two KINDS, and the button behaves as whichever it is
 * showing. A preset is an action: press and a shape appears. Freehand is a mode:
 * press and the tool is armed, and the button stays lit until you leave it.
 * Mixing the two in one control is only confusing if it hides which it is, and
 * the lit state says so.
 */
const FREEHAND = 'freehand' as const
type ShapeChoice = typeof FREEHAND | PrimitiveId

function ShapeMenu() {
  const { open: openMenu, toggle, close } = useMenu('shapes')
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const [picked, setPicked] = useState<ShapeChoice>('ellipse')
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismiss(openMenu, close, wrapRef)

  /*
   * Drawing freehand takes over the button while it is the live tool, however
   * it was reached. Read from `picked` alone, pressing `B` would arm the tool
   * while the button went on offering an ellipse, unlit.
   */
  const chosen: ShapeChoice = tool === 'draw' ? FREEHAND : picked
  const preset = PRIMITIVES.find((p) => p.id === chosen)
  const label = preset ? `Add ${preset.label.toLowerCase()}` : 'Freehand shape'

  const use = (next: ShapeChoice): void => {
    setPicked(next)
    close()
    const shape = PRIMITIVES.find((p) => p.id === next)
    if (!shape) {
      setTool('draw')
      return
    }
    addPrimitive(shape)
    /*
     * And back to Select, which matters when the freehand tool was the one
     * running: a shape has just been placed and selected, and the canvas gates
     * against holding a selection while a drawing tool is armed — so it would
     * arrive selected and untouchable, with the next press starting a stroke
     * across it.
     */
    setTool('select')
  }

  return (
    <div className="tool-menu" ref={wrapRef}>
      <Tooltip label={label} shortcut={preset ? undefined : 'B'}>
        <button
          type="button"
          className="icon-button tool-menu__trigger"
          data-active={!preset && tool === 'draw'}
          aria-label={label}
          onClick={() => use(chosen)}
        >
          {preset ? <ShapeGlyph shape={preset} size={20} /> : <Icon name="brush" size={20} />}
        </button>
      </Tooltip>
      <MenuChevron open={openMenu} label="More shapes" onToggle={toggle} />

      {openMenu ? (
        <div className="tool-menu__flyout popover" role="menu" aria-label="Shapes">
          {/* The tool first: it is the one that draws something of your own. */}
          <button
            type="button"
            role="menuitem"
            className="tool-menu__item"
            data-active={chosen === FREEHAND}
            onClick={() => use(FREEHAND)}
          >
            <Icon name="brush" size={16} />
            <span>Freehand shape</span>
          </button>
          {PRIMITIVES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              className="tool-menu__item"
              data-active={option.id === chosen}
              onClick={() => use(option.id)}
            >
              <ShapeGlyph shape={option} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Toolbar() {
  const [openId, setOpenId] = useState<string | null>(null)
  const menus = useMemo(() => ({ openId, setOpenId }), [openId])
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)

  /** The plain tool buttons — the ones with no menu of their own. */
  const renderTools = (tools: ToolDescriptor[]) =>
    tools.map((t) => (
      <IconButton
        key={t.id}
        icon={t.icon}
        label={t.label}
        shortcut={t.shortcut}
        active={tool === t.id}
                onClick={() => setTool(t.id)}
      />
    ))

  return (
    <OpenMenuContext.Provider value={menus}>
    <nav className="toolbar pill" aria-label="Tools">
      <div className="toolbar__group">
        <ToolMenu tools={VIEW_TOOLS} />
        <ToolMenu tools={PATH_TOOLS} />
        {renderTools(TOOLS)}
        <ShapeMenu />
      </div>

      {/*
        Duplicate and Delete are not here.
        
        They are things you do TO a selection, not tools you pick up, and they
        already have the gestures everyone reaches for first: ⌘D or Alt-drag to
        duplicate, ⌫ to delete, ⌘C/⌘V to copy. Two permanent buttons that spend
        most of their life disabled are two slots of a tool rail paying for
        nothing.
      */}
    </nav>
    </OpenMenuContext.Provider>
  )
}
