import { describe, expect, it } from "vitest";
import { addAnimation, deleteAnimation, renameAnimation } from "@/edit/animations";
import { keyBone } from "@/edit/boneKeys";
import { PRESETS, remapCurve } from "@/edit/curves";
import { History } from "@/edit/history";
import { deleteKeys, moveKeys, setCurve, setKey } from "@/edit/keys";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson, writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration, frameTime, keysAt, keyTime, shortFloat, type TimelinePath, timeFrame } from "@/model/timelines";
import { NO_IMAGES } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import { compare, TOLERANCE } from "./fixtures/oracle";

const doc = (animations: Record<string, unknown> = { walk: {} }, extra: Record<string, unknown> = {}) => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 30 },
  bones: [{ name: "root" }, { name: "hip", parent: "root", rotation: 10, scaleX: 2, length: 20 }],
  animations, ...extra,
})).skeleton;
const ROT: TimelinePath = { section: "bones", owner: "hip", timeline: "rotate" };
const keys = (s: Skeleton, p: TimelinePath = ROT, anim = "walk") => keysAt(s.animations!.find((a) => a.name === anim)!, p);
/** The engine's local value of `hip` (index 1) at `time`, offset 0 rotation, 3 scale x. */
function pose(s: Skeleton, time: number, anim = "walk"): Float64Array {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), NO_IMAGES));
  rig.setupPose();
  rig.apply(rig.animation(anim)!, time, false);
  return rig.local.slice(7, 14);
}
/** Both runtimes read the document alike (setup pose and 11 times along each animation). */
function bothAgree(s: Skeleton): void {
  const { worst } = compare("edited", writeSkeleton(s), "", Array.from({ length: 11 }, (_, i) => i / 10));
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
  expect(profileIssues(s)).toEqual([]);
  expect(writeSkeleton(readSkeleton(writeSkeleton(s)).skeleton)).toBe(writeSkeleton(s));
}

describe("times", () => {
  it.each([[0, 30, 0], [4, 30, 0.13333334], [30, 30, 1], [1, 24, 0.041666668], [7, 30, 0.23333333]])(
    "frame %d at %d fps is written %d, as the Spine Editor writes it", (f, fps, t) => {
      expect(frameTime(f, fps)).toBe(t);
      expect(timeFrame(t, fps)).toBe(f);
    });
  it("reads float32-noisy times back to their frame", () => {
    expect(timeFrame(0.0833333283662796, 24)).toBe(2);
    expect(shortFloat(0.1 + 0.2)).toBe(0.3);
  });
});

describe("setKey", () => {
  it("creates the group and timeline, keeps keys in time order, and leaves time 0 out", () => {
    let s = doc();
    s = setKey("walk", ROT, frameTime(10, 30), { value: 30 })(s);
    s = setKey("walk", ROT, 0, { value: 0 })(s);
    s = setKey("walk", ROT, frameTime(5, 30), { value: 15 })(s);
    expect(keys(s)!.map((k) => [k.time, k.value])).toEqual([[undefined, 0], [0.16666667, 15], [0.33333334, 30]]);
    expect(pose(s, 0.25)[2]).toBeCloseTo(10 + 22.5, 4);
    bothAgree(s);
  });
  it("sets a key already at that time (the same float32), and records nothing when nothing changes", () => {
    let s = setKey("walk", ROT, 0.33333334, { value: 30 })(doc());
    s = setKey("walk", ROT, 1 / 3, { value: 40 })(s);
    expect(keys(s)!.map((k) => k.value)).toEqual([40]);
    const h = new History(s);
    expect(h.apply("same", setKey("walk", ROT, 1 / 3, { value: 40 }))).toBe(false);
  });
  it("refuses a missing animation", () => {
    expect(() => setKey("run", ROT, 0, { value: 1 })(doc())).toThrow(/no animation "run"/);
  });
});

describe("curves keep their shape when the keys around them change", () => {
  const eased = () => setCurve("walk", [{ path: ROT, time: 0 }], PRESETS.easeIn)(
    setKey("walk", ROT, 1, { value: 100 })(setKey("walk", ROT, 0, { value: 0 })(doc())));
  /** How far through its change the rotation is at fraction `f` of the interval. */
  const progress = (s: Skeleton, f: number) => {
    const ks = keys(s)!, t0 = keyTime(ks[0]!), t1 = keyTime(ks[1]!), v0 = ks[0]!.value ?? 0, v1 = ks[1]!.value ?? 0;
    return (pose(s, t0 + f * (t1 - t0))[2]! - 10 - v0) / (v1 - v0);
  };
  it("an ease in starts slow, as both runtimes play it", () => {
    const s = eased();
    expect(progress(s, 0.5)).toBeLessThan(0.4);
    bothAgree(s);
  });
  it.each([
    ["the end key's value changes", (s: Skeleton) => setKey("walk", ROT, 1, { value: -40 })(s)],
    ["the end key moves later", (s: Skeleton) => moveKeys("walk", [{ path: ROT, time: 1 }], 15, 30)(s)],
    ["the start key moves later", (s: Skeleton) => moveKeys("walk", [{ path: ROT, time: 0 }], 6, 30)(s)],
  ])("%s", (_, change) => {
    const before = eased(), after = change(before);
    for (const f of [0.2, 0.5, 0.8]) expect(progress(after, f)).toBeCloseTo(progress(before, f), 4);
    bothAgree(after);
  });
  it("without remapping, the shape would break (the test can fail)", () => {
    const before = eased();
    const moved = moveKeys("walk", [{ path: ROT, time: 1 }], 15, 30)(before);
    const raw = readSkeleton(writeSkeleton(moved).replace(/"curve": \[[^\]]*\]/, `"curve": ${JSON.stringify(keys(before)![0]!.curve)}`)).skeleton;
    expect(Math.abs(progress(raw, 0.5) - progress(before, 0.5))).toBeGreaterThan(0.01);
  });
  it("inserting a key inside an eased interval keeps the start's handles within the new interval", () => {
    const s = setKey("walk", ROT, 0.5, { value: 20 })(eased());
    const c = keys(s)![0]!.curve as number[];
    expect(c[0]).toBeGreaterThanOrEqual(0);
    expect(c[2]).toBeLessThanOrEqual(0.5);
    bothAgree(s);
  });
  it("leaves linear and stepped curves alone", () => {
    const seg = { t0: 0, t1: 1, v0: [0], v1: [1] }, seg2 = { t0: 0, t1: 2, v0: [0], v1: [5] };
    expect(remapCurve(undefined, seg, seg2)).toBeUndefined();
    expect(remapCurve("stepped", seg, seg2)).toBe("stepped");
  });
  it("sets stepped and linear, and refuses keys with no next key", () => {
    let s = setCurve("walk", [{ path: ROT, time: 0 }], "stepped")(eased());
    expect(keys(s)![0]!.curve).toBe("stepped");
    expect(pose(s, 0.9)[2]).toBeCloseTo(10, 6);
    s = setCurve("walk", [{ path: ROT, time: 0 }], "linear")(s);
    expect("curve" in keys(s)![0]!).toBe(false);
    expect(() => setCurve("walk", [{ path: ROT, time: 1 }], "stepped")(s)).toThrow(/next key/);
  });
});

describe("moveKeys and deleteKeys", () => {
  it("finds a key by the time the file stores, a float32 step off the frame's own (Spine exports do this)", () => {
    // 2/24 is stored 0.083333336 by us; the stickman's export has 0.0833333283662796.
    const s0 = doc({ walk: { bones: { hip: { rotate: [{ value: 0 }, { time: 0.0833333283662796, value: 5 }] } } } });
    const moved = moveKeys("walk", [{ path: ROT, time: 0.0833333283662796 }], 1, 24)(s0);
    expect(keys(moved)!.map((k) => timeFrame(keyTime(k), 24))).toEqual([0, 3]);
  });
  it("refuses to move onto a stored key a float32 step off the frame's own time", () => {
    const s0 = doc({ walk: { bones: { hip: { rotate: [{ value: 0 }, { time: 0.125, value: 5 }, { time: 0.1666666567325592, value: 9 }] } } } });
    expect(() => moveKeys("walk", [{ path: ROT, time: 0.125 }], 1, 24)(s0)).toThrow(/already a key at frame 4/);
  });
  it("keying at a frame sets the stored key there, not a second one beside it", () => {
    const s0 = doc({ walk: { bones: { hip: { rotate: [{ value: 0 }, { time: 0.1666666567325592, value: 9 }] } } } });
    const s = setKey("walk", ROT, frameTime(4, 24), { value: 12 })(s0);
    expect(keys(s)!.map((k) => [k.time ?? 0, k.value])).toEqual([[0, 0], [0.1666666567325592, 12]]);
  });
  it("an edit that matches no key changes nothing: the same document, so no empty undo step", () => {
    const s0 = doc({ walk: { bones: { hip: { rotate: [{ value: 0 }, { time: 0.5, value: 5 }] } } } });
    expect(moveKeys("walk", [{ path: ROT, time: 0.25 }], 1, 24)(s0)).toBe(s0);
    expect(deleteKeys("walk", [{ path: ROT, time: 0.25 }])(s0)).toBe(s0);
    const h = new History(s0);
    expect(h.apply("Move", moveKeys("walk", [{ path: ROT, time: 0.25 }], 1, 24))).toBe(false);
  });
  const three = () => [0, 10, 20].reduce((s, f) => setKey("walk", ROT, frameTime(f, 30), { value: f })(s), doc());
  it("moves by whole frames and keeps the order, even past another key", () => {
    const s = moveKeys("walk", [{ path: ROT, time: 0 }], 25, 30)(three());
    expect(keys(s)!.map((k) => timeFrame(keyTime(k), 30))).toEqual([10, 20, 25]);
    expect(keys(s)!.map((k) => k.value)).toEqual([10, 20, 0]);
  });
  it.each([
    ["onto a key that stays", 10, /already a key at frame 10/],
    ["before 0", -1, /before 0/],
  ])("refuses a move %s", (_, by, why) => {
    expect(() => moveKeys("walk", [{ path: ROT, time: 0 }], by, 30)(three())).toThrow(why);
  });
  it("deleting the last keys removes the timeline, the group and the section", () => {
    const s = three();
    const gone = deleteKeys("walk", [0, 10, 20].map((f) => ({ path: ROT, time: frameTime(f, 30) })))(s);
    expect(gone.animations![0]!.bones).toBeUndefined();
    expect(writeSkeleton(gone)).toContain('"walk": {}');
  });
  it("the animation's length follows its last key", () => {
    expect(animationDuration(three().animations![0]!)).toBe(frameTime(20, 30));
  });
});

describe("keying a bone's pose", () => {
  const local = { x: 5, y: -3, rotation: 40, scaleX: 3, scaleY: 1, shearX: 0, shearY: 0 };
  it("writes offsets and factors of the setup pose, which pose back to the same local values", () => {
    const s = keyBone("walk", "hip", ["rotate", "translate", "scale"], local, frameTime(6, 30))(doc());
    // Posed at the frame's float32 time, as the playhead poses (a key at 0.2 is stored 0.2000000029).
    const at = pose(s, Math.fround(frameTime(6, 30)));
    expect([at[0], at[1], at[2], at[3], at[4]].map((v) => Math.round(v! * 1e4) / 1e4)).toEqual([5, -3, 40, 3, 1]);
    expect(keys(s, { section: "bones", owner: "hip", timeline: "scale" })![0]).toMatchObject({ x: 1.5, y: 1 });
    expect(keys(s)![0]).toMatchObject({ value: 30 });
    bothAgree(s);
  });
  it("uses split timelines when the bone already has them", () => {
    const s0 = doc({ walk: { bones: { hip: { translatex: [{ value: 1 }] } } } });
    const s = keyBone("walk", "hip", ["translate"], local, 0)(s0);
    expect(keys(s, { section: "bones", owner: "hip", timeline: "translatex" })!.map((k) => k.value)).toEqual([5]);
    expect(keys(s, { section: "bones", owner: "hip", timeline: "translatey" })!.map((k) => k.value)).toEqual([-3]);
    expect(keys(s, { section: "bones", owner: "hip", timeline: "translate" })).toBeUndefined();
  });
  it("refuses scale on a bone whose setup scale is 0", () => {
    const s0 = readSkeleton(JSON.stringify({ bones: [{ name: "root" }, { name: "hip", parent: "root", scaleX: 0 }], animations: { walk: {} } })).skeleton;
    expect(() => keyBone("walk", "hip", ["scale"], local, 0)(s0)).toThrow(/setup scale of 0/);
  });
});

describe("animations", () => {
  const slider = { constraints: [{ name: "s", type: "slider", animation: "walk" }] };
  it("adds, refusing an empty or taken name", () => {
    expect(addAnimation("run")(doc()).animations!.map((a) => a.name)).toEqual(["walk", "run"]);
    expect(() => addAnimation("walk")(doc())).toThrow(/already/);
    expect(() => addAnimation(" ")(doc())).toThrow(/needs a name/);
  });
  it("deletes, but not one a slider plays", () => {
    expect(deleteAnimation("walk")(doc()).animations).toBeUndefined();
    expect(() => deleteAnimation("walk")(doc({ walk: {} }, slider))).toThrow(/slider "s" plays/);
  });
  it("renames, and the slider follows", () => {
    const s = renameAnimation("walk", "stroll")(doc({ walk: {} }, slider));
    expect(s.animations![0]!.name).toBe("stroll");
    expect(s.constraints![0]).toMatchObject({ animation: "stroll" });
    expect(profileIssues(s)).toEqual([]);
  });
});

describe("the engine reads keys as spine-core does", () => {
  it("a slider time key with no value is 1 (Format-Json-Atlas.md §11.9)", () => {
    const json = JSON.stringify({
      skeleton: { spine: "4.3.0" },
      bones: [{ name: "root" }, { name: "b", parent: "root", length: 10 }],
      constraints: [{ name: "s", type: "slider", animation: "spin", time: 0 }],
      animations: {
        spin: { bones: { b: { rotate: [{ value: 0 }, { time: 1, value: 90 }] } } },
        drive: { slider: { s: { time: [{ time: 0 }, { time: 1 }] } } },
      },
    });
    const { worst } = compare("slider", json, "");
    expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
  });
});
