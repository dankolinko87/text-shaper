import { useDocumentStore } from '../state/documentStore'
import { samePaint } from '../typography/paint'
import type { Stated } from '../types/document'
import { PaintField } from './PaintField'
import { beginCrop, cropTargetFor } from './cropTargets'
import { useUiStore } from '../state/uiStore'

/**
 * The background of EVERY state at once — a setting of the object, folded
 * with the others every state shares, for every kind that has states.
 *
 * The per-state Background section still says what one state shows; this is
 * for the common case of one paint behind the whole animation, which used
 * to mean visiting each state in turn. It reads as "Mixed" once the states
 * disagree, and writing it makes them agree again.
 */
export function StatedBackgroundField({ object }: { object: Stated }) {
  const store = () => useDocumentStore.getState()
  const seen = object.states.map((state) => state.background ?? null)
  const first = seen[0] ?? null
  const agree = seen.every((each) => samePaint(each, first))

  return (
    <PaintField
      label="Background"
      value={agree ? first : null}
      mixed={!agree}
      emptyLabel={agree ? 'None' : 'Mixed'}
      onChange={(paint) => store().setStatedBackground(object.id, paint)}
      onCommit={(label) => store().commit(label)}
      onCrop={() =>
        beginCrop(
          cropTargetFor(
            object.id,
            'background',
            Math.min(useUiStore.getState().mosaicStates[object.id] ?? 0, object.states.length - 1),
          ),
        )
      }
      removeLabel="Clear background"
      onRemove={() => {
        store().setStatedBackground(object.id, null)
        store().commit('Clear background')
      }}
    />
  )
}
