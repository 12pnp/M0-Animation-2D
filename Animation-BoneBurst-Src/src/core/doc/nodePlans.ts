import type { NodeId } from "./ids";
import type { Node, SymbolItem } from "./types";

/**
 * What a command on the selected nodes takes, decided here so the menu that
 * enables it and the command that runs agree.
 */

/** The nodes Swap Instance changes: images, symbol instances and empty
 *  layers (swapping an empty one is how it stops being empty). Bones,
 *  groups, boxes, points and paths show no library item. */
export function swapTargets(sym: SymbolItem, ids: readonly NodeId[]): NodeId[] {
  return ids.filter((id) => {
    const k = sym.nodes[id]?.kind;
    return k === "image" || k === "symbol" || k === "empty";
  });
}

/** Bind to Bone: exactly one bone selected, bound to by everything else
 *  selected. Null when the selection is not that. */
export function bindPlan(nodes: readonly Node[]): { boneId: NodeId; ids: NodeId[]; name: string } | null {
  const bones = nodes.filter((n) => n.kind === "bone");
  const rest = nodes.filter((n) => n.kind !== "bone");
  if (bones.length !== 1 || rest.length === 0) return null;
  return { boneId: bones[0]!.id, ids: rest.map((n) => n.id), name: bones[0]!.name };
}
