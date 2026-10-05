import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import { createLayer, createNode } from "@/core/doc/defaults";
import { attachmentPlan, outlineField, outlineSkin, skinnedOutline } from "@/core/doc/boxes";
import { stageSkinOf } from "@/core/doc/skins";
import { SetSkinOutline } from "@/core/history/skinCommands";
import { isImage } from "@/core/doc/types";
import { AddNode } from "@/core/history/commands";
import { type ConstraintField, EditNode, SetConstraintList, SetSequenceKeys } from "@/core/history/attachmentCommands";
import { newPathConstraint, newPhysics, newSlider, pathThrough } from "@/core/doc/constraints";
import { uniqueNodeName } from "@/core/doc/boxes";
import { evaluateSymbol } from "@/core/doc/pose";
import { apply, applyInverse } from "@/core/math/Matrix2D";
import { type AnimId, newCnId } from "@/core/doc/ids";
import { sequenceFor } from "@/core/doc/sequence";
import type { NodeId } from "@/core/doc/ids";
import type { Node, SequenceKey, SymbolItem } from "@/core/doc/types";
import { traceContour } from "@/core/atlas/contour";

/**
 * A bounding box or point added (ARCHITECTURE ▸ Boxes and points), one undo
 * step, where `attachmentPlan` puts it; selected afterwards. A box made on a
 * picture takes the picture's outline from its alpha.
 */
export function doAddAttachment(store: Store, assets: AssetStore | null, kind: "box" | "point"): void {
  const sym = store.currentSymbol;
  const selected = store.selectedNodes.length === 1 ? store.selectedNodes[0]! : null;
  const item = selected?.itemId ? store.project.items[selected.itemId] : undefined;
  let outline: number[] | null = null;
  if (kind === "box" && isImage(item)) {
    const pixels = assets?.pixels(item.assetId);
    const contour = pixels ? traceContour(pixels.data, pixels.width, pixels.height, { stride: 4, tolerance: 2 }) : null;
    if (contour && contour.points.length >= 6) outline = contour.points;
  }
  const plan = attachmentPlan(sym, kind, selected, outline, isImage(item) ? { w: item.width, h: item.height } : undefined);
  const node = createNode(kind, plan.name, { parentId: plan.parentId });
  node.bind = plan.bind;
  if (plan.points) node.box = { points: plan.points };
  store.apply(new AddNode(kind === "box" ? "Add Bounding Box" : "Add Point", sym.id, node, createLayer(node.id, node.name, sym.layers.length), plan.layerIndex));
  store.selectNodes([node.id]);
  store.emit("stage");
}

/**
 * Display 0 of `nodeId` made a sequence of the library images numbered like
 * its own (`sequenceFor`); the reason when it cannot be.
 */
export function doMakeSequence(store: Store, nodeId: NodeId): string | null {
  const node = store.currentSymbol.nodes[nodeId];
  if (!node?.itemId || node.mesh) return node?.mesh ? "A mesh cannot be a sequence here; remove the mesh first." : "Pick an image layer.";
  const seq = sequenceFor(store.project, node.itemId);
  if (typeof seq === "string") return seq;
  store.apply(new EditNode("Make Sequence", store.currentSymbolId, nodeId, (n) => ({ ...n, itemId: seq.items[0]!, sequence: seq })));
  store.emit("stage");
  return null;
}

/** Back to one image, the one the setup showed; its keys go too. */
export function doRemoveSequence(store: Store, nodeId: NodeId): void {
  const sym = store.currentSymbol;
  const node = sym.nodes[nodeId];
  if (!node?.sequence) return;
  const shown = node.sequence.items[node.sequence.setup ?? 0]!;
  store.transaction("Remove Sequence", () => {
    store.apply(new EditNode("Remove Sequence", sym.id, nodeId, (n) => { const { sequence: _s, ...rest } = n; return { ...rest, itemId: shown }; }));
    for (const anim of sym.animations) if (anim.sequences?.[nodeId]) store.apply(new SetSequenceKeys("Remove Sequence", sym.id, anim.id, nodeId, []));
  });
  store.emit("stage");
  store.emit("timeline");
}

/** The image the setup pose shows. */
export function doSetSequenceSetup(store: Store, nodeId: NodeId, setup: number): void {
  const node = store.currentSymbol.nodes[nodeId];
  if (!node?.sequence) return;
  const at = Math.max(0, Math.min(node.sequence.items.length - 1, Math.round(setup)));
  store.apply(new EditNode("Sequence Setup Frame", store.currentSymbolId, nodeId, (n) => {
    const { setup: _old, ...rest } = n.sequence!;
    return { ...n, sequence: at ? { ...rest, setup: at } : rest };
  }, "sequence.setup"));
  store.emit("stage");
}

/** A node's sequence keys in the current animation, as they are to be. */
export function doSetSequenceKeys(store: Store, nodeId: NodeId, keys: SequenceKey[], label: string, kind?: string): void {
  const anim = store.currentAnimation;
  if (!anim) return;
  store.apply(new SetSequenceKeys(label, store.currentSymbolId, anim.id, nodeId, keys, kind));
  store.emit("timeline");
  store.emit("stage");
}

/** A symbol's physics, slider or path constraints as they are to be. */
export function doSetConstraints<F extends ConstraintField>(store: Store, field: F, list: NonNullable<SymbolItem[F]>, label: string, kind?: string): void {
  store.apply(new SetConstraintList(label, store.currentSymbolId, field, list, kind));
  store.emit("stage");
  store.emit("doc");
}

export function doAddPhysics(store: Store, boneId: NodeId): void {
  const sym = store.currentSymbol;
  doSetConstraints(store, "physics", [...(sym.physics ?? []), newPhysics(sym, boneId, newCnId())], "Add Physics");
}

/** A slider playing `animId`, driven by `boneId`'s rotation (or by time). */
export function doAddSlider(store: Store, animId: AnimId, boneId: NodeId | null): void {
  const sym = store.currentSymbol;
  const anim = sym.animations.find((a) => a.id === animId);
  const seconds = anim ? (anim.endsAtLastFrame ? anim.duration - 1 : anim.duration) / store.project.frameRate : 1;
  doSetConstraints(store, "sliders", [...(sym.sliders ?? []), newSlider(sym, animId, boneId, newCnId(), seconds)], "Add Slider");
}

/**
 * `boneIds` made to follow a new path node: a smooth curve through their
 * origins and the last one's tip at the setup pose, under the first bone's
 * parent (outside the chain, which the path moves). One undo step.
 */
export function doMakePath(store: Store, boneIds: readonly NodeId[]): string | null {
  const sym = store.currentSymbol;
  // Root first, as a chain runs, whatever order they were picked in.
  const depth = (n: Node) => { let d = 0; for (let p = n.parentId; p; p = sym.nodes[p]?.parentId ?? null) d++; return d; };
  const bones = boneIds.map((id) => sym.nodes[id]).filter((n): n is Node => !!n).sort((a, b) => depth(a) - depth(b));
  if (!bones.length) return "Select the bones to follow the path.";
  boneIds = bones.map((b) => b.id);
  const setup = evaluateSymbol(sym, null, 0, "setup", null).byNode;
  const parentId = bones[0]!.parentId && !boneIds.includes(bones[0]!.parentId) ? bones[0]!.parentId : null;
  const parent = parentId ? setup.get(parentId)?.world : undefined;
  const knots: number[] = [];
  const toParent = (x: number, y: number) => {
    const q = { x, y };
    if (parent) applyInverse(q, parent, x, y);
    knots.push(q.x, q.y);
  };
  for (const b of bones) { const w = setup.get(b.id)!.world; toParent(w.tx, w.ty); }
  const last = bones[bones.length - 1]!;
  const tip = apply({ x: 0, y: 0 }, setup.get(last.id)!.world, Math.max(1, last.boneLength ?? 40), 0);
  toParent(tip.x, tip.y);
  const node = createNode("path", uniqueNodeName(sym, `${bones[0]!.name}_path`), { parentId });
  node.path = pathThrough(knots);
  store.transaction("Make Path", () => {
    store.apply(new AddNode("Make Path", sym.id, node, createLayer(node.id, node.name, sym.layers.length), 0));
    doSetConstraints(store, "paths", [...(sym.paths ?? []), newPathConstraint(sym, boneIds, node.id, newCnId())], "Make Path");
  });
  store.selectNodes([node.id]);
  return null;
}

/**
 * An edit of the box, point or path the stage shows on `nodeId`: a shown
 * skin's own (`outlineSkin`), else the node's. `edit` gets and returns the
 * node as the stage shows it; one undo step, merged by `kind`.
 */
export function editShownOutline(store: Store, nodeId: NodeId, edit: (n: Node) => Node, label: string, kind?: string): void {
  const sym = store.currentSymbol;
  const node = sym.nodes[nodeId];
  const field = node ? outlineField(node.kind) : null;
  if (!node || !field) return;
  const skin = outlineSkin(sym, node, stageSkinOf(sym));
  if (!skin) { store.apply(new EditNode(label, store.currentSymbolId, nodeId, edit, kind)); return; }
  const next = edit(skinnedOutline(sym, node, [skin]));
  const value = field === "point" ? next.point ?? { x: 0, y: 0, rotation: 0 } : next[field];
  store.apply(new SetSkinOutline(label, store.currentSymbolId, skin, nodeId, { [field]: value }, kind));
}
