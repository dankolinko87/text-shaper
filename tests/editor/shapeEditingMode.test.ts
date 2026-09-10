import { beforeEach, describe, expect, it } from 'vitest'

import { openShapeEditing, openShapeEditingOnSelection } from '../../src/editor/shapeEditing'
import { strokeToShapePath } from '../../src/geometry/strokeToPath'
import { useDocumentStore } from '../../src/state/documentStore'
import { useUiStore } from '../../src/state/uiStore'
import { circleStroke } from '../fixtures/strokes'
import { shapeIn } from '../fixtures/objects'

/**
 * Going inside a shape is ONE mode, reached three ways.
 *
 * It used to be two: the outline's nodes under the Select tool, and the grid
 * under a tool of its own. Both drew the container's boundary, in the same
 * colour, so opening the second while the first was up put two outlines on
 * screen disagreeing about where the edge was. They are one mode now, and every
 * entry has to do the same work — including deriving nodes for a shape that has
 * none yet, which is why that lives in one function rather than in whichever
 * handler was written first.
 */

const store = () => useDocumentStore.getState()

function shape(): string {
  const stroke = strokeToShapePath(circleStroke(300, 300, 120))
  if (!stroke.ok) throw new Error('fixture stroke failed to convert')
  return store().createObjectFromStroke(stroke)
}

beforeEach(() => {
  store().resetDocument()
  useUiStore.setState({ tool: 'select', temporaryTool: null, editingPoints: null })
})

describe('opening shape editing', () => {
  it('puts the object into the mode and selects it', () => {
    const id = shape()
    useUiStore.getState().setEditingPoints(null)

    expect(openShapeEditing(id)).toBe(true)

    expect(useUiStore.getState().editingPoints).toBe(id)
    expect(store().selection).toEqual([id])
  })

  it('derives the nodes for a shape that has none yet', () => {
    const id = shape()
    const before = shapeIn(store().doc, id)
    store().setGeometry(id, { path: before.currentSourcePath, outline: null })
    expect(shapeIn(store().doc, id).outline).toBeNull()

    openShapeEditing(id)

    // Without this the mode opens on a shape with nothing to grab.
    const object = store().doc.objects[id]!
    expect(object.kind === 'typography' && object.outline).toBeTruthy()
  })

  it('leaves a shape with few nodes exactly as few', () => {
    const id = shape()
    openShapeEditing(id)
    const object = store().doc.objects[id]!
    if (object.kind !== 'typography' || !object.outline) throw new Error('expected an outline')

    const nodes = object.outline.subpaths.reduce((n, s) => n + s.nodes.length, 0)
    // A drawn circle settles at a few dozen; the wall of hundreds is what the
    // grid editor used to leave behind, and no longer can.
    expect(nodes).toBeLessThan(120)
  })

  it('refuses anything that is not a shape', () => {
    const id = store().createMosaic({ columns: 2, rows: 2, artboardCenter: { x: 0, y: 0 } })
    expect(openShapeEditing(id)).toBe(false)
    expect(useUiStore.getState().editingPoints).toBeNull()
  })

  it('needs exactly one thing selected when asked from the toolbar or the keyboard', () => {
    const one = shape()
    const two = shape()

    store().setSelection([one, two])
    expect(openShapeEditingOnSelection(), 'two selected is not one shape').toBe(false)

    store().setSelection([])
    expect(openShapeEditingOnSelection(), 'nothing selected').toBe(false)

    store().setSelection([two])
    expect(openShapeEditingOnSelection()).toBe(true)
    expect(useUiStore.getState().editingPoints).toBe(two)
  })

  it('does not put the app into a grid TOOL, because there is no longer one', () => {
    const id = shape()
    store().setSelection([id])
    openShapeEditingOnSelection()

    // Editing a shape is a mode over an object, not a tool with its own cursor.
    expect(useUiStore.getState().tool).toBe('select')
  })
})
