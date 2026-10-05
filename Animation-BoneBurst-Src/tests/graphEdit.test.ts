import { describe, expect, it } from "vitest";
import { cubicOf, graphSamples, handlesOf, moveGraphKeys, valueRange, withHandle } from "@/core/doc/graphEdit";
import { applyTween, CURVE_Y_LIMIT, type TweenSpec } from "@/core/math/easing";
import type { ChannelKey } from "@/core/doc/propertyKeys";

const lin: TweenSpec = { kind: "linear" };
const SMOOTH = [0.42, 0, 0.58, 1];
const smooth: TweenSpec = { kind: "curve", curve: SMOOTH };
const curveOf = (e: TweenSpec | undefined) => (e as unknown as { curve: number[] }).curve;
// Scale: two leaves.
const keys: ChannelKey[] = [
  { frame: 0, values: [1, 2], eases: [smooth, lin] },
  { frame: 10, values: [3, 2], eases: [lin, { kind: "none" }] },
  { frame: 20, values: [1, 4], eases: [lin, lin] },
];

describe("an interval's ease as one cubic", () => {
  it.each([
    ["stepped holds: no cubic", { kind: "none" } as TweenSpec, null],
    ["linear: the straight cubic", lin, [1 / 3, 1 / 3, 2 / 3, 2 / 3]],
    ["a custom cubic as it is", smooth, [0.42, 0, 0.58, 1]],
  ])("%s", (_, ease, want) => {
    const c = cubicOf(ease);
    if (want === null) expect(c).toBeNull();
    else c!.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
  });

  it("a preset is fitted close to what it plays", () => {
    const ease: TweenSpec = { kind: "preset", family: "sine", dir: "inOut" };
    const c = cubicOf(ease, 30)!;
    const fitted: TweenSpec = { kind: "curve", curve: c };
    for (let i = 1; i < 10; i++) expect(Math.abs(applyTween(fitted, i / 10, 30) - applyTween(ease, i / 10, 30))).toBeLessThan(0.02);
  });
});

describe("handles", () => {
  it("are where the cubic puts them, in frames and the curve's units", () => {
    const h = handlesOf(keys, 0, 0)!;
    expect(h.out).toEqual({ frame: 4.2, value: 1 });
    expect(h.in.frame).toBeCloseTo(5.8, 9);
    expect(h.in.value).toBeCloseTo(3, 9);
    expect(handlesOf(keys, 1, 1)).toBeNull();
    expect(handlesOf(keys, 2, 0)).toBeNull();
  });

  it("written back where they are, nothing changes", () => {
    const h = handlesOf(keys, 0, 0)!;
    const out = withHandle(keys, 0, 0, "out", h.out.frame, h.out.value);
    curveOf(out[0]!.eases[0]).forEach((v, i) => expect(v).toBeCloseTo(SMOOTH[i]!, 9));
  });

  it("a dragged handle bends only its leaf's interval, as the runtime then plays it", () => {
    const out = withHandle(keys, 0, 0, "out", 2, 2.5);
    expect(out[0]!.eases[0]).toEqual({ kind: "curve", curve: [0.2, 0.75, 0.58, 1] });
    expect(out[0]!.eases[1]).toBe(lin);
    expect(out[1]).toBe(keys[1]);
    // Value at frame 5 from the bent cubic, played by applyTween.
    const at = graphSamples(out, 0, 5, 5, 1, [0, 0])[0]!.value;
    expect(at).toBeCloseTo(1 + 2 * applyTween(out[0]!.eases[0]!, 0.5, 10), 9);
  });

  it("time is clamped to the interval, the value to what a curve holds", () => {
    const out = withHandle(keys, 0, 0, "in", 99, 1000);
    expect(curveOf(out[0]!.eases[0]).slice(2)).toEqual([1, CURVE_Y_LIMIT]);
  });

  it("an interval with equal ends only slides in time", () => {
    const flat: ChannelKey[] = [{ frame: 0, values: [5], eases: [lin] }, { frame: 4, values: [5], eases: [lin] }];
    const out = withHandle(flat, 0, 0, "out", 2, 9);
    expect(curveOf(out[0]!.eases[0])).toEqual([0.5, 1 / 3, 2 / 3, 2 / 3]);
  });
});

describe("moving keys", () => {
  it("in time and in value, only the picked leaf's value", () => {
    const out = moveGraphKeys(keys, [{ frame: 10, leaf: 1 }], 3, 0.5);
    expect(out.map((k) => [k.frame, ...k.values])).toEqual([[0, 1, 2], [13, 3, 2.5], [20, 1, 4]]);
  });
  it("onto another key replaces it; never before 0; together keeps the later", () => {
    expect(moveGraphKeys(keys, [{ frame: 10, leaf: 0 }], 10, 0).map((k) => [k.frame, k.values[0]])).toEqual([[0, 1], [20, 3]]);
    expect(moveGraphKeys(keys, [{ frame: 0, leaf: 0 }, { frame: 10, leaf: 0 }], -15, 0).map((k) => [k.frame, k.values[0]])).toEqual([[0, 3], [20, 1]]);
  });
});

describe("samples and range", () => {
  it("every step and at every key, as sampleChannel plays it", () => {
    const s = graphSamples(keys, 0, 0, 20, 7, [0, 0]);
    expect(s.map((p) => p.frame)).toEqual([0, 7, 10, 14, 20]);
    expect(s[2]!.value).toBe(3);
  });
  it("a flat curve still has a height", () => {
    expect(valueRange([{ frame: 0, value: 5 }, { frame: 1, value: 5 }])).toEqual({ min: 4, max: 6 });
    expect(valueRange([])).toEqual({ min: 0, max: 1 });
  });
});
