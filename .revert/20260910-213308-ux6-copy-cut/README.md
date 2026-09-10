# UX step 6 — the copy cut

Copies of `src/editor/{StateList,FramePanel,PropertiesPanel,presetControls,AnimatePanel,ExportMenu,GridSizeField,TilePicker}.tsx`,
`src/editor/panels.css` and `src/components/controls.tsx` before 2026-09-10 21:33.

## The rule

Guidance lives on the control it concerns, as a tooltip; a paragraph under a
control is never the answer. Warnings and disabled reasons stay. Labels stay.

## What went

Every `panel__hint` and `panel__note--dim` paragraph: the page-background
note, the multi-select advice, the textarea note; the mosaic's tile count,
snap explanation, split-tiles note, playback explanation, tile-selection
count, clear-vs-white note, glyph-colour note, backdrop note, easing note, and
`PreviewNote` (four uses); the frame's members note, speed note and
edit-this-state note; every preset's description (`hint` prop removed from
`PresetGrid`, its callers in `AnimatePanel` and `colourParts`; the text stays
in the animation descriptors as data); the export menu's `summarise()`; the
tile picker's "Shift-click to add"; the grid field's " — click to apply".
Every `title=` attribute (export trigger, colour swatch, alpha slider, the two
reorder grips): gone or a `Tooltip`.

## What took its place

- `Slider` has a `tip` prop: the one thing about a control that cannot be
  seen, as a tooltip on its label. One user: Snap, "Hold Alt to drag past the
  grid".
- The mosaic's Reset label carries "Tiles were split — rebuild the grid first"
  while the button is disabled.
- The export trigger's reason is a `Tooltip`; a frame target disables Export
  GIF with "Frames cannot be exported yet"; an export error is a `.warning`.
- "N tiles hold a character the font cannot draw" is a `.warning` with the icon.
- The frame lid reads `Empty` when there are no members.
- The alpha slider announces its value through `aria-valuetext`.
- The grid field's readout is `.grid-size__readout`, a readout rather than a
  hint.

`.panel__hint`, `.panel__note--dim` and `.tile-picker__hint` lost their last
users and are deleted; the class test holds the line.

## Browser (scratch server, reloaded)

No hint or dim-note element anywhere; the mosaic's rail shows Tiles / Glyphs /
Backdrop / Border / Timing with no paragraphs; the right shows Grid and
Playback; the Snap label carries the Alt tip; the export trigger carries
"Export Mosaic 2"; the frame's panel shows Clip and Speed with no paragraphs.
Viewport probe: after a real wheel zoom, opening the rail leaves the viewport
untouched through all eight samples of the slide.

## Result

`npm run check`: 99 files, 1377 tests, typecheck and lint clean.
