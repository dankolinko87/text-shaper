# Phase 1 — the collapsed frame made trustworthy

Copies here were taken before the work, on 2026-09-10, after Phase 0. Restore
one with `cp .revert/<this dir>/<file> src/editor/<file>` (or `src/state/` for
`uiStore.ts`).

## The rule this phase establishes

Inside a frame, a member behaves as an object on the artboard does, the frame
behaves as a mosaic does, and no write reads the UI store to find its target.

## What changed, and why

**Every write derives its target from the Fabric object it acted on.** The
frame's group now stamps `frameId` and `stateIndex` (the state it draws).
`readMemberTransform(child)` (Canvas.tsx, exported) reads both off the child's
parent; the selection handler writes the pick — members and the state they were
picked in — as one change through `uiStore.setFramePick`, so the panel, the
point editor and the colour controls land on the state the object was picked
in. `writeMemberTransform` is gone. `onModified` reads every active member
before writing any.

**A frame resizes.** `collectTransforms` exempts frames from baking as it does
mosaics; the scale stays on the transform, and every member is drawn inside it.

**The frame is selectable while you are inside it.** The builder and
`applyCanvasMode` keep the open frame selectable; `syncSelectionToCanvas`
holds the frame when no member is picked. Clicking its ground selects it (as in
Figma); Fabric still hands a press on a member to the member. This is what makes
a frame movable and resizable from inside, and it removes the reuse-path bug
that flipped `selectable` back on every document change.

**An overhanging member is clickable.** `FrameGroup.getCoords()` reports the
union of the box and the children's corners when the frame does not clip.
Width, height and handles are untouched. `FrameLayer.onDown` decides "ground
of this frame or outside" by asking the press target's `frameId`, not by
testing the document's box.

**A stale shown index draws the LAST state**, the answer every gesture already
gives, so what is looked at is what is edited. The content key gains member
flips and the box's x/y.

**A press on a playing frame settles it first.** `settleFrame` (renderer.ts)
is the one function both stopping and pressing use. Registered on Fabric's
`mouse:down:before` — which fires with the target resolved, before the gesture
is set up — so a drag begins from the arrangement being edited, not from
wherever the clock had painted the member. A preview of the frame ends there,
as a press on a previewing mosaic ends its preview; under the global play the
frame is held until the pointer lets go (`animatingFrameIds` drops the
interacting frame). Stopping paints the plate too. A member's inner group
carries its own object's `shapeId`, so "what is being manipulated" asks for a
member FIRST and then its frame.

**Alt-drag, Cmd+D, Cmd+C and Cmd+V act on the picked member inside a frame.**
`Canvas.onMoving` leaves members to `FrameLayer`; the shortcuts use
`duplicateFrameMember` and `memberAsFreed` (frame.ts) — the one rule for "what
is this member, outside", shared with taking it out. `memberBoxes` takes the
group rather than scanning the canvas for it.

## Verification

`npm run check`: 92 files, 1328 tests, typecheck and lint clean (1311 after
Phase 0; 17 new). Each rule checked to fail with its fix reverted: frames
baking again fails 2, asking the UI store for the state fails 2, the overhang
unreachable fails 1, falling to the first state fails 1.

In the browser on the isolated 5199 origin, canonical document, after hard
reloads:

- ground click selects the frame, member click picks the member, both inside
- the frame's corner handle scaled it 1 → 1.366 and its member with it (163.9
  on screen for 120 × 1.366), one history entry, no state touched
- a member pushed past the authored edge is picked on its overhang
- selectable survives a document change while inside
- deleting the shown state with a stale cursor: the canvas draws the last state
- Alt-drag: one new member, no new top-level object, one history entry; Cmd+D
  the same
- dragging a member while its frame previews: the preview stops on the press,
  the member is settled to its state before the drag, and the write is the
  drag alone (x −45.2, y 0); the same under the global play, where the frame
  resumes on release; the plate settles to the shown state's colour on stop
