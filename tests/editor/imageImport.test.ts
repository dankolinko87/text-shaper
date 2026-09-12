import { describe, expect, it } from 'vitest'

import { assetIdFor, fitWithin, fnv1a } from '../../src/editor/imageImport'

/** A picture is sized down in proportion and named by its bytes. */
describe('sizing a picture down', () => {
  it('caps the longest side and keeps the proportion', () => {
    expect(fitWithin(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 })
    expect(fitWithin(800, 600, 1600), 'small stays as it is').toEqual({ width: 800, height: 600 })
    expect(fitWithin(5000, 1, 1600).height, 'never below a pixel').toBe(1)
  })
})

describe('naming a picture', () => {
  it('is the same name for the same bytes, and differs for different ones', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'))
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'))
    expect(fnv1a('')).toMatch(/^[0-9a-f]{8}$/)
    expect(assetIdFor('data:image/png;base64,AAAA')).toMatch(/^img_[0-9a-f]{8}_[0-9a-z]+$/)
    expect(assetIdFor('data:image/png;base64,AAAA')).toBe(assetIdFor('data:image/png;base64,AAAA'))
  })
})
