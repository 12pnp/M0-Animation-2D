import type { NodeId } from "@/core/doc/ids";
import type { SymbolItem } from "@/core/doc/types";

/**
 * Which nodes the mesh commands act on (ARCHITECTURE ▸ Meshes), pure.
 */

/** Selected image nodes Make Mesh can turn into meshes: an image of its own
 *  (not an opened file's attachment, which stays the file's), no mesh yet. */
export function meshableNodes(sym: SymbolItem, selection: readonly NodeId[]): NodeId[] {
  return selection.filter((id) => {
    const n = sym.nodes[id];
    return !!n && n.kind === "image" && !!n.itemId && !n.attachment && !n.mesh;
  });
}

/** Selected nodes that have a mesh (display 0). */
export function meshNodes(sym: SymbolItem, selection: readonly NodeId[]): NodeId[] {
  return selection.filter((id) => !!sym.nodes[id]?.mesh);
}

/** The mesh to bind and the bones to bind it to, from the selection: one
 *  mesh node and at least one bone; or why not. */
export function bindPlan(sym: SymbolItem, selection: readonly NodeId[]): { mesh: NodeId; bones: NodeId[] } | { refused: string } {
  const meshes = meshNodes(sym, selection);
  const bones = selection.filter((id) => sym.nodes[id]?.kind === "bone");
  if (meshes.length !== 1) return { refused: "Select one mesh and the bones it is to follow." };
  if (!bones.length) return { refused: "Select the bones the mesh is to follow too (⇧-click them)." };
  return { mesh: meshes[0]!, bones };
}
