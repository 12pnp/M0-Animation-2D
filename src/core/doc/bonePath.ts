import { apply } from "@/core/math/Matrix2D";
import { isCycle, seamFrame } from "./cycle";
import type { NodeId } from "./ids";
import { type OnionSpan, wrapFrame } from "./onion";
import type { Pose } from "./pose";
import { keyIndexAt } from "./timeline";
import type { Animation } from "./types";

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
  sample: (frame: number) => Pose;
  ids: readonly NodeId[];
  frames: readonly number[];
  closed: boolean;
  which: PathPointKind;
  isKey?: (id: NodeId, frame: number) => boolean;
}): BonePath[] {
  const paths = args.ids.map((id): BonePath => ({ id, points: [], closed: args.closed }));
  for (const frame of args.frames) {
    const pose = args.sample(frame);
    for (const path of paths) {
      const p = pathPoint(pose, path.id, args.which);
      if (p) path.points.push({ frame, x: p.x, y: p.y, key: args.isKey?.(path.id, frame) ?? false });
    }
  }
  return paths;
}
