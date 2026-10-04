import { cloneTf, type Transform } from "@/core/math/Transform";
import type { NodeId } from "./ids";
import type { Pose } from "./pose";
import { insertKeyframe, keyIndexAt, sampleColorRaw, sampleTransformRaw, spanKeyAt } from "./timeline";
import type { Animation, ColorTransform, Keyframe, Node, Track } from "./types";

/**
 * Cycles: animations whose last frame is the join back to frame 0
 * (docs/CYCLE-PATH-PLAN.md, Part A). A cycle is Spine's timing
 * (`endsAtLastFrame`) on an animation that loops forever; nothing else is
 * stored. At the join the runtime shows the last frame and then frame 0, so the
 * two must be the same pose or the loop hitches.
 */

export function isCycle(anim: Animation): boolean {
  return anim.playTimes === 0 && anim.endsAtLastFrame === true;
}

/** The frame that repeats frame 0, or null when the animation is not a cycle
 *  or too short to have one. */
export function seamFrame(anim: Animation): number | null {
  return isCycle(anim) && anim.duration >= 2 ? anim.duration - 1 : null;
}

export interface SeamTolerance {
  /** Pixels, for the origin. */
  px: number;
  /** Degrees, for each axis's direction. */
  deg: number;
  /** For each axis's length. */
  scale: number;
}

export const SEAM_TOLERANCE: Readonly<SeamTolerance> = Object.freeze({ px: 0.01, deg: 0.01, scale: 1e-4 });

/** How a node's pose at the join differs from frame 0. */
export interface SeamGap {
  nodeId: NodeId;
  /** How far the origin moved, in pixels of the symbol's space. */
  distance: number;
  /** The larger turn of the two axes, in degrees, wrapped to (−180, 180]. */
  rotation: number;
  /** The larger change in either axis's length. */
  scale: number;
  color: boolean;
  /** The display shown, or whether it is shown at all, differs. */
  display: boolean;
}

function turn(fromX: number, fromY: number, toX: number, toY: number): number {
  const d = ((Math.atan2(toY, toX) - Math.atan2(fromY, fromX)) * 180) / Math.PI;
  return d - 360 * Math.ceil((d - 180) / 360);
}

function sameColor(a: ColorTransform, b: ColorTransform): boolean {
  return a.aM === b.aM && a.rM === b.rM && a.gM === b.gM && a.bM === b.bM
    && a.aO === b.aO && a.rO === b.rO && a.gO === b.gO && a.bO === b.bO;
}

/**
 * Every node whose pose at the join differs from frame 0. It compares the posed
 * result rather than the keys, so a bone the IK solves shows a gap when its
 * target's keys do not close, and a node with no keys at all never does.
 */
export function seamGap(start: Pose, end: Pose, tol: SeamTolerance = SEAM_TOLERANCE): SeamGap[] {
  const out: SeamGap[] = [];
  for (const a of start.entries) {
    const b = end.byNode.get(a.nodeId);
    if (!b) continue;
    const m = a.world, n = b.world;
    const distance = Math.hypot(n.tx - m.tx, n.ty - m.ty);
    const rotation = [turn(m.a, m.b, n.a, n.b), turn(m.c, m.d, n.c, n.d)]
      .reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x));
    const scale = Math.max(
      Math.abs(Math.hypot(n.a, n.b) - Math.hypot(m.a, m.b)),
      Math.abs(Math.hypot(n.c, n.d) - Math.hypot(m.c, m.d)),
    );
    const color = !sameColor(a.color, b.color);
    const display = a.visible !== b.visible || (a.visible && a.displayIndex !== b.displayIndex);
    if (distance > tol.px || Math.abs(rotation) > tol.deg || scale > tol.scale || color || display) {
      out.push({ nodeId: a.nodeId, distance, rotation, scale, color, display });
    }
  }
  return out;
}

function sameTransform(a: Transform, b: Transform): boolean {
  return a.x === b.x && a.y === b.y && a.skewX === b.skewX && a.skewY === b.skewY
    && a.scaleX === b.scaleX && a.scaleY === b.scaleY;
}

/**
 * Close Loop: for each of `nodeIds`, the track with a key at the join holding
 * frame 0's values (transform, colour, display). Returns only the tracks that
 * change; the command applies them.
 *
 * The angles keep the whole turns the track makes by the join: a bone that
 * spins once over the cycle gets frame 0's angle plus 360, which is the same
 * pose, rather than being sent back the way it came.
 *
 * A node without a track is static and already closes. A track that shows
 * nothing at frame 0 (its first key is later) is left out: there is no pose
 * to copy.
 */
export function seamKeys(
  anim: Animation, nodes: Readonly<Record<NodeId, Node>>, nodeIds: readonly NodeId[],
): Track[] {
  const end = seamFrame(anim);
  if (end === null) return [];
  const out: Track[] = [];
  for (const id of nodeIds) {
    const track = anim.tracks[id];
    const node = nodes[id];
    if (!track || !node) continue;
    const first = sampleTransformRaw(track, 0);
    const firstKey = spanKeyAt(track, 0);
    if (!first || !firstKey) continue;
    const firstColor = sampleColorRaw(track, 0);

    const atEnd = sampleTransformRaw(track, end) ?? track.keys[track.keys.length - 1]!.transform;
    const turns = Math.round((atEnd.skewY - first.skewY) / 360) * 360;
    const transform = { ...cloneTf(first), skewX: first.skewX + turns, skewY: first.skewY + turns };

    const keyed = keyIndexAt(track, end) >= 0 ? track : insertKeyframe(track, end, node);
    if (!keyed) continue;
    const i = keyIndexAt(keyed, end);
    const old = keyed.keys[i]!;
    const key: Keyframe = { ...old, transform, displayIndex: firstKey.displayIndex };
    if (firstColor) key.color = { ...firstColor };
    else delete key.color;

    const unchanged = keyed === track && sameTransform(old.transform, transform)
      && old.displayIndex === key.displayIndex
      && (old.color && key.color ? sameColor(old.color, key.color) : !old.color && !key.color);
    if (unchanged) continue;
    out.push({ ...keyed, keys: keyed.keys.map((k, j) => (j === i ? key : k)) });
  }
  return out;
}
