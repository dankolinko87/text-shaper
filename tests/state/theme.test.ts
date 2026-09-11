import { describe, expect, it } from 'vitest'

import { applyTheme, other, readTheme, writeTheme } from '../../src/state/theme'

/** A storage that remembers, and one that refuses. */
const memory = (): Storage => {
  const held = new Map<string, string>()
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
  } as Storage
}
const refusing = {
  getItem: () => {
    throw new Error('no')
  },
  setItem: () => {
    throw new Error('no')
  },
}

describe('the kept theme', () => {
  it('is dark until somebody chooses, and dark when the storage is missing or refuses', () => {
    expect(readTheme(memory())).toBe('dark')
    expect(readTheme(null)).toBe('dark')
    expect(readTheme(undefined)).toBe('dark')
    expect(readTheme(refusing)).toBe('dark')
  })

  it('is what was chosen, and nothing else', () => {
    const storage = memory()
    writeTheme(storage, 'light')
    expect(readTheme(storage)).toBe('light')
    storage.setItem('text-shaper:theme', 'sepia')
    expect(readTheme(storage), 'junk in storage is not a theme').toBe('dark')
  })

  it('survives a storage that refuses to write', () => {
    expect(() => writeTheme(refusing, 'light')).not.toThrow()
  })

  it('flips, and lands on the document as one attribute', () => {
    expect(other('dark')).toBe('light')
    expect(other('light')).toBe('dark')
    const root = { dataset: {} as DOMStringMap }
    applyTheme('light', root)
    expect(root.dataset.theme).toBe('light')
  })
})
