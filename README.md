# Text Shaper

Live: https://dankolinko87.github.io/text-shaper/ — built and published from `main` by `.github/workflows/deploy.yml`.

A typography tool for type that is shaped, tiled, bent and animated. Draw a shape and type into
it; lay letters into a mosaic of tiles; pull a mesh of cells about and the letters bend with them;
put objects in a frame with states and play the transitions; fill any of it with a solid, a
gradient or a picture; export the result as a GIF.

**The governing rule:** the shape controls how the text is distributed and how it looks. It never
changes the text itself. The text you type appears exactly once — never repeated, truncated,
reordered, or invented.

---

## What works

### Shapes and text

- Freehand shapes with the brush: capture, arc-length resample, Bézier refit, smooth, close, repair
  self-intersections, drop tiny fragments. Preset shapes (ellipse, rectangle, triangle, hexagon and
  the rest) from the same menu.
- Open paths with the pen (click for corners, drag for curves, continue or close an existing path)
  and the pencil (freehand line).
- Point editing inside any shape or path, the way vector editors do it: click, shift-click, a box
  or an ⌥ lasso to select points; drag or nudge them with the arrows (⇧ for ten); snapping to the
  path's other points; ⇧ to constrain a drag to an axis. Double-click an edge for a point.
- Text fitting: padded inset region, scanline span sampling, candidate layouts scored and selected,
  real glyph outlines from opentype.js. Five modes: LINE STRETCH, GLYPH STRETCH, BOUNDARY WARP
  (outlines deformed to follow the container), RING (a lap or a spiral around the shape) and PATH
  (along a line you drew — the only mode an open path can be in).
- Distortion controls in Warp mode: follow-shape strength, vertical, wave and wave frequency, shear,
  per-glyph size variation and rotation, noise and noise scale, and a re-rollable seed. All
  deterministic.
- Text flow modes: word wrap, character wrap, and preserved manual line breaks.
- Eight bundled display fonts, picked per object.

### Mosaics and meshes

- A **mosaic** is a grid of tiles with a letter or a word in each. Tiles are split, merged and
  their dividers dragged; the letters are typed straight into the tiles with a caret, pasted, and
  reflowed in reading order. A mosaic has states: each one records where the lines sit and what
  every tile is worth, and playing it tweens between them.
- A **mesh** is the mosaic's free-cornered cousin: cells you can pull about by their nodes and
  edges, add points to, cut across, grow out of the rim (⌘-drag an edge) and remove. A letter is
  poured through the cell's own map, so it bends with the cell — and so does a picture filling it.
  A drag is held back where a cell would fold, cross a neighbour or get too thin for its insets;
  the handles turn amber to say so.

### Frames and animation

- A **frame** is a place with states: objects go in it and every state records where each member
  stands, its opacity and its appearance. Playing a frame tweens the members between the states,
  and a member absent from one side fades. Members are picked, moved, resized and turned inside
  the frame with Fabric's own controls; shift-click picks several; ⌘-drag takes one out.
- Every object with states shares one timeline model: per-state hold and transition times, six
  monotone easings, looping, a playback speed. States are duplicated, reordered, retimed and spread
  out side by side to be compared.
- Colour effects on solid fills (cycle, flicker) and motion on gradients (sweep, hover, pulse).
- Play runs everything on the artboard at once; each object's own preview runs it alone.

### Paint

- Every colour input except the page and export backgrounds takes a **solid, a gradient or a
  picture**: text fill, shape fill, banner, lines, tile backgrounds, letter fills, object and frame
  backgrounds. One picker with three tabs.
- Pictures are document assets, imported from a file, scaled to a sane size, and cropped on the
  canvas: drag to pan, corners to zoom. A crop is per state, so it animates like a colour does.
- Blending rule for everything that animates: tween what can be tweened, cut the rest at the
  midpoint. A solid to a gradient promotes the solid; two gradients unify their stops; two crops of
  the same picture slide between each other.

### The editor

- An endless canvas: nothing is clipped to a page, and the view frames your work until you zoom or
  pan yourself. ⇧1 fits it again.
- Select, multi-select, move, scale, rotate, duplicate, delete; drag an object into a frame to add
  it. Right-click for a menu: duplicate, stacking (⌘] ⌘[ with ⌥ for all the way), delete — and with
  more than one thing selected, a row of alignment and distribution buttons with Figma's ⌥
  shortcuts. Inside a frame the same menu works on the picked members.
- The states rail on the left, the properties panel on the right, the tools in the header; light
  and dark themes (press the mark).
- Undo/redo, where one gesture is one history entry. Text reflows live as you type while the whole
  edit still collapses into one entry.
- Projects: several per browser, in a drawer with a thumbnail, name and dates on each card; rename,
  duplicate, delete. Every change is autosaved. The dev server keeps a second copy in
  `.autosave/document.<port>.json`, so a fresh browser profile finds the work again.
- Export as GIF: one selected shape, mosaic or mesh, at a chosen size, frame count and background.
- Keyboard: `V` select, `H` / `Space` pan, `B` shape, `P` pen, `L` pencil, `M` mosaic, `N` mesh,
  `F` frame, `G` edit the selected shape's points, arrows nudge, `⌫` delete, `⌘Z` / `⌘⇧Z` undo and
  redo, `⌘D` duplicate, `⌘C` / `⌘V` copy and paste, `⌘A` select all, `⌘⇧N` new project, `⇧1` fit,
  `Esc` out one level.

### What is not built yet

Exporting a frame, PNG and SVG export, reshape brushes (Add / Erase / Push-Pull / Smooth /
Restore), complex-script text (see below). Per the project's own rule, none of them appear in the
UI as placeholder controls — if you can see a control, it works. The layers panel exists in
`editor/LayersPanel.tsx` but is not mounted: with the states rail and the properties panel it had
nothing left to say.

---

## Commands

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run check
```

`check` runs typecheck, lint, and tests in that order — the full gate before a commit. Lint includes
the architecture boundary rules described below, so a layering violation fails the build.

---

## Architecture

Data flows one way: **state → engine → render**.

```
React UI        (app/, components/, editor/)                 reads the stores, dispatches actions; no geometry maths
Zustand stores  (state/)                                     document model, history, projects, ephemeral UI state
Pure engines    (geometry/, typography/, mosaic/, mesh/,     plain TypeScript, DOM-free, unit tested
                 frame/, anim/)
Fabric renderer (editor/)                                    reconciles store objects onto the canvas
Exporters       (export/)                                    draw the same model to an offscreen canvas and encode it
```

The engines never import React, Zustand, or Fabric. They take plain data and return plain data,
which is why the whole engine is testable in Node with no browser. `types/` holds the document
model — versioned, with a migration per version in `state/persistence.ts`.

### Enforced boundaries

That separation is not a convention held up by code review — `.oxlintrc.json` enforces it with
`no-restricted-imports`, and `npm run lint` fails on a violation:

| Files | May not import |
| --- | --- |
| `geometry/**`, `typography/**` | `react`, `react-dom`, `zustand`, `fabric`, and anything under `state/`, `editor/`, `components/`, `app/` |
| everything except `editor/**` | `fabric` |
| everything except `geometry/paperContext.ts` | `paper`, `paper/**` |

The last two rows are what keep the two heavyweight vendor libraries pinned to one owner each.
Fabric stays behind the renderer, so the document model never learns about canvas objects. paper.js
stays behind `withPaper()`, so every boolean and offset operation runs inside the single headless
scope rather than leaking a second one into the test suite.

The overrides in `.oxlintrc.json` cover disjoint file sets on purpose: oxlint hands a file the
config of the *last* matching override instead of merging them, so an override that silently
shadows another would disable enforcement rather than tighten it. If you add one, exclude its files
from the others.

One gap worth knowing: `no-restricted-imports` inspects `import`, `import type`, `export ... from`,
and dynamic `import()`, but not `require()`. This package is ESM-only, so `require` would not
survive Vite or Vitest regardless.

### Rendering

Glyph outlines and shape outlines are **SVG path strings** everywhere — in the document model, in
the store, in tests, in the thumbnails and in the GIF exporters. Fabric rasterises those strings to
canvas for the interactive editor. There is exactly one vector representation, so what you see and
what gets exported cannot drift apart. Canvas rather than an SVG DOM layer because playback warps
thousands of Bézier points per frame, which the DOM handles poorly.

A picture filling a mesh cell is drawn through the cell's map as triangles (`geometry/warpImage.ts`),
the same map the letter is poured through, so the two bend together; elsewhere a picture is a
Fabric pattern anchored to the object's box.

### Coordinate spaces

- **Screen** — pointer events.
- **Artboard** — the document's own space; zoom and pan are viewport-only and never mutate objects.
- **Object-local** — where all path geometry is stored.

An object's local origin is its bounding-box centre **at creation time**, and it never moves again.
Rotation and scale happen about it, and point edits change the outline without shifting the origin
— otherwise every drag of a point would visually translate the object. A frame's members are stored
in the frame's own space, so a frame moves and turns as one thing.

Fabric positions a group by the centre of its children's combined bounds, which is not the object's
local origin. `positionGroup` and `readTransformFromGroup` in `editor/renderer.ts` convert between
the two. Without that correction an object jumps on screen whenever its text changes the bounds.

### How the deformation works

The warp maps `y -> c(x) + (y - c0) * s(x)`, where `c(x)` is the container's vertical mid-line at
that x and `s(x)` scales the block by how tall the container is there relative to its tallest point.
Because `s(x) > 0` the map is a homeomorphism, so glyph contours keep their winding, counters stay
open under the nonzero fill rule, and nothing that was simple becomes self-intersecting. `s` is
floored well above zero: letterforms have to survive the deformation, and an unfloored scale crushed
the ascender off a "b" near a shape's edge.

---

## Library choices that differ from the original brief

Both were changed on evidence, not preference.

**`fabric` instead of `@fabricjs/browser`.** That package does not exist on npm. Fabric v7's `.`
export is the browser build.

**`js-angusj-clipper` instead of `clipper2-js`.** `clipper2-js@1.2.4`'s negative offset is broken:
insetting a 0–100 square by 10 returns a bounding box of `[10, 1.785, 109.231, 100]` instead of
`[10, 10, 90, 90]`, at every coordinate scale, and both the reverse-path and complement-outset
workarounds fail too. `js-angusj-clipper` returns exactly `[10, 10, 90, 90]`, outsets correctly, and
correctly collapses to zero paths when over-inset — which is what drives the "Not enough space for
text" state. It ships TypeScript types and embeds its WASM as base64 in a single file, so it needs
no bundler configuration.

`opentype.js` 2.0 and `gifenc` ship no types, so `src/types/vendor.d.ts` declares the small surface
we use. Do **not** install `@types/opentype.js` — it is published for the 1.x API and would
type-check calls that are wrong at runtime.

---

## Language and script support

**Latin script only, in this version.** Text is laid out by mapping characters to glyphs and
advancing by each glyph's own width. That is honest for Latin, but it is not text shaping. There is
no support for:

- complex-script shaping (Arabic, Indic, Khmer, and similar), which needs contextual glyph
  substitution and positioning;
- right-to-left or bidirectional text;
- vertical writing modes;
- ligatures, kerning pairs, or other OpenType features;
- grapheme clustering, so character-wrap mode splits by code point and will separate combining marks
  from their base character.

Adding these properly means a real shaping engine (HarfBuzz compiled to WASM), not an extension of
the current approach.

Fonts are loaded as **TTF**, not WOFF2 — opentype.js has no Brotli decoder and cannot read WOFF2.

---

## Fonts

Eight bundled display faces, all under the SIL Open Font License 1.1, in `src/fonts/files/` with
a licence per family in `src/fonts/licenses/`: Anton, Archivo Black, Bebas Neue, Alfa Slab One,
Abril Fatface, Bowlby One SC, Bungee and Pirata One. `src/fonts/manifest.ts` is the list; adding a
face is one entry and one TTF.

Variable fonts are out: opentype.js exposes only the default instance, so their axes would be
inert.

---

## Tests

```bash
npm test
```

About 1,650 tests in 130 files, all in Node with no DOM: the pure engines (paths, insets, spans,
fitting, the text invariant, mosaic dissection and typing, mesh geometry and legality, timelines
and blending, paints and placement), the stores (actions, history, migrations for every schema
version, projects), and the editor itself — the Fabric reconciler runs on Fabric's Node build, so
what a drag, a pick or a playback frame does to the canvas is tested by driving the real object
graph. `tests/styles/classNames.test.ts` checks that every class a component uses has a rule and
every rule has a component.

`tests/typography/preview.test.ts` additionally writes rendered SVGs to `preview/` so fitting
quality can be inspected by eye.

### The text invariant

`src/typography/invariant.ts` is checked on **every** candidate layout before it can be scored, and
again on the final result. A layout that would lose, duplicate, or reorder text is rejected rather
than rendered. This is deliberately not something the fitting engine is trusted to get right.
