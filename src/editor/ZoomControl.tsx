import { IconButton } from '../components/controls'
import { MAX_ZOOM, MIN_ZOOM } from '../geometry/viewportMath'
import { useUiStore } from '../state/uiStore'
import { clamp } from '../utils/math'
import './panels.css'

export function ZoomControl() {
  const zoom = useUiStore((s) => s.zoom)
  // The stage's size as the canvas measured it — the one measurement, so the
  // zoom's centre and the canvas's cannot disagree by a resize step.
  const stageWidth = useUiStore((s) => s.stageWidth)
  const stageHeight = useUiStore((s) => s.stageHeight)

  const setZoomAboutCentre = (next: number): void => {
    const state = useUiStore.getState()
    const target = clamp(next, MIN_ZOOM, MAX_ZOOM)
    const centre = { x: stageWidth / 2, y: stageHeight / 2 }
    // Keep whatever is in the middle of the viewport in the middle.
    const before = {
      x: (centre.x - state.panX) / state.zoom,
      y: (centre.y - state.panY) / state.zoom,
    }
    useUiStore.getState().adjustViewport({
      zoom: target,
      panX: centre.x - before.x * target,
      panY: centre.y - before.y * target,
    })
  }

  // The canvas owns the rendered objects, so it is the only place that can
  // measure what "fit" should frame on an endless canvas.
  const fit = (): void => {
    window.dispatchEvent(new CustomEvent('text-shaper:fit'))
  }

  return (
    <div className="zoom-control" role="group" aria-label="Canvas controls">
      {/*
        The number, and no stepper either side of it.
        
        Two buttons to move the zoom a notch at a time are the slowest way to do
        the one thing every pointer already does better — scroll, or pinch — and
        they cost two slots in a header that has other work to do. What the
        number gives that neither gesture does is a way BACK: it reads the zoom,
        and clicking it returns to 100%.
      */}
      <button
        type="button"
        className="zoom-control__value"
        aria-label={`Zoom level ${Math.round(zoom * 100)} percent. Click to reset to 100 percent.`}
        onClick={() => setZoomAboutCentre(1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <span className="zoom-control__divider" role="separator" />
      <IconButton icon="fit" label="Fit artboard" shortcut="⇧1" onClick={fit} />
    </div>
  )
}

/**
 * Play, on its own.
 *
 * It runs everything that moves, at once, whichever panel happens to be open
 * and whatever is selected — the Animate tab keeps its own preview of the
 * object being worked on. Its own control rather than a corner of the zoom
 * group because it is one of the two things the header keeps when the window
 * is narrow, and the zoom is not.
 *
 * No keyboard shortcut. Space is already the temporary-pan hold, and a second
 * meaning on the key you lean on to move around would be a trap.
 */
export function PlayButton() {
  const playing = useUiStore((s) => s.playing)
  return (
    <IconButton
      icon={playing ? 'pause' : 'play'}
      label={playing ? 'Stop animation' : 'Play all animations'}
      active={playing}
      onClick={() => useUiStore.getState().setPlaying(!playing)}
    />
  )
}
