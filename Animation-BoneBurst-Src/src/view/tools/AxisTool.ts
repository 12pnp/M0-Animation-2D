import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { Point } from "@/core/math/geom";
import { type Transform, quantize } from "@/core/math/Transform";
import { applyEdit, transformAtFrame } from "@/app/TimelineOps";
import { axisDirections, constrainToAxis, scaleFactors, sweptAngle } from "@/core/math/axes";
import { moveBy, rotateAbout } from "@/core/doc/transformOps";
import { hitAt } from "./SelectTool";
import { type EditBase, captureEditBase, finishEdit } from "./axisEdit";

export type AxisToolKind = "rotate" | "translate" | "scale" | "shear";

/**
 * Spine's transform tools, from the stage toolbar: Rotate, Translate, Scale
 * and Shear. Click picks (as the Selection tool does); a drag ANYWHERE acts on
 * the selection, about each node's own origin, so a bone can be turned without
 * grabbing it. Shift: 15° steps for Rotate and Shear, one axis for Translate
 * (the toolbar's axes), uniform for Scale. A click on nothing deselects.
 *
 * Every step goes through `finishEdit` (Pixels, Bones / Images compensation)
 * and `applyEdit`, so Setup writes the rest pose and Animate keys, like any drag.
 */
export class AxisTool implements Tool {
  readonly showsGizmo = false;

  private base: EditBase | null = null;
  private start: Point = { x: 0, y: 0 };
  private startContent: Point = { x: 0, y: 0 };
  private state: "none" | "pressed" | "dragging" = "none";
  private pressedEmpty = false;
  /** Rotate / Shear: the angle swept so far, unwrapped past ±180°. */
  private swept = 0;
  private lastPointer: Point = { x: 0, y: 0 };
  private touched = new Set<NodeId>();

  constructor(readonly id: AxisToolKind) {}

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.start = ctx.toWorld(e);
    this.lastPointer = this.start;
    this.startContent = ctx.toContent(e);
    this.swept = 0;
    const hit = hitAt(ctx, this.start.x, this.start.y);
    this.pressedEmpty = !hit;
    if (hit) {
      if (e.shiftKey) ctx.store.toggleNode(hit);
      else if (!ctx.store.selection.nodes.includes(hit)) ctx.store.selectNodes([hit]);
    }
    this.base = captureEditBase(ctx);
    this.state = "pressed";
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (this.state === "none" || !this.base) return;
    const now = ctx.toWorld(e);
    if (this.state === "pressed") {
      const c = ctx.toContent(e);
      if (Math.hypot(c.x - this.startContent.x, c.y - this.startContent.y) < 3) return;
      if (this.base.snaps.length === 0) return;
      this.state = "dragging";
      if (this.id === "translate") ctx.beginSnap(this.base.snaps.map((s) => s.id));
      ctx.store.history.beginInteraction("node.transform");
    }

    const snaps = this.base.snaps;
    const first = snaps[0]!;
    const origin = (s: typeof first): Point => ({ x: s.world.tx, y: s.world.ty });
    if (this.id === "rotate" || this.id === "shear") {
      this.swept += sweptAngle(origin(first), this.lastPointer, now);
    }
    this.lastPointer = now;
    const angle = e.shiftKey ? Math.round(this.swept / 15) * 15 : this.swept;

    const next = new Map<NodeId, Transform>();
    if (this.id === "translate") {
      let d = { x: now.x - this.start.x, y: now.y - this.start.y };
      if (e.shiftKey) {
        const axes = ctx.store.prefs.value.gizmos.axes;
        d = constrainToAxis(d, axisDirections(axes, first.world, first.parent));
      }
      const snapped = ctx.snapDelta(d.x, d.y, e.metaKey || e.ctrlKey);
      for (const s of snaps) next.set(s.id, moveBy(s, snapped.dx, snapped.dy));
    } else {
      for (const s of snaps) {
        if (this.id === "rotate") next.set(s.id, rotateAbout(s, origin(s), angle));
        else if (this.id === "shear") next.set(s.id, { ...s.local, skewX: s.local.skewX + angle });
        else {
          const f = scaleFactors(origin(s), s.world, this.start, now, e.shiftKey);
          next.set(s.id, {
            ...s.local,
            scaleX: nonZero(s.local.scaleX * f.sx),
            scaleY: nonZero(s.local.scaleY * f.sy),
          });
        }
      }
    }
    const edit = finishEdit(ctx.store, this.base, next);
    for (const id of edit.keys()) this.touched.add(id);
    applyEdit(ctx.store, edit, true);
    ctx.invalidate();
  }

  onPointerUp(e: PointerEvent, ctx: ToolContext): void {
    if (this.state === "dragging") {
      ctx.endSnap();
      // Quantise once on commit, as the other tools do, so files stay stable.
      const next = new Map<NodeId, Transform>();
      for (const id of this.touched) {
        const n = ctx.store.node(id);
        if (n) next.set(id, quantize(transformAtFrame(ctx.store, n)));
      }
      applyEdit(ctx.store, next, true);
      ctx.store.history.endInteraction();
    } else if (this.state === "pressed" && this.pressedEmpty && !e.shiftKey) {
      ctx.store.clearSelection();
    }
    this.reset(ctx);
  }

  onCancel(ctx: ToolContext): void {
    if (this.state === "dragging") {
      ctx.endSnap();
      ctx.store.history.abortInteraction();
    }
    this.reset(ctx);
  }

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const w = ctx.toWorld(e);
    ctx.setCursor(hitAt(ctx, w.x, w.y) || ctx.store.selection.nodes.length ? CURSORS[this.id] : "");
  }

  private reset(ctx: ToolContext): void {
    this.state = "none";
    this.base = null;
    this.touched.clear();
    ctx.invalidate();
  }
}

const CURSORS: Record<AxisToolKind, string> = {
  rotate: "alias",
  translate: "move",
  scale: "nwse-resize",
  shear: "ew-resize",
};

/** A scale of exactly 0 cannot be inverted, and every child would vanish. */
function nonZero(v: number): number {
  return Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
}
