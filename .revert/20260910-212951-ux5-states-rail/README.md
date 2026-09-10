# UX step 5 — the states rail on the left

Copies of `src/editor/{StateList,FramePanel,PropertiesPanel}.tsx`,
`src/editor/panels.css`, `src/app/App.tsx` and `src/app/app.css` before
2026-09-10 21:29.

## What changed

- **`StatesRail.tsx`** (new), first child of `.app__body`: zero wide and empty
  unless the selection is a mosaic or a frame (`useSelectedObject().stated`,
  the OUTER object — a member picked inside a frame keeps the frame's states
  open). Holds the mosaic's `StateList` or the frame's `FrameStateList` under
  a header with the object's name and state count.
- **Animation**: the rail's width tweens 0 ↔ `--panel-width` over
  `--duration-slow`; the panel inside is a fixed width so it is clipped, not
  squashed, and fades and slides in on mount. Closing keeps the last object
  mounted (inert) until the width transition ends, so the panel shuts with
  its cards inside; under reduced motion it unmounts at once. Switching
  between two stated objects swaps content with no width change.
- **What moved**: `StateList` now renders only the `.states` list;
  `GridSection` and `PlaybackSection` are exported and stay on the right for a
  mosaic (`GridSection` derives the shown state itself). `FramePanel` keeps
  the Frame section only; `FrameStateList` moves to the rail. The strip of
  frame states above a picked member's controls is gone — the rail is that.

Rule: object-level settings on the right, the per-state list on the left.

## Browser (scratch server, reloaded)

Nothing selected → rail 0px, nothing mounted, inert, transition 0.22s. A plain
shape → the same. The mosaic → 196px at 60ms, 268px settled, "Mosaic 2" with
its state cards; the right panel shows Grid and Playback and no states. The
frame → stays 268 with zero width changes observed, content swaps to "Frame
1"; the right panel shows only the Frame section. Deselect → content still
mounted and inert while the width closes, gone at 0. Canvas width tracks the
stage. On a fresh, never-zoomed load the canvas re-fits on the resize, as it
does for any resize; once zoomed, see step 6's README for the probe.

## Result

`npm run check`: 99 files, 1377 tests, typecheck and lint clean.
