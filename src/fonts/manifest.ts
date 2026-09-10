export interface FontDescriptor {
  id: string
  family: string
  /** URL the font binary is fetched from. */
  url: string
  weight: number
  italic: boolean
  license: string
  /** What this face is for, shown beside its name in the picker. */
  note: string
}

/**
 * Bundled fonts.
 *
 * TTF rather than WOFF2 deliberately: opentype.js cannot decode WOFF2 (it has
 * no Brotli decompressor), and we need real glyph outlines, not just rendering.
 *
 * CHOSEN FOR BEING SQUEEZED. This tool stretches type to fill a shape, which
 * rules out most of a type library: a thin stroke disappears the moment a row
 * is compressed, and a face built from many fine details turns to mush. What
 * survives is heavy, with closed counters and few pieces per letter — display
 * faces, essentially, which is also what a sticker wants.
 *
 * Each is a different SHAPE of letter rather than a different mood of the same
 * one, so the picker is a set of real choices: condensed, wide, slab, didone,
 * rounded, blocky, blackletter.
 *
 * All SIL Open Font License 1.1, from the Google Fonts project. The licences
 * are in `../licenses`, one per family, as the OFL requires when redistributing.
 */
const file = (name: string): string => new URL(`./files/${name}`, import.meta.url).href

export const FONTS: FontDescriptor[] = [
  {
    id: 'anton',
    family: 'Anton',
    url: file('Anton-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Condensed grotesque',
  },
  {
    id: 'archivo-black',
    family: 'Archivo Black',
    url: file('ArchivoBlack-Regular.ttf'),
    weight: 900,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Wide and heavy',
  },
  {
    id: 'bebas-neue',
    family: 'Bebas Neue',
    url: file('BebasNeue-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Tall condensed caps',
  },
  {
    id: 'alfa-slab-one',
    family: 'Alfa Slab One',
    url: file('AlfaSlabOne-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Heavy slab serif',
  },
  {
    id: 'abril-fatface',
    family: 'Abril Fatface',
    url: file('AbrilFatface-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'High-contrast display serif',
  },
  {
    id: 'bowlby-one-sc',
    family: 'Bowlby One SC',
    url: file('BowlbyOneSC-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Chunky and rounded',
  },
  {
    id: 'bungee',
    family: 'Bungee',
    url: file('Bungee-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Blocky signage',
  },
  {
    id: 'pirata-one',
    family: 'Pirata One',
    url: file('PirataOne-Regular.ttf'),
    weight: 400,
    italic: false,
    license: 'SIL Open Font License 1.1',
    note: 'Gothic blackletter',
  },
]

export const DEFAULT_FONT_ID = 'anton'

export function findFont(id: string): FontDescriptor | undefined {
  return FONTS.find((f) => f.id === id)
}
