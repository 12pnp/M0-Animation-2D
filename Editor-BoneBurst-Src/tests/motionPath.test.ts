import { describe, expect, it } from "vitest";
import { addNodeTime, bakeTranslate, blocksOf, boundaryProgress, buildCurve, curveOf, endFrame, fitChannel, handleOffsets, keyFrames, keysSignature, moveNodeTime, nodeTimeFrames, pathSignature, placeAtFrame, progressAtFrame, removeNodeTime, translateKeys, withBlockGraph, withFrames, withSpeed } from "@/edit/motionPath";
import type { MotionPath } from "@/model/sidecar";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { keyLists, keyTime, timeFrame } from "@/model/timelines";

const nodes = [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 100, y: 10 }, { x: 160, y: 70 }];
/** The owner's example: 15 frames (14 + 0), a ring, node times on 0, 5 and 10. */
const motion = (extra: Partial<MotionPath> = {}): MotionPath => ({ animation: "a", bone: "b", nodes, closed: true, frames: 15, starts: [5, 10], speeds: [], ...extra });

describe("the path through the nodes", () => {
  it("passes through every node, and is a straight line through two", () => {
    const c = buildCurve(nodes);
    nodes.forEach((n, i) => { const p = c.at(c.nodeAt[i]!); expect(p.x).toBeCloseTo(n.x, 6); expect(p.y).toBeCloseTo(n.y, 6); });
    const line = buildCurve([{ x: 0, y: 0 }, { x: 30, y: 40 }]);
    expect(line.length).toBeCloseTo(50, 6);
    expect(line.at(25).x).toBeCloseTo(15, 6);
  });
  it("projects a point onto the nearest place of the path", () => {
    const c = buildCurve(nodes), s = c.length * 0.4, p = c.at(s);
    const back = c.project({ x: p.x + 0.001, y: p.y });
    expect(back.s).toBeCloseTo(s, 1);
    expect(c.project({ x: 500, y: 500 }).distance).toBeGreaterThan(100);
  });
});

describe("projecting where the path doubles back", () => {
  it("takes the place nearer the hint when two parts of the path are equally near", () => {
    const hairpin = buildCurve([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0.001 }]);
    const out = hairpin.project({ x: 25, y: 0 }, hairpin.length * 0.2), back = hairpin.project({ x: 25, y: 0 }, hairpin.length * 0.8);
    expect(out.s).toBeLessThan(hairpin.length / 2);
    expect(back.s).toBeGreaterThan(hairpin.length / 2);
  });
});

describe("a ring", () => {
  it("has every node on it and comes back to the first: the last span joins the last node to the first", () => {
    const c = buildCurve(nodes, true);
    expect(c.nodeAt).toHaveLength(nodes.length + 1);
    nodes.forEach((n, i) => { const p = c.at(c.nodeAt[i]!); expect(p.x).toBeCloseTo(n.x, 6); expect(p.y).toBeCloseTo(n.y, 6); });
    const back = c.at(c.length);
    expect(back.x).toBeCloseTo(nodes[0]!.x, 6);
    expect(back.y).toBeCloseTo(nodes[0]!.y, 6);
    expect(c.length).toBeGreaterThan(buildCurve(nodes, false).length);
  });
  it("gives every node a way in and a way out", () => {
    const hs = handleOffsets(nodes, true);
    for (const h of hs) { expect(Math.hypot(h.out.x, h.out.y)).toBeGreaterThan(0); expect(Math.hypot(h.in.x, h.in.y)).toBeGreaterThan(0); }
    const open = handleOffsets(nodes, false);
    expect(open[0]!.in).toEqual({ x: 0, y: 0 });
  });
  it("through two nodes is a loop and not a line there and back", () => {
    const c = buildCurve([{ x: 0, y: 0 }, { x: 100, y: 0 }], true), mid = c.at(c.length * 0.25);
    expect(Math.abs(mid.y)).toBeGreaterThan(10);
    const back = c.at(c.length);
    expect(back.x).toBeCloseTo(0, 6);
  });
});

describe("blocks (docs/PATH-FRAMES-PLAN.md)", () => {
  it("the owner's example: 15 frames, node times on 0, 5 and 10 on a ring: three blocks, 0→5, 5→10, 10→15", () => {
    const m = motion();
    expect(nodeTimeFrames(m)).toEqual([0, 5, 10]);
    expect(endFrame(m)).toBe(15);
    expect(blocksOf(m).map((b) => [b.start, b.end, b.speed])).toEqual([[0, 5, 1], [5, 10, 1], [10, 15, 1]]);
    expect(keyFrames(m)).toEqual([0, 5, 10, 15]);
  });
  it("an open path ends on the last frame shown: 14", () => {
    const m = motion({ closed: false });
    expect(endFrame(m)).toBe(14);
    expect(blocksOf(m).map((b) => [b.start, b.end])).toEqual([[0, 5], [5, 10], [10, 14]]);
    expect(keyFrames(m)).toEqual([0, 5, 10, 14]);
  });
  it("the path covered in a block is its frames times its multiplier, renormalised: all 1 is even; ×2 on the middle block", () => {
    expect(boundaryProgress(motion()).map((p) => Math.round(p * 1e6) / 1e6)).toEqual([0, 0.333333, 0.666667, 1]);
    expect(boundaryProgress(motion({ speeds: [1, 2, 1] }))).toEqual([0, 0.25, 0.75, 1]);
    // ×2 moves the end of its block further along, and the blocks after it less than before.
    const even = boundaryProgress(motion()), fast = boundaryProgress(motion({ speeds: [1, 2, 1] }));
    expect(fast[2]! - fast[1]!).toBeGreaterThan(even[2]! - even[1]!);
    expect(fast[3]! - fast[2]!).toBeLessThan(even[3]! - even[2]!);
  });
  it("is at the first node on frame 0 and, on a ring, back at it on the last frame (frame 0 again); even speed inside a block", () => {
    const m = motion();
    expect(progressAtFrame(m, 0)).toBe(0);
    expect(progressAtFrame(m, 15)).toBe(1);
    expect(progressAtFrame(m, 2.5)).toBeCloseTo(progressAtFrame(m, 5) / 2, 9);
    const first = placeAtFrame(m, 0), last = placeAtFrame(m, 15);
    expect(last.x).toBeCloseTo(first.x, 6);
    expect(last.y).toBeCloseTo(first.y, 6);
    // Frame 5 is where the second block begins: a third of the way round at even speed.
    const c = curveOf(m), p5 = placeAtFrame(m, 5), want = c.at(c.length / 3);
    expect(p5.x).toBeCloseTo(want.x, 6);
  });
  it("adds a node time inside the run, splitting a block (both halves keep its multiplier); refused on frame 0, the end, or another", () => {
    const m = motion({ speeds: [1, 2, 1] }), added = addNodeTime(m, 7);
    expect(nodeTimeFrames(added)).toEqual([0, 5, 7, 10]);
    expect(blocksOf(added).map((b) => b.speed)).toEqual([1, 2, 2, 1]);
    expect(() => addNodeTime(m, 0)).toThrow(/from 1 to 14/);
    expect(() => addNodeTime(m, 15)).toThrow(/from 1 to 14/);
    expect(() => addNodeTime(m, 5)).toThrow(/already/);
  });
  it("removes a node time but never the first, and a path keeps two", () => {
    const m = motion({ speeds: [1, 2, 3] }), less = removeNodeTime(m, 1);
    expect(nodeTimeFrames(less)).toEqual([0, 10]);
    expect(blocksOf(less).map((b) => b.speed)).toEqual([1, 3]);
    expect(() => removeNodeTime(m, 0)).toThrow(/first/);
    expect(() => removeNodeTime(less, 1)).toThrow(/keeps two/);
  });
  it("moves a node time, held a frame inside its neighbours; the first stays", () => {
    const m = motion();
    expect(nodeTimeFrames(moveNodeTime(m, 1, 7))).toEqual([0, 7, 10]);
    expect(nodeTimeFrames(moveNodeTime(m, 1, 12))).toEqual([0, 9, 10]);
    expect(nodeTimeFrames(moveNodeTime(m, 2, 3))).toEqual([0, 5, 6]);
    expect(() => moveNodeTime(m, 0, 3)).toThrow(/first/);
  });
  it("the total frames keep the node times' share of the run, always two node times; a multiplier is 0.1 to 10", () => {
    const m = motion(), long = withFrames(m, 30);
    expect(long.frames).toBe(30);
    expect(nodeTimeFrames(long)).toEqual([0, 10, 20]);
    expect(nodeTimeFrames(withFrames(m, 4)).length).toBeGreaterThanOrEqual(2);
    expect(() => withFrames(m, 2)).toThrow(/at least 4/);
    expect(withSpeed(m, 1, 2).speeds).toEqual([1, 2, 1]);
    expect(() => withSpeed(m, 1, 0)).toThrow(/0.1 to 10/);
    expect(() => withSpeed(m, 9, 1)).toThrow(/no such block/);
  });
  it("the path's own settings have a signature that changes when one does", () => {
    expect(pathSignature(motion())).toBe(pathSignature(motion()));
    for (const other of [motion({ frames: 16 }), motion({ closed: false }), motion({ starts: [4, 10] }), motion({ speeds: [1, 2, 1] }), motion({ nodes: [{ x: 1, y: 0 }, ...nodes.slice(1)] })]) expect(pathSignature(other)).not.toBe(pathSignature(motion()));
  });
});

describe("fitting a Spine curve to a segment", () => {
  const cubic = (v0: number, c1: number, c2: number, v3: number, n: number) => Array.from({ length: n + 1 }, (_, k) => { const u = k / n, w = 1 - u; return w * w * w * v0 + 3 * w * w * u * c1 + 3 * w * u * u * c2 + u * u * u * v3; });
  it("finds the control values of a cubic that is even in time, exactly", () => {
    const f = fitChannel(cubic(0, 30, -10, 20, 12));
    expect(f.c1).toBeCloseTo(30, 6);
    expect(f.c2).toBeCloseTo(-10, 6);
    expect(f.error).toBeLessThan(1e-9);
  });
  it("is a straight line for a straight segment, and says how far off a segment that is not a cubic is", () => {
    const line = fitChannel([0, 1, 2, 3, 4, 5, 6]);
    expect(line.c1).toBeCloseTo(2, 9);
    expect(line.c2).toBeCloseTo(4, 9);
    expect(line.error).toBeLessThan(1e-9);
    const hump = Array.from({ length: 13 }, (_, k) => (k < 6 ? 0 : k < 7 ? 5 : 10));
    expect(fitChannel(hump).error).toBeGreaterThan(0.5);
  });
});

describe("the keys", () => {
  const FPS = 30;
  const key = (frame: number, f: Partial<Key> = {}): Key => ({ ...(frame ? { time: frame / FPS } : {}), ...f, extra: new Map() }) as Key;
  const doc = (a: Animation): Skeleton => ({ header: { fps: FPS }, bones: [{ name: "b", x: 5, y: -3 }], animations: [a] }) as unknown as Skeleton;
  it("are offsets from the setup pose at the frames' times, each with its curve to the next key (control times at thirds)", () => {
    const ks = translateKeys({ x: 5, y: -3 }, [{ frame: 0, x: 5, y: -3, control: [8, 12, 0, 3] }, { frame: 3, x: 15, y: 7 }], FPS);
    expect(ks[0]).toMatchObject({ x: 0, y: 0 });
    expect(ks[1]).toMatchObject({ x: 10, y: 10 });
    expect(timeFrame(keyTime(ks[1]!), FPS)).toBe(3);
    const curve = ks[0]!.curve as number[];
    expect(curve).toHaveLength(8);
    // x: control times a third and two thirds of the way (0.1 s long), values offset from the setup.
    expect(curve[0]).toBeCloseTo(0.1 / 3, 6);
    expect(curve[1]).toBeCloseTo(3, 6);
    expect(curve[2]).toBeCloseTo((0.1 * 2) / 3, 6);
    expect(curve[3]).toBeCloseTo(7, 6);
    expect(curve[5]).toBeCloseTo(3, 6);
    expect(curve[7]).toBeCloseTo(6, 6);
    expect(ks[1]!.curve).toBeUndefined();
  });
  it("replace the bone's translate timelines, including the split ones, and nothing else", () => {
    const a = { name: "a", bones: [{ name: "b", timelines: [{ name: "rotate", keys: [key(0, { value: 1 })] }, { name: "translatex", keys: [key(0, { value: 4 })] }, { name: "translate", keys: [key(0, { x: 1, y: 1 }), key(9, { x: 2, y: 2 })] }] }], extra: new Map() } as unknown as Animation;
    const out = bakeTranslate("a", "b", translateKeys({ x: 5, y: -3 }, [{ frame: 0, x: 1, y: 1 }, { frame: 5, x: 2, y: 2 }, { frame: 9, x: 3, y: 3 }], FPS))(doc(a)).animations![0]!;
    const lists = keyLists(out).map((l) => ("timeline" in l.path ? l.path.timeline : l.path.section));
    expect(lists.sort()).toEqual(["rotate", "translate"]);
    expect(keyLists(out).find((l) => "timeline" in l.path && l.path.timeline === "translate")!.keys).toHaveLength(3);
  });
  it("cut the keys past the path's last key, on every timeline: the path sets the animation's length", () => {
    const a = { name: "a", bones: [{ name: "b", timelines: [{ name: "rotate", keys: [key(0, { value: 1 }), key(9, { value: 2 }), key(34, { value: 3 })] }, { name: "translate", keys: [key(0, { x: 1, y: 1 }), key(34, { x: 2, y: 2 })] }] }], extra: new Map() } as unknown as Animation;
    const out = bakeTranslate("a", "b", translateKeys({ x: 0, y: 0 }, [{ frame: 0, x: 1, y: 1 }, { frame: 14, x: 1, y: 1 }], FPS))(doc(a)).animations![0]!;
    for (const l of keyLists(out)) expect(l.keys.map((k) => timeFrame(keyTime(k), FPS))).toEqual("timeline" in l.path && l.path.timeline === "rotate" ? [0, 9] : [0, 14]);
  });
  it("have a signature that changes when a key does", () => {
    const a = [key(0, { x: 1, y: 2 }), key(4, { x: 3, y: 4 })];
    expect(keysSignature(a)).toBe(keysSignature([...a]));
    expect(keysSignature(a)).not.toBe(keysSignature([key(0, { x: 1, y: 2 }), key(4, { x: 3, y: 4.01 })]));
  });
});

describe("the nodes of a path", () => {
  it("a path needs two", () => {
    expect(() => curveOf({ nodes: [{ x: 0, y: 0 }], closed: true })).toThrow(/two nodes/);
  });
});

describe("the handles at the nodes", () => {
  const three = [{ x: 0, y: 0 }, { x: 60, y: 40 }, { x: 120, y: 0 }];
  it("are automatic by default: along the line between a node's neighbours, a third of the way to each", () => {
    const hs = handleOffsets(three);
    expect(hs[1]!.out.x).toBeGreaterThan(0);
    expect(hs[1]!.out.y).toBeCloseTo(0, 9);
    expect(hs[1]!.in.x).toBeCloseTo(-hs[1]!.out.x, 9);
    expect(Math.hypot(hs[0]!.out.x, hs[0]!.out.y)).toBeCloseTo(Math.hypot(60, 40) / 3, 9);
    expect(hs[0]!.in).toEqual({ x: 0, y: 0 });
    expect(hs[2]!.out).toEqual({ x: 0, y: 0 });
  });
  it("a dragged handle is the node's, and its mirror is the way in; the curve still passes through every node", () => {
    const ns = [three[0]!, { ...three[1]!, tx: 0, ty: 50 }, three[2]!];
    const hs = handleOffsets(ns);
    expect(hs[1]!.out).toEqual({ x: 0, y: 50 });
    expect(hs[1]!.in).toEqual({ x: -0, y: -50 });
    const c = buildCurve(ns);
    ns.forEach((n, i) => { const p = c.at(c.nodeAt[i]!); expect(p.x).toBeCloseTo(n.x, 6); expect(p.y).toBeCloseTo(n.y, 6); });
    const auto = buildCurve(three), a = auto.at(auto.nodeAt[1]! + 10), b = c.at(c.nodeAt[1]! + 10);
    expect(b.y).toBeGreaterThan(a.y);
  });
});

describe("a block's speed graph", () => {
  const slowIn = [{ u: 0, v: 0.2 }, { u: 1, v: 1.8 }];
  it("is a straight line at 1 by default: the progress is even inside a block", () => {
    const m = motion();
    expect(blocksOf(m)[0]!.graph.every((p) => p.v === 1)).toBe(true);
    expect(progressAtFrame(m, 2.5)).toBeCloseTo(boundaryProgress(m)[1]! / 2, 9);
  });
  it("bends the progress inside the block but not its ends: the frames and the block's share stay", () => {
    const m = withBlockGraph(motion(), 0, slowIn), flat = motion(), bp = boundaryProgress(m);
    expect(bp).toEqual(boundaryProgress(flat));
    expect(progressAtFrame(m, 0)).toBe(0);
    expect(progressAtFrame(m, 5)).toBeCloseTo(bp[1]!, 9);
    // Slow in: less of the block's path is covered by its middle.
    expect(progressAtFrame(m, 2.5)).toBeLessThan(progressAtFrame(flat, 2.5));
    // The area under 0.2 → 1.8 up to u = 0.5 is 0.3 of the whole.
    expect(progressAtFrame(m, 2.5)).toBeCloseTo(bp[1]! * 0.3, 9);
    // Frames in another block are untouched.
    expect(progressAtFrame(m, 7)).toBeCloseTo(progressAtFrame(flat, 7), 9);
  });
  it("is put back to a straight line by null or by points all at 1, and is refused when malformed", () => {
    const bent = withBlockGraph(motion(), 1, slowIn);
    expect(bent.curves?.[1]).toEqual([0, 0.2, 1, 1.8]);
    expect(withBlockGraph(bent, 1, null).curves).toBeUndefined();
    expect(withBlockGraph(bent, 1, [{ u: 0, v: 1 }, { u: 1, v: 1 }]).curves).toBeUndefined();
    expect(() => withBlockGraph(motion(), 0, [{ u: 0, v: 1 }])).toThrow();
    expect(() => withBlockGraph(motion(), 0, [{ u: 0.1, v: 1 }, { u: 1, v: 1 }])).toThrow();
    expect(() => withBlockGraph(motion(), 0, [{ u: 0, v: 1 }, { u: 0, v: 1 }, { u: 1, v: 1 }])).toThrow();
    expect(() => withBlockGraph(motion(), 0, [{ u: 0, v: 0 }, { u: 1, v: 1 }])).toThrow();
    expect(() => withBlockGraph(motion(), 9, slowIn)).toThrow();
  });
  it("stays with its block when node times are added or removed, and joins to a straight line", () => {
    const m = withBlockGraph(motion(), 2, slowIn);
    const added = addNodeTime(m, 2);
    expect(blocksOf(added).map((b) => b.graph.some((p) => p.v !== 1))).toEqual([false, false, false, true]);
    const removed = removeNodeTime(m, 1);
    expect(blocksOf(removed).map((b) => b.graph.some((p) => p.v !== 1))).toEqual([false, true]);
    expect(blocksOf(removeNodeTime(m, 2)).every((b) => b.graph.every((p) => p.v === 1))).toBe(true);
  });
  it("changes the path's signature", () => {
    expect(pathSignature(withBlockGraph(motion(), 0, slowIn))).not.toBe(pathSignature(motion()));
  });
});
