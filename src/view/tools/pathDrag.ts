import type { ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { Track } from "@/core/doc/types";
import { DRAWN_BONE_LENGTH } from "@/core/doc/bonePath";
import { seamFrame } from "@/core/doc/cycle";
import {
  type DragFrame, keyAt, pathDotAt, pathDragMode, type PathDragMode, type Point, rotateTo, rotateWithParentTo,
  shiftKeys, translateTo, withKeyTransform, withoutRedundantKeys,
} from "@/core/doc/pathEdit";
import { apply, invert, mat, type Matrix2D } from "@/core/math/Matrix2D";
import { handleAt, type PathHandle, type Spline, splineSegments, withSpline } from "@/core/doc/pathSpline";
import { quantize, type Transform } from "@/core/math/Transform";
import { posedSymbol } from "@/core/spine/spinePose";
import { EditTracks } from "@/core/history/timelineCommands";

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
 * One undo step; keys the drag added and left redundant are removed on
 * release.
 */
export class PathDrag {
  private dragging = false;
  private mode: PathDragMode | null = null;
  private refused: string | null = null;
  private moving: Moving[] = [];
  private last: Point;

  constructor(
    private readonly ctx: ToolContext,
    id: NodeId,
    private readonly frame: number,
    private readonly dot: Point,
    private readonly startWorld: Point,
    e: PointerEvent,
  ) {
    this.last = dot;
    const store = ctx.store;
    if (!store.selection.nodes.includes(id)) store.selectNodes([id]);
    store.setFrame(frame);

    const sym = store.currentSymbol;
    const anim = store.currentAnimation;
    const node = sym.nodes[id];
    if (!anim || !node) return;
    const which = store.prefs.value.gizmos.bonePathPoint;
    const withParent = (node.pathDrag === "parent") !== e.altKey;
    const rule = pathDragMode(sym, anim, id, which, withParent);
    if ("refused" in rule) {
      this.refused = rule.refused;
      return;
    }
    this.mode = rule.mode;

    const pose = posedSymbol(store.project, sym, anim, frame, "animate");
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
    this.last = { x: this.dot.x + world.x - this.startWorld.x, y: this.dot.y + world.y - this.startWorld.y };
    this.apply(e.shiftKey, false);
  }

  up(e: PointerEvent): void {
    if (!this.dragging || !this.mode) return;
    this.apply(e.shiftKey, true);
    this.ctx.store.history.endInteraction();
  }

  cancel(): void {
    if (this.dragging && this.mode) this.ctx.store.history.abortInteraction();
  }

  /** The new local transform of each moving node for the pointer at `last`. */
  private solve(): Map<NodeId, Transform> {
    const [own, parent] = this.moving;
    const out = new Map<NodeId, Transform>();
    if (!own) return out;
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
        tracks.set(id, shiftKeys(keyed, m.frame.local, t, this.mode));
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
    store.apply(new EditTracks("Drag Path", store.currentSymbolId, anim.id, tracks, "path.drag"));
    store.emit("timeline");
    store.emit("stage");
  }
}

/** The spline handle under a world point, if the selected bone shows any. */
export function handleUnder(ctx: ToolContext, world: Point): PathHandle | null {
  const handles = ctx.pathHandles();
  return handles.length ? handleAt(handles, world.x, world.y, DOT_RADIUS / ctx.camera.screenScale) : null;
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
    this.id = store.selection.nodes[0]!;
    const node = sym.nodes[this.id];
    this.base = anim!.tracks[this.id]!;
    const seg = splineSegments(this.base).find((s) => s.from === handle.from)!;
    this.spline = seg.spline;
    const frame = handle.end === "out" ? seg.from : seg.to;
    const pose = posedSymbol(store.project, sym, anim!, frame, "animate");
    const parent = node?.parentId ? pose.byNode.get(node.parentId)?.world : undefined;
    const lin = parent ? { ...parent, tx: 0, ty: 0 } : mat();
    const inv = mat();
    this.toLocal = invert(inv, lin) ? inv : null;
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
