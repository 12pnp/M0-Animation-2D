import { displaysOf, withLink } from "@/core/doc/displays";
import { EditNode } from "@/core/history/attachmentCommands";
import { meshPositions } from "@/core/mesh/meshPose";
import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import { isImage, type MeshData } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { traceContour } from "@/core/atlas/contour";
import { boxOutline, makeMesh } from "@/core/mesh/makeMesh";
import { autoWeights, type BoneSegment, withWeights } from "@/core/mesh/meshEdit";
import { bindPlan, meshableNodes, meshNodes } from "@/core/mesh/meshPlan";
import { evaluateSymbol } from "@/core/doc/pose";
import { apply } from "@/core/math/Matrix2D";
import { DRAWN_BONE_LENGTH } from "@/core/doc/bonePath";
import { SetMesh } from "@/core/history/meshCommands";

/** Points about this many pixels apart: an image's shorter side in sixths,
 *  at least 8. */
export function meshSpacing(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) / 6));
}

/** Modify ▸ Make Mesh: each selected image as a mesh from its alpha outline
 *  (the whole rectangle when nothing is opaque, or no pixels to read). One
 *  undo step. `ids`: these nodes instead of the selection. */
export function doMakeMesh(store: Store, assets: AssetStore | null, ids?: readonly NodeId[], label = "Make Mesh", spacing?: number): number {
  const sym = store.currentSymbol;
  ids = meshableNodes(sym, ids ?? store.selection.nodes);
  if (!ids.length) return 0;
  store.transaction(label, () => {
    for (const id of ids) {
      const node = sym.nodes[id]!;
      const item = store.project.items[node.itemId!];
      if (!isImage(item)) continue;
      const pixels = assets?.pixels(item.assetId);
      const contour = pixels ? traceContour(pixels.data, pixels.width, pixels.height, { stride: 4, tolerance: 2 }) : null;
      const outline = contour && contour.points.length >= 6 ? contour.points : boxOutline(item.width, item.height);
      store.apply(new SetMesh(label, sym.id, id, 0, makeMesh(outline, spacing ?? meshSpacing(item.width, item.height), item.width, item.height)));
    }
  });
  store.emit("stage");
  return ids.length;
}

/** Modify ▸ Remove Mesh: the selected meshes back to images, their deform keys gone. */
export function doRemoveMesh(store: Store): number {
  const sym = store.currentSymbol;
  const ids = meshNodes(sym, store.selection.nodes);
  if (!ids.length) return 0;
  store.transaction("Remove Mesh", () => {
    for (const id of ids) {
      const deforms = new Map(sym.animations.filter((a) => a.deforms?.[id]).map((a) => [a.id, []]));
      store.apply(new SetMesh("Remove Mesh", sym.id, id, 0, undefined, deforms));
      // Its linked images draw as plain images again.
      const linked = displaysOf(sym.nodes[id]!).flatMap((d, i) => (d.linked?.to === 0 ? [i] : []));
      if (linked.length) store.apply(new EditNode("Remove Mesh", sym.id, id, (n) => linked.reduce((m, i) => withLink(m, i, undefined), n)));
    }
  });
  store.emit("stage");
  return ids.length;
}

/**
 * Modify ▸ Bind Mesh to Bones: the selected mesh follows the selected bones,
 * each point weighted to the two nearest at the setup pose (`autoWeights`).
 * The refusal, when the selection is not one mesh and some bones.
 */
export function doBindMesh(store: Store, selection: readonly NodeId[] = store.selection.nodes, label = "Bind Mesh"): string | null {
  const sym = store.currentSymbol;
  const plan = bindPlan(sym, selection);
  if ("refused" in plan) return plan.refused;
  const node = sym.nodes[plan.mesh]!;
  const mesh = node.mesh!;
  const setup = evaluateSymbol(sym, null, 0, "setup").byNode;
  const nodeWorld = setup.get(plan.mesh)?.world;
  if (!nodeWorld) return "The mesh is not on the stage.";
  const world = meshPositions(mesh).flatMap((v, i, a) => {
    if (i % 2) return [];
    const p = apply({ x: 0, y: 0 }, nodeWorld, v - node.pivot.x, a[i + 1]! - node.pivot.y);
    return [p.x, p.y];
  });
  const segments: BoneSegment[] = plan.bones.flatMap((id) => {
    const w = setup.get(id)?.world;
    if (!w) return [];
    const len = sym.nodes[id]!.boneLength ?? DRAWN_BONE_LENGTH;
    const tip = apply({ x: 0, y: 0 }, w, len, 0);
    return [{ id, x0: w.tx, y0: w.ty, x1: tip.x, y1: tip.y }];
  });
  const bound: MeshData = withWeights(mesh, autoWeights(world, segments, 2));
  store.apply(new SetMesh(label, sym.id, plan.mesh, 0, bound));
  store.emit("stage");
  return null;
}

/** Modify ▸ Unbind Mesh: the selected meshes follow their own node again. */
export function doUnbindMesh(store: Store): number {
  const sym = store.currentSymbol;
  const ids = meshNodes(sym, store.selection.nodes).filter((id) => sym.nodes[id]!.mesh!.weights);
  if (!ids.length) return 0;
  store.transaction("Unbind Mesh", () => {
    for (const id of ids) {
      store.apply(new SetMesh("Unbind Mesh", sym.id, id, 0, withWeights(sym.nodes[id]!.mesh!, undefined)));
    }
  });
  store.emit("stage");
  return ids.length;
}

