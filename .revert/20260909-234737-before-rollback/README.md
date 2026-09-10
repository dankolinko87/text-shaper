# Everything as it stood before rolling the spread work back

A full copy of `src/` and `tests/`, taken 2026-09-09 23:47, immediately before
reverting to the state the tree was in at 22:07 — the moment before the spread
view was built. Unlike every other folder here, this is the whole tree, not the
files one piece of work touched, so anything from today can be lifted back out
of it one file at a time.

## Why the rollback happened

The spread view — a frame's states laid out side by side, one window each —
looked correct against its own tests and against a feature-by-feature pass in
the browser, and was badly broken in use. Shapes changed on every click, the
text came away from the shape it was poured into, and one edit reached states
nobody had touched.

## What was found before stopping, and is worth keeping

**`setMemberValues` freezes a member into a state.** It folded its patch into
`valuesFor`'s RESULT rather than into the state's own patch:

```ts
const next = { ...valuesFor(member, source), ...patch }
```

`valuesFor` fills in every field a state is silent about from the member itself,
so writing a transform wrote the member's whole current self into that state —
`appearance`, `nodes`, `typeSettings`, `padding` — and the state stopped
following the member for good. One drag froze a shape's outline, its colours and
its type settings into a keyframe.

**This is not a spread bug.** It is as old as the frame model, it happens in the
collapsed view too, and it is the thing to think about before any view is built
on top of the model again. It is deliberately back in place after the rollback,
because reverting means reverting.

The fix that was in the tree when it was rolled back, with its test, is in this
snapshot at `src/state/documentStore.ts` and
`tests/state/memberValuesArePatches.test.ts`.

## What else is in here that the live tree no longer has

- The spread view in full, and the fixes made around it.
- A schema migration to version 29 that stripped the frozen fields from saved
  documents. **Destructive**: it rewrote documents on load. Gone from the live
  tree, which is back at version 28.
- Member edits and background edits landing only on the state being edited,
  instead of carrying forward through the states that are still copies.
- Frames keeping their scale on their transform, which is what made a frame
  resizable at all. Reverted, so a frame's corner drag moves it and does not
  resize it — a bug that predates all of today's work.
- Duplicating, copying and pasting a member inside a frame from the keyboard,
  and the guard that stopped Alt-dragging a member from cloning the whole frame.
  Reverted, so those gestures act on the frame again — also a bug that predates
  the spread, from the change that made members real Fabric objects.

## Restoring one thing from here

```
cp .revert/20260909-234737-before-rollback/src/<path> src/<path>
```

Check what a file depends on before lifting it out: `uiStore.ts` here carries
`spreadFrame`, and `renderer.ts`, `Canvas.tsx`, `animationPlayback.ts` and
`FrameStateBar.tsx` all expect it.

## The live tree after the rollback

`npm run check` — 1289 tests, 89 files, typecheck and lint clean. That is the
count from before the spread was built: the spread added ten tests in one file.
