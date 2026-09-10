# Text Shaper

An experimental typography tool. Draw a closed shape with a brush, type text into it, and the text
wraps, scales, and stretches to fill the shape's usable area.

**The governing rule:** the shape controls how the text is distributed and how it looks. It never
changes the text itself. The text you type appears exactly once — never repeated, truncated,
reordered, or invented.

---

## Status: editor foundation plus shape-driven deformation

The full product is planned in eight phases. The editor foundation is complete, and the typography
engine now deforms letterforms to follow the container rather than only wrapping text inside it.

### What works

- Freehand shape drawing: capture, arc-length resample, Bézier refit, smooth, close, repair
  self-intersections, drop tiny fragments.
- Text fitting: padded inset region, scanline span sampling, candidate layouts scored and selected,
  real glyph outlines from opentype.js.
- Three fitting modes: LINE STRETCH (scale each line), GLYPH STRETCH (distribute the surplus between
  glyphs so letters keep their proportions), and BOUNDARY WARP (deform outlines so the type follows
  the container's curves).
- Distortion controls: follow-shape strength, vertical, wave and wave frequency, shear, per-glyph
  size variation and rotation, noise and noise scale, and a re-rollable seed. All deterministic.
- Text flow modes: word wrap, character wrap, and preserved manual line breaks.
- Multiple independent objects, each with its own shape, text, colour, and transform.
- Select, multi-select, move, scale, rotate, duplicate, delete.
- Layers: rename, reorder, hide, lock, select.
- An endless canvas — nothing is clipped to a page, and the view frames your work until you zoom or
  pan yourself.
- Text reflows live as you type, while the whole edit still collapses into one undo entry.
- Undo/redo, where one brush gesture is one history entry.
- Save and reload an editable project as versioned JSON in local storage.
- Keyboard shortcuts: `V` select, `B` draw, `H` / `Space` pan, `⌫` delete, `⌘Z` / `⌘⇧Z` undo and
  redo, `⌘D` duplicate, `⌘A` select all, `Esc` cancel.

### What is not built yet

Reshape brushes (Add / Erase / Push-Pull / Smooth / Restore), animation, and PNG/SVG/GIF export are
later phases. Per the project's own rule, none of them appear in the UI as placeholder controls — if
you can see a control, it works. The distortion panel is shown only in Warp mode, because every
slider in it feeds the warp field and would do nothing in the other two.

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
React UI        (components/, editor/)   reads store, dispatches actions; no geometry maths
Zustand store   (state/)                 document model, history, ephemeral UI state
Pure engines    (geometry/, typography/) plain TypeScript, DOM-free, unit tested
Fabric renderer (editor/)                reconciles store objects onto the canvas
```

`geometry/` and `typography/` never import React, Zustand, or Fabric. They take plain data and
return plain data, which is why the whole engine is testable in Node with no browser.

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
the store, in tests, and (in a later phase) in SVG export. Fabric rasterises those strings to canvas
for the interactive editor. There is exactly one vector representation, so what you see and what
gets exported cannot drift apart. Canvas rather than an SVG DOM layer because later phases warp
thousands of Bézier points per frame during live reshaping, which the DOM handles poorly.

### Coordinate spaces

- **Screen** — pointer events.
- **Artboard** — the document's own space; zoom and pan are viewport-only and never mutate objects.
- **Object-local** — where all path geometry is stored.

An object's local origin is its bounding-box centre **at creation time**, and it never moves again.
Rotation and scale happen about it, and Phase 4's brush edits will change the outline without
shifting the origin — otherwise every brush dab would visually translate the object.

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

Bundled: **Anton** (SIL Open Font License 1.1), in `src/fonts/files/` with its licence.

The rest of the curated set (Archivo Black, Anybody, Barlow Condensed, League Spartan, Space Grotesk,
Syne, Unbounded — all OFL, all verified available as TTF) lands with the font picker in a later
phase rather than shipping now as an unusable control.

Roboto Flex and Recursive are deferred: they are variable fonts, and opentype.js exposes only the
default instance, so their variable axes would be inert.

---

## Tests

```bash
npm test
```

86 tests covering the pure engines and the store: path closing and simplification, inset padding and
its collapse, scanline spans on convex/concave/multi-span shapes, hole preservation, region
filtering, local-coordinate round-trips under rotation and scale, the text invariant across all
three flow modes, short text in large shapes and long text in small ones, one-gesture-one-undo, and
serialisation round-trips.

The suite runs in Node with no DOM. `tests/typography/preview.test.ts` additionally writes rendered
SVGs to `preview/` so fitting quality can be inspected by eye.

### The text invariant

`src/typography/invariant.ts` is checked on **every** candidate layout before it can be scored, and
again on the final result. A layout that would lose, duplicate, or reorder text is rejected rather
than rendered. This is deliberately not something the fitting engine is trusted to get right.
