# Spread-view regressions, and the older bugs the spread exposed

Copies taken 2026-09-09 22:32, before the fixes described below. Restore any
file by copying it back over the one in `src/editor/`.

| file here | goes back to |
| --- | --- |
| `Canvas.tsx` | `src/editor/Canvas.tsx` |
| `FramePanel.tsx` | `src/editor/FramePanel.tsx` |
| `FrameStateBar.tsx` | `src/editor/FrameStateBar.tsx` |
| `PathLayer.tsx` | `src/editor/PathLayer.tsx` |
| `renderer.ts` | `src/editor/renderer.ts` |

`src/editor/transformSync.ts` was changed after these copies were taken and has
no copy here. Its change is one condition, described under "Frames never
resized" below.

## What was wrong

Only one of these was caused by the spread. The rest were older faults that
drawing every state at once made visible.

**A window only redrew when the FIRST state changed.** A frame is rebuilt when
its content key changes, and the key described the state in the first window.
Spread, every state is drawn, so a colour or an arrangement authored in state 3
changed nothing the key could see and window 3 went on showing what it showed
before. This one bug read as several: a background that "only worked on the
first states", edits that did not appear, thumbnails that would not update. The
key now covers every window while spread.

**A member hanging over the frame's edge could not be clicked.** Fabric only
looks inside a group when the pointer is already within the group's own corners,
so with clipping off the overhanging part was painted and unreachable. True of
any frame whose contents overflow it; the spread made it easy to meet, because a
later state usually moves something further than the first does. `FrameGroup`
now reports a hit area that includes what it draws, and only when the frame does
not clip.

**Frames never resized, in any view.** A resize was split off into a "bake" —
the step that folds a scale into an outline — and only typography can bake, so a
frame's scale was computed and then dropped. Dragging a frame's corner moved it
and left it the size it was. A frame now keeps its scale on its transform, as a
mosaic already did.

**A spread frame could not be selected at all.** Going inside a container takes
its own box away so presses reach its contents, and you leave to get the box
back. A spread has no leaving — collapsing is the only way out — so the frame
could be neither moved nor resized while the row was open. The frame stays
pickable while spread; Fabric still hands a press on a member to the member.

**Picking in window 1 did not set the state.** The guard asked `window > 0`,
meaning "only when spread", since a collapsed frame answers 0 for everything.
But window 1 is a window too, so reaching into it left the shown state wherever
it was and the next edit landed elsewhere. The guard now asks about the mode.

**Opening the spread did not frame it.** A row four frames wide does not fit
where one frame did, so every window past the first stood off the right edge.
Opening now fits the view to the row and collapsing puts the view back exactly.

## Also fixed just before these copies

Alt-drag, Cmd+D and Cmd+C on a member cloned the whole frame; the path overlay
was offset in the spread; the background control sat in the frame-wide section
rather than the state's; the panel card did not follow the shown state; `+` was
missing from the spread's bar; clicking a window's ground left the spread.

## Verification

`npm run check` — 1308 tests, 90 files, all passing. Every behaviour above was
also driven by hand in the browser on the isolated scratch origin, collapsed and
spread: entering a frame, cursors, moving, resizing, alt-duplicate, Cmd+D,
Cmd+C/V, re-selecting copies, points on the shape, the Escape ladder, Cmd-drag
out, Delete, the row's layout and framing, per-window picking and editing,
per-state backgrounds, resizing as a whole, the bar's contents, collapse and the
restored view, refusal to animate, and an untouched undo history.

---

## Later: the fault behind "every click something unexpected happens"

Found after the above, by reproducing on a frame whose states were still copies
of one another — which every new frame's are, and which my earlier checks never
used, because the test document arranged each state differently up front. That
one detail hid this completely.

`setMemberValues` in `src/state/documentStore.ts` folded its patch into the
RESOLVED values:

```ts
const next = { ...valuesFor(member, source), ...patch }   // before
```

`valuesFor` fills in every field a state is silent about from the member itself,
so writing a transform wrote the member's entire current self into that state —
`appearance`, `nodes`, `typeSettings` and `padding` — and the state stopped
following the member for good. One drag froze a shape's outline, its colours and
its type settings into a keyframe. Afterwards the shape and the text it was
poured into came apart, reshaping reached only some states, and a colour set in
one state appeared in others, because the states being compared were snapshots
taken at different moments rather than descriptions of what anyone authored.

Now the patch merges into the state's own patch, so only the fields actually
asked for are recorded and everything else keeps falling back to the member.
Pinned by `tests/state/memberValuesArePatches.test.ts`.

This was never a spread bug. It is as old as the frame model; the spread only
put every state on screen at once, where the damage was finally visible.

**Documents made before this fix still carry the frozen values.** Nothing adds
more of them, but the states that were already frozen will keep drawing their
frozen shape and colours until those recorded fields are cleared.

Suite after this change: 1311 tests, 91 files, all passing.
