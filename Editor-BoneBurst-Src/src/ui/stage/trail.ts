import { frameTime } from "@/model/timelines";
import { boneMatrix, boneTip, parentMatrix, type Poser } from "./posed";

/** The space a trail is measured in: the bone's parent (Local), or the skeleton (World). */
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

/** A world point in the space of the matrix `m` ([a, b, c, d, x, y]); NaN when `m` has no inverse. */
export function inSpaceOf(m: readonly number[], x: number, y: number): [number, number] {
  const [a, b, c, d, tx, ty] = m as [number, number, number, number, number, number], det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [Number.NaN, Number.NaN];
  const dx = x - tx, dy = y - ty;
  return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
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
    if (space === "local") { const parent = parentMatrix(p, i); j = inSpaceOf(parent, j[0], j[1]); t = inSpaceOf(parent, t[0], t[1]); }
    joint.set(j, f * 2);
    tip.set(t, f * 2);
  }
  return { frames, fps, joint, tip };
}
