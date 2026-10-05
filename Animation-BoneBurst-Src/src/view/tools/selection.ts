import type { ToolContext } from "./Tool";
import { shownDisplay } from "@/core/doc/pose";
import { transformAtFrame } from "@/app/TimelineOps";
import { mat } from "@/core/math/Matrix2D";
import { type NodeSnapshot, snapshotOf, editTargets } from "@/core/doc/transformOps";

/**
 * A snapshot of every node a drag on the selection moves: the topmost
 * selected ones, minus locked layers. Every transform tool starts from these.
 */
export function selectionSnapshots(ctx: Pick<ToolContext, "store" | "pose">): NodeSnapshot[] {
  const pose = ctx.pose();
  if (!pose) return [];
  const sym = ctx.store.currentSymbol;
  const snaps: NodeSnapshot[] = [];
  const ids = editTargets(sym, ctx.store.selection.nodes);
  for (const id of ids) {
    const entry = pose.byNode.get(id);
    const node = sym.nodes[id];
    if (!entry || !node) continue;
    const parentEntry = node.parentId ? pose.byNode.get(node.parentId) : undefined;
    const shown = shownDisplay(entry);
    snaps.push(snapshotOf(
      id, transformAtFrame(ctx.store, node), entry.world, parentEntry?.world ?? mat(),
      shown.pivot, shown.index,
    ));
  }
  return snaps;
}
