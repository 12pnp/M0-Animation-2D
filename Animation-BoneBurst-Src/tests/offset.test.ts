import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { offsetPlan, offsetTrack } from "@/core/doc/offset";
import { createNode } from "@/core/doc/defaults";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { tf, type Transform } from "@/core/math/Transform";
import type { Keyframe, Track } from "@/core/doc/types";

beforeEach(() => reseed());

const node = createNode("bone", "b");
const key = (frame: number, t: Transform, extra: Partial<Keyframe> = {}): Keyframe =>
  ({ frame, transform: t, displayIndex: 0, tween: { kind: "linear" }, ...extra });

/** A loop over 24 frames: a curve, a hold, linear; it closes at the join. */
const loop: Track = {
  nodeId: node.id, endFrame: 24,
  keys: [
    key(0, tf(0, 0, 10, 10), { tween: { kind: "curve", curve: [0.4, 0, 0.6, 1] } }),
    key(7, tf(30, -12, 80, 80), { tween: { kind: "none" } }),
    key(11, tf(40, 5, 40, 40)),
    key(24, tf(0, 0, 10, 10)),
  ],
};

/** A bone that turns once clockwise over the loop. */
const spin: Track = {
  nodeId: node.id, endFrame: 24,
  keys: [key(0, tf(0, 0, 0, 0)), key(12, tf(0, 0, 180, 180)), key(24, tf(0, 0, 360, 360))],
};

const near = (a: Transform | null, b: Transform | null) => {
  for (const f of ["x", "y", "skewX", "skewY", "scaleX", "scaleY"] as const) expect(a![f]).toBeCloseTo(b![f], 6);
};

describe("offset in a cycle: the same loop started elsewhere", () => {
  it.each([5, -5, 13, 23, 30, -47])("by %i", (delta) => {
    const out = offsetTrack(loop, node, delta, 24);
    const d = ((delta % 24) + 24) % 24;
    for (let f = 0; f <= 24; f++) near(sampleTransformRaw(out, f), sampleTransformRaw(loop, (f - d + 24) % 24));
    expect(out.keys[0]!.frame).toBe(0);
    expect(out.keys[out.keys.length - 1]!.frame).toBe(24);
  });

  it("a whole turn keeps turning the same way, a turn back where it wraps", () => {
    const out = offsetTrack(spin, node, 6, 24);
    for (let f = 0; f <= 24; f++) {
      const want = sampleTransformRaw(spin, (f + 18) % 24)!.skewY - (f < 6 ? 360 : 0);
      expect(sampleTransformRaw(out, f)!.skewY).toBeCloseTo(want, 6);
    }
    expect(sampleTransformRaw(out, 24)!.skewY - sampleTransformRaw(out, 0)!.skewY).toBeCloseTo(360, 6);
  });

  it("a whole loop round, or none: unchanged", () => {
    expect(offsetTrack(loop, node, 24, 24)).toBe(loop);
    expect(offsetTrack(loop, node, 0, 24)).toBe(loop);
  });
});

describe("offset outside a cycle: the span stays", () => {
  it.each([3, 9, 20])("later by %i: the first pose holds, the end is cut", (delta) => {
    const out = offsetTrack(loop, node, delta, null);
    for (let f = 0; f <= 24; f++) near(sampleTransformRaw(out, f), sampleTransformRaw(loop, Math.max(0, f - delta)));
    expect(out.endFrame).toBe(24);
    expect(out.keys[out.keys.length - 1]!.frame).toBeLessThanOrEqual(24);
  });

  it.each([3, 9, 20])("earlier by %i: the start is cut, the last pose holds", (delta) => {
    const out = offsetTrack(loop, node, -delta, null);
    for (let f = 0; f <= 24; f++) near(sampleTransformRaw(out, f), sampleTransformRaw(loop, Math.min(24, f + delta)));
    expect(out.keys[0]!.frame).toBe(0);
  });

  it("pushed past its whole span: one pose", () => {
    expect(offsetTrack(loop, node, 40, null).keys).toHaveLength(1);
    expect(offsetTrack(loop, node, -40, null).keys).toEqual([{ ...loop.keys[3]!, frame: 0 }]);
  });

  it("a cycle's track that stops short of the join is shifted, not wrapped", () => {
    const partial: Track = { ...loop, endFrame: 15, keys: loop.keys.slice(0, 3) };
    const out = offsetTrack(partial, node, 4, 24);
    for (let f = 0; f <= 15; f++) near(sampleTransformRaw(out, f), sampleTransformRaw(partial, Math.max(0, f - 4)));
  });
});

describe("which row moves how far", () => {
  it.each([
    { stagger: false, want: [3, 3, 3] },
    { stagger: true, want: [0, 3, 6] },
  ])("stagger $stagger", ({ stagger, want }) => {
    expect([...offsetPlan(["a", "b", "c"] as never, 3, stagger).values()]).toEqual(want);
  });
});
