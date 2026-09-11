import type { ComponentType } from 'react'

import type { FrameObject, LetterMosaicObject, Stated } from '../types/document'
import { FrameSettings, FrameStateActions } from './FramePanel'
import { FrameThumbnail } from './FrameThumbnail'
import { MosaicSettings } from './StateList'
import { StateMenu } from './StateMenu'
import { StateThumbnail } from './StateThumbnail'

/**
 * What the rail draws differently per kind — and it is only three things.
 *
 * The list, its header, the drag-reorder, the card's row, the film during
 * playback and the timing fields are the same for every object with states
 * (`StatesList`). What a kind brings is the fold of settings every state
 * shares, the picture on a card, and what its ⋯ menu adds. `stated.ts` is the
 * same table for what the kinds DO; this is for what they SHOW.
 */
export interface StatedUi<T extends Stated = Stated> {
  /** What every state shares, folded above the list. */
  Settings: ComponentType<{ object: T }>
  /** The picture on a state's card. */
  Thumbnail: ComponentType<{ object: T; at: number; size: number }>
  /** The ⋯ menu on a state's card. */
  Actions: ComponentType<{ object: T; at: number }>
}

const MOSAIC: StatedUi<LetterMosaicObject> = {
  Settings: MosaicSettings,
  Thumbnail: StateThumbnail,
  Actions: StateMenu,
}

const FRAME: StatedUi<FrameObject> = {
  Settings: FrameSettings,
  Thumbnail: FrameThumbnail,
  Actions: FrameStateActions,
}

/**
 * The one place the kinds are told apart for drawing. Each entry's components
 * take their own kind; dispatching on `kind` is what makes handing them the
 * object safe, which the cast says in the only way a component prop can.
 */
export function uiOf(object: Stated): StatedUi {
  return (object.kind === 'mosaic' ? MOSAIC : FRAME) as unknown as StatedUi
}
