import { PathClock, arrivalTimes, buildCurve, clampSpeed, multiplierOf, nodeProgress, pathPose, progressAtTime, reversePath, setSpeedLegs, slopesOf, SPEED_MAX, SPEED_MIN, speedAt, timeMap, withSpeedSlope } from "@/motion";
import { describe, expect, it } from "vitest";
import type { MotionPath } from "@/model/sidecar";

/** TwinSpline (docs/TWINSPLINE-PLAN.md): the speed spline over a ring, and the time it makes. */

const nodes = [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 100, y: 10 }, { x: 160, y: 70 }];
const path = (speeds: readonly number[] = [], extra: Partial<MotionPath> = {}): MotionPath => ({ animation: "a", bone: "b", nodes: nodes.map((n, i) => (speeds[i] ? { ...n, speed: speeds[i]! } : n)), closed: true, duration: 0.5, loop: true, ...extra });

describe("the speed value", () => {
  it("is held between -0.99 and 5, so the multiplier is never 0", () => {
    expect(clampSpeed(-3)).toBe(SPEED_MIN);
    expect(clampSpeed(99)).toBe(SPEED_MAX);
    expect(clampSpeed(Number.NaN)).toBe(0);
    expect(multiplierOf(-5)).toBeCloseTo(0.01, 10);
    expect(multiplierOf(5)).toBe(6);
    expect(multiplierOf(0)).toBe(1);
  });
});

describe("the speed spline", () => {
  it("is 0 everywhere when no node has a speed, and passes through every node's value", () => {
    expect(speedAt(path(), 0.37)).toBe(0);
    const m = path([0, 2.5, -0.6, 1]);
    nodeProgress(m).forEach((p, i) => expect(speedAt(m, p)).toBeCloseTo([0, 2.5, -0.6, 1][i]!, 6));
  });
  it("never leaves the range, even where the curve would swing past it", () => {
    const m = path([5, -0.99, 5, -0.99]);
    for (let k = 0; k <= 400; k++) { const v = speedAt(m, k / 400); expect(v).toBeGreaterThanOrEqual(SPEED_MIN); expect(v).toBeLessThanOrEqual(SPEED_MAX); }
  });
  it("on a ring runs round: the end meets the start", () => {
    const m = path([0, 2, -0.5, 1]);
    expect(speedAt(m, 1)).toBeCloseTo(speedAt(m, 0), 6);
    expect(Math.abs(speedAt(m, 0.9999) - speedAt(m, 0.0001))).toBeLessThan(0.05);
  });
  it("of an open path has the first and last node's values at its ends", () => {
    const m = path([1, 0, 0, 3], { closed: false });
    expect(speedAt(m, 0)).toBeCloseTo(1, 6);
    expect(speedAt(m, 1)).toBeCloseTo(3, 6);
  });
});

describe("the time it makes", () => {
  it("is even when no node has a speed: progress is the time's share of the run, from 0 to 1", () => {
    const m = path();
    for (const t of [0, 0.1, 0.25, 0.4, 0.5]) expect(progressAtTime(m, t)).toBeCloseTo(t / m.duration, 3);
    expect(pathPose(m, 0)).toEqual(buildCurve(nodes, true).at(0));
  });
  it("holds a time outside the run to its ends", () => {
    const m = path();
    expect(progressAtTime(m, -3)).toBe(0);
    expect(progressAtTime(m, 9)).toBeCloseTo(1, 6);
  });
  it("begins at the first node on frame 0 and, on a ring, is back on it at the end; the run takes its duration whatever the speeds", () => {
    const m = path([0, 3, -0.9, 2]), c = buildCurve(m.nodes, true);
    expect(progressAtTime(m, 0)).toBe(0);
    expect(progressAtTime(m, m.duration)).toBeCloseTo(1, 6);
    expect(pathPose(m, m.duration).x).toBeCloseTo(c.at(0).x, 3);
  });
  it("goes faster where the speed is higher: a stretch at speed 1 (twice as fast) takes about half the time of one at 0", () => {
    const flat = path(), fast = path([1, 1, 1, 1]);
    // Everywhere 1 is the same pace as everywhere 0 (a constant multiplier cancels out).
    expect(progressAtTime(fast, 0.17)).toBeCloseTo(progressAtTime(flat, 0.17), 3);
    // Fast on the first span only: less time to cover it than the same span at an even pace.
    const m = path([2, 2, 0, 0]), t = timeMap(m), xs = nodeProgress(m);
    expect(t.time(xs[1]!)).toBeLessThan(xs[1]!);
  });
  it("goes slowly, never stops: where the speed is -0.99 the bone takes most of the run's time to cover a short stretch", () => {
    const m = path([-0.99, -0.99, 0, 0]), t = timeMap(m), xs = nodeProgress(m);
    expect(t.time(xs[1]!)).toBeGreaterThan(0.8);
    expect(Number.isFinite(t.progress(0.5))).toBe(true);
  });
  it("maps progress and time back and forth", () => {
    const t = timeMap(path([0, 3, -0.5, 1]));
    for (const p of [0, 0.1, 0.33, 0.7, 1]) expect(t.progress(t.time(p))).toBeCloseTo(p, 2);
    expect(t.time(0)).toBe(0);
    expect(t.time(1)).toBeCloseTo(1, 10);
  });
  it("tells the time in seconds each node is reached at, from 0 to the duration (a ring adds the way back)", () => {
    const m = path(), a = arrivalTimes(m);
    expect(a).toHaveLength(5);
    expect(a[0]).toBe(0);
    expect(a.at(-1)).toBeCloseTo(m.duration, 6);
    expect(a.every((t, i) => i === 0 || t > a[i - 1]!)).toBe(true);
    expect(arrivalTimes(path([], { closed: false }))).toHaveLength(4);
  });
});

describe("the speed spline's legs", () => {
  const m = path([0, 2, -0.5, 1]);

  it("are automatic until set: setting none leaves the curve as it was", () => {
    expect(slopesOf(m, 1)).toMatchObject({ broken: false, own: false });
    const same = setSpeedLegs(m, 1, "auto");
    for (const p of [0.1, 0.4, 0.8]) expect(speedAt(same, p)).toBe(speedAt(m, p));
  });

  it("bend the curve when a leg is set, and the curve still passes through the node's value", () => {
    const steep = withSpeedSlope(m, 1, "out", 20), xs = nodeProgress(steep);
    expect(slopesOf(steep, 1)).toMatchObject({ out: 20, into: 20, own: true, broken: false });
    expect(speedAt(steep, xs[1]!)).toBeCloseTo(speedAt(m, xs[1]!), 6);
    expect(speedAt(steep, (xs[1]! + xs[2]!) / 2)).not.toBeCloseTo(speedAt(m, (xs[1]! + xs[2]!) / 2), 3);
  });

  it("break (each leg on its own, the curve unchanged), then mirror (the way out wins)", () => {
    const steep = withSpeedSlope(m, 1, "out", 3), broken = setSpeedLegs(steep, 1, "break"), xs = nodeProgress(m);
    expect(slopesOf(broken, 1)).toMatchObject({ out: 3, into: 3, broken: true });
    expect(speedAt(broken, (xs[0]! + xs[1]!) / 2)).toBeCloseTo(speedAt(steep, (xs[0]! + xs[1]!) / 2), 9);
    const moved = withSpeedSlope(broken, 1, "in", -4);
    expect(slopesOf(moved, 1)).toMatchObject({ out: 3, into: -4, broken: true });
    expect(slopesOf(setSpeedLegs(moved, 1, "mirror"), 1)).toMatchObject({ out: 3, into: 3, broken: false });
    expect(slopesOf(setSpeedLegs(moved, 1, "auto"), 1).own).toBe(false);
  });

  it("run the other way when the path is reversed: the slopes change sign and swap sides", () => {
    const broken = setSpeedLegs(withSpeedSlope(m, 1, "out", 3), 1, "break"), moved = withSpeedSlope(broken, 1, "in", -4), back = reversePath({ ...moved, closed: false });
    const at = back.nodes.findIndex((n) => n.speed === 2);
    expect(back.nodes[at]).toMatchObject({ ss: 4, sb: -3 });
  });
});

describe("the path's own clock", () => {
  it("stands still until it plays, then counts seconds", () => {
    const c = new PathClock();
    expect(c.advance(0.1, 0.5)).toBe(false);
    expect(c.time).toBe(0);
    c.playing = true;
    c.advance(0.2, 0.5);
    expect(c.time).toBeCloseTo(0.2, 9);
  });

  it("starts over at the end when it loops, and stops there when it does not", () => {
    const looping = new PathClock(true), once = new PathClock(false);
    looping.playing = once.playing = true;
    looping.time = once.time = 0.45;
    expect(looping.advance(0.1, 0.5)).toBe(false);
    expect(looping.time).toBeCloseTo(0.05, 9);
    expect(looping.playing).toBe(true);
    expect(once.advance(0.1, 0.5)).toBe(true);
    expect(once.time).toBe(0.5);
    expect(once.playing).toBe(false);
  });

  it("is held to the run when put somewhere", () => {
    const c = new PathClock();
    c.seek(9, 0.5);
    expect(c.time).toBe(0.5);
    c.seek(-1, 0.5);
    expect(c.time).toBe(0);
  });
});
