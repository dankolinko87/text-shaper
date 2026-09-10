# UX step 3 — the tool pill, flyouts that open upward, one popover, one dismiss

Copies of every file this step touched, as they stood before 2026-09-10 21:18:
`src/app/App.tsx`, `src/app/app.css`, `src/styles/tokens.css`,
`src/components/controls.css`, `src/components/controls.tsx`,
`src/editor/{Toolbar,TopBar,ExportMenu,TilePicker,MosaicStateBar,FrameStateBar,ObjectPlayBar}.tsx`,
`src/editor/canvasAnchor.ts`, `src/editor/panels.css`, `src/editor/canvas.css`.

## What changed

- **Tokens.** A z-index scale (`--z-canvas-bar/-toolbar/-popover/-overlay/-tooltip`)
  that every floating thing now reads; `--duration-slow` (zeroed under reduced
  motion); the pill palette (`--pill-bg/-fg/-line/-edge`, `--pill-height`,
  `--tool-pill-height`). Removed, unused: `--toolbar-width`, `--artboard-bg`,
  `--artboard-shadow`, `--selection-hover`, `--text-lg`, `--space-7`,
  `--duration-base`.
- **Recipes** in `controls.css`: `.pill` (black plate, hairline edge, full
  radius) and `.pill__divider`; `.popover` (surface, radius, shadow, a mount
  keyframe that arrives from the side it hangs off). The three flyouts add
  `popover` and keep only their placement.
- **The tool pill.** `<Toolbar/>` is now a child of `.app__stage`, absolutely
  positioned at the bottom-centre; its buttons are white on black, the active
  tool in the accent. The tool flyouts open upward, centred on their button.
  Tooltips on the pill open upward. Pan's tip reads `H` (the key that picks it
  up; Space is the hold). The topbar's logo no longer sizes itself to a rail.
- **One dismiss.** `useDismiss` moved to `src/components/useDismiss.ts`; the
  export menu and the tile picker use it instead of their own copies.
- **Anchor flip.** `canvasAnchor.ts` exports `placeOnStage` (the maths) and
  `placeControl` (below the object, or above it when below would enter the
  pill's band). The hook takes an optional `bounds` for a control that hangs
  from something other than the object's own box (a spread frame's row).

## Tests

`tests/editor/canvasAnchor.test.ts`: under the object with room, still under
when the bottom edge exactly meets the limit, above it one pixel later.

## Result

`npm run check`: 98 files, 1368 tests, typecheck and lint clean.
