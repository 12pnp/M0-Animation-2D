import { describe, expect, it } from "vitest";
import { keyHandles, keyReaches, keySpeedPairs, keySpeeds, REACH_MIN, retimeTranslateKey, setKeyHandles, setTranslateKeyReaches, setTranslateKeySpeed, setTranslateKeySpeeds, spanSpeedSamples, translateNodes } from "@/edit/keySpeed";
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

  /** The bone's places across span 0 → 1 (the first second), at `n` + 1 times. */
  const across = (doc0: Skeleton, n = 40): [number, number][] => Array.from({ length: n + 1 }, (_, j) => at(doc0, j / n));
  /** How far a point is from the 2D Bezier P0 P1 P2 P3, sampled finely. */
  const offCurve = (q: [number, number], P: [number, number][]): number => {
    let best = Infinity;
    for (let j = 0; j <= 2000; j++) {
      const s = j / 2000, w = [(1 - s) ** 3, 3 * (1 - s) ** 2 * s, 3 * (1 - s) * s * s, s ** 3];
      const x = w.reduce((m, c, k) => m + c * P[k]![0], 0), y = w.reduce((m, c, k) => m + c * P[k]![1], 0);
      best = Math.min(best, Math.hypot(q[0] - x, q[1] - y));
    }
    return best;
  };

  it("the bone follows the 2D Bezier of the key, its handles and the next key", () => {
    const s = setKeyHandles("walk", "hip", 1, { in: [-10, 15], out: [10, 15] })(doc(LINE));
    // Span 0 → 1: P0 (0,0), P1 (10,0), P2 (30-10, 0+15), P3 (30,0). The engine draws a Bezier in straight steps, so within a unit.
    const P: [number, number][] = [[0, 0], [10, 0], [20, 15], [30, 0]];
    for (const q of across(s)) expect(offCurve(q, P)).toBeLessThan(1);
    expect(Math.max(...across(s).map((q) => q[1]))).toBeGreaterThan(5);
  });

  it("a speed never moves the path: on a curved span the bone stays on the same curve, only sooner or later", () => {
    const shaped = setKeyHandles("walk", "hip", 1, { in: [-10, 15], out: [10, 15] })(doc(LINE)), P: [number, number][] = [[0, 0], [10, 0], [20, 15], [30, 0]];
    for (const v of [-0.3, 1, 4]) {
      const s = setTranslateKeySpeeds("walk", "hip", 1, { in: v })(shaped);
      expect(keyHandles("hip", nodes(s))[1]).toEqual(keyHandles("hip", nodes(shaped))[1]);
      for (const q of across(s)) expect(offCurve(q, P)).toBeLessThan(1);
    }
    // The timing did change: the bone is elsewhere on the curve at the same time.
    const fast = setTranslateKeySpeeds("walk", "hip", 1, { in: 4 })(shaped);
    expect(Math.hypot(at(fast, 0.5)[0] - at(shaped, 0.5)[0], at(fast, 0.5)[1] - at(shaped, 0.5)[1])).toBeGreaterThan(1);
  });

  it("on a straight span every speed fits and the bone never passes the next key", () => {
    for (const v of [-0.99, 2, 5]) {
      const s = setTranslateKeySpeeds("walk", "hip", 0, { out: v })(doc(LINE));
      expect(keySpeedPairs("hip", nodes(s))[0]!.out).toBeCloseTo(v, 3);
      for (const q of across(s)) { expect(q[0]).toBeGreaterThanOrEqual(-1e-6); expect(q[0]).toBeLessThanOrEqual(30 + 1e-6); expect(Math.abs(q[1])).toBeLessThan(1e-6); }
    }
  });

  it("a speed on a curved key keeps its handle and reads back; slower than the handle allows gives the slowest it allows", () => {
    const s0 = setKeyHandles("walk", "hip", 1, { in: [-6, 8], out: [6, 8] })(doc(LINE));
    const s = setTranslateKeySpeeds("walk", "hip", 1, { out: 2 })(s0);
    expect(keyHandles("hip", nodes(s))[1]!.out).toEqual([6, 8]);
    expect(keySpeedPairs("hip", nodes(s))[1]!.out).toBeCloseTo(2, 3);
    // On a curved span the time handle reaches the span's end at a third of the even pace: speed −2/3 is the slowest (step 9).
    const slow = setTranslateKeySpeeds("walk", "hip", 1, { out: -0.9 })(s0);
    expect(keySpeedPairs("hip", nodes(slow))[1]!.out).toBeCloseTo(1 / 3 - 1, 3);
  });

  it("moving a path handle on a curved span leaves the speed graph exactly as it was (step 9)", () => {
    const curved = setTranslateKeySpeeds("walk", "hip", 1, { in: 1.2, out: 0.4 })(setKeyHandles("walk", "hip", 1, { in: [-6, 8], out: [6, 8] })(doc(LINE)));
    const graph = (d: Skeleton) => [0, 1].flatMap((j) => spanSpeedSamples("hip", nodes(d)[j]!, nodes(d)[j + 1]!, 12).map((q) => Math.round(q.v * 1e3) / 1e3));
    for (const h of [[-20, 25], [-2, 1], [-15, -10]] as const) {
      const moved = setKeyHandles("walk", "hip", 1, { in: [h[0], h[1]], out: [-h[0], -h[1]] })(curved);
      expect(graph(moved)).toEqual(graph(curved));
      expect(keySpeedPairs("hip", nodes(moved))[1]).toEqual(keySpeedPairs("hip", nodes(curved))[1]);
    }
  });

  it("a new handle keeps the speeds", () => {
    const fast = setTranslateKeySpeeds("walk", "hip", 1, { out: 1.5 })(doc(LINE));
    const s = setKeyHandles("walk", "hip", 1, { out: [8, 12] })(fast);
    expect(keySpeedPairs("hip", nodes(s))[1]!.out).toBeCloseTo(1.5, 3);
  });

  it("refuses a handle that is not two numbers", () => {
    expect(() => setKeyHandles("walk", "hip", 0, { out: [Number.NaN, 0] })(doc(LINE))).toThrow(/two numbers/);
  });
});

describe("reach: a leg's length on a straight span (step 10)", () => {
  const reaches = (s: Skeleton) => keyReaches("hip", nodes(s));

  it("a span with no curve reaches a third each side; the ends have one side", () => {
    expect(reaches(doc(THREE))).toEqual([{ in: null, out: 1 / 3 }, { in: 1 / 3, out: 1 / 3 }, { in: 1 / 3, out: null }]);
  });

  it("is set and read back on its own side; the speeds and the line stay", () => {
    const fast = setTranslateKeySpeed("walk", "hip", 1, 1)(doc(THREE));
    const s = setTranslateKeyReaches("walk", "hip", 1, { out: 0.45 })(fast);
    expect(reaches(s)[1]).toEqual({ in: reaches(fast)[1]!.in, out: 0.45 });
    expect(reaches(s)[2]!.in).toBeCloseTo(1 / 3, 4);
    const before = keySpeedPairs("hip", nodes(fast))[1]!, after = keySpeedPairs("hip", nodes(s))[1]!;
    expect(after.out).toBeCloseTo(before.out!, 3);
    expect(after.in).toBeCloseTo(before.in!, 3);
    for (const t of [1.2, 1.5, 1.8]) expect(at(s, t)[0]).toBeCloseTo(30, 4);
  });

  it("a longer reach keeps the key's speed further into the span", () => {
    const fast = setTranslateKeySpeed("walk", "hip", 1, 1)(doc(THREE));
    const short = setTranslateKeyReaches("walk", "hip", 1, { out: 0.1 })(fast), long = setTranslateKeyReaches("walk", "hip", 1, { out: 0.45 })(fast);
    const v = (s: Skeleton) => spanSpeedSamples("hip", nodes(s)[1]!, nodes(s)[2]!, 10)[2]!.v;
    expect(v(long)).toBeGreaterThan(v(short) + 0.1);
  });

  it("is held to REACH_MIN, to 1 ÷ the speed's multiplier, and to what the other side leaves of the span", () => {
    const base = doc(THREE);
    expect(reaches(setTranslateKeyReaches("walk", "hip", 1, { out: 0 })(base))[1]!.out).toBeCloseTo(REACH_MIN, 4);
    const fast = setTranslateKeySpeed("walk", "hip", 1, 3)(base);
    expect(reaches(setTranslateKeyReaches("walk", "hip", 1, { out: 0.9 })(fast))[1]!.out).toBeCloseTo(0.25, 4);
    const both = setTranslateKeyReaches("walk", "hip", 2, { in: 0.9 })(base);
    expect(reaches(both)[2]!.in).toBeCloseTo(1 - 1 / 3, 4);
    expect(reaches(both)[1]!.out).toBeCloseTo(1 / 3, 4);
  });

  it("a speed change keeps the reach; a handle a speed over 3 pushed to the whole chord gets the usual third back", () => {
    const set = setTranslateKeyReaches("walk", "hip", 1, { out: 0.2 })(setTranslateKeySpeed("walk", "hip", 1, 1)(doc(THREE)));
    expect(reaches(setTranslateKeySpeeds("walk", "hip", 1, { out: 0.5 })(set))[1]!.out).toBeCloseTo(0.2, 4);
    const pushed = setTranslateKeySpeeds("walk", "hip", 1, { out: 4 })(doc(THREE));
    expect(reaches(pushed)[1]!.out).toBeCloseTo(0.2, 4);
    expect(reaches(setTranslateKeySpeeds("walk", "hip", 1, { out: 0 })(pushed))[1]!.out).toBeCloseTo(1 / 3, 4);
  });

  it("a curved span has none, and a reach there is refused; so are a stepped span and a reach that is not a number", () => {
    const curved = setKeyHandles("walk", "hip", 1, { out: [20, 10] })(doc(THREE));
    expect(reaches(curved)[1]!.out).toBeNull();
    expect(() => setTranslateKeyReaches("walk", "hip", 1, { out: 0.3 })(curved)).toThrow(/curved/);
    expect(() => setTranslateKeyReaches("walk", "hip", 0, { out: 0.3 })(doc([{ x: 0, curve: "stepped" }, { time: 1, x: 10 }]))).toThrow(/stepped/);
    expect(() => setTranslateKeyReaches("walk", "hip", 1, { out: Number.NaN })(doc(THREE))).toThrow(/number/);
  });
});

describe("retimeTranslateKey: a key moved in time, the path kept (step 16)", () => {
  // A curved key with a speed: both spans have curves, value handles off the line.
  const curved = () => setTranslateKeySpeeds("walk", "hip", 1, { in: 1, out: 0.5 })(setKeyHandles("walk", "hip", 1, { in: [-15, -5], out: [10, 20] })(doc(THREE)));
  const shares = (k: Key, next: Key) => { const c = k.curve as number[], t0 = k.time ?? 0, dt = (next.time ?? 0) - t0; return [0, 2, 4, 6].map((j) => (c[j]! - t0) / dt); };

  it("moves only the key's time: places, path handles and the bone's path are the same; each span's time handles keep their share", () => {
    const before = curved(), after = retimeTranslateKey("walk", "hip", 1, 0.6)(before);
    const nb = nodes(before), na = nodes(after);
    expect(na.map((k) => [k.x, k.y])).toEqual(nb.map((k) => [k.x, k.y]));
    expect(na[1]!.time).toBeCloseTo(0.6, 6);
    expect(keyHandles("hip", na)).toEqual(keyHandles("hip", nb));
    for (const [i, j] of [[0, 1], [1, 2]] as const) shares(na[i]!, na[j]!).forEach((v, n) => expect(v).toBeCloseTo(shares(nb[i]!, nb[j]!)[n]!, 4));
    // The bone passes the same places, only at other times: the key's place is reached at 0.6 now.
    const [x, y] = at(after, 0.6);
    expect(x).toBeCloseTo(30, 3);
    expect(y).toBeCloseTo(60, 3);
  });

  it("keeps each key's speeds", () => {
    const before = curved(), after = retimeTranslateKey("walk", "hip", 1, 1.4)(before);
    keySpeedPairs("hip", nodes(after)).forEach((p, i) => {
      const b = keySpeedPairs("hip", nodes(before))[i]!;
      if (p.in !== null) expect(p.in).toBeCloseTo(b.in!, 3);
      if (p.out !== null) expect(p.out).toBeCloseTo(b.out!, 3);
    });
  });

  it("works on keys without curves, and the first key moves off 0", () => {
    const s = retimeTranslateKey("walk", "hip", 0, 0.25)(doc(THREE));
    expect(nodes(s)[0]!.time).toBe(0.25);
    expect(nodes(s).map((k) => [k.x, k.y])).toEqual([[0, 0], [30, 60], [30, 0]]);
  });

  it("refuses a time at or past a neighbour, before 0, and a key that is not there", () => {
    expect(() => retimeTranslateKey("walk", "hip", 1, 2)(doc(THREE))).toThrow(/neighbours/);
    expect(() => retimeTranslateKey("walk", "hip", 1, 0)(doc(THREE))).toThrow(/neighbours/);
    expect(() => retimeTranslateKey("walk", "hip", 0, -1)(doc(THREE))).toThrow(/before 0/);
    expect(() => retimeTranslateKey("walk", "hip", 7, 1)(doc(THREE))).toThrow(/no translate key 8/);
  });
});
