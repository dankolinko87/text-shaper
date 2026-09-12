import type { ReactNode } from 'react'

import { Icon } from '../components/Icon'
import { useDocumentStore } from '../state/documentStore'
import { solidOf } from '../typography/paint'
import type { Stroke } from '../types/document'
import type { Paint } from '../types/paint'
import { paintCss } from './gradientCss'
import './panels.css'

/**
 * A panel section that folds away, and says something while it is shut.
 *
 * The panel used to be a stack of titled blocks with every control in every one
 * of them on show at once, which meant scrolling past four things you were not
 * changing to reach the fifth. Folding them is only half the answer, though: a
 * row of closed lids reading Tiles / Glyphs / Backdrop / Timing tells you
 * nothing, so opening each in turn to look is worse than the stack was.
 *
 * So the lid carries a `summary` — the colour, the font, the timing — and a shut
 * section still answers the question you would have opened it to ask. That is
 * what makes closing one cheap enough to be worth doing.
 *
 * Uncontrolled state is deliberately NOT offered. Which section is open is a
 * property of the panel, not of the section, because only one wants to be open
 * at a time and the parent is the only thing that can know that.
 */
export function Section({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  /** Shown on the lid while it is shut. A chip, a number, a name — not a sentence. */
  summary?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="section" data-open={open}>
      <button type="button" className="section__lid" aria-expanded={open} onClick={onToggle}>
        <span className="lid-chevron" data-open={open}>
          <Icon name="chevronRight" size={13} />
        </span>
        <span className="section__title">{title}</span>
        {open ? null : <span className="section__summary">{summary}</span>}
      </button>
      {open ? <div className="section__body">{children}</div> : null}
    </section>
  )
}

/**
 * The value on a shut lid, when it is a colour.
 *
 * A swatch rather than a hex string: the question a lid answers is "which
 * colour", and six characters of hex is the slowest possible way to say blue.
 * `null` is a real answer here — no fill at all — and reads as the word None,
 * because an empty square and a white one are the same square.
 */
export function ColourChip({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="section__summary-empty">None</span>
  return <span className="section__chip" style={{ background: value }} aria-hidden="true" />
}

/** The same, for any paint: a colour, the run of a gradient, or a picture. */
export function PaintChip({ value }: { value: Paint | null | undefined }) {
  const src = useDocumentStore((s) =>
    value && typeof value === 'object' && value.kind === 'image' ? s.doc.assets[value.asset]?.src : undefined,
  )
  if (!value) return <span className="section__summary-empty">None</span>
  if (src) {
    return (
      <span
        className="section__chip section__chip--image"
        style={{ backgroundImage: `url(${src})` }}
        aria-hidden="true"
      />
    )
  }
  return <span className="section__chip" style={{ background: paintCss(value) }} aria-hidden="true" />
}

/**
 * The same, for a border — drawn as a ring rather than a filled square.
 *
 * A border and a fill of the same colour are not the same thing, and two
 * identical swatches on two adjacent lids would say they were. The chip is the
 * shape of what it stands for: an edge with nothing inside it.
 */
export function StrokeChip({ value }: { value: Stroke | null | undefined }) {
  if (!value || !(value.width > 0)) return <span className="section__summary-empty">None</span>
  return (
    <span
      className="section__chip section__chip--ring"
      style={{ borderColor: solidOf(value.colour), borderStyle: value.dash ? 'dashed' : 'solid' }}
      aria-hidden="true"
    />
  )
}
