import { ColorField } from '../components/controls'
import { useDocumentStore } from '../state/documentStore'
import type { Stated } from '../types/document'

/**
 * The backdrop of EVERY state at once — a setting of the object, folded with
 * the others every state shares, for every kind that has states.
 *
 * The per-state Backdrop section still says what one state shows; this is
 * for the common case of one colour behind the whole animation, which used
 * to mean visiting each state in turn. It reads as "Mixed" once the states
 * disagree, and writing it makes them agree again.
 */
export function StatedBackgroundField({ object }: { object: Stated }) {
  const store = () => useDocumentStore.getState()
  const seen = object.states.map((state) => (state.background ?? null) as string | null)
  const first = seen[0] ?? null
  const agree = seen.every((each) => each === first)

  return (
    <ColorField
      label="Backdrop"
      value={(agree ? first : null) ?? '#ffffffff'}
      mixed={!agree || first === null}
      emptyLabel={agree ? 'None' : 'Mixed'}
      onChange={(colour) => store().setStatedBackground(object.id, colour)}
      onCommit={() => store().commit('Colour backdrop')}
      removeLabel="Clear backdrop"
      onRemove={() => {
        store().setStatedBackground(object.id, null)
        store().commit('Clear backdrop')
      }}
    />
  )
}
