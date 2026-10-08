import { describe, expect, it } from "vitest";
import { keyHandles, keySpeedPairs, keySpeeds, setKeyHandles, setTranslateKeySpeed, setTranslateKeySpeeds, spanSpeedSamples, translateNodes } from "@/edit/keySpeed";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Key, Skeleton } from "@/model/skeleton";
import { NO_IMAGES } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";

/** docs/FRAMEPATH-SPEED-PLAN.md: a FramePath node's speed, written into its keys' Bezier curves. */

const doc = (translate: unknown[], extra: Record<string, unknown> = {}) => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 30 },
  bones: [{ name: "root" }, { name: "hip", parent: "root" }],
  animations: { walk: { bones: { hip: { translate, ...extra } } } },
})).skeleton;
const THREE = [{ x: 0, y: 0 }, { time: 1, x: 30, y: 60 }, { time: 2, x: 30, y: 0 }];
const nodes = (s: Skeleton): readonly Key[] => translateNodes(s.animations![0]!, "hip")!;
/** The engine's x, y of `hip` at `time`. */
function at(s: Skeleton, time: number): [number, number] {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), NO_IMAGES));
  rig.setupPose();
  rig.apply(rig.animation("walk")!, time, false);
  return [rig.local[7]!, rig.local[8]!];
}

describe("keySpeeds", () => {
  it("reads straight spans as 0 and a stepped span as null", () => {
    expect(keySpeeds("hip", nodes(doc(THREE)))).toEqual([0, 0, 0]);
    expect(keySpeeds("hip", nodes(doc([{ x: 0, curve: "stepped" }, { time: 1, x: 10 }])))).toEqual([null, null]);
  });

  it("is null for split translate keys", () => {
    expect(translateNodes(doc([], { translatex: [{ value: 0 }, { time: 1, value: 5 }] }).animations![0]!, "hip")).toBeNull();
  });
});

describe("setTranslateKeySpeed", () => {
  it("writes the speed at a middle key into both spans and reads it back; the other ends keep theirs", () => {
    const s = setTranslateKeySpeed("walk", "hip", 1, 2)(doc(THREE));
    const speeds = keySpeeds("hip", nodes(s));
    expect(speeds[0]).toBe(0);
    expect(speeds[1]).toBeCloseTo(2, 6);
    expect(nodes(s)[0]!.curve).toHaveLength(8);
    expect(nodes(s)[1]!.curve).toHaveLength(8);
    // The span before ends at the key's speed, the span after starts at it.
    const before = spanSpeedSamples("hip", nodes(s)[0]!, nodes(s)[1]!, 10), after = spanSpeedSamples("hip", nodes(s)[1]!, nodes(s)[2]!, 10);
    expect(before[10]!.v).toBeCloseTo(2, 3);
    expect(after[0]!.v).toBeCloseTo(2, 3);
    expect(before[0]!.v).toBeCloseTo(0, 3);
  });

  it("keeps the keys' places and frames, and the bone on the line between them: only the timing changes", () => {
    const s = setTranslateKeySpeed("walk", "hip", 1, 3)(doc(THREE));
    expect(nodes(s).map((k) => [k.time ?? 0, k.x, k.y])).toEqual([[0, 0, 0], [1, 30, 60], [30 / 30 * 2, 30, 0]]);
    for (const t of [0.2, 0.5, 0.8]) {
      const [x, y] = at(s, t);
      expect(y / x).toBeCloseTo(2, 4);
    }
    // Faster at the key: the bone is behind the even pace mid-span.
    expect(at(s, 0.5)[0]).toBeLessThan(15);
  });

  it("back to 0 at both ends drops the curve", () => {
    const s = setTranslateKeySpeed("walk", "hip", 1, 0)(setTranslateKeySpeed("walk", "hip", 1, 1.5)(doc(THREE)));
    expect(nodes(s).every((k) => k.curve === undefined)).toBe(true);
  });

  it("the last key shapes only the span into it; a stepped neighbour becomes a curve", () => {
    const s = setTranslateKeySpeed("walk", "hip", 2, -0.5)(doc([{ x: 0 }, { time: 1, x: 10, curve: "stepped" }, { time: 2, x: 20 }]));
    expect(nodes(s)[0]!.curve).toBeUndefined();
    expect(keySpeeds("hip", nodes(s))[2]).toBeCloseTo(-0.5, 6);
    expect(keySpeeds("hip", nodes(s))[1]).toBeCloseTo(0, 6);
  });

  it("refuses split keys, a key that is not there, one key, and a speed that is not a number", () => {
    expect(() => setTranslateKeySpeed("walk", "hip", 0, 1)(doc([], { translatex: [{ value: 0 }, { time: 1, value: 5 }] }))).toThrow(/separate x and y/);
    expect(() => setTranslateKeySpeed("walk", "hip", 5, 1)(doc(THREE))).toThrow(/no translate key 6/);
    expect(() => setTranslateKeySpeed("walk", "hip", 0, 1)(doc([{ x: 1 }]))).toThrow(/one translate key/);
    expect(() => setTranslateKeySpeed("walk", "hip", 0, Number.NaN)(doc(THREE))).toThrow(/number/);
  });
});

describe("two speeds per key", () => {
  it("in and out are set and read on their own; a side left out keeps its span as it was (a stepped one too)", () => {
    const s = setTranslateKeySpeeds("walk", "hip", 1, { in: 1, out: -0.5 })(doc(THREE));
    expect(keySpeedPairs("hip", nodes(s))[1]).toEqual({ in: 1, out: -0.5 });
    const only = setTranslateKeySpeeds("walk", "hip", 1, { out: 2 })(doc([{ x: 0, curve: "stepped" }, { time: 1, x: 10 }, { time: 2, x: 20 }]));
    expect(nodes(only)[0]!.curve).toBe("stepped");
    expect(keySpeedPairs("hip", nodes(only))[1]).toEqual({ in: null, out: 2 });
  });

  it("the ends have one side: the first key no in, the last no out", () => {
    expect(keySpeedPairs("hip", nodes(doc(THREE)))).toEqual([{ in: null, out: 0 }, { in: 0, out: 0 }, { in: 0, out: null }]);
  });
});

describe("handles: the path's shape (step 5)", () => {
  const LINE = [{ x: 0, y: 0 }, { time: 1, x: 30, y: 0 }, { time: 2, x: 60, y: 0 }];

  it("a straight span's handles lie on its chord at a third; set ones read back", () => {
    expect(keyHandles("hip", nodes(doc(LINE)))[1]).toEqual({ in: [-10, 0], out: [10, 0] });
    const s = setKeyHandles("walk", "hip", 0, { out: [0, 12] })(doc(LINE));
    expect(keyHandles("hip", nodes(s))[0]!.out).toEqual([0, 12]);
    expect(nodes(s)[1]!.curve).toBeUndefined();
  });

  it("the span is the 2D Bezier of the key, its handles and the next key: the bone passes its middle point at the middle time", () => {
    const s = setKeyHandles("walk", "hip", 1, { in: [-10, 15], out: [10, 15] })(doc(LINE));
    // Span 0 → 1: P0 (0,0), P1 (10,0), P2 (30-10, 0+15), P3 (30,0); its middle is (P0 + 3 P1 + 3 P2 + P3) / 8.
    const [x, y] = at(s, 0.5);
    expect(x).toBeCloseTo((0 + 30 + 60 + 30) / 8, 0);
    expect(y).toBeCloseTo((0 + 0 + 45 + 0) / 8, 0);
  });

  it("a speed set on a curved key keeps the handle's direction and sets its length", () => {
    const s0 = setKeyHandles("walk", "hip", 1, { in: [-6, 8], out: [6, 8] })(doc(LINE));
    const s = setTranslateKeySpeeds("walk", "hip", 1, { out: 2 })(s0);
    const out = keyHandles("hip", nodes(s))[1]!.out!;
    expect(out[1] / out[0]).toBeCloseTo(8 / 6, 4);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(30, 3);
    expect(keySpeedPairs("hip", nodes(s))[1]!.out).toBeCloseTo(2, 4);
  });

  it("refuses a handle that is not two numbers", () => {
    expect(() => setKeyHandles("walk", "hip", 0, { out: [Number.NaN, 0] })(doc(LINE))).toThrow(/two numbers/);
  });
});
