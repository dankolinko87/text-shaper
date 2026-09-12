import { describe, expect, it } from 'vitest'

import { initialMeshState } from '../../src/mesh/dissection'
import { seedMesh } from '../../src/mesh/mesh'
import {
  evaluateMeshAtTime,
  meshAuthoredDuration,
  restingMeshFrame,
} from '../../src/mesh/timeline'
import type { MeshObject } from '../../src/types/document'
import type { MeshState } from '../../src/types/mesh'

/**
 * The mesh's timeline, evaluated: nodes blend as points, what cannot blend is
 * cut on arrival, and a node a state has forgotten stays where it was.
 */

const seeded = seedMesh(2, 1, 100)
const font = { fontId: 'anton', weight: 400, italic: false }

const stateFrom = (patch: Partial<MeshState> = {}): MeshState => ({
  ...initialMeshState(seeded.positions, font),
  holdMs: 0,
  transitionMs: 1000,
  easing: 'linear',
  ...patch,
})

const meshWith = (states: MeshState[]): MeshObject => ({
  kind: 'mesh',
  id: 'm',
  name: 'Mesh',
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false },
  localBounds: { x: -100, y: -50, width: 200, height: 100 },
  opacity: 1,
  loop: true,
  visible: true,
  locked: false,
  nodes: seeded.nodes,
  tiles: seeded.tiles,
  states,
  seed: { columns: 2, rows: 1 },
  snapStep: 10,
  backdrop: 'box',
  speed: 1,
})

const cornerId = seeded.nodes[0]!.id
const tileId = seeded.tiles[0]!.id

describe('evaluating a mesh in time', () => {
  it('blends node positions as points, on the leaving state’s easing', () => {
    const a = stateFrom()
    const b = stateFrom({ nodes: { ...a.nodes, [cornerId]: { x: -60, y: -90 } } })
    const mesh = meshWith([a, b])
    const half = evaluateMeshAtTime(mesh, 500)
    expect(half.segment).toBe('transition')
    expect(half.nodes[cornerId]).toEqual({ x: -80, y: -70 })
    // And the polygon under it is the blend of the polygons.
    expect(half.tileLayouts.get(tileId)!.structural[0]).toEqual({ x: -80, y: -70 })
  })

  it('keeps a node where it was when the next state does not name it', () => {
    const a = stateFrom()
    const { [cornerId]: _gone, ...rest } = a.nodes
    const b = stateFrom({ nodes: rest })
    const mesh = meshWith([a, b])
    const half = evaluateMeshAtTime(mesh, 500)
    expect(half.nodes[cornerId]).toEqual(a.nodes[cornerId])
  })

  it('cuts letters and font on arrival and blends the lines', () => {
    const a = stateFrom({
      chars: { [tileId]: 'A' },
      lines: { colour: '#000000', width: 2, dash: null },
    })
    const b = stateFrom({
      chars: { [tileId]: 'B' },
      font: { ...font, fontId: 'other' },
      lines: { colour: '#000000', width: 6, dash: null },
    })
    const mesh = meshWith([a, b])
    const nearEnd = evaluateMeshAtTime(mesh, 900)
    expect(nearEnd.chars[tileId], 'still the letter being left').toBe('A')
    expect(nearEnd.font.fontId).toBe('anton')
    expect(nearEnd.lines?.width).toBeCloseTo(2 + 0.9 * 4)
    const arrived = evaluateMeshAtTime(mesh, 1000)
    expect(arrived.chars[tileId]).toBe('B')
  })

  it('rests on a state as the hold at its start', () => {
    const mesh = meshWith([stateFrom(), stateFrom()])
    const rest = restingMeshFrame(mesh, 1)
    expect(rest.stateIndex).toBe(1)
    expect(rest.segment).toBe('hold')
    expect(rest.nodes).toEqual(mesh.states[1]!.nodes)
    expect(meshAuthoredDuration(mesh)).toBe(2000)
  })
})
