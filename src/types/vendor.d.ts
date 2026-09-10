/**
 * Hand-written ambient declarations for dependencies that ship no types.
 *
 * NOTE: do NOT install `@types/opentype.js`. It is published for the 1.x API,
 * while we use opentype.js 2.0.0 — so it would type-check calls that are wrong
 * at runtime, which is strictly worse than having no types at all. These
 * declarations cover only the surface we actually use.
 */

// NOTE: `paper` ships its own declarations, including a `declare module
// 'paper/dist/paper-core'` block and a global `declare namespace paper`. Its
// types are therefore reachable as `paper.Path`, `paper.PathItem`, and so on
// WITHOUT importing anything — importing the name locally would shadow the
// namespace with the runtime value and break every type reference.

declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z'
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }

  export interface BoundingBox {
    x1: number
    y1: number
    x2: number
    y2: number
  }

  export interface Path {
    commands: PathCommand[]
    toPathData(decimalPlaces?: number): string
    getBoundingBox(): BoundingBox
  }

  export interface Glyph {
    /**
     * Position in the font's glyph table. Zero is `.notdef` — the box a font
     * shows for a character it has no glyph for — which is how the mosaic knows
     * a grapheme is missing rather than merely blank.
     */
    index: number
    name: string | null
    unicode: number | undefined
    advanceWidth: number | undefined
    getPath(x: number, y: number, fontSize: number): Path
  }

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    getPath(text: string, x: number, y: number, fontSize: number): Path
    getAdvanceWidth(text: string, fontSize: number): number
    stringToGlyphs(text: string): Glyph[]
    charToGlyph(char: string): Glyph
  }

  export function parse(buffer: ArrayBuffer): Font

  const opentype: {
    parse: typeof parse
  }
  export default opentype
}

declare module 'gifenc' {
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][]
        delay?: number
        transparent?: boolean
        transparentIndex?: number
      },
    ): void
    finish(): void
    bytes(): Uint8Array
  }
  export function GIFEncoder(): GIFEncoderInstance
  export function quantize(
    data: Uint8ClampedArray,
    maxColors: number,
    options?: { format?: string },
  ): number[][]
  export function applyPalette(
    data: Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array
}
