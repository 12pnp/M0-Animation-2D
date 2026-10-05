import { describe, expect, it } from "vitest";
import {
  AnimationState, AnimationStateData, AtlasAttachmentLoader, Physics, Skeleton, SkeletonJson, TextureAtlas,
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

function play(name: string, file: Json, atlas: string, plan: Array<{ anim: string; loop: boolean }>, count: number): number {
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
  for (const p of plan.slice(1)) state.addAnimation(0, p.anim, p.loop, 0).setMixDuration(0, 0);
  track.queue(plan.map((p) => ({ anim: rig.animation(p.anim)!, loop: p.loop, mix: 0 })));

  let fired = 0;
  const dts = [0, ...steps(count)];
  dts.forEach((dt, step) => {
    state.update(dt);
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.none);
    track.advance(dt);
    const mine = track.apply(rig).map((e: EventFire) => fmt(e));
    rig.updateWorld();
    const want = theirs.splice(0);
    if (mine.join() !== want.join()) throw new Error(`${name} step ${step}: events [${mine}] vs [${want}]`);
    fired += mine.length;
    skeleton.bones.forEach((b, i) => {
      if (!b.active) return;
      const p = b.appliedPose, got = rig.world.subarray(i * 6, i * 6 + 6);
      const want6 = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
      want6.forEach((v, j) => {
        if (Math.abs(got[j]! - v) > Math.max(1e-4, 1e-5 * Math.abs(v))) throw new Error(`${name} step ${step}: bone ${b.data.name} ${Array.from(got)} vs ${want6}`);
      });
    });
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
