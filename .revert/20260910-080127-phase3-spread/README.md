# Phase 3 — the spread: a frame's states side by side, every window live

Copies here were taken before the work, on 2026-09-10, after Phase 2. Restore
one with `cp .revert/<this dir>/<file> <original path>` (`src/editor/`,
`src/state/uiStore.ts`, `src/components/Icon.tsx`).

## The rule this phase establishes

A window is the frame drawn at one state through the one builder and the one
settle; the first window is the frame; every write asks the window it
happened in; the row is a view.

## What changed, and why

**Rendering** (`renderer.ts`): `SyncInput.spreadFrame`; `RenderedObject.windows`
with `windows[0] === group`, and `windowsOf(entry)` so removal, z-order and
`contentBounds` cover every window; `windowOffset`; `buildFrameGroup(…, window)`
— a further window carries no `shapeId` (the hazard the whole design is built
around: it would enrol the window in every first-match lookup at once), is not
selectable as a whole, and stands along the row; the spread key describes
every state. Window 0 is pinned to state 1 whatever is on show, so the row
never re-orders itself under the hand doing the picking.

**Settling** (`Canvas.tsx`): after every sync while spread, each window is
settled to its own state with `settleFrame` — the same function the stop
button uses — so each window's type is fitted and poured for its own state.
The builder only has the shown state's text paths; the settle has every
state's fit.

**Writes**: nothing new. Phase 1 already made every write ask the Fabric
object's parent for its frame and state, so a drag in window 3 lands on state
3 with no spread-specific code — that was the point of doing it there first.
The selection mirror looks in the window the pick was made in; the point
editor's handles are mapped through the window's offset.

**View** (`uiStore.spreadFrame`): spreading goes inside; leaving collapses.
Opening fits the view to the row through the one fit implementation, and
collapsing puts the view back exactly. The bar under the frame keeps only add
and collapse while spread; the play bar hides; `animatingFrameIds` refuses a
spread frame. `FrameLayer` draws an edge per window, and its ground rule
already asked the press target for its `frameId`, so a click on any window's
ground stays inside.

## Verification

`npm run check`: 95 files, 1358 tests, typecheck and lint clean (1346 after
Phase 2; 12 in `tests/editor/frameSpread.test.ts`). Each rule checked to fail
with its fix reverted: the key describing only the first window fails 1,
further windows not offset fails 2, every window carrying the frame's
`shapeId` fails 1, a write asking the UI store for its state fails 2.

In the browser on the isolated 5199 origin, canonical document, after a hard
reload, opened from the bar's own button:

- three windows, the first exactly where the frame was, evenly spaced, all on
  screen after the automatic fit
- only add and collapse under the frame; no play bar
- window 1 selectable and carrying the frame's id; windows 2 and 3 neither
- each window drawing ITS state: plate, container fill and fitted text all
  differ in window 3, whose state has its own colour, backdrop and sentence
- a pick in any window makes that window's state the shown one
- a real Fabric drag in window 2 recorded `['transform']` in state 2 and
  nothing else, one history entry, and the row held still
- a click on window 3's empty ground stayed inside, put the pick down, and
  left the frame held
- double-clicking the member in window 1, in window 3, and collapsed opened
  its points on the shape, 4 of 4 — after a harness fix: Fabric fires its
  double-click only for a synthetic event whose `detail` is 2
- `+` added a fourth window at the end of the row
- collapse left one window, restored the view exactly, and the history was
  untouched by opening or closing the row
