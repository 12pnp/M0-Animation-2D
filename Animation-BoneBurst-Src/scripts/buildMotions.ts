/**
 * Writes `src/core/rig/motions.json`, the motion library `apply_motion`
 * retargets (`core/rig/motion.ts`). Run: npx vite-node scripts/buildMotions.ts
 *
 * Side clips face right: +x is forward, a thigh at -90 hangs straight down,
 * one at -60 reaches forward. A shin is its thigh less the knee bend; a
 * forearm its upper arm plus the elbow bend. Feet, hands, head and hips are
 * offsets from the rig's own setup angle (`ROLES`). Front clips use screen
 * left and right.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MotionClip } from "@/core/rig/motion";

const TAU = Math.PI * 2;
const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
const pos = (v: number) => Math.max(0, v);

/** Keys every `step` frames over a cycle, `fn` of the phase 0..2π. Frame
 *  `frames` gets the phase-0 value, so a loop closes exactly. */
function cycle(frames: number, step: number, fn: (p: number) => number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let f = 0; f < frames; f += step) out.push([f, r2(fn((TAU * f) / frames))]);
  out.push([frames, out[0]![1]]);
  return out;
}

/** Keys every `step` frames, linear between the given poses. */
function poses(frames: number, step: number, at: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let f = 0; f <= frames; f += step) {
    let i = 1;
    while (i < at.length - 1 && at[i]![0] < f) i++;
    const [f0, v0] = at[i - 1]!, [f1, v1] = at[i]!;
    out.push([f, r2(f <= f0 ? v0 : f >= f1 ? v1 : v0 + ((v1 - v0) * (f - f0)) / (f1 - f0))]);
  }
  if (out[out.length - 1]![0] !== frames) out.push([frames, at[at.length - 1]![1]]);
  return out;
}

/** A side-view gait: legs in opposition, arms against the legs. */
function gait(o: { frames: number; stride: number; kneeSwing: number; kneeStance: number; toe: number; arm: number; elbow: number; elbowSwing: number; lean: number; bob: number; lift: number }) {
  const thigh = (p: number) => -90 + o.stride * Math.sin(p);
  const bend = (p: number) => o.kneeStance + o.kneeSwing * pos(Math.cos(p)) ** 1.3;
  const upper = (p: number) => -90 + o.arm * Math.sin(p + Math.PI);
  const elbow = (p: number) => o.elbow + o.elbowSwing * pos(Math.sin(p + Math.PI));
  const angles: MotionClip["angles"] = {};
  for (const [side, shift] of [["near", 0], ["far", Math.PI]] as const) {
    angles[`thigh.${side}`] = cycle(o.frames, 2, (p) => thigh(p + shift));
    angles[`shin.${side}`] = cycle(o.frames, 2, (p) => thigh(p + shift) - bend(p + shift));
    angles[`foot.${side}`] = cycle(o.frames, 2, (p) => -o.toe * pos(Math.cos(p + shift)));
    angles[`upperArm.${side}`] = cycle(o.frames, 2, (p) => upper(p + shift));
    angles[`forearm.${side}`] = cycle(o.frames, 2, (p) => upper(p + shift) + elbow(p + shift));
  }
  angles.torso = cycle(o.frames, 2, (p) => 90 - o.lean + o.bob * Math.sin(2 * p));
  angles.head = cycle(o.frames, 2, (p) => 0.5 * o.bob * Math.sin(2 * p + 1));
  // The legs already raise and lower the body; `lift` is a flight phase.
  if (!o.lift) return { angles };
  const hips = cycle(o.frames, 2, (p) => o.lift * pos(Math.sin(2 * p))).map(([f, y]) => [f, 0, y] as [number, number, number]);
  return { angles, hips };
}

const clips: MotionClip[] = [];

clips.push({
  name: "walk", description: "Side view, facing right: a relaxed walk cycle in place, one second at 24 fps.",
  view: "side", fps: 24, frames: 24, loop: true, grounded: true,
  ...gait({ frames: 24, stride: 24, kneeSwing: 50, kneeStance: 5, toe: 20, arm: 20, elbow: 18, elbowSwing: 14, lean: 4, bob: 1.5, lift: 0 }),
});

clips.push({
  name: "run", description: "Side view, facing right: a run cycle in place, two strides in 16 frames, with a flight phase.",
  view: "side", fps: 24, frames: 16, loop: true, grounded: true,
  ...gait({ frames: 16, stride: 38, kneeSwing: 85, kneeStance: 22, toe: 25, arm: 40, elbow: 75, elbowSwing: 15, lean: 12, bob: 2, lift: 0.07 }),
});

{
  const angles: MotionClip["angles"] = {};
  for (const [side, spread, sway] of [["near", 2, 1], ["far", -2, -1]] as const) {
    angles[`thigh.${side}`] = cycle(48, 4, () => -90 + spread);
    angles[`shin.${side}`] = cycle(48, 4, () => -92 + spread);
    angles[`upperArm.${side}`] = cycle(48, 4, (p) => -90 + sway * 2 + 2 * Math.sin(p));
    angles[`forearm.${side}`] = cycle(48, 4, (p) => -80 + sway * 2 + 3 * Math.sin(p - 0.4));
  }
  angles.torso = cycle(48, 4, (p) => 90 + 1.2 * Math.sin(p));
  angles.head = cycle(48, 4, (p) => 1.5 * Math.sin(p - 0.6));
  clips.push({
    name: "idle", description: "Side view, facing right: standing, breathing, a slight head sway. Two seconds.",
    view: "side", fps: 24, frames: 48, loop: true, grounded: true, angles,
  });
}

{
  // Crouch, launch, tuck in the air, land, recover.
  const bend: Array<[number, number]> = [[0, 0], [6, 75], [10, 0], [15, 40], [20, 10], [24, 70], [32, 0]];
  const angles: MotionClip["angles"] = {};
  for (const side of ["near", "far"]) {
    angles[`thigh.${side}`] = poses(32, 2, bend.map(([f, b]) => [f, -90 + b * 0.55]));
    angles[`shin.${side}`] = poses(32, 2, bend.map(([f, b]) => [f, -90 - b * 0.45]));
    angles[`upperArm.${side}`] = poses(32, 2, [[0, -90], [6, -130], [10, 60], [15, 40], [20, -20], [24, -70], [32, -90]]);
    angles[`forearm.${side}`] = poses(32, 2, [[0, -80], [6, -115], [10, 80], [15, 70], [20, 0], [24, -40], [32, -80]]);
  }
  angles.torso = poses(32, 2, [[0, 88], [6, 65], [10, 88], [15, 86], [24, 72], [32, 88]]);
  clips.push({
    name: "jump", description: "Side view, facing right: crouch, jump straight up, land and recover. Feet leave the ground from frame 10 to 20.",
    view: "side", fps: 24, frames: 32, loop: true, grounded: true, angles,
    hips: poses(32, 1, [[0, 0], [10, 0], [15, 0.5], [20, 0], [32, 0]]).map(([f, y]) => [f, 0, y]),
  });
}

{
  const angles: MotionClip["angles"] = {};
  for (const [side, out] of [["left", -1], ["right", 1]] as const) {
    angles[`thigh.${side}`] = cycle(48, 4, () => -90 + out * 6);
    angles[`shin.${side}`] = cycle(48, 4, () => -90 + out * 4);
    angles[`upperArm.${side}`] = cycle(48, 4, (p) => -90 + out * (10 + 2 * Math.sin(p)));
    angles[`forearm.${side}`] = cycle(48, 4, (p) => -90 + out * (4 + 2 * Math.sin(p - 0.4)));
  }
  angles.torso = cycle(48, 4, (p) => 90 + Math.sin(p));
  angles.head = cycle(48, 4, (p) => 2 * Math.sin(p - 0.6));
  clips.push({
    name: "idle_front", description: "Front view: standing facing the viewer, breathing, a slight head sway. Two seconds.",
    view: "front", fps: 24, frames: 48, loop: true, grounded: true, angles,
  });

  const wave: MotionClip["angles"] = { ...angles };
  for (const k of Object.keys(wave)) wave[k] = cycle(24, 2, (p) => sampleAt(angles[k]!, (48 * p) / TAU));
  wave["upperArm.right"] = cycle(24, 2, (p) => 50 + 4 * Math.sin(p));
  wave["forearm.right"] = cycle(24, 2, (p) => 95 + 30 * Math.sin(2 * p));
  wave.head = cycle(24, 2, (p) => -5 + Math.sin(p));
  clips.push({
    name: "wave", description: "Front view: waving the screen-right hand above the shoulder, the head tilted. One second.",
    view: "front", fps: 24, frames: 24, loop: true, grounded: true, angles: wave,
  });

  const bend: Array<[number, number]> = [[0, 0], [6, 1], [10, 0], [15, 0.4], [20, 0.1], [24, 1], [32, 0]];
  const jump: MotionClip["angles"] = {};
  for (const [side, out] of [["left", -1], ["right", 1]] as const) {
    jump[`thigh.${side}`] = poses(32, 2, bend.map(([f, b]) => [f, -90 + out * (6 + 30 * b)]));
    jump[`shin.${side}`] = poses(32, 2, bend.map(([f, b]) => [f, -90 + out * (4 - 22 * b)]));
    jump[`upperArm.${side}`] = poses(32, 2, [[0, -90 + out * 10], [6, -90 + out * 25], [10, 90 - out * 40], [15, 90 - out * 30], [20, -90 + out * 60], [24, -90 + out * 30], [32, -90 + out * 10]]);
    jump[`forearm.${side}`] = poses(32, 2, [[0, -90 + out * 4], [6, -90 + out * 20], [10, 90 - out * 30], [15, 90 - out * 20], [20, -90 + out * 70], [24, -90 + out * 25], [32, -90 + out * 4]]);
  }
  jump.torso = poses(32, 2, [[0, 90], [32, 90]]);
  clips.push({
    name: "jump_front", description: "Front view: crouch, jump with the arms up, land and recover. Feet leave the ground from frame 10 to 20.",
    view: "front", fps: 24, frames: 32, loop: true, grounded: true, angles: jump,
    hips: poses(32, 1, [[0, 0], [10, 0], [15, 0.5], [20, 0], [32, 0]]).map(([f, y]) => [f, 0, y]),
  });
}

function sampleAt(keys: Array<[number, number]>, frame: number): number {
  let i = 1;
  while (i < keys.length - 1 && keys[i]![0] < frame) i++;
  const [f0, v0] = keys[i - 1]!, [f1, v1] = keys[i]!;
  return v0 + ((v1 - v0) * Math.min(1, Math.max(0, (frame - f0) / (f1 - f0))));
}

const out = fileURLToPath(new URL("../src/core/rig/motions.json", import.meta.url));
writeFileSync(out, JSON.stringify(clips) + "\n");
console.log(`${clips.length} clips → ${out}: ${clips.map((c) => c.name).join(", ")}`);
