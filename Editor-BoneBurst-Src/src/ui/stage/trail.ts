import { frameTime } from "@/model/timelines";
import { boneMatrix, boneTip, parentMatrix, type Posed, type Poser } from "./posed";

/** The space a trail is measured in: from the bone's parent's joint (Local), or the skeleton's origin (World); both with the world's orientation. */
export type TrailSpace = "local" | "world";

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
 * A world point as Local shows it: the skeleton's own orientation (a rotated bone looks as it does
 * in the world), but from the bone's parent's joint, so the parent's movement is not in it. The
 * root's "parent" is the skeleton's own origin.
 */
export function fromParent(p: Posed, bone: number, x: number, y: number): [number, number] {
  const m = parentMatrix(p, bone);
  return [x - m[4], y - m[5]];
}

/**
 * The trail of `bone` over `animation` (`duration` seconds at `fps`), or null when the rig has no
 * such bone. Poses without physics, as every still frame is.
 */
export function boneTrail(poser: Poser, skin: string | null, animation: string, bone: string, fps: number, duration: number, space: TrailSpace): BoneTrail | null {
  const frames = Math.min(MAX_TRAIL_FRAMES, Math.max(0, Math.round(duration * fps)));
  const joint = new Float64Array((frames + 1) * 2), tip = new Float64Array((frames + 1) * 2);
  for (let f = 0; f <= frames; f++) {
    const p = poser.pose(skin, animation, Math.fround(frameTime(f, fps)), "none"), i = p.bones.get(bone);
    if (i === undefined) return null;
    const m = boneMatrix(p, i), [tx, ty] = boneTip(p, i);
    let j: [number, number] = [m[4], m[5]], t: [number, number] = [tx, ty];
    if (space === "local") { j = fromParent(p, i, j[0], j[1]); t = fromParent(p, i, t[0], t[1]); }
    joint.set(j, f * 2);
    tip.set(t, f * 2);
  }
  return { frames, fps, joint, tip };
}
