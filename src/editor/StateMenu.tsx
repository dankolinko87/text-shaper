import { Menu, type MenuItem } from '../components/Menu'
import type { Stated } from '../types/document'
import { deleteStateAt, duplicateStateAt, kindOf } from './stated'

/**
 * What you do TO a state, behind one glyph — for every kind.
 *
 * Copy it and delete it are what every state offers, and they come from the
 * one brain so the card, the bar and the chips cannot disagree about what a
 * copy is or where it lands. A kind adds what only it has after those: a
 * frame's Apply and Reset. Rare actions as permanent buttons were a row of
 * noise on every card.
 */
export function StateMenu({
  object,
  at,
  heading = 'This state',
  extras = [],
}: {
  object: Stated
  at: number
  heading?: string
  extras?: MenuItem[]
}) {
  const kind = kindOf(object)
  const count = object.states.length
  return (
    <Menu
      label="More"
      heading={heading}
      items={[
        {
          label: 'Duplicate state',
          disabled: count >= kind.max,
          onSelect: () => duplicateStateAt(object, at),
        },
        {
          label: 'Delete state',
          disabled: count <= kind.min,
          onSelect: () => deleteStateAt(object, at),
        },
        ...extras,
      ]}
    />
  )
}
