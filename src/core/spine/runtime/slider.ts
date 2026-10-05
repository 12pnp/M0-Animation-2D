import type { SliderData } from "./rigData";
import type { Rig } from "./rig";
import { boneProperty } from "./transform";

/**
 * Spine 4.3's slider constraint on the BoneBurst runtime's pose (the plan's
 * P2): its animation applied at the slider's time — or the time a bone's
 * property gives — mixed in by its mix, from the current pose or added. The
 * bones it keys rebuild after it. Behaviour measured against spine-core
 * (`SliderData`).
 */

export interface SliderPose { time: number; mix: number }

export function solveSlider(rig: Rig, k: SliderData, pose: SliderPose): void {
  if (pose.mix === 0 || k.animation < 0) return;
  const anim = rig.data.animations[k.animation]!;
  const d = anim.duration;
  // A time below 0 is 0, unless a bone drives a looping slider, which wraps
  // it into the animation (measured).
  let time = pose.time;
  if (k.bone >= 0) {
    time = k.to + (boneProperty(rig, k.bone, k.property, k.local) - k.from) * k.scale;
    if (k.loop && d > 0) {
      time %= d;
      if (time < 0) time += d;
    }
  } else if (k.loop && d > 0) time %= d;
  time = Math.max(0, time);
  const blend = k.additive ? "add" : "replace";
  for (const t of anim.timelines) {
    if (t.kind === "event") continue;
    if (t.kind === "attachment") rig.applyAttachment(t, time, blend, true);
    else rig.applyTimeline(t, time, pose.mix, blend, false);
  }
  for (const b of k.bones) rig.touched(b);
}
