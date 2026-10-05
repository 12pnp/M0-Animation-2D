import type { Store } from "@/app/Store";
import type { Pose } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import { transformAtFrame } from "@/app/TimelineOps";
import { type ChildState, compensateChildren } from "@/core/doc/compensate";
import { mat, mul } from "@/core/math/Matrix2D";
import { type Transform, toMatrix } from "@/core/math/Transform";
import type { NodeSnapshot } from "@/core/doc/transformOps";
import { selectionSnapshots } from "./selection";

/**
 * What an edit from the stage toolbar starts from: the selection, and the
 * direct children compensation may have to hold in place. Taken once, when a
 * drag or a field edit begins, like every other transform tool's snapshot.
 */
export interface EditBase {
  snaps: NodeSnapshot[];
  children: ChildState[];
}

export function captureEditBase(ctx: { store: Store; pose(): Pose | null }): EditBase {
  const snaps = selectionSnapshots(ctx);
  const pose = ctx.pose();
  const sym = ctx.store.currentSymbol;
  const locked = new Set(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
  const editing = new Set(snaps.map((s) => s.id));
  const children: ChildState[] = [];
  if (pose) {
    for (const n of Object.values(sym.nodes)) {
      if (!n.parentId || !editing.has(n.parentId) || editing.has(n.id) || locked.has(n.id)) continue;
      const entry = pose.byNode.get(n.id);
      if (!entry) continue;
      children.push({
        id: n.id, parentId: n.parentId, isBone: n.kind === "bone",
        world: entry.world, local: transformAtFrame(ctx.store, n),
      });
    }
  }
  return { snaps, children };
}

/**
 * The edit to apply: the selection's new transforms, rounded to whole pixels
 * when Pixels is on, plus the children the Bones / Images toggles hold still.
 */
export function finishEdit(store: Store, base: EditBase, next: Map<NodeId, Transform>): Map<NodeId, Transform> {
  const g = store.prefs.value.gizmos;
  const out = new Map(next);
  if (g.snapPixels) {
    for (const [id, t] of out) out.set(id, { ...t, x: Math.round(t.x), y: Math.round(t.y) });
  }
  if (g.compensateBones || g.compensateImages) {
    const parentsNow = new Map<NodeId, ReturnType<typeof mat>>();
    for (const s of base.snaps) {
      const t = out.get(s.id);
      if (t) parentsNow.set(s.id, mul(mat(), s.parent, toMatrix(mat(), t)));
    }
    const held = compensateChildren(base.children, parentsNow,
      { bones: g.compensateBones, images: g.compensateImages });
    for (const [id, t] of held) out.set(id, t);
  }
  return out;
}
