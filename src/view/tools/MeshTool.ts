import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { DeformKey, MeshData, Node, PathShape } from "@/core/doc/types";
import { insidePolygon } from "@/core/mesh/makeMesh";
import { deformsWithPoint, deformsWithoutPoint, paintWeights, withPoint, withPointMoved, withoutPoint } from "@/core/mesh/meshEdit";
import { localDelta, type MeshBones } from "@/core/mesh/meshPose";
import { deformAt, withDeformKey } from "@/core/mesh/deform";
import { evaluateSymbol, type PoseEntry } from "@/core/doc/pose";
import { apply, applyInverse, type Matrix2D } from "@/core/math/Matrix2D";
import { SetDeformKeys, SetMesh } from "@/core/history/meshCommands";
import { boxEdit, EditNode } from "@/core/history/attachmentCommands";
import { withKnotMoved } from "@/core/doc/constraints";
import { inPolygon, withBoxPoint, withoutBoxPoint } from "@/core/doc/boxes";
import type { AnimId } from "@/core/doc/ids";

/** What the overlay draws for the Mesh tool: the mesh it edits and the picked points. */
export const meshView: { node: NodeId | null; picked: Set<number> } = { node: null, picked: new Set() };

/** Screen pixels within which a press picks a point. */
const PICK = 7;

type Drag =
  | { kind: "box"; start: { x: number; y: number }; base: number[]; world: Matrix2D; started: boolean }
  | { kind: "path"; start: { x: number; y: number }; base: PathShape; world: Matrix2D; started: boolean }
  | { kind: "move"; start: { x: number; y: number }; base: MeshData; world: Matrix2D; bones?: MeshBones; started: boolean }
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

  private subject(ctx: ToolContext): { node: Node; entry: PoseEntry } | null {
    const sym = ctx.store.currentSymbol;
    const node = ctx.store.selectedNodes.find((n) => n.mesh || n.box || n.path) ?? null;
    const entry = node ? ctx.pose()?.byNode.get(node.id) : undefined;
    if (!node || !entry || (node.mesh && !entry.spine)) {
      if (meshView.node) { meshView.node = null; meshView.picked.clear(); }
      return null;
    }
    if (meshView.node !== node.id) { meshView.node = node.id; meshView.picked.clear(); }
    return sym.nodes[node.id] ? { node, entry } : null;
  }

  /** The bones a weighted mesh follows, as the pose has them now. */
  private bones(ctx: ToolContext, node: Node, entry: PoseEntry): MeshBones | undefined {
    if (!node.mesh?.weights?.some((w) => w.length)) return undefined;
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
      if (hit && store.currentSymbol.nodes[hit]?.mesh) store.selectNodes([hit]);
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
      if (!e.shiftKey) this.drag = { kind: "path", start: world, base: node.path, world: entry.world, started: false };
      return;
    }
    const paint = store.ui.meshPaint;
    if (paint.on && paint.bone) {
      this.drag = { kind: "paint", started: false };
      this.paint(ctx, node, entry, world);
      return;
    }
    const i = this.pointAt(ctx, entry, e);
    const animate = store.ui.mode === "animate" && !!store.currentAnimation;
    if (i >= 0) {
      if (e.shiftKey) { if (meshView.picked.has(i)) meshView.picked.delete(i); else meshView.picked.add(i); }
      else if (!meshView.picked.has(i)) meshView.picked = new Set([i]);
      ctx.invalidate();
      if (e.shiftKey) return;
      const bones = this.bones(ctx, node, entry);
      if (animate) {
        const anim = store.currentAnimation!;
        const offsets = deformAt(anim, node.id, store.ui.frame) ?? new Array<number>(node.mesh!.points.length).fill(0);
        this.drag = { kind: "deform", start: world, base: anim.deforms?.[node.id] ?? [], offsets, world: entry.world, bones, started: false };
      } else {
        this.drag = { kind: "move", start: world, base: node.mesh!, world: entry.world, bones, started: false };
      }
      return;
    }
    if (!e.shiftKey) meshView.picked.clear();
    // Setup: a click inside the mesh adds a point there.
    if (!animate) {
      const local = { x: 0, y: 0 };
      if (!applyInverse(local, entry.world, world.x, world.y)) return;
      const px = local.x + node.pivot.x, py = local.y + node.pivot.y;
      const mesh = node.mesh!;
      if (insidePolygon(mesh.points, mesh.hull, px, py)) {
        const next = withPoint(mesh, Math.round(px * 100) / 100, Math.round(py * 100) / 100);
        if (next) {
          store.apply(new SetMesh("Add Mesh Point", store.currentSymbolId, node.id, 0, next, this.fittedDeforms(ctx, node.id, deformsWithPoint)));
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
    if (d.kind === "paint") { this.paint(ctx, s.node, s.entry, world); return; }
    const dx = world.x - d.start.x, dy = world.y - d.start.y;
    if (!d.started) {
      const a = ctx.toScreen(d.start), b = ctx.toScreen(world);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
      d.started = true;
      store.history.beginInteraction(d.kind === "move" ? "mesh.move" : d.kind === "box" ? "box.move" : d.kind === "path" ? "path.move" : "mesh.deform");
    }
    if (d.kind === "path") {
      const l = localDelta(BOX_AS_MESH, 0, d.world, undefined, dx, dy);
      let shape = d.base;
      // A picked knot brings its handles; a handle picked with its knot moves once.
      const picked = [...meshView.picked].filter((v) => v % 3 === 1 || !meshView.picked.has(Math.floor(v / 3) * 3 + 1));
      for (const v of picked) shape = withKnotMoved(shape, v, l.x, l.y);
      const rounded = { ...shape, points: shape.points.map((v) => Math.round(v * 100) / 100) };
      store.apply(new EditNode("Move Path Points", store.currentSymbolId, s.node.id, (n) => ({ ...n, path: rounded }), "path.move"));
    } else if (d.kind === "box") {
      const points = [...d.base];
      const l = localDelta(BOX_AS_MESH, 0, d.world, undefined, dx, dy);
      for (const i of meshView.picked) {
        points[i * 2] = Math.round((d.base[i * 2]! + l.x) * 100) / 100;
        points[i * 2 + 1] = Math.round((d.base[i * 2 + 1]! + l.y) * 100) / 100;
      }
      store.apply(boxEdit("Move Box Points", store.currentSymbolId, s.node.id, points, "box.move"));
    } else if (d.kind === "move") {
      const points = [...d.base.points];
      for (const i of meshView.picked) {
        const l = localDelta(d.base, i, d.world, d.bones, dx, dy);
        points[i * 2] = Math.round((d.base.points[i * 2]! + l.x) * 100) / 100;
        points[i * 2 + 1] = Math.round((d.base.points[i * 2 + 1]! + l.y) * 100) / 100;
      }
      store.apply(new SetMesh("Move Mesh Points", store.currentSymbolId, s.node.id, 0, { ...d.base, points }, new Map(), "mesh.move"));
    } else {
      const offsets = [...d.offsets];
      for (const i of meshView.picked) {
        const l = localDelta(s.node.mesh!, i, d.world, d.bones, dx, dy);
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
      const mesh = s?.node.mesh;
      if (s && mesh) store.apply(new SetMesh("Move Mesh Points", store.currentSymbolId, s.node.id, 0, withPointMoved(mesh, 0, mesh.points[0]!, mesh.points[1]!), new Map(), "mesh.move"));
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
  private paint(ctx: ToolContext, node: Node, entry: PoseEntry, world: { x: number; y: number }): void {
    const store = ctx.store;
    const { bone, radius, strength } = store.ui.meshPaint;
    const mesh = node.mesh!;
    if (!bone) return;
    if (this.drag && !this.drag.started) { this.drag.started = true; store.history.beginInteraction("mesh.paint"); }
    // A mesh with no weights yet follows its own node, weight 1, at every point.
    const start = mesh.weights ?? mesh.points.filter((_, i) => i % 2 === 0).map(() => [[node.id, 1]] as Array<[NodeId, number]>);
    const weights = paintWeights(start, entry.spine!.vertices, world.x, world.y, radius / ctx.camera.screenScale, bone, strength);
    store.apply(new SetMesh("Paint Weights", store.currentSymbolId, node.id, 0, { ...mesh, weights }, new Map(), "mesh.paint"));
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
      if (!e.shiftKey) this.drag = { kind: "box", start: world, base: [...node.box!.points], world: entry.world, started: false };
      return;
    }
    meshView.picked.clear();
    const local = { x: 0, y: 0 };
    if (applyInverse(local, entry.world, world.x, world.y) && inPolygon(node.box!.points, local.x, local.y)) {
      const points = withBoxPoint(node.box!.points, Math.round(local.x * 100) / 100, Math.round(local.y * 100) / 100);
      ctx.store.apply(boxEdit("Add Box Point", ctx.store.currentSymbolId, node.id, points));
      meshView.picked = new Set([points.findIndex((_, k) => k % 2 === 0 && points[k] === Math.round(local.x * 100) / 100 && points[k + 1] === Math.round(local.y * 100) / 100) / 2]);
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
      ctx.store.apply(new EditNode("Delete Path Knots", ctx.store.currentSymbolId, s.node.id, (n) => ({ ...n, path: { ...n.path!, points } })));
      meshView.picked.clear();
      ctx.store.emit("stage");
      return true;
    }
    if (s?.node.box && meshView.picked.size) {
      let points: number[] | null = s.node.box.points;
      for (const i of [...meshView.picked].sort((a, b) => b - a)) points = points && withoutBoxPoint(points, i);
      if (!points) { ctx.notify("A bounding box needs at least three points."); return true; }
      ctx.store.apply(boxEdit("Delete Box Points", ctx.store.currentSymbolId, s.node.id, points));
      meshView.picked.clear();
      ctx.store.emit("stage");
      return true;
    }
    if (!s || !meshView.picked.size || ctx.store.ui.mode !== "setup") return false;
    let mesh: MeshData | null = s.node.mesh!;
    let deforms = this.fittedDeforms(ctx, s.node.id, (k) => k);
    for (const i of [...meshView.picked].sort((a, b) => b - a)) {
      const next: MeshData | null = mesh ? withoutPoint(mesh, i) : null;
      if (!next) { ctx.notify("A mesh needs at least three points on its outline."); return true; }
      mesh = next;
      deforms = new Map([...deforms].map(([id, keys]) => [id, deformsWithoutPoint(keys, i)]));
    }
    ctx.store.apply(new SetMesh("Delete Mesh Points", ctx.store.currentSymbolId, s.node.id, 0, mesh!, deforms));
    meshView.picked.clear();
    ctx.store.emit("stage");
    return true;
  }

  /** Every animation's deform keys of `nodeId`, through `fit`. */
  private fittedDeforms(ctx: ToolContext, nodeId: NodeId, fit: (keys: DeformKey[]) => DeformKey[]): Map<AnimId, DeformKey[]> {
    return new Map(ctx.store.currentSymbol.animations.filter((a) => a.deforms?.[nodeId]?.length).map((a) => [a.id, fit(a.deforms![nodeId]!)]));
  }
}

/** An unweighted stand-in, so `localDelta` maps a box's drag through its node. */
const BOX_AS_MESH: MeshData = { width: 1, height: 1, points: [0, 0], triangles: [], hull: 0 };

/** The world points the tool picks among: a mesh's as drawn, a box's through its node. */
export function verticesOf(entry: PoseEntry): number[] {
  if (entry.spine) return entry.spine.vertices;
  const p = entry.node.box?.points ?? entry.node.path?.points ?? [];
  const out = new Array<number>(p.length), q = { x: 0, y: 0 };
  for (let i = 0; i < p.length; i += 2) {
    apply(q, entry.world, p[i]!, p[i + 1]!);
    out[i] = q.x; out[i + 1] = q.y;
  }
  return out;
}
