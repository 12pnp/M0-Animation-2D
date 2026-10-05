/**
 * Compensation (the stage toolbar's Bones / Images, as in Spine): transform a
 * node and leave its children where they are on the stage.
 *
 * Only DIRECT children need it: a grandchild follows its parent, which now
 * stays put. Each one is re-expressed under its parent's new world matrix —
 * the same `reexpress` that re-parenting uses — so the result is an ordinary
 * local transform, written (or keyed) like any other.
 */

import type { NodeId } from "./ids";
import type { Matrix2D } from "@/core/math/Matrix2D";
import type { Transform } from "@/core/math/Transform";
import { reexpress } from "@/core/history/commands";

export interface ChildState {
  id: NodeId;
  parentId: NodeId;
  /** Bones under "Bones"; everything else (images, symbols…) under "Images". */
  isBone: boolean;
  /** Its world matrix when the edit began. */
  world: Matrix2D;
  /** Its local transform when the edit began. */
  local: Transform;
}

export interface Compensation { bones: boolean; images: boolean }

/**
 * New local transforms for the children that must not move, given the new
 * world matrices of the nodes being edited. A child that is itself being
 * edited is the caller's to move, not compensated here.
 */
export function compensateChildren(
  children: readonly ChildState[],
  parentsNow: ReadonlyMap<NodeId, Matrix2D>,
  on: Compensation,
): Map<NodeId, Transform> {
  const out = new Map<NodeId, Transform>();
  for (const c of children) {
    if (parentsNow.has(c.id)) continue;
    if (c.isBone ? !on.bones : !on.images) continue;
    const parent = parentsNow.get(c.parentId);
    if (!parent) continue;
    out.set(c.id, reexpress(c.world, parent, c.local));
  }
  return out;
}
