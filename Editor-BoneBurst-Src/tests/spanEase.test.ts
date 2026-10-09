import { describe, expect, it } from "vitest";
import { keyHandles, keySpeedPairs, setKeyHandles, setSpanEase, setTranslateKeyReaches, setTranslateKeySpeeds, spanEase, spanHandles, translateNodes } from "@/edit/keySpeed";
import { readSkeleton } from "@/io/skeletonRead";
import type { Key, Skeleton } from "@/model/skeleton";

/** docs/CURVES-PANEL-PLAN.md, step 1: a span read and written as Spine's Curves view shows it (time across, progress up). */

const doc = (translate: unknown[]) => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 30 },
  bones: [{ name: "root" }, { name: "hip", parent: "root" }],
  animations: { walk: { bones: { hip: { translate } } } },
})).skeleton;
const THREE = [{ x: 0, y: 0 }, { time: 1, x: 30, y: 60 }, { time: 2, x: 30, y: 0 }];
const nodes = (s: Skeleton): readonly Key[] => translateNodes(s.animations![0]!, "hip")!;
const ease = (s: Skeleton, i: number) => spanEase("hip", nodes(s)[i]!, nodes(s)[i + 1]!);
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, j) => expect(v).toBeCloseTo(b[j]!, 4));

describe("spanEase: reading a span", () => {
  it("a span with no curve is linear, its handles on the diagonal at the thirds", () => {
    const e = ease(doc(THREE), 0);
    expect(e.kind).toBe("linear");
    close(e.out, [1 / 3, 1 / 3]);
    close(e.in, [2 / 3, 2 / 3]);
  });

  it("a stepped span is stepped", () => {
    expect(ease(doc([{ x: 0, curve: "stepped" }, { time: 1, x: 10 }]), 0).kind).toBe("stepped");
  });

  it("a straight span with a speed and a reach reads across as the reach, up as speed × reach (steps 8 and 10)", () => {
    // Key 2 leaves at speed 1 (twice the even pace) with a reach of 0.25.
    const s = setTranslateKeyReaches("walk", "hip", 1, { out: 0.25 })(setTranslateKeySpeeds("walk", "hip", 1, { out: 1 })(doc(THREE)));
    const e = ease(s, 1);
    expect(e.kind).toBe("bezier");
    close(e.out, [0.25, 0.5]);
  });

  it("a curved span reads up as how far each path handle reaches along the chord", () => {
    // Chord of the second span: (0, -60). An out handle (10, -20) reaches 20/60 along it; an in handle (5, 30) reaches 30/60 back.
    const s = setKeyHandles("walk", "hip", 2, { in: [5, 30] })(setKeyHandles("walk", "hip", 1, { out: [10, -20] })(doc(THREE)));
    const e = ease(s, 1);
    expect(e.out[1]).toBeCloseTo(1 / 3, 4);
    expect(e.in[1]).toBeCloseTo(0.5, 4);
  });
});

describe("setSpanEase: writing a span (Decision 1: up and down free on every span)", () => {
  it("writes the kind: stepped, linear (no curve), bezier", () => {
    expect(nodes(setSpanEase("walk", "hip", 0, { kind: "stepped" })(doc(THREE)))[0]!.curve).toBe("stepped");
    const lin = setSpanEase("walk", "hip", 0, { kind: "linear" })(setSpanEase("walk", "hip", 0, { kind: "stepped" })(doc(THREE)));
    expect(nodes(lin)[0]!.curve).toBeUndefined();
    const bez = setSpanEase("walk", "hip", 0, { kind: "bezier" })(doc(THREE));
    expect(Array.isArray(nodes(bez)[0]!.curve)).toBe(true);
    close(ease(bez, 0).out, [1 / 3, 1 / 3]);
  });

  it("a handle written reads back; the keys' places stay", () => {
    const s = setSpanEase("walk", "hip", 0, { kind: "bezier", out: [0.1, 0.6], in: [0.7, 0.95] })(doc(THREE));
    const e = ease(s, 0);
    close(e.out, [0.1, 0.6]);
    close(e.in, [0.7, 0.95]);
    expect(nodes(s).map((k) => [k.time ?? 0, k.x, k.y])).toEqual([[0, 0, 0], [1, 30, 60], [2, 30, 0]]);
  });

  it("on a straight span it writes the same file as the speed and reach edits (the leg drags it replaces)", () => {
    const viaLegs = setTranslateKeyReaches("walk", "hip", 1, { out: 0.25 })(setTranslateKeySpeeds("walk", "hip", 1, { out: 1 })(doc(THREE)));
    const viaCurves = setSpanEase("walk", "hip", 1, { kind: "bezier", out: [0.25, 0.5] })(doc(THREE));
    close(nodes(viaCurves)[1]!.curve as number[], nodes(viaLegs)[1]!.curve as number[]);
    expect(keySpeedPairs("hip", nodes(viaCurves))[1]!.out).toBeCloseTo(1, 3);
  });

  it("on a curved span, across moves only the time handles: the path handles stay", () => {
    const curved = setKeyHandles("walk", "hip", 1, { out: [10, -20] })(doc(THREE));
    const before = keyHandles("hip", nodes(curved));
    const e = ease(curved, 1);
    const s = setSpanEase("walk", "hip", 1, { kind: "bezier", out: [0.15, e.out[1]] })(curved);
    expect(keyHandles("hip", nodes(s))).toEqual(before);
    expect(ease(s, 1).out[0]).toBeCloseTo(0.15, 4);
  });

  it("on a curved span, up changes the path handle along the chord only: its bend across the chord stays", () => {
    const curved = setKeyHandles("walk", "hip", 1, { out: [10, -20] })(doc(THREE));
    const e = ease(curved, 1);
    const s = setSpanEase("walk", "hip", 1, { kind: "bezier", out: [e.out[0], 0.5] })(curved);
    const h = spanHandles("hip", nodes(s)[1]!, nodes(s)[2]!)!.out;
    // Chord (0, -60): across it (x) stays 10; along it, half the chord.
    expect(h[0]).toBeCloseTo(10, 3);
    expect(h[1]).toBeCloseTo(-30, 3);
    expect(ease(s, 1).out[1]).toBeCloseTo(0.5, 4);
  });

  it("holds a handle's time inside its span, and leaves a side not given as it was", () => {
    const s = setSpanEase("walk", "hip", 0, { kind: "bezier", out: [-0.5, 0.2], in: [1.5, 0.8] })(doc(THREE));
    expect(ease(s, 0).out[0]).toBe(0);
    expect(ease(s, 0).in[0]).toBe(1);
    const t = setSpanEase("walk", "hip", 0, { kind: "bezier", out: [0.2, 0.2] })(s);
    close(ease(t, 0).in, ease(s, 0).in);
  });

  it("refuses split keys, a key with no span after it, and a handle that is not two numbers", () => {
    expect(() => setSpanEase("walk", "hip", 2, { kind: "bezier" })(doc(THREE))).toThrow(/no span after/);
    expect(() => setSpanEase("walk", "hip", 0, { kind: "bezier", out: [Number.NaN, 0] })(doc(THREE))).toThrow(/two numbers/);
    const split = readSkeleton(JSON.stringify({ skeleton: { spine: "4.3.0" }, bones: [{ name: "root" }, { name: "hip", parent: "root" }], animations: { walk: { bones: { hip: { translatex: [{ value: 0 }, { time: 1, value: 5 }] } } } } })).skeleton;
    expect(() => setSpanEase("walk", "hip", 0, { kind: "bezier" })(split)).toThrow(/separate x and y/);
  });
});
