# UX step 7 — the facelift's last pass

Copies of `src/editor/{Section,StateList,FramePanel}.tsx`, `src/editor/panels.css`,
`src/components/controls.tsx` and `src/components/controls.css` before
2026-09-10 21:37.

## What changed

- **Tooltip delay.** A tip waits 400ms for the pointer to rest; once one has
  hidden, the next within 300ms shows at once — a sweep across the tool pill
  shows one tip late and the rest immediately. Focus still shows at once.
  Module-level `lastHidden`, because "the user is reading tips" is a fact
  about the user, not about a control. The timer is cleared on unmount.
- **Press states and transitions.** `:active` on `.button`, `.segmented
  button`, `.panel__tab`, `.preset-chip`, `.tool-menu__item`,
  `.tile-picker__all`, `.tile-picker__tile`, `.zoom-control__value`,
  `.section__lid`, `.state-card__open`; a `--duration-fast` transition on each
  that had a hover with no transition; `.grid-picker__cell:hover`;
  `.input:disabled, .textarea:disabled`.
- **One small-caps title**: `.panel__section-title, .section__title,
  .export-menu__scope` share one rule; the scope line is a step brighter.
- **Tokens for the raw sizes**: `.panel__tabs` padding and gap, `.panel__tab`
  radius/padding/size, `.preset-grid` gap and margin, `.preset-chip`
  radius/size, `.tool-menu__item` at the panel's text size.
- **Lid chevrons rotate**: one `chevronRight` in a `.lid-chevron` span turned
  90° when open, in `Section`, the mosaic's state cards and the frame's —
  instead of two glyphs swapped.

## Result

`npm run check`: 99 files, 1377 tests, typecheck and lint clean.
