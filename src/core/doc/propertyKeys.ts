import type { Track } from "./types";
import { toSpineLocal } from "@/core/spine/transform";

/** A bone property the timeline shows on a row of its own, as Spine's
 *  dopesheet does. */
export type TimelineProp = "rotate" | "x" | "y" | "scale" | "shear";

export const TIMELINE_PROPS: readonly TimelineProp[] = ["rotate", "x", "y", "scale", "shear"];

const EPS = 1e-6;

/** The property's value at a key, as Spine reads it (`toSpineLocal`). */
function valueOf(prop: TimelineProp, t: Track["keys"][number]["transform"]): number[] {
  const s = toSpineLocal(t);
  switch (prop) {
    case "rotate": return [s.rotation];
    case "x": return [s.x];
    case "y": return [s.y];
    case "scale": return [s.scaleX, s.scaleY];
    case "shear": return [s.shearX, s.shearY];
  }
}

const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= EPS);

/**
 * The frames where `prop` has a key of its own: a key holds the whole pose
 * here, so a property is keyed where its value differs from the key before
 * or the key after (a key equal to both says nothing about it). A property
 * that never changes has none, as Spine writes no timeline for it.
 */
export function propertyKeys(track: Track | undefined, prop: TimelineProp): number[] {
  const keys = track?.keys ?? [];
  if (keys.length < 2) return [];
  const vals = keys.map((k) => valueOf(prop, k.transform));
  if (vals.every((v) => same(v, vals[0]!))) return [];
  const out: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const prev = vals[i - 1], next = vals[i + 1];
    const moves = (prev && !same(prev, vals[i]!)) || (next && !same(next, vals[i]!));
    if (moves) out.push(keys[i]!.frame);
  }
  return out;
}
