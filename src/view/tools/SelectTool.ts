import type { Tool, ToolContext } from "./Tool";
import { boneRow } from "@/core/doc/boneRow";
import type { NodeId } from "@/core/doc/ids";
import { shownDisplay } from "@/core/doc/pose";
import { rectFromPoints } from "@/core/math/geom";
import { applyEdit, transformAtFrame } from "@/app/TimelineOps";
import { moveBy, type NodeSnapshot, snapshotOf, topmostSelected } from "./transformOps";
import type { Transform } from "@/core/math/Transform";
import { quantize } from "@/core/math/Transform";
import { mat } from "@/core/math/Matrix2D";
import { pickBone } from "./boneGeom";
import { BakeDrag, HandleDrag, PathDrag, pathPick } from "./pathDrag";

/**
 * The Selection tool: click to select, drag to move, marquee on empty space.
 * Scaling, rotating and skewing live on the Free Transform tool (Q), as in
 * Flash.
 */
export class SelectTool implements Tool {
  readonly id = "select";

  private mode: "none" | "maybeDrag" | "dragging" | "marquee" = "none";
  private startWorld = { x: 0, y: 0 };
  private startContent = { x: 0, y: 0 };
  private snaps: NodeSnapshot[] = [];
  private additive = false;
  /** A press on a bone path's dot: it handles the gesture to the end. */
  private path: PathDrag | null = null;
  private handle: HandleDrag | BakeDrag | null = null;

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.startWorld = ctx.toWorld(e);
    this.startContent = ctx.toContent(e);
    this.additive = e.shiftKey;

    // Path handles and dots before artwork and bones: they sit on the bone's
    // tip, where the limb's artwork is.
    const pick = pathPick(ctx, this.startWorld);
    if (pick && "handle" in pick) {
      const { handle } = pick;
      this.handle = handle.bake
        ? new BakeDrag(ctx, { ...handle, bake: handle.bake }, this.startWorld)
        : new HandleDrag(ctx, handle, this.startWorld);
      return;
    }
    if (pick) {
      this.path = new PathDrag(ctx, pick.dot.id, pick.dot.frame, pick.dot, this.startWorld, e);
      return;
    }

    const hit = hitAt(ctx, this.startWorld.x, this.startWorld.y);
    if (hit) {
      const already = ctx.store.selection.nodes.includes(hit);
      if (e.shiftKey) {
        ctx.store.toggleNode(hit);
      } else if (!already) {
        ctx.store.selectNodes([hit]);
      }
      // Locked layers can be clicked but not dragged.
      if (this.captureSnapshots(ctx)) this.mode = "maybeDrag";
      return;
    }

    if (!e.shiftKey) ctx.store.clearSelection();
    this.mode = "marquee";
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (this.path || this.handle) {
      this.path?.move(e, ctx.toWorld(e));
      this.handle?.move(ctx.toWorld(e));
      ctx.invalidate();
      return;
    }
    if (this.mode === "none") return;
    const world = ctx.toWorld(e);
    const content = ctx.toContent(e);

    if (this.mode === "marquee") {
      ctx.setMarquee(rectFromPoints(this.startContent.x, this.startContent.y, content.x, content.y));
      ctx.invalidate();
      return;
    }

    const dx = world.x - this.startWorld.x;
    const dy = world.y - this.startWorld.y;

    if (this.mode === "maybeDrag") {
      const moved = Math.hypot(content.x - this.startContent.x, content.y - this.startContent.y);
      if (moved < 3) return;
      this.mode = "dragging";
      ctx.beginSnap(this.snaps.map((s) => s.id));
      ctx.store.history.beginInteraction("node.transform");
    }

    // Shift constrains to the dominant axis, as in Flash.
    let mx = dx, my = dy;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0;
    }

    // Snapping, unless ⌘/Ctrl is held — the standard way to ask for the raw
    // delta for the length of one drag without touching the setting.
    const snapped = ctx.snapDelta(mx, my, e.metaKey || e.ctrlKey);
    mx = snapped.dx; my = snapped.dy;

    const next = new Map<NodeId, Transform>();
    for (const s of this.snaps) next.set(s.id, moveBy(s, mx, my));
    applyEdit(ctx.store, next, true);
    ctx.invalidate();
  }

  onPointerUp(e: PointerEvent, ctx: ToolContext): void {
    if (this.path || this.handle) {
      this.path?.up(e);
      this.handle?.up(ctx.toWorld(e));
      this.path = null;
      this.handle = null;
      ctx.invalidate();
      return;
    }
    if (this.mode === "marquee") {
      const content = ctx.toContent(e);
      const r = rectFromPoints(this.startContent.x, this.startContent.y, content.x, content.y);
      ctx.setMarquee(null);
      if (r.w > 3 || r.h > 3) {
        ctx.store.selectNodes(ctx.nodesInRect(r, unpickable(ctx)) as NodeId[], this.additive);
      }
    }
    ctx.endSnap();
    if (this.mode === "dragging") {
      // Quantise once on commit so golden files stay stable without the drag
      // feeling sticky.
      const next = new Map<NodeId, Transform>();
      for (const s of this.snaps) {
        const n = ctx.store.node(s.id);
        if (n) next.set(s.id, quantize(transformAtFrame(ctx.store, n)));
      }
      applyEdit(ctx.store, next, true);
      ctx.store.history.endInteraction();
    }
    this.mode = "none";
    this.snaps = [];
    ctx.invalidate();
  }

  onCancel(ctx: ToolContext): void {
    this.path?.cancel();
    this.handle?.cancel();
    this.path = null;
    this.handle = null;
    ctx.endSnap();
    if (this.mode === "dragging") ctx.store.history.abortInteraction();
    this.mode = "none";
    this.snaps = [];
    ctx.setMarquee(null);
    ctx.invalidate();
  }

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const w = ctx.toWorld(e);
    ctx.setCursor(pathPick(ctx, w) ? "pointer" : hitAt(ctx, w.x, w.y) ? "move" : "");
  }

  /** Returns false when nothing draggable is selected. */
  private captureSnapshots(ctx: ToolContext): boolean {
    this.snaps = selectionSnapshots(ctx);
    return this.snaps.length > 0;
  }
}

/**
 * A snapshot of every node a drag on the selection moves: the topmost
 * selected ones, minus locked layers. Every transform tool starts from these.
 */
export function selectionSnapshots(ctx: Pick<ToolContext, "store" | "pose">): NodeSnapshot[] {
  const pose = ctx.pose();
  if (!pose) return [];
  const sym = ctx.store.currentSymbol;
  const lockedNodes = new Set(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
  const snaps: NodeSnapshot[] = [];
  const ids = topmostSelected(
    ctx.store.selection.nodes.filter((id) => !lockedNodes.has(id)),
    (id) => sym.nodes[id]?.parentId,
  );
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

/**
 * Alpha-accurate pick that also skips hidden and locked layers.
 *
 * An IK target under the pointer wins over artwork. The target sits on the
 * effector's tip, which is exactly where the hand or foot artwork is, and the
 * artwork hit test ignores bones — so pressing on the target handle used to
 * pick up the hand instead, and moving or rotating it keyed a deformation on
 * the hand while the target stayed put.
 */
export function hitAt(ctx: ToolContext, wx: number, wy: number): NodeId | null {
  const sym = ctx.store.currentSymbol;
  const g = ctx.store.prefs.value.gizmos;
  const skip = unpickable(ctx);
  const pose = ctx.pose();
  const showBones = ctx.store.ui.showBones;
  if (pose && (showBones || g.showPrimary)) {
    const targets = new Set<string>(sym.ik.map((k) => k.targetId));
    const p = { x: wx, y: wy };
    if (showBones && targets.size && g.showIk && g.selectIk) {
      const target = pickBone(pose, p, 10 / ctx.camera.screenScale,
        (id) => targets.has(id) && !skip.has(id));
      if (target) return target;
    }
    // A bone wins over the artwork under it only close to its line, so the
    // art around a bone stays clickable.
    // A primary bone follows the Primary row, the rest the Bones row.
    const bones = { pick: g.selectBones, show: showBones, name: false };
    const primary = { pick: g.selectPrimary, show: g.showPrimary, name: false };
    const bone = pickBone(pose, p, BONE_PICK_PX / ctx.camera.screenScale,
      (id) => !targets.has(id) && !skip.has(id) && boneRow(!!sym.nodes[id]?.primary, bones, primary).pick);
    if (bone) return bone;
  }
  return ctx.hitTest(wx, wy, skip) as NodeId | null;
}

/** Screen pixels from a bone's line within which a click picks the bone. */
const BONE_PICK_PX = 5;

/**
 * What no pointer gesture may pick: hidden and locked layers, and every
 * image or symbol while the visibility table makes images unselectable (or
 * hides them).
 */
export function unpickable(ctx: ToolContext): Set<string> {
  const sym = ctx.store.currentSymbol;
  const g = ctx.store.prefs.value.gizmos;
  const skip = new Set<string>(
    sym.layers.filter((l) => l.locked || !l.visible).map((l) => l.nodeId),
  );
  if (!g.selectImages || !g.showImages) {
    for (const n of Object.values(sym.nodes)) if (n.kind !== "bone") skip.add(n.id);
  }
  return skip;
}
