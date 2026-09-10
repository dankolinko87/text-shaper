import type { TypographyObject } from '../types/document'

/**
 * Every input that changes the fitted result — and nothing else.
 *
 * The settings groups are SERIALIZED rather than listed field by field, and that
 * is the whole point of this shape. Listing them meant the list had to be
 * remembered every time the model grew, and it was not: `splitAngle` was added
 * to `RunSettings`, wired through the panel and the fit, and left out of here —
 * so the slider moved, the document changed, and the canvas kept handing back
 * the cached artwork. A stale cache is a miserable bug to be given, because
 * everything the user can see says the control is simply broken.
 *
 * Serializing cannot fail that way: a field nobody thought about still lands in
 * the key. The cost is the odd unnecessary refit — two documents can hold the
 * same settings in a different key order — and an unnecessary refit is a slower
 * frame, where a missed one is wrong artwork.
 */
export function fitKey(object: TypographyObject, fontReady: boolean): string {
  return [
    // Whether the font had arrived, because the answer changes the result: not
    // yet means an empty path. Left out, the empty path cached during the wait
    // was still valid once the font landed, and the shape stayed blank.
    fontReady,
    // The outline is not serialized — it is a path string that can run to tens
    // of kilobytes, and every edit to it bumps the revision anyway.
    object.geometryRevision,
    object.currentSourcePath.length,
    object.text,
    object.textFlowMode,
    object.fittingMode,
    object.seed,
    // The banner is geometry, not just a colour: turning it on is what makes
    // the fit produce a path for it at all. The rest of `appearance` is paint,
    // which the renderer applies to a path this does not have to re-solve.
    object.appearance.lineFill === null,
    settingsKey(object.font),
    settingsKey(object.typography),
    settingsKey(object.run),
    settingsKey(object.distortion),
    // Dividers are a list rather than a settings group, so they are spelled out.
    object.dividers.length,
    object.dividers.map((d) => `${d.axis ?? 'row'}:${d.points.map((p) => `${p.x},${p.y}`).join(';')}`).join('|'),
  ].join('|')
}

/**
 * One settings group as a key, in an order that does not depend on the object.
 *
 * Sorted, because insertion order survives `JSON.stringify` and a document
 * rebuilt by a migration can hold the same settings in a different order. That
 * would only ever cost an extra fit, never a missed one, but a key that changes
 * when nothing has changed is a confusing thing to debug later.
 */
function settingsKey(settings: object): string {
  return Object.keys(settings)
    .sort()
    .map((key) => `${key}=${String((settings as Record<string, unknown>)[key])}`)
    .join(',')
}
