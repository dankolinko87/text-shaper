import { useCallback, useRef, useState } from 'react'

import { Button, SegmentedControl, Slider, Tooltip } from '../components/controls'
import { Icon } from '../components/Icon'
import { useDismiss } from '../components/useDismiss'
import { exportGif, type GifBackground } from '../export/gif'
import { exportMosaicGif, type MosaicGifBackground } from '../export/mosaicGif'
import { useDocumentStore } from '../state/documentStore'
import './panels.css'

/**
 * Getting the work out, from the header.
 *
 * It used to sit at the bottom of the Animate tab, under the per-object motion
 * controls and the per-state timing, with nothing to say which scope was which
 * — and it belongs to neither. Exporting is something you do to the thing you
 * have made, not a property of it, which is the same category as undo, zoom and
 * play. So it lives with those.
 *
 * One menu for both object kinds. The controls are identical because it is the
 * same job, and somebody who has exported a mosaic should not have to learn a
 * second dialect for a shape; only the path underneath differs, and each frame
 * still comes from the same evaluator its canvas plays through.
 */

const SIZES = [256, 512, 768] as const

export function ExportMenu() {
  const selection = useDocumentStore((s) => s.selection)
  const objects = useDocumentStore((s) => s.doc.objects)
  const artboard = useDocumentStore((s) => s.doc.artboard.background)

  const [open, setOpen] = useState(false)
  const [size, setSize] = useState<number>(512)
  const [background, setBackground] = useState<'transparent' | 'solid'>('transparent')
  const [frames, setFrames] = useState(24)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, wrapRef)

  /*
   * One object, whatever kind. Exporting "the selection" when it is three things
   * would mean three files from one button, and a GIF is framed on one object's
   * own bounds — there is no honest frame for a set of them.
   */
  const target = selection.length === 1 && selection[0] ? objects[selection[0]] : undefined

  const run = async (): Promise<void> => {
    if (!target) return
    // Not built yet, and said here rather than by a refusal deeper down that
    // was written for a mosaic and names the wrong thing.
    if (target.kind === 'frame') {
      setError('Exporting a frame is not built yet.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (target.kind === 'mosaic') {
        await exportMosaicGif({
          object: target,
          size,
          frames,
          background: background as MosaicGifBackground,
          name: target.name,
          artboard,
        })
      } else {
        await exportGif({
          object: target,
          size,
          frames,
          background: background as GifBackground,
          name: target.name,
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="export-menu" ref={wrapRef}>
      <Tooltip label={target ? `Export ${target.name}` : 'Select one object to export it'}>
      <button
        type="button"
        className="export-menu__trigger"
        aria-expanded={open}
        aria-haspopup="true"
        disabled={!target}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="download" size={16} />
        <span>Export</span>
      </button>
      </Tooltip>

      {open && target ? (
        <div className="export-menu__flyout popover">
          <p className="export-menu__scope">{target.name}</p>

          <SegmentedControl<'transparent' | 'solid'>
            label="Background"
            value={background}
            options={[
              { value: 'transparent', label: 'Cut out' },
              { value: 'solid', label: 'Solid' },
            ]}
            onChange={setBackground}
          />

          <SegmentedControl<string>
            label="Size"
            value={String(size)}
            options={SIZES.map((each) => ({ value: String(each), label: `${each}` }))}
            onChange={(value) => setSize(Number(value))}
          />

          <Slider
            label="Frames"
            value={frames}
            min={8}
            max={48}
            step={1}
            format={(value) => `${Math.round(value)}`}
            onChange={(value) => setFrames(Math.round(value))}
            onCommit={() => undefined}
          />

          <div className="field">
            <span className="field__label">GIF</span>
            {/* Honest about what the button will do until a frame can be exported. */}
            {target.kind === 'frame' ? (
              <Tooltip label="Frames cannot be exported yet" side="top">
                <Button variant="primary" disabled onClick={() => void run()}>
                  Export GIF
                </Button>
              </Tooltip>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void run()}>
                {busy ? 'Rendering…' : 'Export GIF'}
              </Button>
            )}
          </div>

          {error ? (
            <p className="warning" role="status">
              <Icon name="warning" size={13} />
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
