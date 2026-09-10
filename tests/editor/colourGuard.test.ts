import { describe, expect, it } from 'vitest'

import { applyColourGuard, type GuardableObject } from '../../src/editor/colourGuard'

/**
 * The Colour tab must take hold of ONE mosaic, and leave the artboard alone.
 *
 * It used to be treated as being "inside" an object, which is an artboard-wide
 * canvas mode: target finding off, `canvas.selection` off, every shape
 * unselectable. Opening the tab therefore killed selection everywhere — you
 * could not click another object, could not rubber-band, could not even
 * reselect the mosaic. Tiles still answered, because `MosaicLayer` hit-tests
 * those itself, so the whole thing read as "it only lets me select one glyph".
 */

/** A stand-in for a Fabric object that records what was set on it. */
function fakeObject(shapeId: string | undefined) {
  const props: Record<string, unknown> = {
    shapeId,
    lockMovementX: false,
    lockMovementY: false,
    hasControls: true,
  }
  const object: GuardableObject & { props: Record<string, unknown> } = {
    props,
    get: (key: string) => props[key],
    set: (values) => Object.assign(props, values),
  }
  return object
}

function fakeCanvas(...objects: ReturnType<typeof fakeObject>[]) {
  return {
    objects,
    forEachObject: (callback: (o: GuardableObject) => void) => objects.forEach(callback),
  }
}

describe('the colour guard', () => {
  it('takes the handles off the mosaic being coloured, and locks it', () => {
    const mosaic = fakeObject('mosaic-1')
    const canvas = fakeCanvas(mosaic)

    applyColourGuard(canvas, 'mosaic-1')

    // No control under the pointer, so Fabric cannot start a scale — which is
    // what a corner-started sweep actually did, squashing the mosaic.
    expect(mosaic.props.hasControls).toBe(false)
    expect(mosaic.props.lockMovementX).toBe(true)
    expect(mosaic.props.lockMovementY).toBe(true)
  })

  it('leaves every other object exactly as it was', () => {
    const mosaic = fakeObject('mosaic-1')
    const other = fakeObject('shape-2')
    const another = fakeObject('mosaic-3')

    applyColourGuard(fakeCanvas(mosaic, other, another), 'mosaic-1')

    for (const untouched of [other, another]) {
      expect(untouched.props.hasControls).toBe(true)
      expect(untouched.props.lockMovementX).toBe(false)
      expect(untouched.props.lockMovementY).toBe(false)
    }
  })

  it('gives the mosaic its handles back when the tab closes', () => {
    const mosaic = fakeObject('mosaic-1')
    const canvas = fakeCanvas(mosaic)

    applyColourGuard(canvas, 'mosaic-1')
    applyColourGuard(canvas, null)

    expect(mosaic.props.hasControls).toBe(true)
    expect(mosaic.props.lockMovementX).toBe(false)
    expect(mosaic.props.lockMovementY).toBe(false)
  })

  it('releases the old mosaic when the coloured one changes', () => {
    // Selecting a different mosaic with the tab still open must not leave the
    // first one permanently unable to move.
    const first = fakeObject('mosaic-1')
    const second = fakeObject('mosaic-2')
    const canvas = fakeCanvas(first, second)

    applyColourGuard(canvas, 'mosaic-1')
    applyColourGuard(canvas, 'mosaic-2')

    expect(first.props.hasControls).toBe(true)
    expect(first.props.lockMovementX).toBe(false)
    expect(second.props.hasControls).toBe(false)
    expect(second.props.lockMovementX).toBe(true)
  })

  it('ignores overlay objects, which carry no shape id', () => {
    // MosaicLayer draws tile outlines and handles straight onto the canvas.
    const overlay = fakeObject(undefined)

    applyColourGuard(fakeCanvas(overlay), 'mosaic-1')

    expect(overlay.props.hasControls).toBe(true)
    expect(overlay.props.lockMovementX).toBe(false)
  })
})
