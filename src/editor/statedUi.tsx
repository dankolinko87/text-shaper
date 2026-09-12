import type { ComponentType } from 'react'

import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { FrameObject, LetterMosaicObject, MeshObject, Stated } from '../types/document'
import { FrameSettings, FrameStateActions } from './FramePanel'
import { FrameThumbnail } from './FrameThumbnail'
import { MeshSettings } from './MeshPanel'
import { MeshThumbnail } from './MeshThumbnail'
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

/** The mosaic's menu, plus the one thing only a mosaic offers: becoming a mesh. */
function MosaicStateActions({ object, at }: { object: LetterMosaicObject; at: number }) {
  return (
    <StateMenu
      object={object}
      at={at}
      extras={[
        {
          label: 'Convert to mesh',
          onSelect: () => {
            const store = useDocumentStore.getState()
            const made = store.convertMosaicToMesh(object.id)
            if (!made) return
            store.commit('Convert to mesh')
            const ui = useUiStore.getState()
            ui.setTyping(null)
            ui.setMosaicSelection([])
          },
        },
      ]}
    />
  )
}

const MOSAIC: StatedUi<LetterMosaicObject> = {
  Settings: MosaicSettings,
  Thumbnail: StateThumbnail,
  Actions: MosaicStateActions,
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
const MESH: StatedUi<MeshObject> = {
  Settings: MeshSettings,
  Thumbnail: MeshThumbnail,
  Actions: StateMenu,
}

export function uiOf(object: Stated): StatedUi {
  return (object.kind === 'mosaic' ? MOSAIC : object.kind === 'mesh' ? MESH : FRAME) as unknown as StatedUi
}
