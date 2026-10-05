import { describe, expect, it } from "vitest";
import { snapPoint } from "@/core/math/snap";
import { bentOnPath, handlePartner, handlesSmooth, mirroredHandle, type SplineSegment } from "@/core/doc/pathSpline";
import type { Keyframe } from "@/core/doc/types";

const seg = (from: number, to: number): SplineSegment => ({ from, to, exact: true, spline: { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, p3: { x: 0, y: 0 }, cx: [1 / 3, 2 / 3] } });

describe("a dragged dot snaps", () => {
  const opts = { grid: 10, pixel: false, tolerance: 3 };
  it.each([
    { name: "onto another dot near it, both axes", at: [21, 38], want: [20, 40] },
    { name: "else onto the nearer line on each axis (here the grid)", at: [32, 58.5], want: [30, 60] },
    { name: "else not at all", at: [35, 55], want: [35, 55] },
  ])("$name", ({ at, want }) => {
    const r = snapPoint(at[0]!, at[1]!, [{ x: 20, y: 40 }, { x: 100, y: 100 }], { xs: [], ys: [] }, opts);
    expect([r.x, r.y]).toEqual(want);
  });
  it("a guide beats the grid at the same distance", () => {
    expect(snapPoint(12, 0, [], { xs: [10], ys: [] }, { grid: 10, pixel: false, tolerance: 3 }).lines[0]).toEqual({ axis: "x", at: 10 });
  });
});

describe("the handle across a key", () => {
  const segs = [seg(0, 6), seg(6, 12), seg(12, 20)];
  it.each([
    { name: "an out handle: the in handle arriving at its key", h: { from: 6, end: "out" as const }, join: null, want: { from: 0, end: "in" } },
    { name: "an in handle: the out handle leaving its key", h: { from: 0, end: "in" as const }, join: null, want: { from: 6, end: "out" } },
    { name: "frame 0's out handle, no cycle: none", h: { from: 0, end: "out" as const }, join: null, want: null },
    { name: "frame 0's out handle on a cycle: the join's in handle", h: { from: 0, end: "out" as const }, join: 20, want: { from: 12, end: "in" } },
    { name: "the join's in handle on a cycle: frame 0's out handle", h: { from: 12, end: "in" as const }, join: 20, want: { from: 0, end: "out" } },
  ])("$name", ({ h, join, want }) => {
    expect(handlePartner(segs, h, join)).toEqual(want);
  });

  it("smooth when they point opposite ways; the partner turned keeps its length", () => {
    const a = { x: 0, y: 0 };
    expect(handlesSmooth(a, { x: 10, y: 0 }, { x: -4, y: 0.05 })).toBe(true);
    expect(handlesSmooth(a, { x: 10, y: 0 }, { x: 0, y: 4 })).toBe(false);
    const m = mirroredHandle(a, { x: 0, y: 10 }, { x: -4, y: 0 });
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo(-4, 9);
  });
});

describe("the Ease panel's note", () => {
  const key = (eases: Keyframe["eases"], tween: Keyframe["tween"] = { kind: "linear" }) => ({ frame: 0, displayIndex: 0, transform: {} as never, tween, eases }) as Keyframe;
  it.each([
    { name: "x and y each a curve: bent on the stage", k: key({ x: { kind: "curve", curve: [0.3, 0.2, 0.6, 0.9] }, y: { kind: "curve", curve: [0.3, 0.5, 0.6, 1] } }), want: true },
    { name: "a preset: not", k: key({ x: { kind: "preset", family: "sine", dir: "out" } as never }), want: false },
    { name: "a hold: not", k: key({ x: { kind: "curve", curve: [0, 0, 1, 1] }, y: { kind: "curve", curve: [0, 0, 1, 1] } }, { kind: "none" }), want: false },
  ])("$name", ({ k, want }) => {
    expect(bentOnPath(k)).toBe(want);
  });
});
