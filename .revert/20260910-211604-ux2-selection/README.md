# UX step 2 — one answer to "what is selected"

Copies of `src/editor/PropertiesPanel.tsx`, `src/editor/ObjectPlayBar.tsx` and
`src/editor/Canvas.tsx` before 2026-09-10 21:16.

## What changed

New `src/editor/selection.ts`: `selectedObject(selection, objects, ui)` — a
pure function — and `useSelectedObject()` over it. It answers, from one place,
the OUTER object (the frame while inside it), the member picked, the object the
panel edits (the member as the shown state draws it, through `memberAsDrawn`),
where edits go, and which object's STATES are on show.

The derivation was lifted verbatim from the properties panel, which used to be
one of three places working it out (with the play bar and the canvas). The
panel, the play bar and the canvas now ask; the canvas no longer computes
`soleSelected` and the play bar no longer takes an object prop.

No visible change. `tests/editor/selection.test.ts` covers nothing, one
shape, a frame, a member picked inside a frame (frame stays the stated object;
edits go to the member; the object carries the shown state's colour), and
several members picked.

## Result

`npm run check`: 97 files, 1365 tests, typecheck and lint clean.
