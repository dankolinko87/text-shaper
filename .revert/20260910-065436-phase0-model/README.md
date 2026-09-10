# Phase 0 — a frame's state records only what was authored in it

Copies here were taken before the work, on 2026-09-10. Restore one with
`cp .revert/<this dir>/<copy> <path>`:

| copy | goes back to |
| --- | --- |
| `types-frame.ts` | `src/types/frame.ts` |
| `frame-model.ts` | `src/frame/frame.ts` |
| `documentStore.ts` | `src/state/documentStore.ts` |
| `memberEdits.ts` | `src/editor/memberEdits.ts` |
| `colourParts.tsx` | `src/editor/colourParts.tsx` |
| `renderer.ts` | `src/editor/renderer.ts` |
| `useTextPaths.ts` | `src/editor/useTextPaths.ts` |
| `persistence.ts` | `src/state/persistence.ts` |
| `types-document.ts` | `src/types/document.ts` |
| `Canvas.tsx`, `FrameLayer.tsx` | not changed in this phase; copied in case Phase 1 needs them |

Restoring `types-document.ts` puts the schema version back to 28; restore
`persistence.ts` with it or a document saved at 29 will be refused.

## The rule this phase establishes

A state holds a sparse, two-level patch of what somebody authored in it, and
nothing else. `Object.keys(state.values[memberId])` is the list of what was
done in that state. An edit lands on the state it was made in and nowhere
else.

## What changed, and why

**Four writers froze the member into the state.** `setMemberValues` merged its
patch into the RESOLVED values; `duplicateFrameMember` copied resolved values
into every state; `colourParts.setAppearance` read the resolved appearance,
changed one fill and wrote all five back; `memberEdits.updateShape` did the
same with all six type settings. One drag, one colour or one word froze the
shape's whole current self into that state, and the state could never follow
the shape again. This was never a spread bug; it happens in the collapsed view.

Now: the store merges a patch into the state's own patch, two levels deep
(`appearance` and `typeSettings` merge field by field); the panel writers hand
it only the field that changed; a duplicated member copies its original's
patches, not its resolved values.

**States are born empty.** `stateFromMembers` is gone; `emptyState()` records
nothing, and `addToFrame` no longer writes a position and opacity into every
state. A state that says nothing resolves to the member, exactly as before.

**Carry-forward is gone for frames.** `frameFollowersOf` had two callers, both
deleted. `sameArrangement` stays: playback needs it to know whether there is
anything to animate. Consequence: colouring state 1 of a fresh frame is a
colour animation from 1 to 2, because state 2 still shows the shape's own
colour. That is what authoring a keyframe means.

**The resolver is per field at both levels.** `valuesFor` resolves
`appearance` and `typeSettings` field by field through one `mergeTypeSettings`
that `withTypeSettings` also uses, and reads `padding` off the merged settings
— a state that changes only the text keeps the member's inset instead of
getting 0. `EvaluatedValues` is spelled out rather than derived from the patch
type. `MemberValues.appearance` is `Partial<AppearanceSettings>`.

**Readers that bypassed the resolver now use it.** `strokeAnyState` resolves
through `valuesFor` (the member's own border counts, so a border a state takes
away still has a zero-alpha child to fade). `removeFromFrame` hands back
`memberAtState(member, values)` — the member as its state draws it, colour and
shape included — rebased into artboard space. `memberAtState` lives in the
model; the renderer's `memberAsDrawn` is now that plus its zero-alpha-border
tweak. Both reshape checks (`renderer.ts`, `useTextPaths.ts`) go through
`stateShape`, which compares node lists by value.

**`setGeometry` reaches a member**, through `editObject`; a topology change
drops every state's own nodes for that member, because per-state nodes of
another topology can never be blended.

**Migration v28 → v29 repairs saved documents without loss.** Field by field,
a recorded value equal to what the member gives anyway is dropped; a value
that differs is kept, because the migration cannot tell frozen-then-outdated
from authored. `padding` is always dropped. Every picture is identical before
and after; what changes is which states follow the member from now on.
`completeFrame` drops unknown patch keys on every load and nothing else.

## Verification

`npm run check`: 90 files, 1311 tests, typecheck and lint clean (1289 before
the phase; 22 new). Each new rule was checked to fail with its fix reverted:
the old resolved-values merge fails 7 of 12 patch tests, the whole-object
padding fails the cut-tier test, restored carry-forward fails 6 of 10
background tests.

In the browser on the isolated 5199 origin, on the canonical document (fresh
frame, three states still copies, a shape with text, clipping off, built
through the store's own actions), after a hard reload:

- a real Fabric drag in state 2 recorded `['transform']` in state 2 and
  nothing anywhere else; states 1 and 3 were the same objects before and
  after; the drawn centre matched the resolved transform to 1e-3; history +1
- a colour recorded `appearance: { containerFill }` only; the container drew it
- a text change through the real `updateShape` recorded
  `typeSettings: { text }` only; padding stayed the member's
- a reshape recorded `['nodes']` only in state 3; state 3 drew its own shape,
  state 1 the member's; the drawn centre matched the drawn path's own centre
- recolouring the member itself reached every state silent about that colour,
  while state 2 kept its own container fill
- duplicating and deleting a state each cost one history entry, copied patches
  rather than sharing them, and left bar, panel and canvas agreeing
- after serialising, reloading the page and loading again: recorded keys,
  resolved values and drawn centre identical, and only state 3 judged reshaped
