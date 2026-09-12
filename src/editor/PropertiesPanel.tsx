import { useState } from "react";

import { Icon } from "../components/Icon";
import { AnimatePanel } from "./AnimatePanel";
import {
  BannerColour,
  OpacityControl,
  ShapeBorder,
  ShapeColour,
  TypeColour,
} from "./colourParts";
import { FramePanel } from "./FramePanel";
import { PaintChip, Section, StrokeChip } from "./Section";
import { MosaicStatePanel } from "./StateList";
import { MeshStatePanel } from "./MeshPanel";
import {
  Button,
  ColorField,
  SegmentedControl,
  Slider,
} from "../components/controls";
import { FONTS } from "../fonts/manifest";
import { typographyById, useDocumentStore } from "../state/documentStore";
import { useUiStore } from "../state/uiStore";
import { useSelectedObject } from "./selection";
import { currentTypeSettings, updateShape } from "./memberEdits";
import {
  MIN_LINE_HEIGHT,
  MIN_FONT_SIZE,
  type TextFlowMode,
  type TypographyObject,
} from "../types/document";
import "./panels.css";

/** Which part of a shape or line is unfolded in Design. */
type TypographyPart =
  | "type"
  | "run"
  | "packing"
  | "banner"
  | "shape"
  | "border"
  | "opacity";

/** The face's own name, for the Type lid. */
function fontName(fontId: string): string {
  return FONTS.find((font) => font.id === fontId)?.family ?? fontId;
}

/**
 * What a run is, in three words: its size and how it winds.
 *
 * The mode is the useful half — a lap and a spiral are different objects to
 * work on — so the lid names it rather than repeating the fitting mode already
 * in the title.
 */
function runSummary(object: TypographyObject, autoSize: number): string {
  // Zero means "fit it for me", and the lid should say what that came out as
  // rather than the zero — which reads as type with no size at all.
  const size = Math.round(object.run.fontSize > 0 ? object.run.fontSize : autoSize);
  const shown = size > 0 ? `${size}` : "auto";
  if (object.fittingMode === "path") return shown;
  return object.run.turns === "many" ? `${shown} · spiral` : `${shown} · one turn`;
}

interface PropertiesPanelProps {
  warnings: Record<string, string>;
  /** The largest the type could be, per object id. See `useTextPaths`. */
  autoSizes: Record<string, number>;
  /** How many rows each object's text actually came out as. */
  lineCounts: Record<string, number>;
}

export function PropertiesPanel({ warnings, autoSizes, lineCounts }: PropertiesPanelProps) {
  const selection = useDocumentStore((s) => s.selection);
  const panelTab = useUiStore((s) => s.panelTab);
  /* Which of the selection's states is on show, for a panel that describes one state. */
  const shownIndex = useUiStore((s) => (selection[0] ? (s.mosaicStates[selection[0]] ?? 0) : 0));
  const artboardBackground = useDocumentStore((s) => s.doc.artboard.background);
  const setPanelTab = useUiStore((s) => s.setPanelTab);
  // What the panel is about, answered by the one function every surface asks.
  const picked = useSelectedObject();
  /*
   * Which parts are unfolded — a set, not one at a time.
   *
   * An accordion decides for you that looking at the run means giving up the
   * type, and it can never be fully shut. Independent lids let the panel be
   * closed right down to five labels, which is the state it should be in when
   * you are working on the canvas rather than in here.
   */
  const [open, setOpen] = useState<ReadonlySet<TypographyPart>>(
    () => new Set(["type"]),
  );
  const toggle = (part: TypographyPart) => () =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(part)) next.delete(part);
      else next.add(part);
      return next;
    });

  if (selection.length === 0) {
    /*
     * Nothing selected is not nothing to edit.
     *
     * With no object in hand the thing you are looking at is the page itself,
     * so that is what the panel offers — the same answer Figma gives, and the
     * only moment the surface colour has a natural home. Put on an object's
     * panel it would be a document-wide setting hiding inside one shape's
     * properties.
     */
    return (
      <aside className="panel panel--properties" aria-label="Properties">
        <header className="panel__header">
          <h2 className="panel__title">Properties</h2>
        </header>
        <div className="panel__scroll">
          <section className="panel__section">
            <h3 className="panel__section-title">Page</h3>
            <ColorField
              label="Background"
              value={artboardBackground}
              onChange={(colour) =>
                useDocumentStore.getState().setArtboardBackground(colour)
              }
              onCommit={() =>
                useDocumentStore.getState().commit("Page background")
              }
            />
          </section>
        </div>
      </aside>
    );
  }

  if (selection.length > 1) {
    return (
      <aside className="panel panel--properties" aria-label="Properties">
        <header className="panel__header">
          <h2 className="panel__title">Properties</h2>
          <span className="panel__count">{selection.length}</span>
        </header>
        <div className="panel__section">
          <p className="panel__note">{selection.length} shapes selected.</p>
        </div>
      </aside>
    );
  }

  const { selected, object, id } = picked;
  if (!selected || !object || !id) return null;

  /*
   * A mosaic has almost nothing in common with the panel below.
   *
   * Its type is not fitted into a shape, so there is no fill mode, no packing,
   * no run; and its colour and motion are per state rather than per object. It
   * gets its own panel as those controls arrive — for now, what it can honestly
   * say about itself.
   */
  if (object.kind === "mosaic") {
    /*
     * No tabs at all: almost everything a mosaic has belongs to a STATE — its
     * lines, spacing, corners, colours, letters, font and timing alike. So the
     * panel describes the state on show, named in its header; the grid every
     * state shares and the clock they play to fold above the list in the rail.
     */
    const at = Math.min(shownIndex, object.states.length - 1);
    return (
      <aside className="panel panel--properties" aria-label="Properties">
        {/* The object's name lives in the rail; here, the state this panel is about. */}
        <header className="panel__header">
          <h2 className="panel__title">State {at + 1}</h2>
        </header>

        <div className="panel__scroll">
          <MosaicStatePanel object={object} at={at} />
        </div>
      </aside>
    );
  }

  // A mesh: the mosaic's panel, on polygons.
  if (object.kind === "mesh") {
    const at = Math.min(shownIndex, object.states.length - 1);
    return (
      <aside className="panel panel--properties" aria-label="Properties">
        <header className="panel__header">
          <h2 className="panel__title">State {at + 1}</h2>
        </header>

        <div className="panel__scroll">
          <MeshStatePanel object={object} at={at} />
        </div>
      </aside>
    );
  }

  /*
   * A frame, which is the mosaic's panel one level out: no tabs, the thing that
   * every state shares at the top, then the states themselves.
   */
  if (object.kind === "frame") {
    const at = Math.min(shownIndex, object.states.length - 1);
    return (
      <aside className="panel panel--properties" aria-label="Properties">
        <header className="panel__header">
          <h2 className="panel__title">State {at + 1}</h2>
        </header>

        <div className="panel__scroll">
          <FramePanel object={object} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel panel--properties" aria-label="Properties">
      <header className="panel__header">
        <h2 className="panel__title">{object.name}</h2>
      </header>

      {/*
        Three tabs rather than one long panel, split by the decision being made:
        the shape of the type, its colour, and its motion. The canvas watches
        which is open — a shape loops only while Colour or Animate is showing, so
        the artboard stays still while you are laying type out.
      */}
      <div className="panel__tabs" role="tablist">
        {(["design", "animate"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={panelTab === tab}
            className="panel__tab"
            onClick={() => setPanelTab(tab)}
          >
            {tab === "design" ? "Design" : "Animate"}
          </button>
        ))}
      </div>

      {panelTab === "animate" ? (
        <div className="panel__scroll">
          <AnimatePanel id={id} object={object} rows={lineCounts[id] ?? 1} />
        </div>
      ) : (
        <div className="panel__scroll">
          {warnings[id] ? (
            <p className="warning" role="status" aria-live="polite">
              <Icon name="warning" size={13} />
              {warnings[id]}
            </p>
          ) : null}

          {/*
            Sections are PARTS now, not kinds of property.
            
            Colour used to be a tab of its own, so a banner's colour and a
            banner's motion were two places apart and editing one thing meant
            visiting both. Each part now holds everything about itself that is
            not motion, and Animate holds the motion — a split by phase of work
            rather than by which field it happens to be.
            
            Folded, with the value on the lid, because a run has twelve controls
            and a shut Ring section that says "64 · one turn" answers the
            question you would have opened it to ask.
          */}
          <Section
            title="Type"
            summary={fontName(object.font.fontId)}
            open={open.has("type")}
            onToggle={toggle("type")}
          >
            <TextSection id={id} text={object.text} />

            <div className="field">
              <label className="field__label" htmlFor="font-select">
                Font
              </label>
              <select
                id="font-select"
                className="input"
                value={object.font.fontId}
                onChange={(e) => {
                  const store = useDocumentStore.getState();
                  updateShape(id, {
                    font: { ...object.font, fontId: e.target.value },
                  });
                  store.commit("Change font");
                }}
              >
                {FONTS.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.family} — {font.note}
                  </option>
                ))}
              </select>
            </div>

            {/* The type's own measure, beside the face it is set in. */}
            {/*
              The GAP between the lines, which is all this has ever set on a
              run: a turn is the line height plus this. It is named for that
              where it means that, and hidden from a single lap, which has
              nothing to space itself against.
            */}
            {object.fittingMode !== "path" &&
              (object.fittingMode !== "ring" ||
                object.run.turns === "many") && (
                <Slider
                  label={
                    object.fittingMode === "ring" ? "Line gap" : "Line spacing"
                  }
                  value={object.typography.lineSpacing}
                  min={0.5}
                  max={4}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={(lineSpacing) =>
                    updateShape(id, {
                      typography: { ...object.typography, lineSpacing },
                    })
                  }
                  onCommit={() =>
                    useDocumentStore.getState().commit("Change line spacing")
                  }
                />
              )}

            <Slider
              label="Letter spacing"
              value={object.typography.letterSpacing}
              min={-0.05}
              max={0.4}
              step={0.005}
              // Shown as a percentage of the em, the way type is normally tracked.
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(letterSpacing) =>
                updateShape(id, {
                  typography: { ...object.typography, letterSpacing },
                })
              }
              onCommit={() =>
                useDocumentStore.getState().commit("Change letter spacing")
              }
            />

            {/*
              Two ways of filling a shape, not four. Line stretch and glyph
              stretch were the steps on the way to warping and are not offered;
              both remain in the model, so a saved document keeps whatever it
              has.

              A drawn LINE has no inside to fill, so there is nothing to choose
              between: it can only be written along.
            */}
            {object.fittingMode !== "path" && (
              <SegmentedControl<"boundary-warp" | "ring">
                label="Layout"
                value={object.fittingMode === "ring" ? "ring" : "boundary-warp"}
                options={[
                  { value: "boundary-warp", label: "Shape" },
                  { value: "ring", label: "Ring" },
                ]}
                onChange={(mode) => {
                  const store = useDocumentStore.getState();
                  updateShape(id, { fittingMode: mode });
                  store.commit("Change fill");
                }}
              />
            )}

            {/*
              Character flow is not offered: breaking words at arbitrary letters
              is a wrapping mode, not a design one, and it never produced
              anything worth keeping here. The engine still supports it.
            */}
            <SegmentedControl<TextFlowMode>
              label="Text flow"
              value={
                object.textFlowMode === "character"
                  ? "word"
                  : object.textFlowMode
              }
              options={[
                { value: "word", label: "Word" },
                { value: "preserve-lines", label: "Lines" },
              ]}
              onChange={(mode) => {
                const store = useDocumentStore.getState();
                updateShape(id, { textFlowMode: mode });
                store.commit("Change text flow");
              }}
            />

            <TypeColour id={id} object={object} />
          </Section>

          {/*
            How the type is arranged: along a run, or packed into a shape. Never
            both — a ring has no packing to do, and a shape has no run.
          */}
          {object.fittingMode === "ring" || object.fittingMode === "path" ? (
            <Section
              title={object.fittingMode === "path" ? "Line" : "Ring"}
              summary={runSummary(object, autoSizes[id] ?? 0)}
              open={open.has("run")}
              onToggle={toggle("run")}
            >
              <RunSection id={id} object={object} autoSize={autoSizes[id] ?? 0} />
            </Section>
          ) : (
            <Section
              title="Packing"
              summary={`${Math.round(object.distortion.vertical * 100)}% · ${Math.round(
                object.distortion.glyphScaleVariation * 100,
              )}%`}
              open={open.has("packing")}
              onToggle={toggle("packing")}
            >
              <DistortionSection id={id} object={object} />
            </Section>
          )}

          {/*
            The banner: a filled band following the run, with the type inside
            it. Every mode with a run to follow has one — a lap, a spiral, and a
            line the user drew. Not offered where there is nothing to follow: a
            row of text in a shape has a band in the layout sense but nothing to
            draw it along.
          */}
          {object.fittingMode === "ring" || object.fittingMode === "path" ? (
            <Section
              title="Banner"
              summary={<PaintChip value={object.appearance.lineFill} />}
              open={open.has("banner")}
              onToggle={toggle("banner")}
            >
              <BannerColour id={id} object={object} />
            </Section>
          ) : null}

          {/* A drawn line has no inside, so it has no shape to fill or pad. */}
          {object.fittingMode !== "path" ? (
            <Section
              title="Shape"
              summary={<PaintChip value={object.appearance.containerFill} />}
              open={open.has("shape")}
              onToggle={toggle("shape")}
            >
              <ShapeColour id={id} object={object} />

              <Slider
                label="Padding"
                value={object.typography.padding}
                min={0}
                max={120}
                onChange={(padding) =>
                  updateShape(id, {
                    typography: { ...object.typography, padding },
                  })
                }
                onCommit={() =>
                  useDocumentStore.getState().commit("Change padding")
                }
              />

              {object.dividers.length > 0 && object.fittingMode !== "ring" && (
                // Only shown once a grid exists. Dragging any boundary commits
                // the rows to the object, and until now there was no way to take
                // them off again — the grid built for one piece of text stayed
                // on the shape for every later one.
                <div className="field">
                  <span className="field__label">Grid</span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const store = useDocumentStore.getState();
                      store.clearGrid(id);
                      store.commit("Reset grid");
                    }}
                  >
                    Reset ({describeGrid(object.dividers)})
                  </Button>
                </div>
              )}
            </Section>
          ) : null}

          {/*
            The edge, in a section of its own rather than inside Shape.
            
            A border is a PEER of the fill, not a detail of it — you reach for
            one without touching the other, and folded inside Shape its five
            rows made the fill's own two hard to find. Directly after Shape,
            because it is the same part's other half.
            
            Hidden for a drawn line for the same reason Shape is: a line has no
            inside, so there is no container to draw an edge on. Its own stroke
            is a separate thing, and it does not have one yet.
          */}
          {object.fittingMode !== "path" ? (
            <Section
              title="Border"
              summary={<StrokeChip value={object.appearance.containerStroke} />}
              open={open.has("border")}
              onToggle={toggle("border")}
            >
              <ShapeBorder id={id} object={object} />
            </Section>
          ) : null}

          {/*
            The whole object's transparency, above the individual fills — every
            colour field already carries its own alpha, and this is the one that
            governs all of them at once.
          */}
          <Section
            title="Opacity"
            summary={`${Math.round(object.appearance.opacity * 100)}%`}
            open={open.has("opacity")}
            onToggle={toggle("opacity")}
          >
            <OpacityControl id={id} object={object} />
          </Section>
        </div>
      )}
    </aside>
  );
}

/**
 * "3 rows", or "3 rows, 2 deformers".
 *
 * Not "3 x 2": the two are not axes of a grid of cells. Rows decide what goes
 * where; vertical deformers only squeeze what is already there.
 */
function describeGrid(dividers: TypographyObject["dividers"]): string {
  const rows = dividers.filter((d) => d.axis !== "column").length + 1;
  const deformers = dividers.filter((d) => d.axis === "column").length;
  const rowLabel = `${rows} row${rows === 1 ? "" : "s"}`;
  if (deformers === 0) return rowLabel;
  return `${rowLabel}, ${deformers} deformer${deformers === 1 ? "" : "s"}`;
}

/**
 * The deformation controls.
 *
 * Only shown in Warp mode, because every slider here feeds the warp field and
 * would do nothing in the other two modes — a visible control that does nothing
 * is worse than no control.
 *
 * Three settings are deliberately NOT exposed and stay at their defaults:
 * `boundaryInfluence` (following the shape is the whole point of the tool, not
 * a preference), `glyphRotation` (height fill, for the same reason), and
 * `horizontal` (the base character gap, now that letter spacing in the Layout
 * section moves the same quantity and does it in the units type is normally
 * spaced in). They remain in the model because the engine reads them.
 */
/**
 * Spiral mode's own controls.
 *
 * No turn count. It is decided by how much text there is — more words wind more
 * turns at a smaller size — so the panel REPORTS it rather than offering it.
 * Saying so out loud is the difference between a surprising behaviour and a
 * usable one.
 */
/**
 * The controls for text along a run: a lap around the shape, or a spiral into it.
 *
 * One section because it is one mode. A lap and a spiral differ in how many
 * times the run goes round and in nothing else, so most of what is here applies
 * to both; the few controls that only mean something at one turn count or the
 * other are shown where they mean something.
 */
function RunSection({
  id,
  object,
  autoSize,
}: {
  id: string;
  object: TypographyObject;
  /** The largest the type could be on this shape, with this text. */
  autoSize: number;
}) {
  const settings = object.run;
  /*
   * A drawn line is the run itself. Nothing is offset from it, so there is no
   * turn count, nowhere for a band to sit across it, no direction to reverse —
   * a line has one — and no seam to leave a gap at. What is left is how the
   * letters meet it and how big they are.
   */
  const online = object.fittingMode === "path";
  const many = !online && settings.turns === "many";
  /*
    While the font is still loading, or the text is empty, there is no fitted
    size to offer yet. Half the shape's shorter side stands in until there is:
    type bigger than that could not be set on it whatever the words are.
  */
  const ceiling = Math.max(
    MIN_FONT_SIZE + 1,
    Math.round(
      autoSize > 0
        ? autoSize
        : Math.min(object.localBounds.width, object.localBounds.height) / 2,
    ),
  );

  /**
   * Merged onto the settings as the STORE has them, not as this render saw them
   * — and inside a frame that means the STATE's, which is where the write goes.
   * Reading the member's resting run and writing to the state would merge onto
   * the wrong values the moment the two differed, which is the moment this
   * feature exists for.
   */
  const write = (patch: Partial<TypographyObject["run"]>): void => {
    const current = currentTypeSettings(id)?.run ?? typographyById(id)?.run ?? settings;
    updateShape(id, { run: { ...current, ...patch } });
  };
  const update = (
    patch: Partial<TypographyObject["run"]>,
    label: string,
  ): void => {
    write(patch);
    useDocumentStore.getState().commit(label);
  };
  const commit = (label: string) => () =>
    useDocumentStore.getState().commit(label);

  return (
    <>
      {/*
        The only real difference between the two. Not a number: the turn count on
        Many falls out of the pitch and the shape — thirty characters make one
        big turn, six hundred make eight small ones — so a number here would be a
        cap pretending to be a target.
      */}
      {/*
        A real size, in the object's own units, and its top end is the largest
        the words actually fit at here — not an arbitrary ceiling. That number
        moves as the text is edited and as the shape is resized, so the way to
        get bigger type is a bigger shape.

        Dragging to the top stores 0, which means "as big as fits" and keeps
        tracking the shape rather than freezing at today's number.
      */}
      <Slider
        label="Font size"
        value={
          settings.fontSize > 0 ? Math.min(settings.fontSize, ceiling) : ceiling
        }
        min={MIN_FONT_SIZE}
        max={ceiling}
        step={1}
        format={(v) => `${Math.round(v)}`}
        onChange={(fontSize) =>
          write({
            fontSize: fontSize >= ceiling - 0.5 ? 0 : Math.round(fontSize),
          })
        }
        onCommit={commit("Change font size")}
      />

      {!online && (
        <SegmentedControl<"one" | "many">
          label="Turns"
          value={settings.turns}
          options={[
            { value: "one", label: "One" },
            { value: "many", label: "Many" },
          ]}
          onChange={(turns) => update({ turns }, "Change turns")}
        />
      )}

      {/* A drawn line is the run itself: there is nothing to sit a band across. */}
      {!online && (
        <SegmentedControl<"in" | "on" | "out">
          label="Band"
          value={
            settings.side > 0.5 ? "in" : settings.side < -0.5 ? "out" : "on"
          }
          options={[
            { value: "in", label: "Inside" },
            { value: "on", label: "Centred" },
            { value: "out", label: "Outside" },
          ]}
          onChange={(choice) =>
            update(
              { side: choice === "in" ? 1 : choice === "out" ? -1 : 0 },
              "Change band position",
            )
          }
        />
      )}

      {/*
        On many turns this winds out from the middle instead of in from the edge.
        On one it flips which side of the line the capitals stand on, which is the
        badge look — reversing the direction and the normal together preserves
        handedness, so the type stays readable rather than mirrored.

        A drawn line has one direction, so neither applies and it is not shown.
      */}
      {!online && (
        <SegmentedControl<"in" | "out">
          label={many ? "Winds" : "Type"}
          value={settings.outward ? "out" : "in"}
          options={
            many
              ? [
                  { value: "in", label: "Inward" },
                  { value: "out", label: "Outward" },
                ]
              : [
                  { value: "in", label: "Outside" },
                  { value: "out", label: "Inside" },
                ]
          }
          onChange={(choice) =>
            update({ outward: choice === "out" }, "Change run direction")
          }
        />
      )}

      {!many && !online && (
        <>
          {/*
            Continuous closes the ring: the words go the whole way round and the
            banner with them, and the gap is only there to stop the last word
            landing against the first. Split opens it at a chosen point on the
            shape — the words begin and end there, and the banner breaks with them.

            The line is the same line either way. Neither one stacks a second
            line under the first: along the bottom the words are upside down, as
            type on any closed path is.
          */}
          <SegmentedControl<"around" | "split">
            label="Text"
            value={settings.split ? "split" : "around"}
            options={[
              { value: "around", label: "Continuous" },
              { value: "split", label: "Split" },
            ]}
            onChange={(choice) =>
              update({ split: choice === "split" }, "Change ring text")
            }
          />

          {settings.split && (
            /*
              Read like a clock face, which is how anyone describes where they
              want a join: nine o'clock sends the words up over the top first,
              twelve starts them at the top with the join above them, six puts
              the join under the shape.

              Only offered with Split on, because with the line continuous there
              is no break to place — the seam is wherever the last word meets the
              first, and that is decided by how much has been written.
            */
            <Slider
              label="Split at"
              value={settings.splitAngle}
              min={0}
              max={359}
              step={1}
              format={(v) => `${Math.round(v)}° ${clockFace(v)}`}
              onChange={(splitAngle) => write({ splitAngle })}
              onCommit={commit("Move the split")}
            />
          )}
        </>
      )}

      {/*
        The two ways type can meet a curve. Wrapped, each letter is stretched
        into its own slot and the letterforms carry the shape; set, they keep the
        widths they were drawn at and the run only decides where they go.
        Separate from the angle control below, because all four combinations are
        real — set letters standing upright is a perfectly good badge.
      */}
      <SegmentedControl<"wrap" | "rigid">
        label="Letters"
        value={settings.rigid ? "rigid" : "wrap"}
        options={[
          { value: "wrap", label: "Wrap" },
          { value: "rigid", label: "Set" },
        ]}
        onChange={(choice) =>
          update({ rigid: choice === "rigid" }, "Change letter shaping")
        }
      />

      <SegmentedControl<"tangent" | "upright">
        label="Angle"
        value={settings.upright ? "upright" : "tangent"}
        options={[
          { value: "tangent", label: "Follow" },
          { value: "upright", label: "Upright" },
        ]}
        onChange={(choice) =>
          update({ upright: choice === "upright" }, "Change letter angle")
        }
      />

      {!many && !online && (
        /*
          Room where the ends meet. Continuous, that is the seam — where the last
          word lands against the first, and without it a lap ending in BELIEVE and
          starting with NICE reads BELIEVENCE.
        */
        <Slider
          label="Gap"
          value={settings.gap}
          min={0}
          max={0.4}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(gap) => write({ gap })}
          onCommit={commit("Change gap")}
        />
      )}

      {many && (
        /*
          A floor, not a target: no type comes closer to the middle than this.
          Winding deeper with the same words needs smaller type and more turns,
          and past a point the letters would have to stretch to cover the extra
          run — so where a turn boundary does not land on the number, the middle
          comes out wider than asked rather than the letters coming out wider
          than drawn.
        */
        <Slider
          label="Centre hole"
          value={settings.centreHole}
          min={0}
          max={0.8}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(centreHole) => write({ centreHole })}
          onCommit={commit("Change centre hole")}
        />
      )}

      {/*
        The band the type travels in, and the reason it is separate from the line
        gap in Layout. Together they used to be one number, so there was no way to
        ask for room AROUND the letters — a banner — without also moving the turns.
      */}
      <Slider
        label="Line height"
        value={settings.lineHeight}
        min={MIN_LINE_HEIGHT}
        max={3}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(lineHeight) => write({ lineHeight })}
        onCommit={commit("Change line height")}
      />

      <Slider
        label="Baseline shift"
        value={settings.baselineShift}
        min={-0.4}
        max={0.4}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(baselineShift) => write({ baselineShift })}
        onCommit={commit("Change baseline shift")}
      />
    </>
  );
}

function DistortionSection({
  id,
  object,
}: {
  id: string;
  object: TypographyObject;
}) {
  if (object.fittingMode !== "boundary-warp") return null;

  const d = object.distortion;
  const set = (patch: Partial<typeof d>): void => {
    useDocumentStore
      .getState()
      .updateObject(id, { distortion: { ...d, ...patch } });
  };
  const commit = (label: string) => () =>
    useDocumentStore.getState().commit(label);

  return (
    <>
      {/*
        Shown whatever the grid is. It used to be hidden once dividers existed,
        because a grid set the row boundaries outright and the automatic height
        search was skipped entirely — the slider moved and nothing happened.
        Dividers deform now and take no part in the layout, so the search runs
        as it always did and this works alongside them.
      */}
      {(
        <Slider
          label="Line height variation"
          value={d.vertical}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(vertical) => set({ vertical })}
          onCommit={commit("Change line height variation")}
        />
      )}

      <Slider
        label="Width variation"
        value={d.glyphScaleVariation}
        min={0}
        max={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(glyphScaleVariation) => set({ glyphScaleVariation })}
        onCommit={commit("Change width variation")}
      />
    </>
  );
}

/**
 * The text field reflows the shape live, on every keystroke.
 *
 * Each keystroke writes to the document but does NOT commit, so the typography
 * updates as you type while the whole edit still collapses into a single undo
 * entry when the field is left. The value is read straight from the document
 * rather than mirrored in local state, so an undo mid-edit is reflected in the
 * field immediately.
 */
function TextSection({ id, text }: { id: string; text: string }) {
  return (
    <>
      <textarea
        className="textarea"
        value={text}
        placeholder="Type to fill this shape…"
        aria-label="Shape text"
        onChange={(e) =>
          updateShape(id, { text: e.target.value })
        }
        onBlur={() => useDocumentStore.getState().commit("Edit text")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
    </>
  );
}

/** The nearest hour, so the number reads as a place rather than as a number. */
function clockFace(degrees: number): string {
  const hour = Math.round(degrees / 30) % 12
  return `(${hour === 0 ? 12 : hour} o'clock)`
}

