import type { Canvas as FabricCanvas } from 'fabric'

import { Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { MAX_CROP_SCALE } from '../geometry/imagePlacement'
import { cropObjectOf, cropPaintFor } from '../state/cropModel'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import { DEFAULT_CROP } from '../types/paint'
import { useCanvasAnchor } from './canvasAnchor'
import './canvas.css'

/**
 * The bar under a picture being cropped: how far in it is, and a way back to
 * cover. The canvas does the panning and the corner zoom; this is the part a
 * slider says better than a drag. There is nothing to confirm — every move is
 * already in the document — so a press anywhere outside the picture simply
 * ends the mode, as Escape and Enter do.
 */
export function CropBar({ canvas }: { canvas: FabricCanvas | null }) {
  const target = useUiStore((s) => s.croppingPaint)
  const doc = useDocumentStore((s) => s.doc)
  const object = target ? cropObjectOf(doc, target) : undefined
  const paint = target ? cropPaintFor(doc, target) : null
  const at = useCanvasAnchor(canvas, object)

  if (!target || !object || !paint || !at) return null
  const store = useDocumentStore.getState()

  return (
    <div className="crop-bar pill" style={{ left: at.left, top: at.top }} role="group" aria-label="Crop the picture">
      <span className="crop-bar__label">Crop</span>
      <input
        className="crop-bar__zoom"
        type="range"
        min={1}
        max={MAX_CROP_SCALE}
        step={0.01}
        value={paint.crop.scale}
        aria-label="Zoom the picture"
        onChange={(e) => {
          const scale = Number(e.target.value)
          store.editPaintCrop(target, (crop) => ({ ...crop, scale }))
        }}
        onPointerUp={() => store.commit('Crop picture')}
        onKeyUp={() => store.commit('Crop picture')}
      />
      <Tooltip label="Fit the picture to its box" side="top">
        <button
          type="button"
          className="pill__button"
          aria-label="Fit the picture to its box"
          onClick={() => {
            store.editPaintCrop(target, () => DEFAULT_CROP)
            store.commit('Fit picture')
          }}
        >
          <Icon name="fit" size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
