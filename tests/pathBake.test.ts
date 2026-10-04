import { describe, expect, it } from "vitest";
import { type BakeFrame, bakePlan, type DragFrame } from "@/core/doc/pathEdit";
import { fitCubic, splineAt } from "@/core/doc/pathSpline";
import { apply, mat, mul } from "@/core/math/Matrix2D";
import { tf, toMatrix, type Transform } from "@/core/math/Transform";

const frameOf = (local: Transform, parentWorld = mat(), length = 100): DragFrame =>
  ({ local, parentWorld, world: mul(mat(), parentWorld, toMatrix(mat(), local)), length });
const tipOf = (local: Transform, parentWorld = mat(), length = 100) =>
  apply({ x: 0, y: 0 }, mul(mat(), parentWorld, toMatrix(mat(), local)), length, 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

describe("fitCubic", () => {
  it("gives back a cubic it is fitted to", () => {
    const s = { p0: { x: 0, y: 0 }, p1: { x: 20, y: -80 }, p2: { x: 110, y: -40 }, p3: { x: 120, y: 30 }, cx: [1 / 3, 2 / 3] as [number, number] };
    const samples = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ t: i / 8, p: splineAt(s, i / 8) }));
    const fit = fitCubic(s.p0, s.p3, samples);
    expect(fit.p1.x).toBeCloseTo(20, 6);
    expect(fit.p1.y).toBeCloseTo(-80, 6);
    expect(fit.p2.x).toBeCloseTo(110, 6);
    expect(fit.p2.y).toBeCloseTo(-40, 6);
  });

  it("matches a quarter circle within the bake's tolerance", () => {
    const at = (t: number) => ({ x: 100 * Math.cos(t * Math.PI / 2), y: 100 * Math.sin(t * Math.PI / 2) });
    const samples = Array.from({ length: 11 }, (_, i) => ({ t: i / 12 + 1 / 12, p: at(i / 12 + 1 / 12) }));
    const fit = fitCubic(at(0), at(1), samples);
    for (const { t, p } of samples) {
      const q = splineAt(fit, t);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(0.5);
    }
  });

  it("falls back to straight handles with too few samples", () => {
    const fit = fitCubic({ x: 0, y: 0 }, { x: 90, y: 0 }, [{ t: 0.5, p: { x: 45, y: 30 } }]);
    expect(fit.p1).toEqual({ x: 30, y: 0 });
    expect(fit.p2).toEqual({ x: 60, y: 0 });
  });
});

/** A bone of length 100 at the origin, aiming its tip along a line. */
function lineBake(n: number, parent?: DragFrame): BakeFrame[] {
  return Array.from({ length: n + 1 }, (_, i) => ({
    frame: i * 2,
    own: frameOf(tf(0, 0)),
    target: { x: lerp(-100, 100, i / n), y: 60 },
    ...(parent ? { parent } : {}),
  }));
}

describe("bakePlan", () => {
  it("keeps the ends and only the keys a linear tween needs, within the tolerance", () => {
    const frames = lineBake(20);
    const keys = bakePlan(frames, 0.5);
    expect(keys[0]!.frame).toBe(0);
    expect(keys.at(-1)!.frame).toBe(40);
    expect(keys.length).toBeGreaterThan(2);
    expect(keys.length).toBeLessThan(21);
    // Between kept keys, a linear tween keeps the tip within 0.5 of the
    // per-frame solve, which points the tip at the target.
    for (const f of frames) {
      const i = keys.findIndex((k) => k.frame >= f.frame);
      const b = keys[i]!, a = keys[Math.max(0, i - 1)]!;
      const t = b.frame === a.frame ? 0 : (f.frame - a.frame) / (b.frame - a.frame);
      const angle = lerp(a.own.skewY, b.own.skewY, t);
      const tip = tipOf({ ...tf(0, 0), skewX: angle, skewY: angle });
      const want = Math.atan2(f.target.y, f.target.x);
      expect(Math.hypot(tip.x - 100 * Math.cos(want), tip.y - 100 * Math.sin(want))).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("keeps fewer keys for a looser tolerance, and only the ends for a huge one", () => {
    const frames = lineBake(20);
    expect(bakePlan(frames, 5).length).toBeLessThan(bakePlan(frames, 0.5).length);
    expect(bakePlan(frames, 1000).map((k) => k.frame)).toEqual([0, 40]);
  });

  it("runs on without a jump of a turn where the angle passes ±180", () => {
    const frames = Array.from({ length: 9 }, (_, i) => ({
      frame: i, own: frameOf({ ...tf(0, 0), skewX: 170, skewY: 170 }),
      target: { x: -100, y: lerp(-30, 30, i / 8) },
    }));
    const keys = bakePlan(frames, 0.01);
    for (let i = 1; i < keys.length; i++) expect(Math.abs(keys[i]!.own.skewY - keys[i - 1]!.own.skewY)).toBeLessThan(30);
  });

  it("with the parent, puts the tip on targets in reach", () => {
    // Thigh down from the origin, shin 60 along it bent forward.
    const thigh = frameOf({ ...tf(0, 0), skewX: 90, skewY: 90 }, mat(), 60);
    const shinLocal = { ...tf(60, 0), skewX: -30, skewY: -30 };
    const frames: BakeFrame[] = Array.from({ length: 11 }, (_, i) => ({
      frame: i, own: frameOf(shinLocal, thigh.world, 50), parent: thigh,
      target: { x: lerp(-30, 60, i / 10), y: 90 },
    }));
    const keys = bakePlan(frames, 0.5);
    for (const k of keys) {
      const f = frames.find((x) => x.frame === k.frame)!;
      const thighWorld = mul(mat(), mat(), toMatrix(mat(), k.parent!));
      const tip = tipOf(k.own, thighWorld, 50);
      expect(Math.hypot(tip.x - f.target.x, tip.y - f.target.y)).toBeLessThan(1e-6);
    }
  });

  it("is nothing for fewer than two frames", () => {
    expect(bakePlan(lineBake(20).slice(0, 1))).toEqual([]);
  });
});

describe("withBakedKeys", () => {
  it("writes the kept keys inside the interval, linear in the turn, and leaves the ends", async () => {
    const { createKeyframe, createNode } = await import("@/core/doc/defaults");
    const { withBakedKeys } = await import("@/core/doc/pathEdit");
    const { sampleTransformRaw } = await import("@/core/doc/timeline");
    const node = createNode("bone", "b");
    const k = (frame: number, deg: number, extra = {}) => ({ ...createKeyframe(frame, node), transform: { ...tf(5, 6), skewX: deg, skewY: deg }, ...extra });
    const track = {
      nodeId: node.id, endFrame: 20,
      keys: [k(0, 0, { tween: { kind: "ease", value: 1 }, rotateDir: "cw" }), k(10, 90, { tween: { kind: "linear" } }), k(20, 0)],
    };
    const out = withBakedKeys(track as never, node, 0, [
      { frame: 4, t: { ...tf(5, 6), skewX: 50, skewY: 50 } },
      { frame: 12, t: { ...tf(5, 6), skewX: 1, skewY: 1 } },
    ]);
    expect(out.keys.map((x) => x.frame)).toEqual([0, 4, 10, 20]);
    expect(out.keys[0]!.transform.skewY).toBe(0);
    expect(out.keys[2]!.transform.skewY).toBe(90);
    expect(out.keys[0]!.rotateDir).toBeUndefined();
    // The turn is linear between the kept keys; x keeps the old ease.
    expect(sampleTransformRaw(out, 2)!.skewY).toBeCloseTo(25, 9);
    expect(sampleTransformRaw(out, 7)!.skewY).toBeCloseTo(70, 9);
    expect(out.keys[0]!.tween).toEqual({ kind: "ease", value: 1 });
    // Outside the interval, nothing changes.
    expect(out.keys[3]).toBe(track.keys[2]);
  });
});

describe("bakePlan on a nearly straight chain", () => {
  it("bends one way for the whole interval", async () => {
    const { bendOf, rotateWithParentTo } = await import("@/core/doc/pathEdit");
    // A chest pointing up and a head almost in line with it.
    const chest = frameOf({ ...tf(0, 0), skewX: -90, skewY: -90 }, mat(), 0);
    // Its keyed angle crosses straight inside the interval, so the bend of
    // the pose as it stands changes sign from frame to frame.
    const headLocal = (i: number) => ({ ...tf(80, 0), skewX: 3 - i, skewY: 3 - i });
    const frames: BakeFrame[] = Array.from({ length: 9 }, (_, i) => ({
      frame: i, own: frameOf(headLocal(i), chest.world, 40), parent: chest,
      target: { x: lerp(-8, 8, i / 8), y: -115 },
    }));
    const bend = bendOf(frames[0]!.own, chest);
    const keys = bakePlan(frames, 0.01);
    for (const k of keys) {
      const f = frames.find((x) => x.frame === k.frame)!;
      expect(k.own).toEqual(rotateWithParentTo(f.own, chest, f.target, bend).child);
      const chestWorld = toMatrix(mat(), k.parent!);
      const headWorld = mul(mat(), chestWorld, toMatrix(mat(), k.own));
      const a = { x: 0, y: 0 }, c = { x: headWorld.tx, y: headWorld.ty }, t = apply({ x: 0, y: 0 }, headWorld, 40, 0);
      const sign = (c.x - a.x) * (t.y - c.y) - (c.y - a.y) * (t.x - c.x) < 0 ? -1 : 1;
      expect(sign).toBe(bend);
    }
    for (let i = 1; i < keys.length; i++) expect(Math.abs(keys[i]!.parent!.skewY - keys[i - 1]!.parent!.skewY)).toBeLessThan(10);
  });
});
