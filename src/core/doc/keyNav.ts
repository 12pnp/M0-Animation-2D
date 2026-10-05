/**
 * Previous / Next Keyframe (Q / W): where the playhead jumps. The keys of the
 * selected layers when any are selected, else of every layer, the draw
 * order, the IK keys and the event keys. Pure, so the arithmetic is tested without a timeline.
 */

import type { NodeId } from "./ids";
import type { Animation } from "./types";

/** Every frame that holds a key, sorted and unique. `nodes` null: every layer,
 *  the draw order, the IK keys and the event keys. */
export function keyFrames(anim: Animation, nodes: readonly NodeId[] | null): number[] {
  const out = new Set<number>();
  const ids = nodes ?? (Object.keys(anim.tracks) as NodeId[]);
  for (const id of ids) for (const k of anim.tracks[id]?.keys ?? []) out.add(k.frame);
  if (!nodes) for (const k of anim.drawOrder ?? []) out.add(k.frame);
  if (!nodes) for (const keys of Object.values(anim.ik ?? {})) for (const k of keys) out.add(k.frame);
  if (!nodes) for (const k of anim.events ?? []) out.add(k.frame);
  if (!nodes) for (const keys of Object.values(anim.transforms ?? {})) for (const k of keys) out.add(k.frame);
  for (const [id, keys] of Object.entries(anim.deforms ?? {})) if (!nodes || nodes.includes(id as NodeId)) for (const k of keys) out.add(k.frame);
  for (const byNode of Object.values(anim.displayDeforms ?? {})) {
    for (const [id, byIndex] of Object.entries(byNode)) if (!nodes || nodes.includes(id as NodeId)) for (const keys of Object.values(byIndex)) for (const k of keys) out.add(k.frame);
  }
  for (const [id, keys] of Object.entries(anim.sequences ?? {})) if (!nodes || nodes.includes(id as NodeId)) for (const k of keys) out.add(k.frame);
  return [...out].sort((a, b) => a - b);
}

/** The nearest key frame before (`dir` −1) or after (+1) `frame`. Past the
 *  last key it wraps to the first, and before the first to the last; null
 *  when that is where the playhead already is, or there are no keys. */
export function adjacentKeyFrame(frames: readonly number[], frame: number, dir: -1 | 1): number | null {
  if (!frames.length) return null;
  let to: number | undefined;
  if (dir > 0) to = frames.find((f) => f > frame) ?? frames[0];
  else {
    for (let i = frames.length - 1; i >= 0 && to === undefined; i--) if (frames[i]! < frame) to = frames[i];
    to ??= frames[frames.length - 1];
  }
  return to === frame ? null : to!;
}
