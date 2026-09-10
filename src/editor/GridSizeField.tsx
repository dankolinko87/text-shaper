import { useState } from 'react'

import { NumberField } from '../components/controls'
import { MOSAIC_MAX_SIDE } from '../types/mosaic'
import './panels.css'

/**
 * How many cells across and down, with a grid you can aim at.
 *
 * Two numbers are exact and a picker is fast, and neither replaces the other:
 * typing is how you get to 7 × 4, and pointing is how you find out that 5 × 3 is
 * what you wanted. So both, over one value.
 *
 * The picker shows a fixed board rather than one that grows with the mosaic —
 * the point of it is that the target never moves, so the same cell is always the
 * same size and you can go back to a size you just left.
 */

/** How much of the board to show. Past this, typing is the sane way in. */
const BOARD = 8

export function GridSizeField({
  columns,
  rows,
  onChange,
}: {
  columns: number
  rows: number
  onChange: (columns: number, rows: number) => void
}) {
  const [hover, setHover] = useState<{ columns: number; rows: number } | null>(null)
  const shown = hover ?? { columns, rows }

  const cells = []
  for (let row = 1; row <= BOARD; row++) {
    for (let column = 1; column <= BOARD; column++) {
      const inside = column <= shown.columns && row <= shown.rows
      cells.push(
        <button
          key={`${column}x${row}`}
          type="button"
          className={`grid-picker__cell${inside ? ' grid-picker__cell--on' : ''}`}
          // The size it would make, so the whole board is one control to a
          // screen reader rather than sixty-four unexplained buttons.
          aria-label={`${column} by ${row}`}
          onMouseEnter={() => setHover({ columns: column, rows: row })}
          onFocus={() => setHover({ columns: column, rows: row })}
          onClick={() => onChange(column, row)}
        />,
      )
    }
  }

  return (
    <div className="field field--stack">
      <span className="field__label">Grid</span>

      <div className="grid-size">
        <NumberField
          label="Columns"
          value={columns}
          step={1}
          onChange={(value) => onChange(clampSide(value), rows)}
          onCommit={() => undefined}
        />
        <span className="grid-size__by" aria-hidden="true">
          ×
        </span>
        <NumberField
          label="Rows"
          value={rows}
          step={1}
          onChange={(value) => onChange(columns, clampSide(value))}
          onCommit={() => undefined}
        />
      </div>

      {/*
        Leaving the board puts the preview back to what the mosaic actually is,
        so a pointer passing over on its way somewhere else does not leave the
        picker describing a size nobody chose.
      */}
      <div
        className="grid-picker"
        onMouseLeave={() => setHover(null)}
        role="group"
        aria-label={`Grid size, currently ${columns} by ${rows}`}
      >
        {cells}
      </div>

      <p className="grid-size__readout">
        {shown.columns} × {shown.rows}
      </p>
    </div>
  )
}

const clampSide = (value: number): number =>
  Math.max(1, Math.min(MOSAIC_MAX_SIDE, Math.round(value)))
