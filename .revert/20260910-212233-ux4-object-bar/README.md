# UX step 4 — one bar under the object, and numbered spread windows

Copies of `src/editor/{Canvas,FrameStateBar,MosaicStateBar,ObjectPlayBar}.tsx`,
`src/editor/canvas.css`, `src/editor/canvasAnchor.ts`,
`src/components/controls.css` and `src/components/Icon.tsx` before
2026-09-10 21:22. The three bar components are DELETED from the live tree; this
folder is the only copy.

## What changed

- **`ObjectBar.tsx`** replaces `MosaicStateBar`, `FrameStateBar` and
  `ObjectPlayBar`. One black pill centred under the selected object (or the
  mosaic being typed into): `▶ | ‹ n/N › + | spread` for a frame, without the
  spread toggle for a mosaic, play alone for a shape with a preset. Play is
  always there and disabled while nothing moves. Spread: `▶ | + | □`, hung from
  the whole row. Every button carries a tooltip opening upward. The mosaic's
  count keeps its invisible native select.
- **`objectBarActions.ts`** holds the rules, callable without a DOM: `moves`,
  `playing`, `togglePlay` (a spread frame folds back to one window and plays
  in one press), `addState` (a copy of the shown state; of the LAST one while
  spread), `toggleSpread`, `spreadBounds` (the row, in the frame's own units).
- **`SpreadChips.tsx`**: a numbered chip over each window's top-left, placed by
  `placeOnStage`; the shown state's chip is inverted; pressing one shows that
  state.
- **`canvasAnchor.ts`**: no more `'bottom-left'`; the hook takes an optional
  `bounds` (the spread row).
- **`canvas.css`**: the `.mosaic-bar*` block is gone (with its `#fff`, raw
  `rgb()` and `120ms ease`); `.object-bar*` and `.spread-chip*` through tokens.
- `Icon.tsx`: `collapse: Square`.
- `Canvas.tsx`: one mount each for `ObjectBar` and `SpreadChips`; `shownFrame`
  deleted (its only reader was the frame bar).

## Tests

`tests/editor/objectBar.test.ts` — through the real stores: nothing to play for
a plain shape or a frame of copies, something after one state differs; play
starts and a second press stops (not pauses); play on a spread frame clears
the spread and starts playback; a shape previews on its own switch; add copies
the shown state and goes to it, or the last one while spread; the spread opens
with nothing playing; the row's bounds cancel the frame's scale.

## Browser (scratch server, reloaded)

Frame selected: black 32px pill, `▶ ‹ 1/4 › + | spread`, centred under the
frame. Spread: four chips one window step apart (171.7px = 380 × 1.12 × zoom),
bar centred under the row to 0.1px, chip 3 shows state 3 and inverts, play →
`spreadFrame === null`, playing, chips gone, viewport restored. Panning the
frame down: the bar flips above the frame exactly when below would enter the
pill's band, and back when panned up.

## Result

`npm run check`: 99 files, 1377 tests, typecheck and lint clean.
