# Phase 2 — the frame's states, on a par with the mosaic's

Copies here were taken before the work, on 2026-09-10, after Phase 1. Restore
one with `cp .revert/<this dir>/<file> <original path>` (`src/editor/` for the
components and `panels.css`, `src/state/` for the stores, `src/export/` for
`gif.ts`). Two files are NEW and have no copy: `src/editor/frameStates.ts` and
`src/editor/FrameThumbnail.tsx` — delete them to revert, after restoring the
files that import them.

## The rule this phase establishes

There is one brain for "show, duplicate, delete, move a state" and every
control goes through it; the state list never leaves the screen while a
member is being edited; a state's thumbnail is a real render of that state.

## What changed, and why

**`frameStates.ts`** mirrors `mosaicStates.ts` function for function:
`showFrameState` (stops playback, guards the range), `duplicateFrameStateAt`
(commits, re-reads, goes to the copy), `deleteFrameStateAt` (lands on the
survivor), `moveFrameStateTo` (follows the state that moved). The bar under
the frame and the panel's list both use it. Before, the bar inlined its own
"show", and the panel's + and delete ignored the index the store returned —
duplicating from the panel left you on the original, and deleting the shown
state left the cursor past the end.

**Store:** `moveFrameState` (the mosaic's, for a frame),
`applyFrameStateToAll` (lays what one state says over every other state, at
both patch levels, so a colour pushed everywhere does not erase a position
another state authored) and `resetFrameStateToMember` (forgets what a state
says about a member, so it follows the member again — which is also how a
state frozen by an older build is put right). The two stale doc comments that
still described carry-forward are rewritten.

**`FramePanel`:** the states list is its own exported `FrameStateList`, with
the mosaic's list machinery lifted across: opening a card shows its state and
closing leaves the canvas alone; stepping on the canvas carries the open card;
drag-to-reorder with the same 4px slop, insertion-point maths, cancel on
`pointercancel`, and a capture-phase Escape that does not fall through to the
editor's own; Alt+Arrow moves a state one place. The background control moved
onto the state's card — it was in the frame-wide section, silently editing
whichever state was on show. Each card body carries the two escape hatches,
acting on the picked member when there is one and on every member otherwise.

**`FrameThumbnail`:** a real SVG render per state, built the way the canvas
draws a member — `memberAtState`, the same `fitObject`, and where the state
reshaped the member the type is poured through the state's outline with the
layout held still. It shows position, rotation, flip, colour, fade, border and
backdrop; the grey boxes it replaces showed position and size and nothing
else. `frameStateArtwork` is exported and pure so a test holds it against the
canvas's own functions.

**`PropertiesPanel`:** with a member picked inside a frame, the frame's state
list renders above the member's tabs instead of the panel swapping out.

**`ExportMenu`:** a frame is refused plainly before anything runs, and the
summary says so, instead of advertising an export and then failing with the
mosaic's error text. Building the export is deferred.

## Verification

`npm run check`: 94 files, 1346 tests, typecheck and lint clean (1328 after
Phase 1; 18 new). Each rule checked to fail with its fix reverted: duplicate
not re-showing fails 1, apply replacing instead of laying over fails 1, the
thumbnail drawing the type unpoured fails 1.

In the browser on the isolated 5199 origin, canonical document, after a hard
reload: the bar's + and the panel's + each left cursor, drawn state and the
marked card agreeing on the copy; deleting the shown state from its card
landed all three on the survivor; Alt+ArrowDown on a card and a pointer drag
to the end of the list both reordered the states and the canvas followed the
one that moved; picking a member kept the state list on screen beside the
member's tabs; "Apply to every state" put the state's colour into every state
and "Reset to follow the shape" emptied the shown one; every thumbnail held
real path data.
