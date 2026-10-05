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
import { bindPlan, meshTargets, type ShownIndex, shownMeshes } from "@/core/mesh/meshPlan";
import { stageSkinOf } from "@/core/doc/skins";
import { deformKeysOf } from "@/core/mesh/deform";
import { displayAtFrame } from "./TimelineOps";
import { evaluateSymbol } from "@/core/doc/pose";
import { apply } from "@/core/math/Matrix2D";
import { DRAWN_BONE_LENGTH } from "@/core/doc/bonePath";
import { SetMesh } from "@/core/history/meshCommands";

/** Points about this many pixels apart: an image's shorter side in sixths,
 *  at least 8. */
export function meshSpacing(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) / 6));
}

/** What the stage shows (ARCHITECTURE ▸ Meshes): its skins, and each node's
 *  display at the playhead. The mesh commands act on that image. */
export function shownOn(store: Store): { skins: string[]; indexOf: ShownIndex } {
  return { skins: stageSkinOf(store.currentSymbol), indexOf: (n) => displayAtFrame(store, n).index };
}

/** Modify ▸ Make Mesh: the image each selected layer shows, a skin's
 *  included (`meshTargets`), as a mesh from its alpha outline (the whole
 *  rectangle when nothing is opaque, or no pixels to read). One undo step.
 *  `ids`: these nodes instead of the selection. */
export function doMakeMesh(store: Store, assets: AssetStore | null, ids?: readonly NodeId[], label = "Make Mesh", spacing?: number): number {
  const sym = store.currentSymbol;
  const { skins, indexOf } = shownOn(store);
  const targets = meshTargets(sym, ids ?? store.selection.nodes, skins, indexOf);
  if (!targets.length) return 0;
  store.transaction(label, () => {
    for (const t of targets) {
      const item = store.project.items[t.itemId];
      if (!isImage(item)) continue;
      const pixels = assets?.pixels(item.assetId);
      const contour = pixels ? traceContour(pixels.data, pixels.width, pixels.height, { stride: 4, tolerance: 2 }) : null;
      const outline = contour && contour.points.length >= 6 ? contour.points : boxOutline(item.width, item.height);
      store.apply(new SetMesh(label, sym.id, t.nodeId, t.index, makeMesh(outline, spacing ?? meshSpacing(item.width, item.height), item.width, item.height), new Map(), undefined, t.skin));
    }
  });
  store.emit("stage");
  return targets.length;
}

/** Modify ▸ Remove Mesh: the meshes the selected layers show back to images,
 *  their deform keys gone. */
export function doRemoveMesh(store: Store): number {
  const sym = store.currentSymbol;
  const { skins, indexOf } = shownOn(store);
  const meshes = shownMeshes(sym, store.selection.nodes, skins, indexOf);
  if (!meshes.length) return 0;
  store.transaction("Remove Mesh", () => {
    for (const m of meshes) {
      const target = { nodeId: m.nodeId, skin: m.skin, index: m.index };
      const deforms = new Map(sym.animations.filter((a) => deformKeysOf(a, target)?.length).map((a) => [a.id, []]));
      store.apply(new SetMesh("Remove Mesh", sym.id, m.nodeId, m.index, undefined, deforms, undefined, m.skin));
      // Its linked images draw as plain images again.
      if (m.skin) continue;
      const linked = displaysOf(sym.nodes[m.nodeId]!).flatMap((d, i) => (d.linked?.to === m.index && !d.linked.skin ? [i] : []));
      if (linked.length) store.apply(new EditNode("Remove Mesh", sym.id, m.nodeId, (n) => linked.reduce((x, i) => withLink(x, i, undefined), n)));
    }
  });
  store.emit("stage");
  return meshes.length;
}

/**
 * Modify ▸ Bind Mesh to Bones: the selected mesh follows the selected bones,
 * each point weighted to the two nearest at the setup pose (`autoWeights`).
 * The refusal, when the selection is not one mesh and some bones.
 */
export function doBindMesh(store: Store, selection: readonly NodeId[] = store.selection.nodes, label = "Bind Mesh"): string | null {
  const sym = store.currentSymbol;
  const { skins, indexOf } = shownOn(store);
  const plan = bindPlan(sym, selection, skins, indexOf);
  if ("refused" in plan) return plan.refused;
  const target = shownMeshes(sym, [plan.mesh], skins, indexOf)[0]!;
  const mesh = target.mesh;
  const setup = evaluateSymbol(sym, null, 0, "setup").byNode;
  const nodeWorld = setup.get(plan.mesh)?.world;
  if (!nodeWorld) return "The mesh is not on the stage.";
  const world = meshPositions(mesh).flatMap((v, i, a) => {
    if (i % 2) return [];
    const p = apply({ x: 0, y: 0 }, nodeWorld, v - target.pivot.x, a[i + 1]! - target.pivot.y);
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
  store.apply(new SetMesh(label, sym.id, plan.mesh, target.index, bound, new Map(), undefined, target.skin));
  store.emit("stage");
  return null;
}

/** Modify ▸ Unbind Mesh: the selected meshes follow their own node again. */
export function doUnbindMesh(store: Store): number {
  const sym = store.currentSymbol;
  const { skins, indexOf } = shownOn(store);
  const meshes = shownMeshes(sym, store.selection.nodes, skins, indexOf).filter((m) => m.mesh.weights);
  if (!meshes.length) return 0;
  store.transaction("Unbind Mesh", () => {
    for (const m of meshes) {
      store.apply(new SetMesh("Unbind Mesh", sym.id, m.nodeId, m.index, withWeights(m.mesh, undefined), new Map(), undefined, m.skin));
    }
  });
  store.emit("stage");
  return meshes.length;
}

