import { describe, expect, it } from "vitest";
import { packAnimation, trimAnimation } from "@/edit/fitLength";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { keysAt } from "@/model/timelines";
import { NO_IMAGES } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";

/** docs/FRAME-LIMIT-PLAN.md, step 1: an animation fitted into a last frame, by Pack or Trim. At 10 fps, frame n is time n / 10. */

const doc = (anim: Record<string, unknown>) => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 10 },
  bones: [{ name: "root" }, { name: "hip", parent: "root" }],
  slots: [{ name: "s", bone: "hip", attachment: "a" }],
  skins: [{ name: "default", attachments: { s: { a: { width: 10, height: 10 }, b: { width: 10, height: 10 } } } }],
  events: { step: {} },
  animations: { walk: anim },
})).skeleton;
const anim = (s: Skeleton): Animation => s.animations![0]!;
const list = (s: Skeleton, timeline: string, owner = "hip", section: "bones" | "slots" = "bones"): readonly Key[] => keysAt(anim(s), { section, owner, timeline }) ?? [];
const times = (ks: readonly Key[]) => ks.map((k) => Math.round((k.time ?? 0) * 10));
/** The engine's hip x, y at `time`. */
function pose(s: Skeleton, time: number): [number, number] {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), NO_IMAGES));
  rig.setupPose();
  rig.apply(rig.animation("walk")!, time, false);
  return [rig.local[7]!, rig.local[8]!];
}

const WALK = {
  bones: { hip: {
    translate: [{ x: 0, y: 0, curve: [1, 0, 3, 20, 1, 0, 3, 40] }, { time: 4, x: 20, y: 40 }, { time: 5, x: 50, y: 100 }],
    rotate: [{ value: 0 }, { time: 2.5, value: 90 }],
  } },
  slots: { s: { rgba: [{ color: "ff0000ff" }, { time: 5, color: "0000ffff" }], attachment: [{ name: "a" }, { time: 4.5, name: "b" }] } },
  events: [{ time: 1, name: "step" }, { time: 4, name: "step" }],
};

describe("packAnimation", () => {
  it("scales every list's keys into the last frame, rounded to frames, the last key on it", () => {
    const s = packAnimation("walk", 30, 10)(doc(WALK));
    expect(times(list(s, "translate"))).toEqual([0, 24, 30]);
    expect(times(list(s, "rotate"))).toEqual([0, 15]);
    expect(times(list(s, "rgba", "s", "slots"))).toEqual([0, 30]);
    expect(times(list(s, "attachment", "s", "slots"))).toEqual([0, 27]);
    expect(times(anim(s).events ?? [])).toEqual([6, 24]);
  });

  it("carries each bezier to its interval's new ends: its handles keep their share of the interval", () => {
    const s = packAnimation("walk", 30, 10)(doc(WALK)), c = list(s, "translate")[0]!.curve as number[];
    // 0 → 4 s became 0 → 2.4 s: the time handles at 1 and 3 become 0.6 and 1.8; the values stay.
    expect(c[0]).toBeCloseTo(0.6, 5);
    expect(c[2]).toBeCloseTo(1.8, 5);
    expect(c[3]).toBeCloseTo(20, 5);
  });

  it("leaves an animation that already ends by the last frame as it is", () => {
    const d = doc(WALK);
    expect(packAnimation("walk", 50, 10)(d)).toBe(d);
  });

  it("refuses, changing nothing, when two keys of a list would land on one frame; and a last frame that is not a whole number from 1", () => {
    const d = doc({ bones: { hip: { rotate: [{ value: 0 }, { time: 0.1, value: 10 }, { time: 0.2, value: 20 }, { time: 5, value: 0 }] } } });
    expect(() => packAnimation("walk", 10, 10)(d)).toThrow(/hip's rotate on frame 0/);
    expect(() => packAnimation("walk", 0, 10)(d)).toThrow(/whole number/);
  });
});

describe("trimAnimation", () => {
  it("cuts the keys after the last frame and keys every list with values there: the motion up to it is the same", () => {
    const before = doc(WALK), s = trimAnimation("walk", 30, 10)(before);
    expect(times(list(s, "translate"))).toEqual([0, 30]);
    // The exact curve up to the cut is the same: the split's left part, at the key's start and the cut, reaching the original's value.
    const exact = (c: readonly number[], t0: number, v0: number, t1: number, v1: number, t: number): number => {
      const x = (u: number) => (1 - u) ** 3 * t0 + 3 * (1 - u) ** 2 * u * c[0]! + 3 * (1 - u) * u * u * c[2]! + u ** 3 * t1;
      const y = (u: number) => (1 - u) ** 3 * v0 + 3 * (1 - u) ** 2 * u * c[1]! + 3 * (1 - u) * u * u * c[3]! + u ** 3 * v1;
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (x(m) < t) lo = m; else hi = m; }
      return y((lo + hi) / 2);
    };
    const oc = list(before, "translate")[0]!.curve as number[], nc = list(s, "translate")[0]!.curve as number[], cutX = list(s, "translate")[1]!.x!;
    for (const t of [0.5, 1.5, 2.2, 2.9]) expect(exact(nc.slice(0, 4), 0, 0, 3, cutX, t)).toBeCloseTo(exact(oc.slice(0, 4), 0, 0, 4, 20, t), 4);
    // As played (Spine samples a bezier in 10 steps, so the shorter curve's samples fall elsewhere): within a fifth of a unit.
    for (const t of [0.5, 1.5, 2.2, 3]) {
      const a = pose(before, t), b = pose(s, t);
      expect(Math.abs(b[0] - a[0])).toBeLessThan(0.2);
      expect(Math.abs(b[1] - a[1])).toBeLessThan(0.4);
    }
    // The rotate list ends at 2.5 s: before the cut, untouched.
    expect(list(s, "rotate")).toEqual(list(before, "rotate"));
  });

  it("keys a colour at the cut with its value there, as hex", () => {
    const s = trimAnimation("walk", 30, 10)(doc(WALK)), ks = list(s, "rgba", "s", "slots");
    expect(times(ks)).toEqual([0, 30]);
    // Linear red → blue, 3/5 of the way: 40% red, 60% blue.
    expect(ks[1]!.color).toBe("660099ff");
  });

  it("a list without values only loses its later keys; events after the cut go", () => {
    const s = trimAnimation("walk", 30, 10)(doc(WALK));
    expect(times(list(s, "attachment", "s", "slots"))).toEqual([0]);
    expect(times(anim(s).events ?? [])).toEqual([10]);
  });

  it("a key right on the cut needs no new key; an animation with nothing after the cut is left as it is", () => {
    const s = trimAnimation("walk", 40, 10)(doc(WALK));
    expect(times(list(s, "translate"))).toEqual([0, 40]);
    const d = doc(WALK);
    expect(trimAnimation("walk", 50, 10)(d)).toBe(d);
  });
});
