import type { NodeId } from "@/core/doc/ids";
import type { MeshData, Node, SymbolItem } from "@/core/doc/types";
import { shownDisplay, stageSkinOf } from "@/core/doc/skins";
import { displaysOf } from "@/core/doc/displays";
import type { DeformTarget } from "./deform";

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

/** The mesh the Mesh tool edits on a node (ARCHITECTURE ▸ Meshes ▸ Skins'
 *  meshes): the one the stage shows at display `index` with `skins`, in the
 *  skin that fills it or the node's own, with its own deform keys
 *  (`deformKeysOf`). Null when the shown display is not a mesh of its own. */
export interface EditedMesh {
  mesh: MeshData;
  pivot: { x: number; y: number };
  index: number;
  skin: string | null;
}

export function editedMesh(sym: SymbolItem, node: Node, index: number, skins: readonly string[]): EditedMesh | null {
  const shown = index >= 0 ? shownDisplay(sym, node, index, skins) : null;
  if (!shown?.display.mesh) return null;
  return { mesh: shown.display.mesh, pivot: shown.display.pivot, index, skin: shown.skin };
}

/**
 * The mesh a node's Deform row shows and keys: the first of its displays the
 * stage shows with `skins` (display 0 first) that is a mesh of its own, in the
 * skin that fills it. Null for a node with none.
 */
export function deformRow(sym: SymbolItem, node: Node, skins: readonly string[] = stageSkinOf(sym)): { target: DeformTarget; mesh: MeshData } | null {
  const count = displaysOf(node).length;
  for (let i = 0; i < count; i++) {
    const shown = shownDisplay(sym, node, i, skins);
    if (shown?.display.mesh) return { target: { nodeId: node.id, skin: shown.skin, index: i }, mesh: shown.display.mesh };
  }
  return null;
}
