import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../../src/state/uiStore'

/**
 * Being inside an object is one mode, not two.
 *
 * Point editing and the grid editor are both "inside" the same shape, and both
 * draw a boundary in the same orange with the same white handles — so with both
 * on there are two outlines on screen that disagree about where the edge is, and
 * no way to tell which one a drag will move.
 *
 * Point editing belongs to the Select tool: it is entered by double-clicking
 * with Select active, and it has no meaning under any other tool. So picking a
 * different tool leaves it, which is what keeps the two from overlapping.
 */

beforeEach(() => {
  useUiStore.setState({ tool: 'select', temporaryTool: null, editingPoints: null })
})

describe('picking a tool while editing points', () => {
  it('leaves point editing behind', () => {
    useUiStore.getState().setEditingPoints('shape-1')
    useUiStore.getState().setTool('grid')

    expect(useUiStore.getState().editingPoints).toBeNull()
  })

  it('does so for every tool that is not Select', () => {
    for (const tool of ['draw', 'line', 'pen', 'mosaic', 'pan', 'grid'] as const) {
      useUiStore.setState({ tool: 'select', editingPoints: 'shape-1' })
      useUiStore.getState().setTool(tool)
      expect(useUiStore.getState().editingPoints, tool).toBeNull()
    }
  })

  it('keeps it when the tool picked is Select again', () => {
    // Pressing V while already editing points must not throw the mode away.
    useUiStore.getState().setEditingPoints('shape-1')
    useUiStore.getState().setTool('select')

    expect(useUiStore.getState().editingPoints).toBe('shape-1')
  })

  it('keeps it while Space borrows the pan tool', () => {
    /*
     * Holding Space is not picking a tool — it is a temporary borrow that ends
     * on release, and coming back from it must find the object still open.
     */
    useUiStore.getState().setEditingPoints('shape-1')
    useUiStore.getState().setTemporaryTool('pan')

    expect(useUiStore.getState().editingPoints).toBe('shape-1')
    expect(useUiStore.getState().activeTool()).toBe('pan')

    useUiStore.getState().setTemporaryTool(null)
    expect(useUiStore.getState().editingPoints).toBe('shape-1')
  })
})
