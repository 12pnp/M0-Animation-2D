import type { ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import type { Track } from "@/core/doc/types";
import { DRAWN_BONE_LENGTH } from "@/core/doc/bonePath";
import { seamFrame } from "@/core/doc/cycle";
import {
  type DragFrame, keyAt, pathDotAt, pathDragMode, type PathDragMode, type Point, rotateTo, rotateWithParentTo,
  shiftKeys, translateTo, withKeyTransform, withoutRedundantKeys,
} from "@/core/doc/pathEdit";
import { mat } from "@/core/math/Matrix2D";
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
