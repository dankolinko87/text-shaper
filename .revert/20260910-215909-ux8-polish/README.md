# UX step 8 — the polish round

Copies of `src/editor/{Toolbar,FramePanel,StateList,colourParts,ObjectBar,Canvas,TopBar,ZoomControl,PropertiesPanel,StatesRail}.tsx`,
`src/editor/panels.css`, `src/components/{controls.tsx,controls.css,Icon.tsx}`,
`src/app/{App.tsx,app.css}` before 2026-09-10 21:59.

## What changed

- **The blink when the rail opens.** Each step of the rail's slide resized the
  canvas; giving the element a new size wipes its bitmap, and Fabric's deferred
  render let the browser paint the blank canvas first — a dozen blinks in a
  row. The canvas now renders synchronously at the end of its resize handler.
  The app's second ResizeObserver on the stage is gone; the zoom control reads
  the stage size the canvas already writes to the store.
- **Menu carets beside the tools**, as Figma has them: a narrow button to the
  right of each tool with a menu (`MenuChevron`), with its own tooltip, pressed
  state and focus ring — instead of a mark in the tool's corner that had to
  catch its own mousedown.
- **⋯ on every frame state card** (`components/Menu.tsx`): "Apply to every
  state" and "Reset to follow the shape" behind one glyph, with the heading
  saying what they act on; the two ghost buttons and their "This state" field
  are gone.
- **Colour rows in Figma's format** (`ColorField`): swatch and hex in one well,
  opacity as a percentage in a second, and a `−` at the end where the colour
  can be removed (`onRemove`). The `#` is not shown. `bare` hides the label
  where the section already names the thing. The alpha range slider is gone.
- **No play button under a thing that cannot play.** The object bar shows play
  only while something moves or is running; a still shape gets no bar at all.
- **"Background +" / "Border +" rows** (`AddRow`): a part that is not there yet
  is its name and a + at the right — the frame state's background, a border,
  a banner, the shape colour. Their `Remove` / `Type only` / `Clear background`
  buttons became the colour row's `−`. `.field-row-inline` lost its last user
  and is deleted.

## Browser (scratch server, reloaded, every action pinned to the scratch tab)

Three caret buttons, each right of its tool; the second opens its flyout with
`aria-expanded`, and a press elsewhere closes it. The still shape shows no
bar; the frame's bar shows play. Every state card has the ⋯ menu; open, it
lists both actions (disabled while the state has authored nothing) under
"This state", and closes on a press outside. State 1 shows "Background +";
state 3 shows the colour row `0000ff · 100 % · Remove background`. The shape's
panel shows "Border +", the text colour row without a remove, the shape colour
row with "Type only". No console errors.

## Result

`npm run check`: 99 files, 1377 tests, typecheck and lint clean.
