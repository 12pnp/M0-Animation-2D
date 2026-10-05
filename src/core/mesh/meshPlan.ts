import type { ItemId, NodeId } from "@/core/doc/ids";
import type { MeshData, Node, SymbolItem } from "@/core/doc/types";
import { shownDisplay, stageSkinOf } from "@/core/doc/skins";
import { displaysOf } from "@/core/doc/displays";
import type { DeformTarget } from "./deform";

/**
 * Which nodes the mesh commands act on (ARCHITECTURE ▸ Meshes), pure.
 */

/** Which display of a node the stage shows (its index at the playhead). */
export type ShownIndex = (node: Node) => number;

/**
 * Where Make Mesh puts a mesh on each selected node: the image the stage
 * shows (display `indexOf(node)`, in the last of `skins` that fills it, else
 * the node's own) when it is an image of its own, not yet a mesh, a link, a
 * sequence or an opened file's attachment, which stays the file's.
 */
export function meshTargets(
  sym: SymbolItem, selection: readonly NodeId[], skins: readonly string[] = [], indexOf: ShownIndex = () => 0,
): Array<{ nodeId: NodeId; index: number; skin: string | null; itemId: ItemId }> {
  return selection.flatMap((id) => {
    const n = sym.nodes[id];
    if (!n || n.kind !== "image" || !n.itemId) return [];
    const index = indexOf(n);
    const shown = shownDisplay(sym, n, index, skins);
    const d = shown?.display;
    if (!d || d.mesh || d.linked || d.sequence || d.attachment) return [];
    return [{ nodeId: id, index, skin: shown!.skin, itemId: d.itemId }];
  });
}

/** Selected image nodes Make Mesh can turn into meshes (`meshTargets`). */
export function meshableNodes(sym: SymbolItem, selection: readonly NodeId[], skins: readonly string[] = [], indexOf: ShownIndex = () => 0): NodeId[] {
  return meshTargets(sym, selection, skins, indexOf).map((t) => t.nodeId);
}

/** The meshes the stage shows on the selected nodes (`editedMesh`): what
 *  Remove Mesh, Bind and Unbind act on. */
export function shownMeshes(
  sym: SymbolItem, selection: readonly NodeId[], skins: readonly string[] = [], indexOf: ShownIndex = () => 0,
): Array<EditedMesh & { nodeId: NodeId }> {
  return selection.flatMap((id) => {
    const n = sym.nodes[id];
    const m = n ? editedMesh(sym, n, indexOf(n), skins) : null;
    return m ? [{ ...m, nodeId: id }] : [];
  });
}

/** Selected nodes that show a mesh of their own (`shownMeshes`). */
export function meshNodes(sym: SymbolItem, selection: readonly NodeId[], skins: readonly string[] = [], indexOf: ShownIndex = () => 0): NodeId[] {
  return shownMeshes(sym, selection, skins, indexOf).map((m) => m.nodeId);
}

/** The mesh to bind and the bones to bind it to, from the selection: one
 *  mesh node and at least one bone; or why not. */
export function bindPlan(
  sym: SymbolItem, selection: readonly NodeId[], skins: readonly string[] = [], indexOf: ShownIndex = () => 0,
): { mesh: NodeId; bones: NodeId[] } | { refused: string } {
  const meshes = meshNodes(sym, selection, skins, indexOf);
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
