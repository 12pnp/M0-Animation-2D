import type { Keyframe, TimelineProp } from "./types";
import { TIMELINE_PROPS } from "./types";
import type { Transform } from "@/core/math/Transform";

/** The eased channels each bone property is made of (`easeOf`). */
export type Leaf = "x" | "y" | "rotation" | "shear" | "scaleX" | "scaleY";
export const LEAVES: Record<TimelineProp, readonly Leaf[]> = {
  rotate: ["rotation"], x: ["x"], y: ["y"], scale: ["scaleX", "scaleY"], shear: ["shear"],
};

/** Rotation is the bone's skewY; shear is skewY − skewX, so turning keeps it. */
export function leafValue(t: Transform, leaf: Leaf): number {
  switch (leaf) {
    case "x": return t.x;
    case "y": return t.y;
    case "rotation": return t.skewY;
    case "shear": return t.skewY - t.skewX;
    case "scaleX": return t.scaleX;
    case "scaleY": return t.scaleY;
  }
}

export const valuesOf = (prop: TimelineProp, t: Transform): number[] => LEAVES[prop].map((l) => leafValue(t, l));

const EPS = 1e-6;
export const sameValues = (a: readonly number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= EPS);

/**
 * `k` with a new transform. A key that lists the properties it is a key of
 * (`Keyframe.keyed`) gains every property the new transform changes: a pose
 * set on the stage at a key keys what it changed, as in Spine.
 */
export function withTransform(k: Keyframe, transform: Transform): Keyframe {
  if (!k.keyed) return { ...k, transform };
  const changed = TIMELINE_PROPS.filter((p) => !sameValues(valuesOf(p, k.transform), valuesOf(p, transform)));
  return { ...k, transform, keyed: TIMELINE_PROPS.filter((p) => k.keyed!.includes(p) || changed.includes(p)) };
}
