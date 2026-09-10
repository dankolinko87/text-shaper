# UX step 9 — a spread folds on a double-click, not on the first click beside it

Copies of `src/editor/FrameLayer.tsx` and `src/editor/Canvas.tsx` before
2026-09-10 22:08. Also touched: `src/editor/frameStates.ts` (three rules
added), `tests/editor/frameStates.test.ts` (four cases added).

## The rule

While a frame is spread, a single press on empty ground only puts the member
pick down: the row stays, the frame stays selected, its handles stay. The row
folds on a DOUBLE-click on the ground, on Escape, or on its own button. A
collapsed frame behaves as before: one press outside leaves it.

The row is laid out to be compared, and comparing involves clicking about —
putting a member down, missing a window by a pixel. Folding it on the first
such click threw the comparison away.

## Where it lives

`frameStates.ts` — the frame's brain, so the layer and the canvas ask rather
than restate: `spreadHoldsGround()`, `pressOutside(frameId)`,
`doublePressOutside(frameId)`. `FrameLayer.onDown` calls `pressOutside` for a
press that hit no window; `FrameLayer.onDoubleClick` calls
`doublePressOutside` first. `Canvas.onCleared` — Fabric's "let go of the
selection" — re-runs the one selection mirror (`syncSelectionToCanvas`) in a
microtask while a spread holds the ground, so the handles come back after
Fabric has finished with the press. That guard sits BEFORE the handler's
"inside anything" early return, because a spread is always inside.

## Also fixed, from the same report

Only the first spread window carries the frame's `shapeId`; a press on the
ground of any other window read as a press on nothing and deselected the
frame. `Canvas.onSelection` now maps a window with no `shapeId` to its
`frameId`, so every window is the frame.

## Browser (scratch server, reloaded, every action on the scratch tab)

Spread, then: a press on window 3's ground → frame still selected, handles on
the frame, row intact; a press beside the row → the same; a double-click
beside the row → row folded, still inside the frame, still selected.

## Result

`npm run check`: 99 files, 1381 tests, typecheck and lint clean.
