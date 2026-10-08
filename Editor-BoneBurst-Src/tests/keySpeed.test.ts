import { describe, expect, it } from "vitest";
import { keySpeeds, setTranslateKeySpeed, spanSpeedSamples, translateNodes } from "@/edit/keySpeed";
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
