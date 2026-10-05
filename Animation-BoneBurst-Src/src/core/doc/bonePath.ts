import { apply, invert, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { isCycle, seamFrame } from "./cycle";
import { anchorOf } from "./displays";
import type { NodeId } from "./ids";
import { type OnionSpan, wrapFrame } from "./onion";
import type { Pose } from "./pose";
import { keyIndexAt } from "./timeline";
import type { Animation, Node } from "./types";

/**
 * Bone paths (docs/CYCLE-PATH-PLAN.md, Part B): where one point of a bone is
 * at each frame, so the stage can draw how it moves. Positions come from posed
 * frames, IK solve included, so a bone the solver turns draws the path the
 * runtime will play.
 */

/** Which point of the bone is followed: its tip (the origin plus its length
 *  along +x, which shows a swing) or its origin. */
export type PathPointKind = "tip" | "origin";

export interface PathPoint {
  /** The frame shown, inside the animation (wrapped on a cycle). */
  frame: number;
  x: number;
  y: number;
  /** The node has a key at this frame. */
  key: boolean;
}

export interface BonePath {
  id: NodeId;
  /** In playing order. */
  points: PathPoint[];
  /** The last point runs back into the first: a whole cycle. */
  closed: boolean;
  /** Set when the points are relative to the parent (`parentSpace`): the
   *  frame whose parent pose they are drawn in. */
  relativeAt?: number;
}

/**
 * The bone's parent as a frame of reference: `shown` brings a point of frame
 * `f` into the parent's pose at frame `at`, as if the parent had held still
 * there all along, so the path shows only the bone's own motion against its
 * parent; `back` is the inverse, a point drawn that way into frame `f`'s
 * space, where an edit is solved. A root bone has no parent: both are the
 * identity.
 */
export interface ParentSpace {
  shown(frame: number, p: { x: number; y: number }): { x: number; y: number };
  back(frame: number, p: { x: number; y: number }): { x: number; y: number };
  /** The parent's matrix at `at`: what a vector in the parent's space is
   *  drawn through. */
  at: Matrix2D;
}

export function parentSpace(
  sample: (frame: number) => Pose | null, id: NodeId, at: number,
): ParentSpace | null {
  const now = sample(at);
  const e = now?.byNode.get(id);
  if (!now || !e) return null;
  const parentId = anchorOf(e.node);
  const worldAt = (pose: Pose | null) => (parentId ? pose?.byNode.get(parentId)?.world ?? null : mat());
  const atM = worldAt(now);
  if (!atM) return null;
  const atInv = mat();
  if (!invert(atInv, atM)) return null;
  const map = (m: Matrix2D, p: { x: number; y: number }) => apply({ x: 0, y: 0 }, m, p.x, p.y);
  return {
    at: atM,
    shown(frame, p) {
      const m = worldAt(sample(frame));
      const inv = mat();
      return m && invert(inv, m) ? map(mul(mat(), atM, inv), p) : p;
    },
    back(frame, p) {
      const m = worldAt(sample(frame));
      return m ? map(mul(mat(), m, atInv), p) : p;
    },
  };
}

/** The length the stage draws a bone with when it has none of its own. */
export const DRAWN_BONE_LENGTH = 40;

/** The point followed on `id` in this pose, in the symbol's space; null when
 *  the pose does not have the node. The tip is where the stage draws it;
 *  anything but a bone has its tip at its origin. */
export function pathPoint(pose: Pose, id: NodeId, which: PathPointKind): { x: number; y: number } | null {
  const e = pose.byNode.get(id);
  if (!e) return null;
  const length = which === "tip" && e.node.kind === "bone" ? e.node.boneLength ?? DRAWN_BONE_LENGTH : 0;
  return apply({ x: 0, y: 0 }, e.world, length, 0);
}

/**
 * The frames a path runs through, in playing order. A cycle runs 0 to the
 * frame before the join (the join is frame 0 again) and is closed; anything
 * else runs over its whole length. With `span` (the onion markers), only those
 * frames: on a cycle the span may be unwrapped (`onionSpan`), and its frames
 * are wrapped into the animation in the same order.
 */
export function pathFrames(anim: Animation, span?: OnionSpan | null): { frames: number[]; closed: boolean } {
  const join = isCycle(anim) ? seamFrame(anim) : null;
  const end = join ?? Math.max(1, anim.duration);
  if (!span) return { frames: Array.from({ length: end }, (_, i) => i), closed: join !== null };
  const frames: number[] = [];
  for (let f = span.start; f <= span.end; f++) {
    if (join !== null) frames.push(wrapFrame(f, join));
    else if (f >= 0 && f < end) frames.push(f);
  }
  const whole = join !== null && span.end - span.start + 1 >= join;
  return { frames: whole ? frames.slice(0, join) : frames, closed: whole };
}

/** Whether `id` has a key at `frame` in `anim`. */
export function keyedIn(anim: Animation): (id: NodeId, frame: number) => boolean {
  return (id, frame) => {
    const track = anim.tracks[id];
    return !!track && keyIndexAt(track, frame) >= 0;
  };
}

/**
 * The path of each of `ids` over `frames`. `sample` poses a frame; each frame
 * is posed once for all the paths.
 */
export function bonePaths(args: {
  /** Null for a frame not posed yet: it is left out of the paths. */
  sample: (frame: number) => Pose | null;
  ids: readonly NodeId[];
  frames: readonly number[];
  closed: boolean;
  which: PathPointKind;
  isKey?: (id: NodeId, frame: number) => boolean;
  /** Each path relative to the bone's parent, drawn in the parent's pose at
   *  this frame (`parentSpace`). */
  relativeAt?: number;
}): BonePath[] {
  const rel = args.relativeAt;
  const spaces = new Map(args.ids.map((id) => [id, rel === undefined ? null : parentSpace(args.sample, id, rel)]));
  const paths = args.ids.map((id): BonePath => ({
    id, points: [], closed: args.closed, ...(spaces.get(id) ? { relativeAt: rel } : {}),
  }));
  for (const frame of args.frames) {
    const pose = args.sample(frame);
    if (!pose) continue;
    for (const path of paths) {
      const p = pathPoint(pose, path.id, args.which);
      if (!p) continue;
      const q = spaces.get(path.id)?.shown(frame, p) ?? p;
      path.points.push({ frame, x: q.x, y: q.y, key: args.isKey?.(path.id, frame) ?? false });
    }
  }
  return paths;
}

/**
 * The bones whose paths a selection shows: a selected bone, and the bone a
 * selected picture hangs on (its slot bone or its parent), so clicking a
 * leg's artwork shows the leg. Each once, in selection order.
 */
export function pathBoneIds(nodes: Readonly<Record<NodeId, Node>>, selection: readonly NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  for (const id of selection) {
    const n = nodes[id];
    if (!n) continue;
    const bone = n.kind === "bone" ? n : (() => {
      const a = anchorOf(n);
      const p = a ? nodes[a] : undefined;
      return p?.kind === "bone" ? p : undefined;
    })();
    if (bone && !out.includes(bone.id)) out.push(bone.id);
  }
  return out;
}
