import type { NodeId, ItemId } from "@/core/doc/ids";
import { type Normalization, normalizeLayerOrder, denormalize } from "@/core/doc/layerTree";
import { invalidateBounds, evaluateSymbol, type Pose } from "@/core/doc/pose";
import type { Track, Project, SymbolItem, DisplayRef, Keyframe } from "@/core/doc/types";
import { type Matrix2D, mat, invert, mul } from "@/core/math/Matrix2D";
import { type Transform, cloneTf, fromMatrix, translateLocal } from "@/core/math/Transform";
import type { Command, TouchSet } from "./Command";
import { symbolOf } from "./lookup";

export class SetParent implements Command {
  readonly kind = "node.parent";
  readonly touches: TouchSet;
  private beforeParent = new Map<NodeId, NodeId | null>();
  private beforeBind = new Map<NodeId, Transform>();
  /** The tracks whose keys were re-expressed, as they were. */
  private beforeTracks: Array<{ animId: string; nodeId: NodeId; track: Track; }> = [];
  private norm: Normalization | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly ids: NodeId[],
    private readonly parentId: NodeId | null,
    /** Keep the object visually where it is, re-expressing its transform in
     *  the new parent's space. Off means "adopt the parent's frame", which
     *  makes the object jump — occasionally wanted, never the default. */
    private readonly preserveWorld = true,
    readonly label = "Set Parent"
  ) {
    this.touches = { symbols: [symbolId], nodes: ids, stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const moving = this.ids.filter((id) => {
      const n = sym.nodes[id];
      if (!n) return false;
      return !(this.parentId && createsCycle(sym, id, this.parentId));
    });
    if (moving.length === 0) return;

    if (!this.preserveWorld) {
      for (const id of moving) {
        const n = sym.nodes[id]!;
        this.beforeParent.set(id, n.parentId);
        n.parentId = this.parentId;
      }
      this.norm = normalizeLayerOrder(sym);
      invalidateBounds([this.symbolId]);
      return;
    }

    // Capture where everything is BEFORE the parent changes: the setup pose,
    // plus each animation at each frame the moving nodes have a keyframe on.
    // Re-expressing only the bind pose would leave every existing keyframe
    // describing a position in a coordinate space that no longer exists.
    const framesByAnim = new Map<string, Set<number>>();
    for (const anim of sym.animations) {
      const frames = new Set<number>();
      for (const id of moving) {
        for (const key of anim.tracks[id]?.keys ?? []) frames.add(key.frame);
      }
      if (frames.size) framesByAnim.set(anim.id, frames);
    }

    const setupBefore = evaluateSymbol(sym, null, 0, "setup");
    const animBefore = new Map<string, Map<number, Pose>>();
    for (const [animId, frames] of framesByAnim) {
      const anim = sym.animations.find((a) => a.id === animId)!;
      const byFrame = new Map<number, Pose>();
      for (const f of frames) byFrame.set(f, evaluateSymbol(sym, anim, f, "animate"));
      animBefore.set(animId, byFrame);
    }

    for (const id of moving) {
      const n = sym.nodes[id]!;
      this.beforeParent.set(id, n.parentId);
      this.beforeBind.set(id, cloneTf(n.bind));
      n.parentId = this.parentId;
    }

    // Setup pose.
    const setupAfter = evaluateSymbol(sym, null, 0, "setup");
    for (const id of moving) {
      const world = setupBefore.byNode.get(id)?.world;
      if (!world) continue;
      const parentWorld = this.parentId
        ? setupAfter.byNode.get(this.parentId)?.world
        : undefined;
      sym.nodes[id]!.bind = reexpress(world, parentWorld, sym.nodes[id]!.bind);
    }

    // Keyframes, frame by frame. Collected first and written as new tracks:
    // the key objects are shared with tracks earlier undo steps keep. The new
    // parent cannot descend from a moving node, so its pose does not depend
    // on the keys being rewritten.
    this.beforeTracks = [];
    for (const [animId, byFrame] of animBefore) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (!anim) continue;
      const rewritten = new Map<NodeId, Map<number, Transform>>();
      for (const [frame, poseBefore] of byFrame) {
        const poseAfter = evaluateSymbol(sym, anim, frame, "animate");
        for (const id of moving) {
          const key = anim.tracks[id]?.keys.find((k) => k.frame === frame);
          const world = poseBefore.byNode.get(id)?.world;
          if (!key || !world) continue;
          const parentWorld = this.parentId
            ? poseAfter.byNode.get(this.parentId)?.world
            : undefined;
          if (!rewritten.has(id)) rewritten.set(id, new Map());
          rewritten.get(id)!.set(frame, reexpress(world, parentWorld, key.transform));
        }
      }
      for (const [id, byFrame] of rewritten) {
        const track = anim.tracks[id]!;
        this.beforeTracks.push({ animId, nodeId: id, track });
        anim.tracks[id] = {
          ...track,
          keys: track.keys.map((k) => {
            const transform = byFrame.get(k.frame);
            return transform ? { ...k, transform } : k;
          }),
        };
      }
    }

    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    // The order this command found: it never touches the array itself, so
    // re-normalising under the old parents is NOT the inverse.
    if (this.norm) denormalize(sym, this.norm);
    for (const [id, parent] of this.beforeParent) {
      const n = sym.nodes[id];
      if (n) n.parentId = parent;
    }
    for (const [id, bind] of this.beforeBind) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(bind);
    }
    for (const { animId, nodeId, track } of this.beforeTracks) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track;
    }
    invalidateBounds([this.symbolId]);
  }
}
/** `local = inverse(parentWorld) * world`, decomposed back to a Transform. */

export function reexpress(
  world: Matrix2D, parentWorld: Matrix2D | undefined, prev: Transform
): Transform {
  if (!parentWorld) return fromMatrix(cloneTf(prev), world, prev);
  const inv = mat();
  if (!invert(inv, parentWorld)) return cloneTf(prev);
  return fromMatrix(cloneTf(prev), mul(mat(), inv, world), prev);
}
/** Would parenting `child` under `parent` close a loop? */

export function createsCycle(sym: SymbolItem, child: NodeId, parent: NodeId): boolean {
  let cur: NodeId | null = parent;
  const seen = new Set<NodeId>();
  while (cur) {
    if (cur === child) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = sym.nodes[cur]?.parentId ?? null;
  }
  return false;
}
/**
 * Move a node's transform point, keeping the artwork where it is.
 *
 * The compensation reaches the bind pose AND every keyframe of the node's
 * tracks. It has to: the artwork hangs off the origin at -pivot, so a pivot
 * that moved without each frame's origin moving with it would drag the
 * artwork across the whole animation — and compensating only the bind pose
 * (which is what this command used to do) fixes Setup mode while leaving
 * every animated object to slide, since the rendered pose comes from the
 * track.
 *
 * Each display has its own transform point (`displays` picks one per node,
 * 0 by default), so only the keys showing it are compensated — and the bind
 * pose and the blank keys only for display 0, which is what they stand for.
 *
 * `keepArtwork: false` sets the transform point outright, which is what
 * pasting properties from another instance means.
 */

export class SetPivot implements Command {
  readonly kind = "node.pivot";
  readonly touches: TouchSet;
  readonly label = "Move Transform Point";
  private before = new Map<NodeId, {
    pivot: { x: number; y: number; }; bind: Transform; extras: DisplayRef[] | undefined;
  }>();
  /** The tracks this replaced, as they were before the first step. */
  private beforeTracks = new Map<string, { animId: string; nodeId: NodeId; track: Track; }>();
  private after: Map<NodeId, { x: number; y: number; }>;
  private readonly displays: Map<NodeId, number>;
  private readonly keepArtwork: boolean;

  constructor(
    private readonly symbolId: ItemId,
    pivots: Map<NodeId, { x: number; y: number; }>,
    opts: { keepArtwork?: boolean; displays?: Map<NodeId, number>; } = {}
  ) {
    this.after = new Map([...pivots].map(([k, v]) => [k, { ...v }]));
    this.displays = new Map(opts.displays ?? []);
    this.keepArtwork = opts.keepArtwork !== false;
    this.touches = { symbols: [symbolId], nodes: [...pivots.keys()], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, pivot] of this.after) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (!this.before.has(id)) {
        this.before.set(id, { pivot: n.pivot, bind: n.bind, extras: n.extraDisplays });
      }

      const wanted = this.displays.get(id) ?? 0;
      const d = wanted > 0 && n.extraDisplays?.[wanted - 1] ? wanted : 0;
      const current = d === 0 ? n.pivot : n.extraDisplays![d - 1]!.pivot;
      const dx = pivot.x - current.x;
      const dy = pivot.y - current.y;
      if (d === 0) n.pivot = { ...pivot };
      else {
        n.extraDisplays = n.extraDisplays!.map((e, i) => (i === d - 1 ? { itemId: e.itemId, pivot: { ...pivot } } : e));
      }
      if (!this.keepArtwork || (dx === 0 && dy === 0)) continue;

      // New objects all the way down, keys included: the frame algebra
      // shares key objects between a track and the one an earlier undo step
      // keeps, and a converted symbol shares `bind` with the node its
      // command keeps.
      if (d === 0) n.bind = translateLocal(cloneTf(n.bind), n.bind, dx, dy);
      const shows = (k: Keyframe) => k.displayIndex === d || (d === 0 && k.displayIndex < 0);
      for (const anim of sym.animations) {
        const track = anim.tracks[id];
        if (!track || !track.keys.some(shows)) continue;
        const k = `${anim.id}/${id}`;
        if (!this.beforeTracks.has(k)) this.beforeTracks.set(k, { animId: anim.id, nodeId: id, track });
        anim.tracks[id] = {
          ...track,
          keys: track.keys.map((key) => (shows(key)
            ? { ...key, transform: translateLocal(cloneTf(key.transform), key.transform, dx, dy) }
            : key)),
        };
      }
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, prev] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      n.pivot = prev.pivot;
      n.bind = prev.bind;
      if (prev.extras) n.extraDisplays = prev.extras;
      else delete n.extraDisplays;
    }
    for (const { animId, nodeId, track } of this.beforeTracks.values()) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track;
    }
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetPivot)) return false;
    if (next.symbolId !== this.symbolId || next.keepArtwork !== this.keepArtwork) return false;
    // Redo replays only the merged command, so one node's steps must all
    // have moved the same display.
    for (const id of next.after.keys()) {
      if (this.after.has(id) && (next.displays.get(id) ?? 0) !== (this.displays.get(id) ?? 0)) return false;
    }
    // Our `before` holds the state from the start of the drag; the follow-up
    // only adds what it touched for the first time.
    for (const [id, pivot] of next.after) this.after.set(id, { ...pivot });
    for (const [id, d] of next.displays) this.displays.set(id, d);
    for (const [id, prev] of next.before) if (!this.before.has(id)) this.before.set(id, prev);
    for (const [k, t] of next.beforeTracks) if (!this.beforeTracks.has(k)) this.beforeTracks.set(k, t);
    return true;
  }
}
