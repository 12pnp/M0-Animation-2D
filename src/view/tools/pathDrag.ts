import type { ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { Track } from "@/core/doc/types";
import { DRAWN_BONE_LENGTH, pathBoneIds } from "@/core/doc/bonePath";
import { seamFrame } from "@/core/doc/cycle";
import {
  type BakeFrame, bakePlan, type DragFrame, keyAt, pathDotAt, withBakedKeys, pathDragMode, type PathDragMode, type Point, rotateTo, rotateWithParentTo,
  shiftKeys, translateTo, withKeyTransform, withoutRedundantKeys,
} from "@/core/doc/pathEdit";
import { apply, invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { handleAt, type PathHandle, type Spline, splineAt, splineSegments, withSpline } from "@/core/doc/pathSpline";
import { quantize, type Transform } from "@/core/math/Transform";
import { type IkPathDrag, ikTargetFor, targetLocalAt, withTargetAt } from "@/core/doc/ikPathEdit";
import type { Pose } from "@/core/doc/pose";
import { posedSymbol } from "@/core/spine/spinePose";
import { EditTracks } from "@/core/history/timelineCommands";

/**
 * While a dot is held: the frame whose parent pose its path was drawn in. A
 * press moves the playhead to the dot's frame, and a path drawn relative to
 * the parent at the playhead would re-anchor under the pointer; the stage
 * keeps drawing it at this frame until the press ends.
 */
export let pathDragAnchor: number | null = null;

/** Screen pixels within which a press picks a path dot. */
const DOT_RADIUS = 7;

/** The path dot under a world point, if bone paths are drawn. */
export function pathDotUnder(ctx: ToolContext, world: Point) {
  const paths = ctx.bonePaths();
  return paths.length
    ? pathDotAt(paths, world.x, world.y, DOT_RADIUS / ctx.camera.screenScale, ctx.store.ui.frame)
    : null;
}

interface Moving {
  id: NodeId;
  frame: DragFrame;
  base: Track | undefined;
}

/**
 * A press on a bone's path (docs/CYCLE-PATH-PLAN.md, B5). A click puts the
 * playhead on that dot's frame. A drag re-keys the bone at that frame so the
 * dot follows the pointer, as `pathDragMode` decides; ⇧ moves every key of
 * the bone instead, ⌥ flips the bone's "with parent" option for this drag.
 * A bone the IK solves keys its target instead (`ikTargetFor`).
 * One undo step; keys the drag added and left redundant are removed on
 * release.
 */
export class PathDrag {
  private dragging = false;
  private mode: PathDragMode | "throughTarget" | null = null;
  /** Through the IK target: the constraint, the frame's pose at the press,
   *  and the last target that fitted (a knee pulled across stops there). */
  private ik: { drag: IkPathDrag; start: Pose; last: Transform } | null = null;
  private refused: string | null = null;
  private moving: Moving[] = [];
  private last: Point;
  private pressed: Point = { x: 0, y: 0 };
  /** Relative paths: a drawn point into the dragged frame's space. */
  private back: Matrix2D | null = null;

  constructor(
    private readonly ctx: ToolContext,
    id: NodeId,
    private readonly frame: number,
    private readonly dot: Point & { relativeAt?: number },
    private readonly startWorld: Point,
    e: PointerEvent,
  ) {
    this.last = dot;
    pathDragAnchor = dot.relativeAt ?? null;
    const store = ctx.store;
    // A selected picture shows its bone's path; keep it selected.
    if (!pathBoneIds(store.currentSymbol.nodes, store.selection.nodes).includes(id)) store.selectNodes([id]);
    store.setFrame(frame);

    const sym = store.currentSymbol;
    const anim = store.currentAnimation;
    const node = sym.nodes[id];
    if (!anim || !node) return;
    const which = store.prefs.value.gizmos.bonePathPoint;
    const withParent = (node.pathDrag === "parent") !== e.altKey;
    const rule = pathDragMode(sym, anim, id, which, withParent, frame);
    if ("refused" in rule) {
      this.refused = rule.refused;
      return;
    }
    this.mode = rule.mode;

    const pose = posedSymbol(store.project, sym, anim, frame, "animate");
    if (rule.mode === "throughTarget") {
      const k = sym.ik.find((c) => c.id === rule.ik.ik)!;
      const target = pose.byNode.get(k.targetId);
      const tparent = target?.node.parentId ? pose.byNode.get(target.node.parentId)?.world : undefined;
      if (!target) { this.mode = null; return; }
      this.ik = { drag: rule.ik, start: pose, last: target.local };
      this.moving.push({ id: k.targetId, frame: { local: target.local, world: target.world, parentWorld: tparent ?? mat(), length: 0 }, base: anim.tracks[k.targetId] });
    }
    const frameOf = (nid: NodeId, length: number): DragFrame | null => {
      const entry = pose.byNode.get(nid);
      const n = sym.nodes[nid];
      if (!entry || !n) return null;
      const parent = n.parentId ? pose.byNode.get(n.parentId)?.world : undefined;
      return { local: entry.local, world: entry.world, parentWorld: parent ?? mat(), length };
    };
    const length = which === "tip" && node.kind === "bone" ? node.boneLength ?? DRAWN_BONE_LENGTH : 0;
    const own = frameOf(id, length);
    if (!own) { this.mode = null; return; }
    // The dot's own point at the press, where the pointer's delta is measured from.
    this.pressed = apply({ x: 0, y: 0 }, own.world, length, 0);
    // A path drawn relative to the parent: a point drawn in the parent's pose
    // at `relativeAt` is in this frame's space through the parent's pose here.
    if (dot.relativeAt !== undefined) {
      const at = posedSymbol(store.project, sym, anim, dot.relativeAt, "animate");
      const atParent = node.parentId ? at.byNode.get(node.parentId)?.world : undefined;
      const inv = mat();
      if (atParent && invert(inv, atParent)) this.back = mul(mat(), own.parentWorld, inv);
    }
    if (this.ik) return;
    this.moving.push({ id, frame: own, base: anim.tracks[id] });
    if (this.mode === "rotateWithParent" && node.parentId) {
      const parent = frameOf(node.parentId, 0);
      if (parent) this.moving.push({ id: node.parentId, frame: parent, base: anim.tracks[node.parentId] });
      else this.mode = "rotate";
    }
  }

  move(e: PointerEvent, world: Point): void {
    const ctx = this.ctx;
    if (!this.dragging) {
      const s = ctx.toScreen(this.startWorld), n = ctx.toScreen(world);
      if (Math.hypot(n.x - s.x, n.y - s.y) < 3) return;
      this.dragging = true;
      if (this.refused) ctx.notify(this.refused);
      if (!this.mode) return;
      ctx.store.history.beginInteraction("path.drag");
    }
    if (!this.mode) return;
    const shown = { x: this.dot.x + world.x - this.startWorld.x, y: this.dot.y + world.y - this.startWorld.y };
    this.last = this.back ? apply({ x: 0, y: 0 }, this.back, shown.x, shown.y) : shown;
    this.apply(e.shiftKey, false);
  }

  up(e: PointerEvent): void {
    pathDragAnchor = null;
    if (!this.dragging || !this.mode) return;
    this.apply(e.shiftKey, true);
    this.ctx.store.history.endInteraction();
  }

  cancel(): void {
    pathDragAnchor = null;
    if (this.dragging && this.mode) this.ctx.store.history.abortInteraction();
  }

  /** The new local transform of each moving node for the pointer at `last`. */
  private solve(): Map<NodeId, Transform> {
    const [own, parent] = this.moving;
    const out = new Map<NodeId, Transform>();
    if (!own) return out;
    if (this.ik) {
      const ik = this.ik;
      const store = this.ctx.store;
      const sym = store.currentSymbol, anim = store.currentAnimation!;
      const delta = { x: this.last.x - this.pressed.x, y: this.last.y - this.pressed.y };
      const world = ikTargetFor(sym, ik.drag, ik.start, delta, (w) => {
        const local = targetLocalAt(ik.start, own.id, w) ?? ik.last;
        return posedSymbol(store.project, sym, withTargetAt(anim, sym, own.id, this.frame, local), this.frame, "animate");
      });
      const local = world ? targetLocalAt(ik.start, own.id, world) : null;
      if (local) ik.last = local;
      out.set(own.id, ik.last);
      return out;
    }
    if (this.mode === "translate") out.set(own.id, translateTo(own.frame, this.last));
    else if (this.mode === "rotate" || !parent) out.set(own.id, rotateTo(own.frame, this.last));
    else {
      const both = rotateWithParentTo(own.frame, parent.frame, this.last);
      out.set(own.id, both.child);
      out.set(parent.id, both.parent);
    }
    return out;
  }

  private apply(shift: boolean, final: boolean): void {
    const store = this.ctx.store;
    const sym = store.currentSymbol;
    const anim = store.currentAnimation;
    if (!anim || !this.mode) return;
    const join = seamFrame(anim);
    const tracks = new Map<NodeId, Track | undefined>();
    for (const [id, solved] of this.solve()) {
      const m = this.moving.find((x) => x.id === id)!;
      const node = sym.nodes[id];
      if (!node) continue;
      const t = final ? quantize(solved) : solved;
      if (shift) {
        const keyed = m.base ?? keyAt(undefined, node, this.frame, anim.duration).track;
        tracks.set(id, shiftKeys(keyed, m.frame.local, t, this.mode === "throughTarget" ? "translate" : this.mode));
        continue;
      }
      const added: number[] = [];
      let { track, added: isNew } = keyAt(m.base, node, this.frame, anim.duration);
      if (isNew) added.push(this.frame);
      track = withKeyTransform(track, this.frame, t);
      // A cycle's frame 0 is also its join: move the two together, keeping
      // the whole turns the join adds.
      if (this.frame === 0 && join !== null) {
        const at = keyAt(track, node, join, anim.duration);
        if (at.added) added.push(join);
        const old = at.track.keys.find((k) => k.frame === join)!.transform;
        const turns = Math.round((old.skewY - m.frame.local.skewY) / 360) * 360;
        track = withKeyTransform(at.track, join, { ...t, skewX: t.skewX + turns, skewY: t.skewY + turns });
      }
      tracks.set(id, final && added.length ? withoutRedundantKeys(track, added) : track);
    }
    if (!tracks.size) return;
    store.apply(new EditTracks(this.ik ? "Drag Path (IK)" : "Drag Path", store.currentSymbolId, anim.id, tracks, "path.drag"));
    store.emit("timeline");
    store.emit("stage");
  }
}

/** The spline handle under a world point, if the selected bone shows any. */
export function handleUnder(ctx: ToolContext, world: Point): PathHandle | null {
  const handles = ctx.pathHandles();
  return handles.length
    ? handleAt(handles, world.x, world.y, DOT_RADIUS / ctx.camera.screenScale, ctx.store.ui.frame)
    : null;
}

/**
 * Dragging a spline handle (B5 ▸ Spline handles): the interval leaving
 * `handle.from` bends so the handle follows the pointer. Written as x and y
 * eases (`withSpline`); where an axis that does not travel has to bend, a key
 * is cut in the middle of the interval. One undo step.
 */
export class HandleDrag {
  private started = false;
  private told = false;
  private readonly id: NodeId;
  private readonly base: Track;
  private readonly spline: Spline;
  /** The parent's linear part at the handle's key, inverted: world deltas
   *  into the parent's space, where the keys are. */
  private readonly toLocal: Matrix2D | null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly handle: PathHandle,
    private readonly startWorld: Point,
  ) {
    const store = ctx.store;
    const sym = store.currentSymbol;
    const anim = store.currentAnimation;
    this.id = pathBoneIds(sym.nodes, store.selection.nodes)[0]!;
    this.base = anim!.tracks[this.id]!;
    const seg = splineSegments(this.base).find((s) => s.from === handle.from)!;
    this.spline = seg.spline;
    // The matrix the handle was drawn through: its key's parent pose, or the
    // parent's pose the path is shown in.
    const l = handle.lin ?? { a: 1, b: 0, c: 0, d: 1 };
    const inv = mat();
    this.toLocal = invert(inv, { ...l, tx: 0, ty: 0 }) ? inv : null;
  }

  move(world: Point): void {
    const ctx = this.ctx;
    if (!this.started) {
      const s = ctx.toScreen(this.startWorld), n = ctx.toScreen(world);
      if (Math.hypot(n.x - s.x, n.y - s.y) < 3) return;
      this.started = true;
      ctx.store.history.beginInteraction("path.handle");
    }
    this.apply(world, false);
  }

  up(world: Point): void {
    if (!this.started) return;
    this.apply(world, true);
    this.ctx.store.history.endInteraction();
  }

  cancel(): void {
    if (this.started) this.ctx.store.history.abortInteraction();
  }

  private apply(world: Point, final: boolean): void {
    const store = this.ctx.store;
    const anim = store.currentAnimation;
    const node = store.currentSymbol.nodes[this.id];
    if (!anim || !node || !this.toLocal) return;
    const d = apply({ x: 0, y: 0 }, this.toLocal, world.x - this.startWorld.x, world.y - this.startWorld.y);
    const s = this.spline;
    const moved = (p: Point): Point => {
      const q = { x: p.x + d.x, y: p.y + d.y };
      return final ? { x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 } : q;
    };
    const next: Spline = this.handle.end === "out" ? { ...s, p1: moved(s.p1) } : { ...s, p2: moved(s.p2) };
    const edit = withSpline(this.base, node, this.handle.from, next);
    if ("refused" in edit) {
      if (!this.told) this.ctx.notify(edit.refused);
      this.told = true;
      return;
    }
    if (edit.clamped && final) this.ctx.notify("The handle was pulled in: that axis moves too little for it to reach further.");
    const track = final && edit.split !== null ? withoutRedundantKeys(edit.track, [edit.split]) : edit.track;
    store.apply(new EditTracks("Bend Path", store.currentSymbolId, anim.id, new Map([[this.id, track]]), "path.handle"));
    store.emit("timeline");
    store.emit("stage");
  }
}

/**
 * Dragging a handle on a bone that turns (B5 ▸ Rotation bones: bake): the
 * handle reshapes the curve fitted to the tip's arc, and the interval is
 * baked onto it: the bone (and its parent, with the bone's "With parent"
 * option) turned at every frame to follow it, then only the keys a linear
 * turn needs within 0.5 px kept (`bakePlan`). One undo step.
 */
export class BakeDrag {
  private started = false;
  private readonly id: NodeId;
  private readonly parentId: NodeId | null;
  private readonly frames: BakeFrame[] = [];
  private readonly bases: Map<NodeId, Track | undefined> = new Map();
  private readonly to: number;
  /** Relative paths: the inverse of the parent's pose they are drawn in. */
  private atInv: Matrix2D | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly handle: PathHandle & { bake: Spline },
    private readonly startWorld: Point,
  ) {
    const store = ctx.store;
    const sym = store.currentSymbol;
    const anim = store.currentAnimation!;
    this.id = pathBoneIds(sym.nodes, store.selection.nodes)[0]!;
    const node = sym.nodes[this.id]!;
    if (handle.relativeAt !== undefined) {
      const at = posedSymbol(store.project, sym, anim, handle.relativeAt, "animate");
      const m = node.parentId ? at.byNode.get(node.parentId)?.world : undefined;
      const inv = mat();
      if (m && invert(inv, m)) this.atInv = inv;
    }
    this.to = anim.tracks[this.id]!.keys.find((k) => k.frame > handle.from)!.frame;
    const withParent = node.pathDrag === "parent" && !!node.parentId && sym.nodes[node.parentId]?.kind === "bone";
    this.parentId = withParent ? node.parentId : null;
    const length = node.boneLength ?? DRAWN_BONE_LENGTH;
    for (let f = handle.from; f <= this.to; f++) {
      const pose = posedSymbol(store.project, sym, anim, f, "animate");
      const own = pose.byNode.get(this.id)!;
      const parent = node.parentId ? pose.byNode.get(node.parentId) : undefined;
      const grand = parent?.node.parentId ? pose.byNode.get(parent.node.parentId)?.world : undefined;
      this.frames.push({
        frame: f,
        own: { local: own.local, world: own.world, parentWorld: parent?.world ?? mat(), length },
        ...(withParent && parent ? { parent: { local: parent.local, world: parent.world, parentWorld: grand ?? mat(), length: 0 } } : {}),
        target: { x: 0, y: 0 },
      });
    }
    this.bases.set(this.id, anim.tracks[this.id]);
    if (this.parentId) this.bases.set(this.parentId, anim.tracks[this.parentId]);
  }

  move(world: Point): void {
    const ctx = this.ctx;
    if (!this.started) {
      const s = ctx.toScreen(this.startWorld), n = ctx.toScreen(world);
      if (Math.hypot(n.x - s.x, n.y - s.y) < 3) return;
      this.started = true;
      ctx.store.history.beginInteraction("path.bake");
    }
    this.apply(world, false);
  }

  up(world: Point): void {
    if (!this.started) return;
    this.apply(world, true);
    this.ctx.store.history.endInteraction();
  }

  cancel(): void {
    if (this.started) this.ctx.store.history.abortInteraction();
  }

  private apply(world: Point, final: boolean): void {
    const store = this.ctx.store;
    const anim = store.currentAnimation;
    const sym = store.currentSymbol;
    if (!anim) return;
    const dx = world.x - this.startWorld.x, dy = world.y - this.startWorld.y;
    const s0 = this.handle.bake;
    const s = this.handle.end === "out"
      ? { ...s0, p1: { x: s0.p1.x + dx, y: s0.p1.y + dy } }
      : { ...s0, p2: { x: s0.p2.x + dx, y: s0.p2.y + dy } };
    const span = this.to - this.handle.from;
    const frames = this.frames.map((f) => {
      const p = splineAt(s, (f.frame - this.handle.from) / span);
      // Drawn relative to the parent: into this frame through its parent pose.
      const target = this.atInv ? apply({ x: 0, y: 0 }, mul(mat(), f.own.parentWorld, this.atInv), p.x, p.y) : p;
      return { ...f, target };
    });
    const kept = bakePlan(frames).filter((k) => k.frame > this.handle.from && k.frame < this.to);
    const q = (t: Transform) => (final ? quantize(t) : t);

    const tracks = new Map<NodeId, Track | undefined>();
    const node = sym.nodes[this.id]!;
    tracks.set(this.id, withBakedKeys(this.bases.get(this.id)!, node, this.handle.from, kept.map((k) => ({ frame: k.frame, t: q(k.own) }))));
    if (this.parentId) {
      const parent = sym.nodes[this.parentId]!;
      // Pin the parent at the interval's ends, so it turns only inside it.
      let base = keyAt(this.bases.get(this.parentId), parent, this.handle.from, anim.duration).track;
      base = keyAt(base, parent, this.to, anim.duration).track;
      // The bake replaces whatever the parent had inside the interval.
      base = { ...base, keys: base.keys.filter((k) => k.frame <= this.handle.from || k.frame >= this.to) };
      tracks.set(this.parentId, withBakedKeys(base, parent, this.handle.from, kept.map((k) => ({ frame: k.frame, t: q(k.parent!) }))));
    }
    store.apply(new EditTracks("Bake Path", store.currentSymbolId, anim.id, tracks, "path.bake"));
    store.emit("timeline");
    store.emit("stage");
  }
}

/**
 * What a press at `world` takes: a handle or a dot, whichever is nearer.
 * Short handles sit on their key's dot, and a handle winning outright made
 * the dot impossible to grab; a tie goes to the dot.
 */
export function pathPick(ctx: ToolContext, world: Point):
  | { handle: PathHandle }
  | { dot: NonNullable<ReturnType<typeof pathDotUnder>> }
  | null {
  const handle = handleUnder(ctx, world);
  const dot = pathDotUnder(ctx, world);
  if (handle && dot) {
    const dh = Math.hypot(handle.x - world.x, handle.y - world.y), dd = Math.hypot(dot.x - world.x, dot.y - world.y);
    return dh < dd ? { handle } : { dot };
  }
  return handle ? { handle } : dot ? { dot } : null;
}
