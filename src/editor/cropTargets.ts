import type { CropSurface, CropTarget } from '../state/cropModel'
import { useUiStore } from '../state/uiStore'
import { frameTargetFor } from './memberEdits'

/**
 * A crop target from where the panel stands: the object, the surface, the
 * state on show — and the frame, if the object is a member of one, since the
 * store cannot read where the panel is standing.
 */
export function cropTargetFor(
  objectId: string,
  surface: CropSurface,
  stateIndex: number,
  leafIds?: readonly string[],
): CropTarget {
  const member = frameTargetFor(objectId)
  const target: CropTarget = { objectId, surface, stateIndex: member ? member.at : stateIndex }
  if (leafIds) target.leafIds = [...leafIds]
  if (member) target.member = { frameId: member.frameId, memberId: member.memberId }
  return target
}

/** Enter the crop mode for a target, replacing whatever was being cropped. */
export function beginCrop(target: CropTarget): void {
  useUiStore.getState().setCroppingPaint(target)
}
