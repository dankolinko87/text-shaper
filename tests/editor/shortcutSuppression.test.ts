import { describe, expect, it } from 'vitest'

import { suppressedByCaret } from '../../src/editor/useShortcuts'

/**
 * Shortcuts must not fire while a mosaic tile has the caret.
 *
 * The caret is not a DOM field — it lives on the canvas — so the guard that
 * covers the layer-name input cannot see it. Without a second guard, typing
 * `V` into a tile would switch to the Select tool and `B` would arm the brush,
 * which is the kind of thing that makes an editor feel possessed.
 *
 * The real predicate is imported rather than restated. Stated twice it agreed
 * with itself no matter what `useShortcuts` actually did, and went on passing
 * while every command shortcut was dead inside a mosaic.
 */

const press = (key: string, mod = false) => ({ key, metaKey: mod, ctrlKey: false })

describe('typing into a tile', () => {
  it('swallows the keys that are also tool shortcuts', () => {
    for (const key of ['v', 'b', 'l', 'p', 'm', 'h', 'g']) {
      expect(suppressedByCaret(press(key), true), key).toBe(true)
    }
  })

  it('lets Escape through, because Escape is how you stop', () => {
    expect(suppressedByCaret(press('Escape'), true)).toBe(false)
  })

  it('lets commands through — they are not letters going into the tile', () => {
    // Cmd/Ctrl held means a command, and the mosaic refuses to type those
    // anyway. Swallowing them left undo, duplicate and select-all dead for as
    // long as a caret was in a tile — which, in the Colour tab, is always.
    for (const key of ['a', 'z', 'd', 'y']) {
      expect(suppressedByCaret({ key, metaKey: true, ctrlKey: false }, true), `cmd+${key}`).toBe(false)
      expect(suppressedByCaret({ key, metaKey: false, ctrlKey: true }, true), `ctrl+${key}`).toBe(false)
    }
  })

  it('swallows nothing once the caret is put away', () => {
    for (const key of ['v', 'b', 'Escape']) {
      expect(suppressedByCaret(press(key), false), key).toBe(false)
    }
  })
})
