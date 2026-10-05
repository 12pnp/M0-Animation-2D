import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createKeyframe, createNode } from "@/core/doc/defaults";
import {
  easesToSpline, type Spline, splineAt, splineToEases, splitSpline, straightSpline, withSpline,
} from "@/core/doc/pathSpline";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { CURVE_Y_LIMIT, TWEEN_LINEAR } from "@/core/math/easing";
import { tf } from "@/core/math/Transform";
import type { Keyframe, Track } from "@/core/doc/types";

beforeEach(() => reseed());

const node = createNode("bone", "b");
function key(frame: number, x: number, y: number, extra: Partial<Keyframe> = {}): Keyframe {
  return { ...createKeyframe(frame, node), transform: { ...tf(x, y), skewX: 10, skewY: 10 }, tween: TWEEN_LINEAR, ...extra };
}
const track = (...keys: Keyframe[]): Track => ({ nodeId: node.id, keys, endFrame: keys.at(-1)!.frame });
const close = (a: { x: number; y: number }, b: { x: number; y: number }, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
};

const arc: Spline = { p0: { x: 0, y: 0 }, p1: { x: 30, y: -60 }, p2: { x: 90, y: -60 }, p3: { x: 120, y: 0 }, cx: [1 / 3, 2 / 3] };

describe("splines and eases", () => {
  it("a linear interval is the straight spline", () => {
    const a = key(0, 0, 0), b = key(12, 120, 30);
    const s = easesToSpline(a, b)!;
    const st = straightSpline(a, b);
    for (const k of ["p0", "p1", "p2", "p3"] as const) close(s[k], st[k]);
    expect(s.cx).toEqual([1 / 3, 2 / 3]);
  });

  it("round-trips: spline → eases → spline", () => {
    const s = { ...arc, p3: { x: 120, y: 20 } };
    const e = splineToEases(s);
    if ("split" in e) throw new Error("no split expected");
    expect(e.clamped).toBe(false);
    const back = easesToSpline(key(0, 0, 0, { eases: { x: e.x, y: e.y } }), key(12, 120, 20))!;
    for (const k of ["p0", "p1", "p2", "p3"] as const) close(back[k], s[k]);
  });

  it("keeps the shared control times: speed changes, the shape does not", () => {
    const s = { ...arc, p3: { x: 120, y: 20 }, cx: [0.6, 0.9] as [number, number] };
    const e = splineToEases(s);
    if ("split" in e) throw new Error("no split expected");
    expect(easesToSpline(key(0, 0, 0, { eases: { x: e.x, y: e.y } }), key(12, 120, 20))!.cx).toEqual([0.6, 0.9]);
  });

  it("reads the quad eases as splines, and refuses what is not one", () => {
    expect(easesToSpline(key(0, 0, 0, { tween: { kind: "ease", value: 1 } }), key(12, 90, 30))).not.toBeNull();
    expect(easesToSpline(key(0, 0, 0, { tween: { kind: "none" } }), key(12, 90, 30))).toBeNull();
    expect(easesToSpline(key(0, 0, 0, { tween: { kind: "preset", family: "back", dir: "out" } }), key(12, 90, 30))).toBeNull();
    // x and y timed differently cannot be one curve.
    const a = key(0, 0, 0, { eases: { x: { kind: "curve", curve: [0.2, 0, 0.8, 1] }, y: { kind: "curve", curve: [0.4, 0, 0.6, 1] } } });
    expect(easesToSpline(a, key(12, 90, 30))).toBeNull();
  });

  it("asks for a split where an axis does not travel but has to bend", () => {
    expect(splineToEases(arc)).toEqual({ split: true });
    // Not bending that axis is fine.
    const flat = { ...arc, p1: { x: 30, y: 0 }, p2: { x: 90, y: 0 } };
    expect("split" in splineToEases(flat)).toBe(false);
  });

  it("pulls in a handle past the curve limit", () => {
    const far = { ...arc, p3: { x: 120, y: 1 }, p1: { x: 30, y: -60 } };
    const e = splineToEases(far);
    if ("split" in e) throw new Error("no split expected");
    expect(e.clamped).toBe(true);
    expect(e.y.kind === "curve" && e.y.curve[1]).toBe(-CURVE_Y_LIMIT);
  });

  it("splits at a parameter into two halves that meet on the curve", () => {
    const [h1, h2] = splitSpline(arc, 0.5);
    close(h1.p3, splineAt(arc, 0.5));
    close(h2.p0, h1.p3);
    close(splineAt(h1, 0.5), splineAt(arc, 0.25));
    close(splineAt(h2, 0.5), splineAt(arc, 0.75));
  });
});

describe("withSpline", () => {
  it("bends an interval with eases only, and the track follows the curve at the frames", () => {
    const t = track(key(0, 0, 0), key(10, 100, 50));
    const s = { ...straightSpline(t.keys[0]!, t.keys[1]!), p1: { x: 20, y: -40 }, p2: { x: 100, y: -10 } };
    const out = withSpline(t, node, 0, s);
    if ("refused" in out) throw new Error(out.refused);
    expect(out.split).toBeNull();
    expect(out.track.keys).toHaveLength(2);
    // Spine reads the curve as a 10-piece polyline, so a whole frame is on
    // the curve within the chord error, and exactly on it at t = 0.1 steps.
    for (let f = 0; f <= 10; f++) close(sampleTransformRaw(out.track, f)!, splineAt(s, f / 10), 6);
  });

  it("turns a hold into a tween to bend it", () => {
    const t = track(key(0, 0, 0, { tween: { kind: "none" } }), key(10, 100, 50));
    const out = withSpline(t, node, 0, { ...straightSpline(t.keys[0]!, t.keys[1]!), p1: { x: 10, y: 30 } });
    if ("refused" in out) throw new Error(out.refused);
    expect(out.track.keys[0]!.tween.kind).toBe("linear");
  });

  it("cuts a key in the middle when an axis that does not travel has to bend", () => {
    const t = track(key(0, 0, 0), key(10, 120, 0));
    const out = withSpline(t, node, 0, { ...arc });
    if ("refused" in out) throw new Error(out.refused);
    expect(out.split).toBe(5);
    expect(out.track.keys.map((k) => k.frame)).toEqual([0, 5, 10]);
    close(out.track.keys[1]!.transform, splineAt(arc, 0.5));
    // The other channels keep what the stage showed there.
    expect(out.track.keys[1]!.transform.skewX).toBe(10);
    for (const f of [0, 5, 10]) close(sampleTransformRaw(out.track, f)!, splineAt(arc, f / 10), 6);
  });

  it("refuses a bend with no frame to put the key on, or no key to bend toward", () => {
    expect(withSpline(track(key(0, 0, 0), key(1, 120, 0)), node, 0, { ...arc })).toMatchObject({ refused: expect.any(String) });
    expect(withSpline(track(key(0, 0, 0)), node, 0, { ...arc })).toMatchObject({ refused: expect.any(String) });
  });
});

describe("handleAt", () => {
  it("prefers the interval the playhead is in where handles pile up, then the nearest", async () => {
    const { handleAt } = await import("@/core/doc/pathSpline");
    const h = (from: number, to: number, x: number) => ({ from, to, end: "out" as const, x, y: 0, anchorX: 0, anchorY: 0 });
    const piled = [h(0, 8, 0), h(8, 16, 0)];
    expect(handleAt(piled, 0, 0, 5, 4)!.from).toBe(0);
    expect(handleAt(piled, 0, 0, 5, 12)!.from).toBe(8);
    expect(handleAt([h(0, 8, 3), h(8, 16, 1)], 0, 0, 5, 20)!.from).toBe(8);
    expect(handleAt(piled, 50, 0, 5, 4)).toBeNull();
  });
});
