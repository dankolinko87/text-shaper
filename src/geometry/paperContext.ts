import paper from 'paper/dist/paper-core'

/**
 * Headless paper.js scope, shared by the browser app and the Vitest suite.
 *
 * Three details make this work:
 *
 * 1. We import `paper/dist/paper-core`, never `paper`. The default entry bundles
 *    PaperScript plus the acorn parser and expects a DOM canvas; paper-core runs
 *    in plain Node, so the exact same module resolves under Vite and under
 *    Vitest's `node` environment.
 * 2. `setup(new Size(1, 1))` creates a project with no View bound to a canvas —
 *    nothing ever paints and nothing requests animation frames.
 * 3. `settings.insertItems = false` stops constructed paths being auto-inserted
 *    into the active layer. Without it a long drawing session accumulates
 *    thousands of orphaned items and leaks steadily.
 */

let scope: paper.PaperScope | null = null

function ensureScope(): paper.PaperScope {
  if (scope) return scope
  const s = new paper.PaperScope()
  s.setup(new paper.Size(1, 1))
  s.settings.insertItems = false
  s.settings.applyMatrix = true
  s.settings.handleSize = 0
  scope = s
  return s
}

/**
 * Activate the headless scope, run `fn`, and always clean up afterwards.
 *
 * This is the ONLY entry point to paper.js in the codebase — no other module
 * calls `paper.*` directly. The `finally` clause covers the operations (boolean
 * results in particular) that insert into the project despite `insertItems`.
 */
export function withPaper<T>(fn: (s: paper.PaperScope) => T): T {
  const s = ensureScope()
  s.activate()
  try {
    return fn(s)
  } finally {
    s.project.activeLayer.removeChildren()
  }
}

/** Test hook: drop the scope so leak assertions start from a clean slate. */
export function resetPaperScope(): void {
  if (scope) scope.project.clear()
  scope = null
}

/** Test hook: how many items are lingering in the active layer. */
export function activeLayerItemCount(): number {
  if (!scope) return 0
  return scope.project.activeLayer.children.length
}
