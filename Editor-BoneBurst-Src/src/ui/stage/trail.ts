import { frameTime } from "@/model/timelines";
import { boneMatrix, boneTip, parentMatrix, type Posed, type Poser } from "./posed";

/** The space a trail is measured in: from a parent bone's joint (Parent: the bone's own parent, or a bone named), or the skeleton's origin (World); both with the world's orientation. */
export type TrailSpace = "parent" | "world";

/**
 * Where one bone is at every frame of an animation (docs/MOTION-PREVIEW-PLAN.md): its joint and its
 * tip, two numbers each (x, y), frame 0 to `frames`. Read from the posed rig, so a bone an IK or
 * other constraint moves is where the constraint puts it. A frame the bone has no pose at is NaN.
 */
export interface BoneTrail {
  readonly frames: number;
  readonly fps: number;
  readonly joint: Float64Array;
  readonly tip: Float64Array;
}

/** The most frames a trail covers; a longer animation is cut here. */
export const MAX_TRAIL_FRAMES = 2000;

/**
 * A world point as Parent shows it: the skeleton's own orientation (a rotated bone looks as it does
 * in the world), but from a parent bone's joint, so that bone's movement is not in it: `origin`, a
 * bone by name, else the bone's own parent. The root's "parent" is
 * the skeleton's own origin.
 */
export function fromParent(p: Posed, bone: number, x: number, y: number, origin: string | null = null): [number, number] {
  const o = origin === null ? undefined : p.bones.get(origin), m = o === undefined ? parentMatrix(p, bone) : boneMatrix(p, o);
  return [x - m[4], y - m[5]];
}

/**
 * The trail of `bone` over `animation` (`duration` seconds at `fps`), or null when the rig has no
 * such bone. Poses without physics, as every still frame is.
 */
export function boneTrail(poser: Poser, skin: string | null, animation: string, bone: string, fps: number, duration: number, space: TrailSpace, origin: string | null = null): BoneTrail | null {
  const frames = Math.min(MAX_TRAIL_FRAMES, Math.max(0, Math.round(duration * fps)));
  const joint = new Float64Array((frames + 1) * 2), tip = new Float64Array((frames + 1) * 2);
  for (let f = 0; f <= frames; f++) {
    const p = poser.pose(skin, animation, Math.fround(frameTime(f, fps)), "none"), i = p.bones.get(bone);
    if (i === undefined) return null;
    const m = boneMatrix(p, i), [tx, ty] = boneTip(p, i);
    let j: [number, number] = [m[4], m[5]], t: [number, number] = [tx, ty];
    if (space === "parent") { j = fromParent(p, i, j[0], j[1], origin); t = fromParent(p, i, t[0], t[1], origin); }
    joint.set(j, f * 2);
    tip.set(t, f * 2);
  }
  return { frames, fps, joint, tip };
}
