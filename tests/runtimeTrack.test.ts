import { describe, expect, it } from "vitest";
import {
  AnimationState, AnimationStateData, AtlasAttachmentLoader, BoundingBoxAttachment, Physics, PointAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { type EventFire, readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import { Track } from "@/core/spine/runtime/track";
import { sampleRigs } from "./fixtures/spineSamples";
import { type Json, solvable } from "./fixtures/runtimeOracle";

/**
 * The BoneBurst runtime's track (`core/spine/runtime/track.ts`) against
 * spine-core's `AnimationState`, stepped with uneven frame times: the events
 * each step fires, with their values, and every bone's world matrix.
 */

/** Frame times as a browser gives them: around 60 a second, never even. */
const steps = (n: number) => Array.from({ length: n }, (_, i) => (1 / 60) * (0.6 + ((i * 7919) % 13) / 15));

const fmt = (e: { name: string; int: number; float: number; string: string; volume: number; balance: number }) =>
  `${e.name}:${e.int}:${e.float}:${e.string}:${e.volume}:${e.balance}`;

function play(name: string, file: Json, atlas: string, plan: Array<{ anim: string; loop: boolean; mix?: number }>, count: number): number {
  const json = solvable(file);
  const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlas))).readSkeletonData(json);
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  const theirs: string[] = [];
  state.addListener({ event: (_entry, e) => theirs.push(fmt({ name: e.data.name, int: e.intValue, float: e.floatValue, string: e.stringValue ?? "", volume: e.volume, balance: e.balance })) });
  const rig = new Rig(readRig(json, readAtlas(atlas)));
  const track = new Track();
  skeleton.setupPose();
  state.setAnimation(0, plan[0]!.anim, plan[0]!.loop);
  for (const p of plan.slice(1)) state.addAnimation(0, p.anim, p.loop, 0).setMixDuration(p.mix ?? 0, 0);
  track.queue(plan.map((p) => ({ anim: rig.animation(p.anim)!, loop: p.loop, mix: p.mix ?? 0 })));

  let fired = 0;
  const dts = [0, ...steps(count)];
  dts.forEach((dt, step) => {
    state.update(dt);
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.none);
    track.advance(dt);
    const mine = track.apply(rig).map((e: EventFire) => fmt(e));
    // What the mixing produced, before any constraint: strictly.
    const pre = Float64Array.from(rig.local);
    rig.updateWorld();
    const want = theirs.splice(0);
    if (mine.join() !== want.join()) throw new Error(`${name} step ${step}: events [${mine}] vs [${want}]`);
    fired += mine.length;
    // Positions at the rig's size, as `fixtures/runtimeOracle.ts` compares them.
    let size = 0;
    for (let i = 0; i < rig.world.length; i += 6) size = Math.max(size, Math.abs(rig.world[i + 4]!), Math.abs(rig.world[i + 5]!));
    skeleton.bones.forEach((b, i) => {
      if (!b.active) return;
      const pose = b.pose, local = pre.subarray(i * 7, i * 7 + 7);
      // Angles (rotation, shears) to 1e-4 degrees: a curve point's rounding step.
      [pose.x, pose.y, pose.rotation, pose.scaleX, pose.scaleY, pose.shearX, pose.shearY].forEach((v, j) => {
        const angle = j === 2 || j >= 5;
        if (Math.abs(local[j]! - v) > Math.max(angle ? 1e-4 : 1e-5, 1e-5 * Math.max(Math.abs(v), j < 2 ? size : 0))) throw new Error(`${name} step ${step}: bone ${b.data.name} local ${Array.from(local)} vs ${[pose.x, pose.y, pose.rotation, pose.scaleX, pose.scaleY, pose.shearX, pose.shearY]}`);
      });
      // The world after the constraints, which a near-straight IK chain can
      // turn a rounding step into thousandths with: to 1e-3 (matrices) and a
      // ten-thousandth of the rig (positions). The solvers are held strictly
      // in their own tests.
      const p = b.appliedPose, got = rig.world.subarray(i * 6, i * 6 + 6);
      const want6 = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
      want6.forEach((v, j) => {
        if (Math.abs(got[j]! - v) > (j >= 4 ? Math.max(1e-4, 1e-4 * Math.max(Math.abs(v), size)) : 1e-3)) throw new Error(`${name} step ${step}: bone ${b.data.name} ${Array.from(got)} vs ${want6}`);
      });
    });
    skeleton.slots.forEach((slot, i) => {
      const c = slot.appliedPose.color, got = rig.color.subarray(i * 7, i * 7 + 4);
      [c.r, c.g, c.b, c.a].forEach((v, j) => {
        if (Math.abs(got[j]! - v) > 1e-5) throw new Error(`${name} step ${step}: slot ${slot.data.name} colour ${Array.from(got)} vs ${[c.r, c.g, c.b, c.a]}`);
      });
      const shown = slot.bone.active ? slot.appliedPose.getAttachment() : null;
      // Points and boxes are not read yet (P3).
      if (shown instanceof PointAttachment || shown instanceof BoundingBoxAttachment) return;
      const mine = rig.attachmentOf(i)?.name ?? null;
      if ((shown?.name ?? null) !== mine) throw new Error(`${name} step ${step}: slot ${slot.data.name} shows ${mine} vs ${shown?.name ?? null}`);
    });
    const order = skeleton.drawOrder.appliedPose.map((s) => s.data.name).join();
    if (order !== rig.drawOrder.map((i) => rig.data.slots[i]!.name).join()) throw new Error(`${name} step ${step}: draw order`);
  });
  return fired;
}

describe("the track against spine-core's AnimationState", () => {
  const rigs = sampleRigs();
  for (const rig of rigs) {
    const file = JSON.parse(rig.json) as Json;
    const animations = Object.entries((file.animations as Record<string, Json>) ?? {});
    const withEvents = animations.filter(([, a]) => Array.isArray(a.events) && a.events.length).map(([n]) => n);
    if (!withEvents.length) continue;
    it(`${rig.name}: looping, events and pose`, () => {
      let fired = 0;
      for (const anim of withEvents) fired += play(`${rig.name} ${anim}`, file, rig.atlas, [{ anim, loop: true }], 300);
      expect(fired).toBeGreaterThan(0);
    });
    it(`${rig.name}: once, then held`, () => {
      for (const anim of withEvents) play(`${rig.name} ${anim}`, file, rig.atlas, [{ anim, loop: false }], 200);
    });
    it(`${rig.name}: queued without a crossfade`, () => {
      const names = animations.map(([n]) => n);
      const plan = [withEvents[0]!, names.find((n) => n !== withEvents[0]) ?? withEvents[0]!, withEvents[0]!];
      play(`${rig.name} queue`, file, rig.atlas, plan.map((anim, i) => ({ anim, loop: i === plan.length - 1 })), 400);
    });
  }
});

describe("crossfades against spine-core's AnimationState", () => {
  for (const rig of sampleRigs()) {
    const file = JSON.parse(rig.json) as Json;
    const names = Object.keys((file.animations as Record<string, Json>) ?? {});
    if (names.length < 2) continue;
    it(`${rig.name}: every animation into the next, crossfaded`, () => {
      for (let i = 0; i < names.length; i++) {
        const a = names[i]!, b = names[(i + 1) % names.length]!;
        play(`${rig.name} ${a} > ${b}`, file, rig.atlas, [{ anim: a, loop: false }, { anim: b, loop: true, mix: 0.25 }], 120);
      }
    });
    it(`${rig.name}: a crossfade interrupted by the next`, () => {
      const [a, b] = names as [string, string];
      const c = names[2] ?? a;
      // Each mix is longer than the animation before it lasts, so each
      // crossfade is cut short by the next.
      play(`${rig.name} ${a} > ${b} > ${c}`, file, rig.atlas, [
        { anim: a, loop: false }, { anim: b, loop: false, mix: 0.6 }, { anim: c, loop: true, mix: 0.9 },
      ], 240);
    });
  }
});
