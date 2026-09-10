import { useEffect, useMemo, useRef, useState } from 'react'

import { fitKey } from './fitKey'
import { isFontLoaded, loadFont } from '../typography/fontRegistry'
import type { RibbonSlice } from '../typography/frame'
import { fitObject, frameAt, pourThrough } from '../typography/objectFit'
import type { FitOutcome } from '../typography/fit'
import { stateShape, valuesFor, withTypeSettings } from '../frame/frame'
import type { TypographyObject } from '../types/document'
import { isTypography } from '../types/document'
import { useDocumentStore } from '../state/documentStore'
import { useUiStore } from '../state/uiStore'

/**
 * Runs the typography pipeline for every object and returns the glyph paths.
 *
 * Pipeline per object: inset by padding -> scanline spans -> candidate layouts
 * -> scored selection -> glyph outlines. Results are cached on a key built from
 * every input that affects the output, so unrelated edits (moving an object,
 * renaming a layer) do not re-run the fit.
 */
export function useTextPaths(): {
  textPaths: Record<string, string>
  /** The banner behind the type, per object id. Empty where there is none. */
  bandPaths: Record<string, string>
  /**
   * The banner and the words in slices, per object id, in run order.
   *
   * Only for objects with a banner. Laid down alternately so a run that crosses
   * itself covers what it passes over.
   */
  ribbons: Record<string, RibbonSlice[]>
  /**
   * The largest the type could be, per object id, for the run modes.
   *
   * A property of the shape and the text together, so it moves whenever either
   * does — which is what lets the size control offer the whole range and no
   * more, and what makes "enlarge the shape" the real answer to wanting bigger
   * type.
   */
  autoSizes: Record<string, number>
  warnings: Record<string, string>
  /** Rows the engine actually laid out, per object id. */
  lineCounts: Record<string, number>
  /**
   * Where those rows sit in the container, as `v` bands, per object id.
   *
   * The grid editor opens on these rather than on an even split, so the guides
   * appear over the type instead of beside it.
   */
  rowBands: Record<string, { top: number; bottom: number }[]>
  /**
   * The solved fit for each frame MEMBER, one per STATE.
   *
   * Only members, and only because playback needs it: between two states the
   * container is a shape no state authored, so the type has to be emitted
   * through it right then. Handing over the fit is what makes that affordable —
   * the layout is already solved, and only the patch is rebuilt.
   *
   * Per state, and that is the cut tier's doing: a state may set a different
   * size or a different sentence, so the layout it is played with is its own.
   * A transition shows the DEPARTING state's, held until it arrives.
   *
   * Not kept for ordinary objects: nothing re-pours those, and a fit carries the
   * whole laid-out block.
   */
  fits: Record<string, (FitOutcome | null)[]>
} {
  const doc = useDocumentStore((s) => s.doc)
  /*
   * Which arrangement each frame is showing.
   *
   * A member is poured through the shape its state gives it, so stepping to
   * another state has to re-emit the type — the fit is cached and reused, only
   * the container it flows through changes.
   */
  const states = useUiStore((s) => s.mosaicStates)
  const fontLoaded = useUiStore((s) => s.fontLoaded)
  const clipperReady = useUiStore((s) => s.clipperReady)

  const cache = useRef(
    new Map<
      string,
      {
        key: string
        path: string
        band: string
        ribbon: RibbonSlice[]
        autoSize: number
        warning: string | null
        lineCount: number
        bands: { top: number; bottom: number }[]
        fitted: FitOutcome | null
      }
    >(),
  )
  /*
   * The per-state fits, keyed by the fit's OWN inputs rather than by state.
   *
   * Two states that set their type identically produce the same key and share
   * one solve, which is what keeps a frame with a dozen states from fitting a
   * dozen times for a change that touched none of them.
   */
  const stateFits = useRef(new Map<string, FitOutcome | null>())
  /*
   * Bumped whenever a font finishes arriving, and READ by the memo below.
   *
   * It has to be read, not just set. A font landing changes nothing the memo
   * depends on — the document is the same, and `usedFonts` is the same string it
   * was when the font was requested — so setting this only re-rendered, and the
   * memo handed back its previous value: the empty paths it produced while the
   * font was still in flight. Switching a font showed an empty shape until some
   * unrelated edit happened to invalidate the memo.
   */
  const [fontRevision, forceUpdate] = useState(0)

  // Recompute when the engine dependencies become available.
  useEffect(() => {
    if (fontLoaded && clipperReady) forceUpdate((n) => n + 1)
  }, [fontLoaded, clipperReady])

  /*
   * Fetch whatever fonts the document is actually using.
   *
   * Only the default was ever loaded, so every other entry in the picker fitted
   * with a font that was not there. Loading on demand rather than up front keeps
   * the first paint to one font file: the rest arrive when they are chosen, and
   * a shape waiting for its font simply draws nothing for that moment.
   */
  /*
   * Every font any object asks for. A mosaic's font is per STATE now — each
   * composition can be set in its own typeface — so all of them have to be
   * loaded, not just the one on show, or arriving at a state would find its font
   * missing and draw nothing.
   */
  const usedFonts = [
    ...new Set(
      doc.objectOrder.flatMap((id) => {
        const object = doc.objects[id]
        if (!object) return []
        if (object.kind === 'mosaic') return object.states.map((state) => state.font.fontId)
        // A frame's fonts are whatever its members use, one level down.
        if (object.kind === 'frame') {
          return object.members.flatMap((member) =>
            member.object.kind === 'mosaic'
              ? member.object.states.map((state) => state.font.fontId)
              : member.object.kind === 'typography'
                ? [member.object.font.fontId]
                : [],
          )
        }
        return [object.font.fontId]
      }),
    ),
  ]
    .filter((id): id is string => Boolean(id))
    .sort()
    .join(',')

  useEffect(() => {
    let cancelled = false
    for (const id of usedFonts.split(',').filter(Boolean)) {
      if (isFontLoaded(id)) continue
      loadFont(id)
        .then(() => {
          if (!cancelled) forceUpdate((n) => n + 1)
        })
        .catch(() => {
          // Reported through the object's own warning rather than thrown: one
          // font failing must not take the whole canvas down with it.
          if (!cancelled) forceUpdate((n) => n + 1)
        })
    }
    return () => {
      cancelled = true
    }
  }, [usedFonts])

  return useMemo(() => {
    const textPaths: Record<string, string> = {}
    const bandPaths: Record<string, string> = {}
    const ribbons: Record<string, RibbonSlice[]> = {}
    const autoSizes: Record<string, number> = {}
    const warnings: Record<string, string> = {}
    const lineCounts: Record<string, number> = {}
    const rowBands: Record<string, { top: number; bottom: number }[]> = {}
    const fits: Record<string, (FitOutcome | null)[]> = {}

    if (!fontLoaded || !clipperReady) {
      return { textPaths, bandPaths, ribbons, autoSizes, warnings, lineCounts, rowBands, fits }
    }

    /*
     * Every object that could hold type, including the ones inside a frame.
     *
     * A frame's members are not in `doc.objects` — they belong to the frame,
     * which is what makes membership structural — so walking the object order
     * alone would leave a member's text unfitted and it would draw as an empty
     * shape the moment it was dropped in.
     */
    const fittable = doc.objectOrder.flatMap((id) => {
      const object = doc.objects[id]
      if (!object) return []
      if (object.kind !== 'frame')
        return [{ object, shapePath: undefined as string | undefined, member: false }]

      /*
       * A member is fitted to its own shape and POURED through the state's.
       *
       * The state on show, because that is what is drawn. The fit itself is
       * against the member's resting outline — its line breaks belong to the
       * member, not to one arrangement of it — and only the container the type
       * is emitted through changes.
       */
      const at = Math.min(states[object.id] ?? 0, object.states.length - 1)
      return object.members.map((member) => {
        const values = valuesFor(member, object.states[at])
        // The state's own shape, if it gives one — judged by value, by the model.
        const reshaped = stateShape(member, values)?.currentSourcePath
        /*
         * Fitted with the STATE's type settings and the member's OWN shape.
         *
         * The two halves are deliberately different. Size, spacing and the text
         * itself decide the line breaks, so a state that changes one has to be
         * fitted afresh — that is exactly why they cut. The shape does not:
         * re-fitting to it would move the breaks, so it is poured through
         * instead.
         */
        return {
          object: withTypeSettings(member.object, values.typeSettings),
          shapePath: reshaped,
          member: true,
        }
      })
    })

    for (const { object, shapePath, member } of fittable) {
      const id = object.id
      // Only typography is FITTED. A mosaic's letters are placed by its own
      // partition and never go near the text engine, so it has nothing to cache
      // here and asking would be asking for a shape it does not have.
      if (!isTypography(object)) continue

      const key = `${fitKey(object, isFontLoaded(object.font.fontId))}~${shapePath ?? ''}`
      const cached = cache.current.get(id)
      if (cached && cached.key === key) {
        textPaths[id] = cached.path
        bandPaths[id] = cached.band
        ribbons[id] = cached.ribbon
        autoSizes[id] = cached.autoSize
        lineCounts[id] = cached.lineCount
        rowBands[id] = cached.bands
        if (cached.warning) warnings[id] = cached.warning
        continue
      }

      const { path, band, ribbon, autoSize, warning, lineCount, bands, fitted } =
        computeTextPath(object, shapePath, member)
      cache.current.set(id, { key, path, band, ribbon, autoSize, warning, lineCount, bands, fitted })
      textPaths[id] = path
      bandPaths[id] = band
      ribbons[id] = ribbon
      autoSizes[id] = autoSize
      lineCounts[id] = lineCount
      rowBands[id] = bands
      if (warning) warnings[id] = warning
    }

    /*
     * A layout per state, for playback.
     *
     * The loop runs over every state, not only the one on show, so a transition
     * has the departing state's type to hold. Cached per state and keyed on the
     * fit's own inputs, so two states that set their type the same way — which
     * is most of them — solve once and share the answer.
     */
    for (const frameId of doc.objectOrder) {
      const frame = doc.objects[frameId]
      if (!frame || frame.kind !== 'frame') continue
      for (const member of frame.members) {
        if (member.object.kind !== 'typography') continue
        if (!isFontLoaded(member.object.font.fontId)) continue

        const perState: (FitOutcome | null)[] = []
        for (const state of frame.states) {
          const fitAs = withTypeSettings(member.object, valuesFor(member, state).typeSettings)
          const key = fitKey(fitAs, true)
          const seen = stateFits.current.get(key)
          if (seen !== undefined) {
            perState.push(seen)
            continue
          }
          const solved = fitObject(fitAs)
          const kept = solved.ok ? solved : null
          stateFits.current.set(key, kept)
          perState.push(kept)
        }
        fits[member.object.id] = perState
      }
    }

    return { textPaths, bandPaths, ribbons, autoSizes, warnings, lineCounts, rowBands, fits }
  }, [doc, states, fontLoaded, clipperReady, usedFonts, fontRevision])
}


function computeTextPath(
  object: TypographyObject,
  /** A frame state's own outline, when the member has been reshaped in one. */
  shapePath?: string,
  /** Whether to hand the solved fit back, which only a frame member needs. */
  keepFit = false,
): {
  path: string
  band: string
  ribbon: RibbonSlice[]
  autoSize: number
  warning: string | null
  lineCount: number
  bands: { top: number; bottom: number }[]
  fitted: FitOutcome | null
} {
  if (object.text.trim().length === 0) {
    return {
      path: '',
      band: '',
      ribbon: [],
      autoSize: 0,
      warning: null,
      lineCount: 1,
      bands: [],
      fitted: null,
    }
  }

  // Its font has not arrived yet. Silent rather than a warning: it is on its way
  // and a message would flash up for a few hundred milliseconds and vanish.
  if (!isFontLoaded(object.font.fontId)) {
    return {
      path: '',
      band: '',
      ribbon: [],
      autoSize: 0,
      warning: null,
      lineCount: 1,
      bands: [],
      fitted: null,
    }
  }

  const result = fitObject(object)

  if (!result.ok) {
    return {
      path: '',
      band: '',
      ribbon: [],
      autoSize: 0,
      warning: result.reason === 'empty-text' ? null : result.message,
      lineCount: 1,
      bands: [],
      fitted: null,
    }
  }

  /*
   * Heavy distortion is the medium here, not a fault, so it is not surfaced as a
   * warning. `FitResult.extremeDistortion` is still reported by the engine for
   * anything that wants to act on it. The only warning left is the one that
   * means the text genuinely cannot be shown: the container has no room.
   *
   * A grid with more rows than words used to warn here, because it switched
   * itself off and that looked identical to a grid that was broken. It no longer
   * switches off — a row with nothing to put in it is simply blank — so there is
   * nothing left to explain.
   */
  /*
   * Poured through the state's shape, when there is one.
   *
   * `result.path` is the type as the fit drew it — through the object's OWN
   * outline. A member reshaped in a frame is drawn through a different one, so
   * the type is re-emitted through a patch built at that outline while the fit's
   * layout, and therefore every line break, stays exactly as solved.
   *
   * Without this a morph bent the container and left the words behind: the shape
   * moved, the text path came back byte-identical, and since the type is what
   * you actually see, dragging a point looked like it did nothing at all.
   */
  const poured = shapePath ? repour(object, result, shapePath) : null

  return {
    path: poured?.path ?? result.path,
    band: poured?.bandPath ?? result.band ?? '',
    ribbon: poured?.ribbon ?? result.ribbon ?? [],
    autoSize: result.autoSize ?? 0,
    warning: null,
    lineCount: result.lineCount,
    bands: result.lines.map((line) => ({ top: line.rowTop, bottom: line.rowBottom })),
    fitted: keepFit ? result : null,
  }
}

/** The type at rest, emitted through a container the state supplies. */
function repour(object: TypographyObject, fitted: FitOutcome, shapePath: string) {
  // The fit is handed over rather than run again — `prepareFrames` would start
  // its own, and fitting twice per member on every state change is the whole
  // cost of this feature paid twice for nothing.
  const source = pourThrough(object, fitted, shapePath)
  return source ? frameAt(object, source, 0) : null
}
