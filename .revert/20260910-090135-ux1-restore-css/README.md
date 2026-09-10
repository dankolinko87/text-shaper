# UX step 1 — restore the lost CSS, and a test that keeps it

Copies of `src/editor/panels.css`, `src/editor/canvas.css`,
`src/components/controls.css`, `src/styles/*.css`, `src/editor/GridSizeField.tsx`
and `src/editor/ObjectPlayBar.tsx` as they stood before 2026-09-10 09:01.

## What changed

- `.warning` is back (verbatim from `dist/assets/index-cNdP4o8x.css`, the only
  place it survived), so the three warnings in the panels are tinted again.
- `@keyframes loading-slide` is back; the loading bar had been standing still.
- `.mosaic-bar__divider` has a rule for the first time — the frame bar had been
  drawing its divider invisibly.
- `field--stacked` → `field--stack` (the rule that exists); `mosaic-bar--play`
  dropped (nothing ever styled it).
- Twelve dead rules deleted, each with the comment that stood over it:
  `.state-bar*` (4), `.state-picker*` (2), `.panel__empty-state/-title/-body`,
  `.section__summary-dim`, `.topbar__status`, `.field__value`.
- The "RESTORED from a build" note over the panels block rewritten, as it asked.

## The test

`tests/styles/classNames.test.ts` walks `src` and asserts two things: every
class a component writes has a selector in some stylesheet, and every selector
is written by some component. No DOM, no parser; comments are stripped and the
rest read as words. Before the fixes it failed on exactly the five missing
classes and the twelve dead rules above. One allowlisted hook:
`mosaic-bar--states`, queried by `ObjectPlayBar` and styled by nothing.

## Result

`npm run check`: 96 files, 1360 tests, typecheck and lint clean.
