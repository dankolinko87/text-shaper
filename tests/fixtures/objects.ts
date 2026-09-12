import type {
  LetterMosaicObject,
  MeshObject,
  TextShaperDocument,
  TypographyObject,
} from '../../src/types/document'

/**
 * Reaching into a document for an object of a known kind.
 *
 * Objects come in two kinds now, so `doc.objects[id]` is a union and every test
 * that wants a typography object's settings has to say so. A helper that throws
 * beats a cast: a cast would let a test keep passing while quietly reading the
 * wrong kind of object, which is the failure the discriminator exists to stop.
 */
export function shapeIn(doc: TextShaperDocument, id: string): TypographyObject {
  const object = doc.objects[id]
  if (!object) throw new Error(`no object ${id}`)
  if (object.kind !== 'typography') throw new Error(`${id} is a ${object.kind}, not a shape`)
  return object
}

export function mosaicIn(doc: TextShaperDocument, id: string): LetterMosaicObject {
  const object = doc.objects[id]
  if (!object) throw new Error(`no object ${id}`)
  if (object.kind !== 'mosaic') throw new Error(`${id} is a ${object.kind}, not a mosaic`)
  return object
}

export function meshIn(doc: TextShaperDocument, id: string): MeshObject {
  const object = doc.objects[id]
  if (!object) throw new Error(`no object ${id}`)
  if (object.kind !== 'mesh') throw new Error(`${id} is a ${object.kind}, not a mesh`)
  return object
}
