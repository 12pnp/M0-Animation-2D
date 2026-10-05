import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { DeformKey, MeshData, Node, PathShape } from "@/core/doc/types";
import { insidePolygon } from "@/core/mesh/makeMesh";
import { deformsWithPoint, deformsWithoutPoint, paintWeights, withPoint, withPointMoved, withoutPoint, withPositions, withWeights } from "@/core/mesh/meshEdit";
import { localDelta, type MeshBones, meshPositions } from "@/core/mesh/meshPose";
import { deformAt, withDeformKey } from "@/core/mesh/deform";
import { evaluateSymbol, type PoseEntry } from "@/core/doc/pose";
import { applyInverse, type Matrix2D } from "@/core/math/Matrix2D";
import { SetDeformKeys, SetMesh } from "@/core/history/meshCommands";
import { boxEdit, EditNode } from "@/core/history/attachmentCommands";
import { withKnotMoved } from "@/core/doc/constraints";
import { editedMesh, type EditedMesh } from "@/core/mesh/meshPlan";
import { stageSkinOf } from "@/core/doc/skins";
import { boxWeightsWithPoint, entryOutline, roundMoved, inPolygon, outlineAsMesh, outlineWeighted, outlineWeightsKept, withBoxPoint, withOutlinePoints, withoutBoxPoint } from "@/core/doc/boxes";
import type { AnimId, ItemId } from "@/core/doc/ids";

/** What the overlay draws for the Mesh tool: the mesh it edits and the picked points. */
export const meshView: { node: NodeId | null; picked: Set<number> } = { node: null, picked: new Set() };

/** Screen pixels within which a press picks a point. */
const PICK = 7;

type Drag =
  | { kind: "box"; start: { x: number; y: number }; base: NonNullable<Node["box"]>; world: Matrix2D; bones?: MeshBones; started: boolean }
  | { kind: "path"; start: { x: number; y: number }; base: PathShape; world: Matrix2D; bones?: MeshBones; started: boolean }
  | { kind: "move"; start: { x: number; y: number }; base: MeshData; world: Matrix2D; bones?: MeshBones; started: boolean; target: EditedMesh }
  | { kind: "deform"; start: { x: number; y: number }; base: DeformKey[]; offsets: number[]; world: Matrix2D; bones?: MeshBones; started: boolean }
  | { kind: "paint"; started: boolean };

/**
 * The Mesh tool (ARCHITECTURE ▸ Meshes), on the selected node's mesh. A press
 * on a point picks it (⇧ adds); dragging moves the picked points, which in
 * Setup reshapes the mesh and in Animate keys a deform at the playhead.
 * In Setup a click inside the mesh adds a point and Delete removes the
 * picked ones. With the weight brush on (Properties ▸ Mesh) a drag paints
 * the chosen bone's weight. Every gesture is one undo step.
 */
export class MeshTool implements Tool {
  readonly id = "mesh";
  private drag: Drag | null = null;

  /** The selected box or path, or the selected node whose shown display is
   *  a mesh (`editedMesh`: a skin's, when a shown skin fills it). */
  private subject(ctx: ToolContext): { node: Node; entry: PoseEntry; target: EditedMesh | null } | null {
    const sym = ctx.store.currentSymbol;
    const pose = ctx.pose();
    let found: { node: Node; entry: PoseEntry; target: EditedMesh | null } | null = null;
    for (const node of ctx.store.selectedNodes) {
      const entry = pose?.byNode.get(node.id);
      if (!entry) continue;
      if (node.box || node.path) { found = { node, entry, target: null }; break; }
      const target = editedMesh(sym, node, entry.displayIndex, stageSkinOf(sym));
      if (target && entry.spine) { found = { node, entry, target }; break; }
    }
    if (!found || !sym.nodes[found.node.id]) {
      if (meshView.node) { meshView.node = null; meshView.picked.clear(); }
      return null;
    }
    if (meshView.node !== found.node.id) { meshView.node = found.node.id; meshView.picked.clear(); }
    return found;
  }

  /** The bones a weighted mesh, box or path follows, as the pose has them now. */
  private bones(ctx: ToolContext, node: Node, entry: PoseEntry, mesh?: MeshData): MeshBones | undefined {
    if (!mesh?.weights?.some((w) => w.length) && !outlineWeighted(node)) return undefined;
    const pose = ctx.pose()!;
    const setup = evaluateSymbol(ctx.store.currentSymbol, null, 0, "setup").byNode;
    return {
      now: (id) => pose.byNode.get(id)?.world,
      setup: (id) => setup.get(id)?.world,
      node: setup.get(node.id)?.world ?? entry.world,
    };
  }

  private pointAt(ctx: ToolContext, entry: PoseEntry, e: PointerEvent): number {
    const v = verticesOf(entry);
    const at = ctx.toContent(e);
    let best = -1, bestD = PICK;
    for (let i = 0; i < v.length / 2; i++) {
      const s = ctx.toScreen({ x: v[i * 2]!, y: v[i * 2 + 1]! });
      const d = Math.hypot(s.x - at.x, s.y - at.y);
      if (d <= bestD) { best = i; bestD = d; }
    }
    return best;
  }

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const store = ctx.store;
    const world = ctx.toWorld(e);
    const s = this.subject(ctx);
    if (!s) {
      const hit = ctx.hitTest(world.x, world.y) as NodeId | null;
      const hitNode = hit ? store.currentSymbol.nodes[hit] : undefined;
      const hitEntry = hit ? ctx.pose()?.byNode.get(hit) : undefined;
      if (hitNode && hitEntry && editedMesh(store.currentSymbol, hitNode, hitEntry.displayIndex, stageSkinOf(store.currentSymbol))) store.selectNodes([hit!]);
      else if (hit) ctx.notify("That image is not a mesh yet: Modify ▸ Mesh ▸ Make Mesh.");
      return;
    }
    const { node, entry } = s;
    if (node.box) { this.boxDown(ctx, node, entry, e, world); return; }
    if (node.path) {
      const i = this.pointAt(ctx, entry, e);
      if (i < 0) { meshView.picked.clear(); ctx.invalidate(); return; }
      if (e.shiftKey) { if (meshView.picked.has(i)) meshView.picked.delete(i); else meshView.picked.add(i); }
      else if (!meshView.picked.has(i)) meshView.picked = new Set([i]);
      ctx.invalidate();
      if (!e.shiftKey) this.drag = { kind: "path", start: world, base: node.path, world: entry.world, bones: this.bones(ctx, node, entry), started: false };
      return;
    }
    const target = s.target!;
    const paint = store.ui.meshPaint;
    if (paint.on && paint.bone) {
      this.drag = { kind: "paint", started: false };
      this.paint(ctx, node, entry, target, world);
      return;
    }
    const i = this.pointAt(ctx, entry, e);
    const animate = store.ui.mode === "animate" && !!store.currentAnimation;
    if (i >= 0) {
      if (e.shiftKey) { if (meshView.picked.has(i)) meshView.picked.delete(i); else meshView.picked.add(i); }
      else if (!meshView.picked.has(i)) meshView.picked = new Set([i]);
      ctx.invalidate();
      if (e.shiftKey) return;
      const bones = this.bones(ctx, node, entry, target.mesh);
      if (animate) {
        // Deform keys are the default skin's display 0's (ARCHITECTURE ▸ Meshes).
        if (!target.deforms) { ctx.notify("Only the image's first display in the default skin takes deform keys; reshape this one in Setup mode."); return; }
        const anim = store.currentAnimation!;
        const offsets = deformAt(anim, node.id, store.ui.frame) ?? new Array<number>(target.mesh.points.length).fill(0);
        this.drag = { kind: "deform", start: world, base: anim.deforms?.[node.id] ?? [], offsets, world: entry.world, bones, started: false };
      } else {
        this.drag = { kind: "move", start: world, base: target.mesh, world: entry.world, bones, started: false, target };
      }
      return;
    }
    if (!e.shiftKey) meshView.picked.clear();
    // Setup: a click inside the mesh adds a point there.
    if (!animate) {
      const local = { x: 0, y: 0 };
      if (!applyInverse(local, entry.world, world.x, world.y)) return;
      const px = local.x + target.pivot.x, py = local.y + target.pivot.y;
      const mesh = target.mesh;
      if (insidePolygon([...meshPositions(mesh)], mesh.hull, px, py)) {
        const next = withPoint(mesh, Math.round(px * 100) / 100, Math.round(py * 100) / 100);
        if (next) {
          store.apply(meshEdit("Add Mesh Point", store.currentSymbolId, node.id, target, next, target.deforms ? this.fittedDeforms(ctx, node.id, deformsWithPoint) : new Map()));
          meshView.picked = new Set([next.points.length / 2 - 1]);
          store.emit("stage");
        }
      }
    }
    ctx.invalidate();
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    const d = this.drag;
    if (!d) return;
    const s = this.subject(ctx);
    if (!s) return;
    const store = ctx.store;
    const world = ctx.toWorld(e);
    if (d.kind === "paint") { if (s.target) this.paint(ctx, s.node, s.entry, s.target, world); return; }
    const dx = world.x - d.start.x, dy = world.y - d.start.y;
    if (!d.started) {
      const a = ctx.toScreen(d.start), b = ctx.toScreen(world);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
      d.started = true;
      store.history.beginInteraction(d.kind === "move" ? "mesh.move" : d.kind === "box" ? "box.move" : d.kind === "path" ? "path.move" : "mesh.deform");
    }
    if (d.kind === "path") {
      const asMesh = outlineAsMesh(d.base);
      let shape = d.base;
      // A picked knot brings its handles; a handle picked with its knot moves once.
      const picked = [...meshView.picked].filter((v) => v % 3 === 1 || !meshView.picked.has(Math.floor(v / 3) * 3 + 1));
      for (const v of picked) {
        const l = localDelta(asMesh, v, d.world, d.bones, dx, dy);
        shape = withKnotMoved(shape, v, l.x, l.y);
      }
      // Only the points the drag moved are rounded, and only they drop the file's offsets.
      const { points, moved } = roundMoved(d.base.points, shape.points);
      const next = withOutlinePoints(shape, points, moved);
      store.apply(new EditNode("Move Path Points", store.currentSymbolId, s.node.id, (n) => ({ ...n, path: next }), "path.move"));
    } else if (d.kind === "box") {
      const points = [...d.base.points];
      const asMesh = outlineAsMesh(d.base);
      for (const i of meshView.picked) {
        const l = localDelta(asMesh, i, d.world, d.bones, dx, dy);
        points[i * 2] = Math.round((d.base.points[i * 2]! + l.x) * 100) / 100;
        points[i * 2 + 1] = Math.round((d.base.points[i * 2 + 1]! + l.y) * 100) / 100;
      }
      store.apply(boxEdit("Move Box Points", store.currentSymbolId, s.node.id, withOutlinePoints(d.base, points, meshView.picked), "box.move"));
    } else if (d.kind === "move") {
      // An opened mesh's positions move alone; a mesh made here moves its texture coordinates with them.
      const base = meshPositions(d.base);
      const moved = [...base];
      for (const i of meshView.picked) {
        const l = localDelta(d.base, i, d.world, d.bones, dx, dy);
        moved[i * 2] = Math.round((base[i * 2]! + l.x) * 100) / 100;
        moved[i * 2 + 1] = Math.round((base[i * 2 + 1]! + l.y) * 100) / 100;
      }
      const next = withPositions(d.base, moved, meshView.picked);
      store.apply(meshEdit("Move Mesh Points", store.currentSymbolId, s.node.id, d.target, next, new Map(), "mesh.move"));
    } else {
      const offsets = [...d.offsets];
      for (const i of meshView.picked) {
        const l = localDelta(s.target!.mesh, i, d.world, d.bones, dx, dy);
        offsets[i * 2] = d.offsets[i * 2]! + l.x;
        offsets[i * 2 + 1] = d.offsets[i * 2 + 1]! + l.y;
      }
      const anim = store.currentAnimation!;
      store.apply(new SetDeformKeys("Deform", store.currentSymbolId, anim.id, s.node.id, withDeformKey(d.base, store.ui.frame, offsets), "mesh.deform"));
      store.emit("timeline");
    }
    store.emit("stage");
  }

  onPointerUp(_e: PointerEvent, ctx: ToolContext): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.started) return;
    const store = ctx.store;
    // A move ends with the triangles redone, so none is left turned over.
    if (d.kind === "move") {
      const s = this.subject(ctx);
      const mesh = s?.target?.mesh;
      if (s && mesh) store.apply(meshEdit("Move Mesh Points", store.currentSymbolId, s.node.id, s.target!, withPointMoved(mesh, 0, meshPositions(mesh)[0]!, meshPositions(mesh)[1]!), new Map(), "mesh.move"));
    }
    store.history.endInteraction();
    store.emit("stage");
  }

  onCancel(ctx: ToolContext): void {
    if (this.drag?.started) ctx.store.history.abortInteraction();
    this.drag = null;
  }

  onDeactivate(): void {
    meshView.node = null;
    meshView.picked.clear();
  }

  /** One dab of the weight brush, the radius in screen pixels. */
  private paint(ctx: ToolContext, node: Node, entry: PoseEntry, target: EditedMesh, world: { x: number; y: number }): void {
    const store = ctx.store;
    const { bone, radius, strength } = store.ui.meshPaint;
    const mesh = target.mesh;
    if (!bone) return;
    if (this.drag && !this.drag.started) { this.drag.started = true; store.history.beginInteraction("mesh.paint"); }
    // A mesh with no weights yet follows its own node, weight 1, at every point.
    const start = mesh.weights ?? mesh.points.filter((_, i) => i % 2 === 0).map(() => [[node.id, 1]] as Array<[NodeId, number]>);
    const weights = paintWeights(start, entry.spine!.vertices, world.x, world.y, radius / ctx.camera.screenScale, bone, strength);
    store.apply(meshEdit("Paint Weights", store.currentSymbolId, node.id, target, withWeights(mesh, weights), new Map(), "mesh.paint"));
    store.emit("stage");
  }

  /** A box (ARCHITECTURE ▸ Boxes and points): a press on a point picks it
   *  and drags; a click inside adds a point on the nearest edge. */
  private boxDown(ctx: ToolContext, node: Node, entry: PoseEntry, e: PointerEvent, world: { x: number; y: number }): void {
    const i = this.pointAt(ctx, entry, e);
    if (i >= 0) {
      if (e.shiftKey) { if (meshView.picked.has(i)) meshView.picked.delete(i); else meshView.picked.add(i); }
      else if (!meshView.picked.has(i)) meshView.picked = new Set([i]);
      ctx.invalidate();
      if (!e.shiftKey) this.drag = { kind: "box", start: world, base: node.box!, world: entry.world, bones: this.bones(ctx, node, entry), started: false };
      return;
    }
    meshView.picked.clear();
    const local = { x: 0, y: 0 };
    // Setup only for a weighted box: elsewhere its points are not where the node puts them.
    if (outlineWeighted(node) && ctx.store.ui.mode !== "setup") { ctx.invalidate(); return; }
    if (applyInverse(local, entry.world, world.x, world.y) && inPolygon(node.box!.points, local.x, local.y)) {
      const x = Math.round(local.x * 100) / 100, y = Math.round(local.y * 100) / 100;
      const points = withBoxPoint(node.box!.points, x, y);
      const at = points.findIndex((_, k) => k % 2 === 0 && points[k] === x && points[k + 1] === y) / 2;
      ctx.store.apply(boxEdit("Add Box Point", ctx.store.currentSymbolId, node.id, { points, ...boxWeightsWithPoint(node.box!, at) }));
      meshView.picked = new Set([at]);
      ctx.store.emit("stage");
    }
    ctx.invalidate();
  }

  /** Delete the picked points (Setup); false when there is nothing to delete. */
  deletePicked(ctx: ToolContext): boolean {
    const s = this.subject(ctx);
    if (s?.node.path && meshView.picked.size) {
      const knots = new Set([...meshView.picked].map((v) => Math.floor(v / 3)));
      const left = s.node.path.points.length / 6 - knots.size;
      if (left < 2) { ctx.notify("A path needs at least two knots."); return true; }
      const points = s.node.path.points.filter((_, k) => !knots.has(Math.floor(k / 6)));
      const kept = outlineWeightsKept(s.node.path, (i) => !knots.has(Math.floor(i / 3)));
      ctx.store.apply(new EditNode("Delete Path Knots", ctx.store.currentSymbolId, s.node.id, (n) => ({ ...n, path: { ...n.path!, points, ...kept } })));
      meshView.picked.clear();
      ctx.store.emit("stage");
      return true;
    }
    if (s?.node.box && meshView.picked.size) {
      let points: number[] | null = s.node.box.points;
      for (const i of [...meshView.picked].sort((a, b) => b - a)) points = points && withoutBoxPoint(points, i);
      if (!points) { ctx.notify("A bounding box needs at least three points."); return true; }
      const kept = outlineWeightsKept(s.node.box, (i) => !meshView.picked.has(i));
      ctx.store.apply(boxEdit("Delete Box Points", ctx.store.currentSymbolId, s.node.id, { points, ...kept }));
      meshView.picked.clear();
      ctx.store.emit("stage");
      return true;
    }
    if (!s?.target || !meshView.picked.size || ctx.store.ui.mode !== "setup") return false;
    let mesh: MeshData | null = s.target.mesh;
    let deforms = s.target.deforms ? this.fittedDeforms(ctx, s.node.id, (k) => k) : new Map<AnimId, DeformKey[]>();
    for (const i of [...meshView.picked].sort((a, b) => b - a)) {
      const next: MeshData | null = mesh ? withoutPoint(mesh, i) : null;
      if (!next) { ctx.notify("A mesh needs at least three points on its outline."); return true; }
      mesh = next;
      deforms = new Map([...deforms].map(([id, keys]) => [id, deformsWithoutPoint(keys, i)]));
    }
    ctx.store.apply(meshEdit("Delete Mesh Points", ctx.store.currentSymbolId, s.node.id, s.target, mesh!, deforms));
    meshView.picked.clear();
    ctx.store.emit("stage");
    return true;
  }

  /** Every animation's deform keys of `nodeId`, through `fit`. */
  private fittedDeforms(ctx: ToolContext, nodeId: NodeId, fit: (keys: DeformKey[]) => DeformKey[]): Map<AnimId, DeformKey[]> {
    return new Map(ctx.store.currentSymbol.animations.filter((a) => a.deforms?.[nodeId]?.length).map((a) => [a.id, fit(a.deforms![nodeId]!)]));
  }
}

/** A `SetMesh` on the mesh `target` names: its display, in its skin. */
function meshEdit(label: string, symbolId: ItemId, nodeId: NodeId, target: EditedMesh, mesh: MeshData, deforms: Map<AnimId, DeformKey[]>, kind?: string): SetMesh {
  return new SetMesh(label, symbolId, nodeId, target.index, mesh, deforms, kind, target.skin);
}

/** The world points the tool picks among: a mesh's as drawn, a box's through its node. */
export function verticesOf(entry: PoseEntry): number[] {
  if (entry.spine) return entry.spine.vertices;
  return entryOutline(entry);
}
