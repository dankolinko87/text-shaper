const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Short, collision-resistant id. Not a UUID — these are document-local. */
export function createId(prefix = 'o'): string {
  let out = ''
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return `${prefix}_${out}`
}

export function createSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}
