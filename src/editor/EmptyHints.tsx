import { useEffect, useState } from 'react'
import type { Canvas as FabricCanvas } from 'fabric'

import { Icon } from '../components/Icon'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'
import type { Stated } from '../types/document'
import { isStated } from '../types/document'
import { placeOnStage } from './canvasAnchor'
import { invitationFor, type Invitation } from './invitations'
import { isExporting } from './liveCanvas'
import './canvas.css'

/**
 * What an empty thing with states says: put something in me.
 *
 * A frame with no members, a mosaic or a mesh with no letters, draws nothing
 * of its own — no edge, no fill unless a backdrop was chosen — so without
 * this each would be an invisible shape that could only be found by
 * accident. Instead the space carries an invitation, in the middle,
 * selected or not, until something lands in it: an object dropped into the
 * frame, a letter typed into a tile. It goes while you are typing inside,
 * since the caret is then the invitation. HTML placed by the same maths as
 * the name and the bar, so it keeps one size at every zoom; it takes no
 * presses, so a press on it is a press on the object.
 */

export function EmptyHints({ canvas }: { canvas: FabricCanvas | null }) {
  const objects = useDocumentStore((s) => s.doc.objects)
  const order = useDocumentStore((s) => s.doc.objectOrder)
  const typing = useUiStore((s) => s.typing?.object ?? null)
  const empty = order
    .map((id) => objects[id])
    .filter((object): object is Stated => Boolean(object) && isStated(object as never) && (object as Stated).visible)
    .filter((object) => object.id !== typing)
  return (
    <>
      {empty.map((object) => {
        const invitation = invitationFor(object)
        return invitation ? (
          <EmptyHint key={object.id} canvas={canvas} object={object} invitation={invitation} />
        ) : null
      })}
    </>
  )
}

function EmptyHint({
  canvas,
  object,
  invitation,
}: {
  canvas: FabricCanvas | null
  object: Stated
  invitation: Invitation
}) {
  const [at, setAt] = useState<{ x: number; y: number; width: number; height: number } | null>(null)

  useEffect(() => {
    if (!canvas) return
    const place = (): void => {
      // A snapshot's render is not the screen's; see `isExporting`.
      if (isExporting()) return
      const box = object.localBounds
      const centre = placeOnStage(canvas, object, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      const corner = placeOnStage(canvas, object, { x: box.x + box.width, y: box.y + box.height })
      if (!centre || !corner) return
      // The box on screen, so the words can be kept inside it.
      const next = {
        x: centre.x,
        y: centre.y,
        width: Math.abs(corner.x - centre.x) * 2,
        height: Math.abs(corner.y - centre.y) * 2,
      }
      setAt((previous) =>
        previous &&
        Math.abs(previous.x - next.x) < 0.5 &&
        Math.abs(previous.y - next.y) < 0.5 &&
        Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
          ? previous
          : next,
      )
    }
    place()
    canvas.on('after:render', place)
    return () => {
      canvas.off('after:render', place)
    }
  }, [canvas, object])

  if (!at) return null
  /*
   * Inside the box or not at all. The sentence wraps to the box's width, less
   * a margin; a box too small for even a wrapped sentence keeps the glyph
   * alone, and one too small for that shows nothing.
   */
  const inset = 12
  const room = { width: at.width - inset * 2, height: at.height - inset * 2 }
  if (room.width < 24 || room.height < 24) return null
  const words = room.width >= 96 && room.height >= 64
  return (
    <div
      className="frame-empty"
      style={{ left: at.x, top: at.y, maxWidth: room.width }}
      data-object={object.id}
      aria-hidden="true"
    >
      <Icon name={invitation.icon} size={20} />
      {words ? <span className="frame-empty__hint">{invitation.hint}</span> : null}
    </div>
  )
}
