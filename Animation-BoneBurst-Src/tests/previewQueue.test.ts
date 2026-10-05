import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData, AtlasAttachmentLoader, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { queueSteps } from "@/preview/queue";

describe("the queue's steps", () => {
  it.each([
    {
      name: "the first has no mix; the last loops with Loop on",
      entries: [{ name: "a", mix: 0.5 }, { name: "b", mix: 0.2 }, { name: "c", mix: 0.1 }], loop: true,
      want: [{ name: "a", mix: 0, loop: false }, { name: "b", mix: 0.2, loop: false }, { name: "c", mix: 0.1, loop: true }],
    },
    {
      name: "Loop off: none loops; a negative or broken mix is 0",
      entries: [{ name: "a", mix: 0 }, { name: "b", mix: -1 }, { name: "a", mix: Number.NaN }], loop: false,
      want: [{ name: "a", mix: 0, loop: false }, { name: "b", mix: 0, loop: false }, { name: "a", mix: 0, loop: false }],
    },
    {
      name: "an animation the skeleton lacks is left out",
      entries: [{ name: "gone", mix: 0 }, { name: "b", mix: 0.3 }], loop: true,
      want: [{ name: "b", mix: 0, loop: true }],
    },
  ])("$name", ({ entries, loop, want }) => {
    expect(queueSteps(entries, ["a", "b", "c"], loop)).toEqual(want);
  });
});

describe("spine-core plays a queue as the Preview builds it", () => {
  it("each animation starts as the one before ends, crossfading over its mix", () => {
    const anim = (deg: number, end: number) => ({ bones: { b: { rotate: [{ time: 0, value: deg }, { time: end, value: deg }] } } });
    const json = { skeleton: { spine: "4.3.13" }, bones: [{ name: "root" }, { name: "b", parent: "root" }], animations: { a: anim(10, 1), b: anim(50, 0.5), c: anim(90, 2) } };
    const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(json);
    const state = new AnimationState(new AnimationStateData(data));
    const skeleton = new Skeleton(data);
    const steps = queueSteps([{ name: "a", mix: 0 }, { name: "b", mix: 0.2 }, { name: "c", mix: 0.1 }], ["a", "b", "c"], true);
    // What the Preview client does with the steps.
    state.setAnimation(0, steps[0]!.name, steps[0]!.loop);
    for (const step of steps.slice(1)) state.addAnimation(0, step.name, step.loop, 0).setMixDuration(step.mix, 0);
    // In steps, as the Preview's ticks: a queued entry starts on an update
    // after the one where the previous reached its delay.
    const at = (t: number) => {
      for (let i = 0; i < 10; i++) { state.update(t / 10); state.apply(skeleton); }
      const e = state.getTrack(0)!;
      return { name: e.animation!.name, from: e.mixingFrom?.animation?.name ?? null, loop: e.loop };
    };
    expect(at(0.7)).toEqual({ name: "a", from: null, loop: false });
    // b starts 0.2 s before a ends (0.8 s) and runs 0.5 s; c starts 0.1 s before that ends (1.2 s).
    expect(at(0.2)).toEqual({ name: "b", from: "a", loop: false }); // 0.9 s
    expect(at(0.25)).toEqual({ name: "b", from: null, loop: false }); // 1.15 s
    expect(at(0.1)).toEqual({ name: "c", from: "b", loop: true }); // 1.25 s
  });
});
