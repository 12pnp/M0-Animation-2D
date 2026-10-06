import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { keyBone, type LocalPose } from "@/edit/boneKeys";
import { PRESETS } from "@/edit/curves";
import { defineEvent, keyEvent } from "@/edit/events";
import { setCurve } from "@/edit/keys";
import { copyKeys, pasteKeys, pastePose } from "@/edit/paste";
import { readSkeleton } from "@/io/skeletonRead";
import { boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { frameTime, keysAt, keyTime } from "@/model/timelines";

/** Copy and paste (E6 step 4c): keys at the playhead onto the same timelines, eases refitted; a pose. */

const stick = readSkeleton(readFileSync(join(__dirname, "fixtures", "stickman", "Stickman_IK.json"), "utf8")).skeleton;
const fps = 24;
const rot = (s: Skeleton, anim: string, bone: string) => keysAt(s.animations!.find((a) => a.name === anim)!, { section: "bones", owner: bone, timeline: "rotate" }) ?? [];
const local = (s: Skeleton, bone: string, over: Partial<LocalPose> = {}): LocalPose => {
  const b = s.bones!.find((x) => x.name === bone)!;
  return { x: boneNumber(b, "x"), y: boneNumber(b, "y"), rotation: boneNumber(b, "rotation"), scaleX: boneNumber(b, "scaleX"), scaleY: boneNumber(b, "scaleY"), shearX: boneNumber(b, "shearX"), shearY: boneNumber(b, "shearY"), ...over };
};

describe("copy and paste (E6 step 4c)", () => {
  it("keys paste at the frame with their spacing, onto the same timelines of another animation, replacing what is there, the ease refitted", () => {
    let s = addAnimation("a")(addAnimation("b")(stick));
    for (const [f, r] of [[0, 10], [6, 40], [12, 10]] as const) s = keyBone("a", "head", ["rotate"], local(s, "head", { rotation: boneNumber(s.bones!.find((b) => b.name === "head")!, "rotation") + r }), frameTime(f, fps))(s);
    s = setCurve("a", [{ path: { section: "bones", owner: "head", timeline: "rotate" }, time: 0 }], PRESETS.easeInOut)(s);
    // b has a key at frame 20 that the paste replaces.
    s = keyBone("b", "head", ["rotate"], local(s, "head", { rotation: 99 }), frameTime(20, fps))(s);
    const clip = copyKeys(s.animations!.find((a) => a.name === "a")!, rot(s, "a", "head").slice(0, 2).map((k) => ({ path: { section: "bones", owner: "head", timeline: "rotate" }, time: keyTime(k) })), fps);
    expect(clip.keys.map((k) => k.offset)).toEqual([0, 6]);
    const out = pasteKeys("b", clip, 20, fps).edit(s);
    const keys = rot(out, "b", "head");
    expect(keys.map((k) => Math.round(keyTime(k) * fps))).toEqual([20, 26]);
    expect(keys.map((k) => k.value)).toEqual([10, 40]);
    // The ease's shape over its new interval: handles at the same shares of time and change.
    const c = keys[0]!.curve as number[], t0 = keyTime(keys[0]!), t1 = keyTime(keys[1]!);
    expect([(c[0]! - t0) / (t1 - t0), (c[1]! - 10) / 30, (c[2]! - t0) / (t1 - t0), (c[3]! - 10) / 30].map((x) => Math.round(x * 100) / 100)).toEqual([0.42, 0, 0.58, 1]);
  });

  it("an event pastes beside the events on its frame; a timeline whose owner the rig lacks is skipped and named", () => {
    let s = defineEvent("dust", {})(defineEvent("step", {})(addAnimation("a")(stick)));
    s = keyEvent("a", frameTime(2, fps), "step")(keyEvent("a", frameTime(8, fps), "dust")(s));
    const a = s.animations!.find((x) => x.name === "a")!;
    const clip = copyKeys(a, [{ path: { section: "events" }, time: frameTime(2, fps), name: "step" }], fps);
    const out = pasteKeys("a", clip, 8, fps).edit(s);
    expect((out.animations!.find((x) => x.name === "a")!.events ?? []).map((k) => `${k.name}@${Math.round(keyTime(k) * fps)}`)).toEqual(["step@2", "dust@8", "step@8"]);
    const ghost = { kind: "keys" as const, keys: [{ path: { section: "bones" as const, owner: "tail", timeline: "rotate" }, offset: 0, fields: { value: 5 }, ease: null }, ...clip.keys] };
    const p = pasteKeys("a", ghost, 12, fps);
    expect(p.skipped(s)).toEqual(["bones/tail"]);
    expect((p.edit(s).animations!.find((x) => x.name === "a")!.events ?? []).length).toBe(3);
  });

  it("a pose keys only the properties that differ at the frame; without an animation it sets the setup pose", () => {
    let s = addAnimation("a")(stick);
    const head = local(s, "head"), chest = local(s, "chest");
    const pose = { kind: "pose" as const, bones: new Map([["head", { ...head, rotation: head.rotation + 20 }], ["chest", chest], ["tail", chest]]) };
    const now = new Map([["head", head], ["chest", chest]]);
    const out = pastePose(pose, "a", frameTime(4, fps), now)(s);
    const tl = out.animations!.find((x) => x.name === "a")!.bones!;
    expect(tl.map((g) => `${g.name}:${g.timelines.map((t) => t.name).join(",")}`)).toEqual(["head:rotate"]);
    s = pastePose(pose, null, 0, now)(s);
    expect(boneNumber(s.bones!.find((b) => b.name === "head")!, "rotation")).toBeCloseTo(head.rotation + 20, 6);
    expect(() => pastePose({ kind: "pose", bones: new Map([["chest", chest]]) }, "a", 0, now)(stick)).toThrow(/already there/);
  });
});
