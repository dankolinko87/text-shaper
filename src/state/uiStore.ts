import { readTheme, type Theme } from './theme'
import { create } from 'zustand'

import { MAX_ZOOM, MIN_ZOOM } from '../geometry/viewportMath'
import { clamp } from '../utils/math'
import type { DocumentObject } from '../types/document'

export type ToolId = 'select' | 'draw' | 'line' | 'pen' | 'mosaic' | 'frame' | 'pan' | 'grid'

/**
 * Which tab of the right-hand panel is showing.
 *
 * There is no Colour tab any more. Colour was never a tab so much as a MODE —
 * it armed tile picking, the marquee and "select all means all tiles" — and a
 * mode that lives in a panel is a mode you cannot see. All of that now keys off
 * `typing`: being INSIDE a mosaic, which you enter by double-clicking it and
 * leave with Escape, the same gesture that opens a shape's points.
 *
 * A mosaic has no tabs at all now; a shape or a line keeps these two, with the
 * colour controls folded into Design beside the part they belong to.
 */
export type PanelTab = 'design' | 'animate'

/**
 * Ephemeral editor state: never persisted and never part of undo history.
 *
 * Keeping this separate from the document store is what stops a zoom or a tool
 * change from creating an undo entry, and what keeps live gesture state out of
 * the serialised project file.
 */
export interface UiState {
  tool: ToolId
  /** Which palette the UI wears. Kept in the browser, see `theme.ts`. */
  theme: Theme
  /**
   * Which panel tab is open.
   *
   * The canvas reads this: shapes loop only while Animate is showing, so the
   * artboard stays still during layout work.
   */
  panelTab: PanelTab
  /** Set while Space is held, so pan is temporary and reverts on release. */
  temporaryTool: ToolId | null
  /**
   * The object whose points are on show, if any.
   *
   * The Figma model, and the reason it is a mode rather than a property of the
   * selection: a click selects an object to move and turn, and a DOUBLE-click
   * goes inside it to the points it is made of. One rule for a drawn line and a
   * drawn shape alike — a line's points used to appear on plain selection, which
   * made the two behave differently for no reason a user could name.
   *
   * Ephemeral on purpose: entering point editing is not something to undo, and
   * it should not survive a reload.
   */
  editingPoints: string | null
  /**
   * The frame being worked INSIDE, if any.
   *
   * A third way of being inside something, beside a shape's points and a
   * mosaic's tiles, and it means what those mean: a click selects the frame to
   * move it, a DOUBLE-click goes in to the objects it is made of. Escape leaves.
   *
   * Ephemeral, like the other two: going inside is not something to undo, and it
   * should not survive a reload.
   */
  insideFrame: string | null
  /**
   * The object with states drawn as a ROW of windows, one per state, if any —
   * a mosaic or a frame.
   *
   * Ephemeral like `insideFrame`, and for the same reason: how you are looking
   * at a thing is not the artwork. What spreading ALSO does depends on the
   * kind — a frame is entered, because its windows exist to pick members in —
   * and is decided where the kinds are told apart (`editor/stated.ts`), not
   * here. Leaving a frame folds its row.
   */
  spread: string | null
  /**
   * Which member is picked out inside that frame, by member id.
   *
   * Member ids rather than positions, so a pick survives every arrangement
   * change: moving things about does not stop any of them being the member it
   * was — the same reason `mosaicSelection` names leaves.
   */
  frameSelection: string[]
  /**
   * The global play button: every animated object runs, together.
   *
   * Separate from the per-selection preview the Animate and Colour tabs give
   * you, and it does not replace it. That one answers "what does this setting
   * do"; this one answers "what does the whole thing look like", which is the
   * question you cannot ask one object at a time.
   *
   * Everything stays usable while it runs — tools, drawing, every panel — and
   * edits land live, because a composition you cannot touch while watching is
   * only half of what this is for.
   */
  playing: boolean
  /**
   * One object playing on its own, from the control under it on the canvas.
   *
   * Distinct from `playing`, which is the whole artboard, and from the preview a
   * watching panel gives the sole selection: this is somebody pointing at one
   * thing and asking to see it move, whatever tab they are on. Ephemeral, like
   * every other playback flag — it is where the cursor is standing, not part of
   * the artwork.
   */
  previewObject: string | null
  /**
   * The object under direct manipulation, if any.
   *
   * Its animation stops for the length of the gesture, so what gets dragged,
   * resized or reshaped is the object's RESTING geometry. Dragging a deformed
   * frame means the handles sit somewhere the shape is not, and the gesture ends
   * by measuring a transform against a picture that was never the object.
   *
   * It rejoins the shared clock afterwards, at wherever that clock has got to.
   */
  interacting: string | null
  /**
   * The mosaic tile the caret is in, if any.
   *
   * Both halves, because a leaf id alone would not say which object it belongs
   * to — and the overlay, the keyboard handler and the shortcut suppression all
   * need to know that a mosaic is being typed into, not just that some tile is.
   *
   * Ephemeral: where the caret sits is not something to undo, and it should not
   * survive a reload.
   */
  typing: { object: string; leaf: string } | null
  /**
   * The tiles picked out inside the mosaic being edited, by leaf id.
   *
   * Leaf ids rather than positions, so a selection survives every proportion
   * change: resizing moves the tiles about and none of them stop being the tile
   * they were. Normally this is just the tile the caret is in; shift-clicking
   * adds more, which is what lets tiles that line up be resized as one.
   */
  mosaicSelection: string[]
  zoom: number
  panX: number
  panY: number
  /** Canvas size in screen pixels, so anything placed lands where you are looking. */
  stageWidth: number
  stageHeight: number
  isDrawing: boolean
  /**
   * What ⌘C copied, waiting for ⌘V.
   *
   * Whole objects rather than their ids: what was copied may since have been
   * deleted, and a clipboard of ids would paste nothing exactly when it was
   * most wanted.
   *
   * Here rather than in the document because it is not part of the drawing —
   * nothing on the artboard changes when you copy, it must not appear in the
   * history, and it has no business being saved. It lives as long as the tab
   * does, which is what a clipboard is.
   */
  clipboard: DocumentObject[]
  fontLoaded: boolean
  clipperReady: boolean
  /**
   * Whether the user has zoomed or panned themselves.
   *
   * Until they have, the artboard re-fits on every stage resize — so opening
   * the editor, or resizing the window, always leaves the artwork framed
   * rather than stranded off-screen at whatever size the panels happened to
   * be during first layout.
   */
  viewportAdjusted: boolean

  setTool: (tool: ToolId) => void
  setTheme: (theme: Theme) => void
  setPanelTab: (tab: PanelTab) => void
  setTemporaryTool: (tool: ToolId | null) => void
  setEditingPoints: (id: string | null) => void
  setInsideFrame: (id: string | null) => void
  setFrameSelection: (members: string[]) => void
  setSpread: (id: string | null) => void
  /**
   * The pick, as one write: which members, and which STATE they were picked
   * in. Read off the Fabric child's parent by the selection handler, so that
   * every write that follows — from the panel, the point editor, a colour
   * control — lands on the state the object was picked in rather than on
   * whatever the store happened to be showing.
   */
  setFramePick: (frame: string, members: string[], state: number) => void
  setPlaying: (playing: boolean) => void
  setPreviewObject: (id: string | null) => void
  setInteracting: (id: string | null) => void
  setTyping: (at: { object: string; leaf: string } | null) => void
  setMosaicSelection: (leaves: string[]) => void
  /**
   * Which state of each mosaic is being looked at, by object id.
   *
   * Here rather than on the object because it is not the artwork. A mosaic's
   * states, their geometry and their timing are what somebody made; WHICH of
   * them happens to be on screen is where the cursor is standing. Keeping it in
   * the document would mean clicking a chevron dirtied the file, filled the undo
   * history with navigation, and changed what an export produced depending on
   * where the last person had been looking.
   *
   * Absent means the first state. Cleared for a mosaic whose states shrank under
   * it, which `clampMosaicState` does after a delete or an undo.
   */
  mosaicStates: Record<string, number>
  setMosaicState: (object: string, index: number) => void
  /** Pull the shown index back inside a mosaic that now has fewer states. */
  clampMosaicState: (object: string, count: number) => void
  /** Which state of this mosaic is shown, with absent meaning the first. */
  shownState: (object: string) => number
  /**
   * The mosaic being previewed, and where its clock has got to.
   *
   * Ephemeral, and deliberately not in the document: whether something is
   * playing and how far through it is are facts about this moment at this
   * screen, not about the artwork. Persisting them would mean a file remembered
   * that somebody once paused it two thirds of the way through.
   *
   * `atMs` is WALL time since the timeline began, not authored time — playback
   * speed is applied when the clock is read, so changing speed mid-play does not
   * make the preview jump. One mosaic at a time in this version.
   */
  mosaicPlayback: { object: string; playing: boolean; atMs: number } | null
  /** Start, or resume from where a pause left it. */
  playMosaic: (object: string) => void
  /** Freeze the preview where it is. The frame stays on screen, uneditable. */
  pauseMosaicPlayback: (atMs?: number) => void
  /** Back to the first state at time zero, still playing if it was. */
  restartMosaic: (object: string) => void
  /** Leave playback entirely and go back to the authored state on show. */
  stopMosaicPlayback: () => void
  /** Shift-click: in if it is out, out if it is in. */
  toggleMosaicSelection: (leaf: string) => void
  activeTool: () => ToolId
  setViewport: (v: { zoom: number; panX: number; panY: number }) => void
  /** Viewport change driven by the user, which stops automatic re-fitting. */
  adjustViewport: (v: { zoom: number; panX: number; panY: number }) => void
  setZoom: (zoom: number) => void
  setStageSize: (size: { width: number; height: number }) => void
  setDrawing: (drawing: boolean) => void
  setClipboard: (objects: DocumentObject[]) => void
  setFontLoaded: (loaded: boolean) => void
  setClipperReady: (ready: boolean) => void
}

export const useUiStore = create<UiState>()((set, get) => ({
  tool: 'select',
  theme: readTheme(typeof window === 'undefined' ? null : window.localStorage),
  panelTab: 'design',
  temporaryTool: null,
  editingPoints: null,
  insideFrame: null,
  spread: null,
  frameSelection: [],
  playing: false,
  previewObject: null,
  interacting: null,
  typing: null,
  mosaicSelection: [],
  mosaicStates: {},
  mosaicPlayback: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  stageWidth: 0,
  stageHeight: 0,
  isDrawing: false,
  clipboard: [],
  fontLoaded: false,
  clipperReady: false,
  viewportAdjusted: false,

  // The palette is a plain value; App puts it on the document and keeps it.
  setTheme: (theme) => set({ theme }),
  /*
   * Picking a tool leaves point editing.
   *
   * Point editing and the grid editor are both ways of being INSIDE one shape,
   * and both draw its boundary in the same orange with the same white handles.
   * With both on there were two outlines on screen disagreeing about where the
   * edge was, and nothing to say which one a drag would move.
   *
   * Point editing is a Select-tool mode — it is entered by double-clicking with
   * Select active and means nothing under any other tool — so choosing a tool is
   * choosing to leave it. `temporaryTool` deliberately does not do this: holding
   * Space to pan is borrowing a tool for a moment, not putting the object down.
   */
  setTool: (tool) =>
    set((state) =>
      tool === 'select' || state.editingPoints === null
        ? { tool }
        : { tool, editingPoints: null },
    ),
  // Normalised rather than trusted. Nothing persists the tab, but the store
  // outlives a hot reload, so a session that was sitting on the old 'colour'
  // value would otherwise come back to a tab that no longer renders anything.
  setPanelTab: (panelTab) => set({ panelTab: panelTab === 'animate' ? 'animate' : 'design' }),
  setTemporaryTool: (temporaryTool) => set({ temporaryTool }),
  setEditingPoints: (editingPoints) => set({ editingPoints }),
  /*
   * Leaving a frame drops what was picked inside it. A member id means nothing
   * once you are outside — it would be a selection the panel counts and reports
   * while nothing on screen is in it, which is the bug the mosaic's own
   * teardown exists to prevent.
   */
  // Leaving a frame folds ITS row too: a spread frame with nobody inside it is
  // not a state anything can be in. Another object's row is not its business.
  setInsideFrame: (insideFrame) =>
    set((state) =>
      insideFrame === null
        ? {
            insideFrame: null,
            frameSelection: [],
            spread: state.spread === state.insideFrame ? null : state.spread,
          }
        : { insideFrame },
    ),
  // Either way the member pick goes: the row is a new place to be looking.
  setSpread: (spread) => set({ spread, frameSelection: [] }),
  setFrameSelection: (frameSelection) => set({ frameSelection }),
  setFramePick: (frame, frameSelection, at) =>
    set((state) => ({
      frameSelection,
      mosaicStates: { ...state.mosaicStates, [frame]: Math.max(0, Math.floor(at)) },
    })),
  setPlaying: (playing) => set({ playing }),
  setPreviewObject: (previewObject) => set({ previewObject }),
  setInteracting: (interacting) => set({ interacting }),

  setMosaicState: (object, index) =>
    set((state) => ({
      mosaicStates: { ...state.mosaicStates, [object]: Math.max(0, Math.floor(index)) },
    })),

  clampMosaicState: (object, count) =>
    set((state) => {
      const at = state.mosaicStates[object]
      if (at === undefined) return {}
      const highest = Math.max(0, count - 1)
      if (at <= highest) return {}
      // Undo, a delete or a smaller count can leave the cursor standing past the
      // end. It steps back to the last state rather than showing nothing.
      return { mosaicStates: { ...state.mosaicStates, [object]: highest } }
    }),

  shownState: (object) => get().mosaicStates[object] ?? 0,

  playMosaic: (object) =>
    set((state) => {
      const current = state.mosaicPlayback
      // Resuming keeps the clock where the pause left it; starting a different
      // mosaic begins at the state being looked at rather than at zero.
      const atMs = current && current.object === object ? current.atMs : 0
      return { mosaicPlayback: { object, playing: true, atMs } }
    }),

  pauseMosaicPlayback: (atMs) =>
    set((state) => {
      const current = state.mosaicPlayback
      if (!current) return {}
      return {
        mosaicPlayback: { ...current, playing: false, atMs: atMs ?? current.atMs },
      }
    }),

  restartMosaic: (object) =>
    set((state) => {
      const current = state.mosaicPlayback
      const playing = current?.object === object ? current.playing : false
      return { mosaicPlayback: { object, playing, atMs: 0 } }
    }),

  stopMosaicPlayback: () => set((state) => (state.mosaicPlayback ? { mosaicPlayback: null } : {})),
  /*
   * The caret's tile is a selected tile, always.
   *
   * That is what makes editing one mode rather than two: the tile you are typing
   * into is the tile whose edges you can drag, with nothing to switch between.
   * A caret that is ALREADY in the selection leaves it alone, so moving about
   * inside a multi-selection does not collapse it — otherwise shift-clicking a
   * second tile would immediately throw the first one away.
   *
   * Moving the caret to a tile nobody chose moves the working tile with it —
   * putting the caret somewhere IS choosing that tile, and leaving handles on
   * the tile you just typed away from would be worse than useless.
   *
   * Dropping the caret does NOT drop the selection, though. The two are separate
   * questions: which tiles are being worked on, and where the next letter goes.
   * A marquee answers the first without answering the second — clearing the
   * selection here meant every press emptied it before the press could extend
   * it, so Shift-click could never add a second tile.
   *
   * Leaving the mosaic still clears both, but that is the caller's to say: it
   * knows whether the press left the object or merely put the caret down.
   */
  setTyping: (typing) =>
    set((state) => {
      if (!typing) return { typing: null }
      if (state.mosaicSelection.includes(typing.leaf)) return { typing }
      return { typing, mosaicSelection: [typing.leaf] }
    }),
  setMosaicSelection: (mosaicSelection) => set({ mosaicSelection }),
  toggleMosaicSelection: (leaf) =>
    set((state) => ({
      mosaicSelection: state.mosaicSelection.includes(leaf)
        ? state.mosaicSelection.filter((id) => id !== leaf)
        : [...state.mosaicSelection, leaf],
    })),
  activeTool: () => get().temporaryTool ?? get().tool,
  setViewport: ({ zoom, panX, panY }) =>
    set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), panX, panY }),
  adjustViewport: ({ zoom, panX, panY }) =>
    set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), panX, panY, viewportAdjusted: true }),
  setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
  setStageSize: ({ width, height }) => set({ stageWidth: width, stageHeight: height }),
  setDrawing: (isDrawing) => set({ isDrawing }),
  setClipboard: (clipboard) => set({ clipboard }),
  setFontLoaded: (fontLoaded) => set({ fontLoaded }),
  setClipperReady: (clipperReady) => set({ clipperReady }),
}))

// Dev-only handle, matching the one on the document store, for inspecting UI
// state from the browser console. The `typeof window` guard keeps it out of the
// way of the headless test run.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __ui?: typeof useUiStore }).__ui = useUiStore
}
