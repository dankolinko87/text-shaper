/**
 * What the Colour tab is allowed to take hold of.
 *
 * Colouring a mosaic means sweeping across it, and a sweep starts on top of the
 * object — so Fabric reads the very same press as its own. Near the middle it
 * picks the mosaic up; anywhere near an edge or a corner it lands on a resize
 * handle instead and stretches it. Both were seen: the first sweep slid the
 * mosaic across the artboard, and once movement was locked the next one came
 * back as `action: 'scale'` and squashed it to a third of a pixel.
 */

/** The little of a Fabric object this needs, so a test can supply its own. */
export interface GuardableObject {
  get(key: string): unknown
  set(values: { lockMovementX: boolean; lockMovementY: boolean; hasControls: boolean }): void
}

export interface GuardableCanvas {
  forEachObject(callback: (object: GuardableObject) => void): void
}

/**
 * Hold the mosaic being coloured still, and take its handles away.
 *
 * The handles have to be gone BEFORE the press, not cancelled during it: Fabric
 * picks the action inside its own mousedown, before any `mouse:down` listener of
 * ours is called, so a lock applied from a handler is always one step late. With
 * no control under the pointer the action falls back to a drag, and the movement
 * locks refuse that.
 *
 * Scoped to ONE object on purpose. This was once done with the artboard-wide
 * "inside an object" switch, which turns off `canvas.selection`, turns on
 * `skipTargetFind` and makes every shape unselectable. Opening the Colour tab
 * therefore stopped the whole canvas answering clicks — no selecting another
 * object, no rubber band, no reselecting the mosaic itself. Only tiles still
 * responded, because `MosaicLayer` hit-tests those itself, so it read as "it
 * only lets me select one glyph" when in fact the entire artboard had gone dead.
 *
 * The trade is that the guarded mosaic cannot be resized by its handles while
 * the tab is open, and that is the right way round: the Colour tab is tile work,
 * its gestures cover the whole object, and the size controls are one tab away.
 */
export function applyColourGuard(canvas: GuardableCanvas, colouring: string | null): void {
  canvas.forEachObject((o) => {
    const id = o.get('shapeId') as string | undefined
    if (!id) return
    const guarded = id === colouring
    o.set({ lockMovementX: guarded, lockMovementY: guarded, hasControls: !guarded })
  })
}
