import { SegmentedControl, Slider } from "../components/controls";
import { documentDefaults } from "../state/defaults";
import { typographyById, useDocumentStore } from "../state/documentStore";
import {
  ANIMATIONS,
  animationById,
  bannerAnimations,
  defaultConfig,
  defaultLoop,
} from "../typography/animation";
import {
  SHAPE_ANIMATIONS,
  defaultShapeConfig,
  shapeAnimationById,
  type ShapePreset,
} from "../typography/shapeAnimation";
import type { AnimationPreset, TypographyObject } from "../types/document";
import { hasContainer, isMoving } from "../typography/objectFit";
import { wordsCanTravel } from "../typography/runFit";
import { ControlList, PresetGrid } from "./presetControls";
import "./panels.css";

/**
 * The Animate tab.
 *
 * Deliberately not a timeline. A menu per part — the type, its banner, the
 * container — each with the handful of controls its preset declares for itself.
 * This component renders whatever any preset asks for without knowing anything
 * about them individually, so adding one needs no change here.
 *
 * Ordered the way the artwork is STACKED, top to bottom: the words, then the
 * banner behind them, then the shape behind that. It is the order the renderer
 * lays the three down in, and the order they sit in on the canvas, so a panel
 * that read type, shape, banner asked people to hold a different arrangement in
 * their head from the one they were looking at. The Colour tab is ordered the
 * same way, for the same reason.
 *
 * Motion only: colour has its own tab, so a sticker can shimmer AND bounce.
 *
 * The two menus compose rather than competing. A shape preset deforms the
 * container and the type is laid out through the deformed container, so it
 * follows — unless you say otherwise, for a shape that frames the words rather
 * than holding them.
 */
export function AnimatePanel({
  id,
  object,
  rows,
}: {
  id: string;
  object: TypographyObject;
  /** How many rows the text actually came out as. See `typeControls`. */
  rows: number;
}) {
  const preset = animationById(object.animation.preset);
  const shape = shapeAnimationById(object.animation.shapePreset as ShapePreset);
  const bannerChoice = object.animation.bannerPreset ?? "follow";
  const bannerPreset =
    bannerChoice === "follow"
      ? null
      : animationById(bannerChoice as AnimationPreset);

  /**
   * Merge onto the animation as the STORE has it, not as this render saw it.
   *
   * Spreading the prop would drop any change made since React last rendered —
   * two settings changed in quick succession and the second silently undid the
   * first, which reads as a control that will not stay put.
   */
  const update = (
    patch: Partial<TypographyObject["animation"]>,
    label?: string,
  ): void => {
    const store = useDocumentStore.getState();
    const current = typographyById(id)?.animation ?? object.animation;
    store.updateObject(id, { animation: { ...current, ...patch } });
    if (label) store.commit(label);
  };

  /** The settings as the store has them, for the same reason as `update`. */
  const currentConfig = (
    key: "config" | "shapeConfig" | "bannerConfig",
  ): Record<string, number | string> =>
    typographyById(id)?.animation[key] ?? object.animation[key];

  const commit = (label: string) => (): void => {
    useDocumentStore.getState().commit(`Change ${label.toLowerCase()}`);
  };

  /*
   * Line offset delays each ROW against the one above it, so it needs rows.
   *
   * `linePhase` returns the phase untouched below two of them, so on anything
   * that came out as a single line the control does nothing whatsoever. Asked of
   * the layout rather than of the fitting mode, which is the version that keeps
   * working: the old test named `ring`, so it hid the control on a lap and a
   * spiral and left it sitting on a drawn line — and on any shape whose text
   * happens to fit on one row, which no list of modes could have caught.
   *
   * The per-letter stagger, which is what someone reaching for this on a single
   * line actually wants, is already a control of its own on the presets that can
   * use it.
   */
  const typeControls =
    rows > 1
      ? preset.controls
      : preset.controls.filter((c) => c.key !== "lineOffset");

  return (
    <>
      <section className="panel__section">
        <h3 className="panel__section-title">Type</h3>
        {/*
          Travel is the one preset that needs a run with no ends. It carries the
          words bodily round and relies on coming back to where they started; on
          a shape's rows, on a spiral, or on a lap that has been cut open at the
          side, there is nowhere for them to come back FROM and it would do
          nothing at all. Offered only where it works, rather than sitting in the
          picker doing nothing.
        */}
        <PresetGrid
          options={ANIMATIONS.filter(
            (p) => p.id !== "travel" || carriesATravellingLine(object),
          ).map((p) => ({ id: p.id, label: p.label }))}
          value={preset.id}
          onChange={(next) =>
            update(
              {
                preset: next as AnimationPreset,
                config: defaultConfig(next as AnimationPreset),
                // The loop the preset wants, which is not the same for a
                // shimmer and for words carried the whole way round a shape.
                loopDuration: defaultLoop(
                  next as AnimationPreset,
                  documentDefaults.animation.loopDuration,
                ),
              },
              "Change type animation",
            )
          }
        />
        <ControlList
          controls={typeControls}
          config={object.animation.config}
          onChange={(key, value) =>
            update({ config: { ...currentConfig("config"), [key]: value } })
          }
          onCommit={commit}
        />

        {/*
          Loop length sits HERE, with the first controls, rather than at the
          foot of the panel.

          It is the control people reach for first and reach for most: it is
          half of how fast everything looks, and the other half is whichever
          slider is directly above it. Kept at the bottom it was below the
          banner and shape menus — off the end of a scroll on a tall object —
          so the usual answer to "this is too fast" was somewhere nobody
          thought to look, and the amount slider above got pushed around
          instead.

          It governs the whole object rather than the type alone, which is why
          it is gated on ANYTHING moving rather than on the type preset, and why
          it keeps a label that names the loop rather than the type.
        */}
        {isMoving(object) && (
          <Slider
            label="Loop length"
            value={object.animation.loopDuration}
            /*
              The range runs long rather than short on purpose: six seconds was
              the slowest a loop could be, which is a brisk walk for a ripple and
              a sprint for words travelling round a shape — most of the slider
              was spent on speeds nobody wants, and the useful end of it was the
              last centimetre. Thirty seconds puts the slow, considered end in
              the middle where it can be aimed at.

              The floor comes up for the same reason. Four tenths of a second was
              a blur at any setting, and with two laps to spend it put the words
              round a shape five times a second; a second is as brisk as this
              needs to be.
            */
            min={1}
            max={30}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            onChange={(loopDuration) => update({ loopDuration })}
            onCommit={() =>
              useDocumentStore.getState().commit("Change loop length")
            }
          />
        )}
      </section>

      {/*
        The banner is a shape, not a marking on the letters, so it is animated
        like one — its own menu, next to the container's.

        Following is the default and stays the default: a ripple that lifted the
        words off a banner left behind would tear the two apart, and that is what
        anyone wants nine times in ten. The menu is for the tenth — the words
        travelling round inside a banner that holds still, or a banner rippling
        under type that does not.

        Only the presets that take hold of the STRIP are offered. A banner has no
        letters, so Bounce, Pop and Jitter would do nothing to one; and it is
        never carried ALONG its run, because a banner that leaves the words it
        belongs to is not a banner any more.
      */}
      {object.appearance.lineFill !== null && (
        <section className="panel__section">
          <h3 className="panel__section-title">Banner</h3>
          <PresetGrid
            options={[
              { id: "follow", label: "Follow type" },
              ...bannerAnimations().map((p) => ({ id: p.id, label: p.label })),
            ]}
            value={bannerChoice}
            onChange={(next) =>
              update(
                next === "follow"
                  ? { bannerPreset: "follow", bannerConfig: {} }
                  : {
                      bannerPreset: next as AnimationPreset,
                      bannerConfig: defaultConfig(next as AnimationPreset),
                    },
                "Change banner animation",
              )
            }
          />
          {bannerPreset && (
            <ControlList
              controls={bannerPreset.controls.filter(
                (c) => c.key !== "lineOffset",
              )}
              /* A banner is one strip along one run: there are never rows to
                 stagger, whatever the type inside it is doing. */
              config={object.animation.bannerConfig}
              onChange={(key, value) =>
                update({
                  bannerConfig: {
                    ...currentConfig("bannerConfig"),
                    [key]: value,
                  },
                })
              }
              onCommit={commit}
            />
          )}
        </section>
      )}

      {/*
        The shape presets deform the CONTAINER, so they are offered where there
        is one. A drawn line is a run and nothing else — no inside to squeeze, no
        corners to pull — and the thin line drawn along it in the editor is a
        guide rather than artwork, so the whole menu could only wobble something
        nobody is looking at.
      */}
      {hasContainer(object) && (
        <section className="panel__section">
          <h3 className="panel__section-title">Shape</h3>
          <PresetGrid
            options={SHAPE_ANIMATIONS.map((p) => ({
              id: p.id,
              label: p.label,
            }))}
            value={shape.id}
            onChange={(next) =>
              update(
                {
                  shapePreset: next,
                  shapeConfig: defaultShapeConfig(next as ShapePreset),
                },
                "Change shape animation",
              )
            }
          />
          <ControlList
            controls={shape.controls}
            config={object.animation.shapeConfig}
            onChange={(key, value) =>
              update({
                shapeConfig: { ...currentConfig("shapeConfig"), [key]: value },
              })
            }
            onCommit={commit}
          />

          {shape.id !== "none" && (
            <SegmentedControl<"follow" | "hold">
              label="The type"
              value={
                object.animation.shapeAffectsText === false ? "hold" : "follow"
              }
              options={[
                { value: "follow", label: "Follows" },
                { value: "hold", label: "Holds still" },
              ]}
              onChange={(choice) =>
                update(
                  { shapeAffectsText: choice === "follow" },
                  "Change what the shape affects",
                )
              }
            />
          )}
        </section>
      )}
    </>
  );
}

/**
 * Does this object's type sit on a run that comes back to where it started?
 *
 * One lap around the shape, uncut. A spiral has two ends, a split lap has been
 * opened at the side on purpose, and rows in a shape are not a run at all —
 * none of them can carry words that travel in one direction and still close
 * their loop.
 */
function carriesATravellingLine(object: TypographyObject): boolean {
  if (object.fittingMode !== "ring" && object.fittingMode !== "path")
    return false;
  const closed = object.fittingMode === "ring" && object.run.turns === "one";
  return wordsCanTravel(closed, object.run.split);
}
