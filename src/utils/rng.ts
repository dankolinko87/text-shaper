/**
 * Deterministic seeded RNG (mulberry32).
 *
 * Every distortion and animation effect draws from this rather than
 * `Math.random`, so a document renders identically on every load and every
 * exported frame — which is what makes seeded distortion stable and animation
 * loops seamless.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Stable per-index value in [0,1) — same seed and index always give the same result.
 *
 * The index is mixed with `Math.imul`, which keeps the product in 32 bits.
 * Multiplying normally computes it as a double: a hashed index near 2^31 times
 * the constant lands around 5.7e18, far past the largest exactly representable
 * integer, and adding a seed of 1 or 2 to a double that size changes nothing at
 * all. The seed was silently dropped for large indices — two documents with
 * different seeds produced identical noise wherever the lattice hash ran high.
 */
export function seededValue(seed: number, index: number): number {
  let t = (Math.imul(index, 0x9e3779b9) + seed) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
