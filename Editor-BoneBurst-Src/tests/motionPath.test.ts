import { breakLegs, buildCurve, curveOf, handleOffsets, mergeNodes, midAfter, mirrorLegs, moveNode, nodeLabels, renumberNodes, reversePath, withDuration, withLoop, withNode, withOrigin } from "@/motion";
import { describe, expect, it } from "vitest";
import { fitChannel, translateKeys, writeTranslateKeys } from "@/edit/pathKeys";
import type { MotionPath } from "@/model/sidecar";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { keyLists, keyTime, timeFrame } from "@/model/timelines";

const nodes = [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 100, y: 10 }, { x: 160, y: 70 }];
/** 15 frames (14 + 0), a ring through four nodes. */
const motion = (extra: Partial<MotionPath> = {}): MotionPath => ({ animation: "a", bone: "b", nodes, closed: true, duration: 0.5, loop: true, ...extra });

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
    const out = writeTranslateKeys("a", "b", translateKeys({ x: 5, y: -3 }, [{ frame: 0, x: 1, y: 1 }, { frame: 5, x: 2, y: 2 }, { frame: 9, x: 3, y: 3 }], FPS))(doc(a)).animations![0]!;
    const lists = keyLists(out).map((l) => ("timeline" in l.path ? l.path.timeline : l.path.section));
    expect(lists.sort()).toEqual(["rotate", "translate"]);
    expect(keyLists(out).find((l) => "timeline" in l.path && l.path.timeline === "translate")!.keys).toHaveLength(3);
  });
  it("cut the keys past the path's last key, on every timeline: the path sets the animation's length", () => {
    const a = { name: "a", bones: [{ name: "b", timelines: [{ name: "rotate", keys: [key(0, { value: 1 }), key(9, { value: 2 }), key(34, { value: 3 })] }, { name: "translate", keys: [key(0, { x: 1, y: 1 }), key(34, { x: 2, y: 2 })] }] }], extra: new Map() } as unknown as Animation;
    const out = writeTranslateKeys("a", "b", translateKeys({ x: 0, y: 0 }, [{ frame: 0, x: 1, y: 1 }, { frame: 14, x: 1, y: 1 }], FPS))(doc(a)).animations![0]!;
    for (const l of keyLists(out)) expect(l.keys.map((k) => timeFrame(keyTime(k), FPS))).toEqual("timeline" in l.path && l.path.timeline === "rotate" ? [0, 9] : [0, 14]);
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

describe("moving spline nodes", () => {
  const four = () => motion({ nodes: [{ x: 0, y: 0 }, { x: 5, y: 5, tx: 1, ty: 2 }, { x: 9, y: 9 }, { x: 4, y: 8 }] });
  it("takes a node to another place in the order; it keeps its handle and its number: 1, 2, 3 with 3 dragged before 2 reads 1, 3, 2", () => {
    const m = four(), s = moveNode(m, 2, 1);
    expect(s.nodes.map((n) => [n.x, n.y, n.id])).toEqual([[0, 0, 1], [9, 9, 3], [5, 5, 2], [4, 8, 4]]);
    expect(s.nodes[2]!.tx).toBe(1);
    expect(nodeLabels(s)).toEqual([1, 3, 2, 4]);
    // The same places, another order: the curve differs.
    expect(curveOf(s).length).not.toBeCloseTo(curveOf(m).length, 6);
    expect(moveNode(s, 1, 2).nodes.map((n) => [n.x, n.y])).toEqual(m.nodes.map((n) => [n.x, n.y]));
  });
  it("shifts the others: 1 moved after 2 in 3, 1, 2, 4 gives 3, 2, 1, 4", () => {
    const start = moveNode(four(), 2, 0);
    expect(nodeLabels(start)).toEqual([3, 1, 2, 4]);
    expect(nodeLabels(moveNode(start, 1, 2))).toEqual([3, 2, 1, 4]);
    expect(nodeLabels(moveNode(four(), 0, 3))).toEqual([2, 3, 4, 1]);
  });
  it("refuses a node that is not there or no move", () => {
    expect(() => moveNode(four(), 0, 4)).toThrow();
    expect(() => moveNode(four(), 1, 1)).toThrow();
    expect(() => moveNode(four(), -1, 1)).toThrow();
  });
  it("gives a node added later the next free number, in the middle too", () => {
    const m = motion({ nodes: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
    expect(nodeLabels(withNode(m, { x: 9, y: 9 }))).toEqual([1, 2, 3]);
    expect(withNode(m, { x: 9, y: 9 }).nodes.every((n) => n.id === undefined)).toBe(true);
    const sw = moveNode(withNode(m, { x: 9, y: 9 }), 2, 1);
    expect(nodeLabels(withNode(sw, { x: 7, y: 7 }))).toEqual([1, 3, 2, 4]);
    expect(nodeLabels(withNode(m, { x: 2, y: 2 }, 1))).toEqual([1, 3, 2]);
  });
});

describe("the origin of a ring", () => {
  const four = () => moveNode(motion({ nodes: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 9 }, { x: 4, y: 8 }] }), 2, 0);
  it("starts the ring at a node and goes round in the same order: 3, 1, 2, 4 started at 2 is 2, 4, 3, 1", () => {
    const m = four();
    expect(nodeLabels(m)).toEqual([3, 1, 2, 4]);
    const s = withOrigin(m, 2);
    expect(nodeLabels(s)).toEqual([2, 4, 3, 1]);
    // The same ring: every place has the same two neighbours.
    const around = (x: MotionPath) => x.nodes.map((n, i) => [n.id, x.nodes[(i + 1) % x.nodes.length]!.id]).sort().join("|");
    expect(around(s)).toBe(around(m));
    // Started again two nodes on, it is back where it was.
    expect(nodeLabels(withOrigin(s, 2))).toEqual([3, 1, 2, 4]);
  });
  it("refuses the origin itself, a node that is not there, and an open path", () => {
    expect(() => withOrigin(four(), 0)).toThrow();
    expect(() => withOrigin(four(), 4)).toThrow();
    expect(() => withOrigin({ ...four(), closed: false }, 2)).toThrow();
  });
});

describe("insert after, merge and reverse", () => {
  it("finds the middle of the span after a node, also the closing span of a ring; none after an open path's end", () => {
    const m = motion(), c = curveOf(m), p = midAfter(m, 0)!, back = c.project(p);
    expect(back.distance).toBeLessThan(1e-6);
    expect(back.s).toBeCloseTo((c.nodeAt[0]! + c.nodeAt[1]!) / 2, 3);
    expect(midAfter(m, 3)).not.toBeNull();
    expect(midAfter(motion({ closed: false }), 3)).toBeNull();
  });
  it("joins picked nodes into one at their centre, in the first one's place and number", () => {
    const next = mergeNodes(motion(), [1, 0]);
    expect(nodeLabels(next)).toEqual([1, 3, 4]);
    expect(next.nodes[0]).toMatchObject({ x: 20, y: 30 });
    expect(() => mergeNodes(motion(), [1])).toThrow();
    expect(() => mergeNodes(motion({ nodes: nodes.slice(0, 3) }), [0, 1, 2])).toThrow();
  });
  it("runs a ring the other way keeping node 1 first (1 2 3 4 becomes 1 4 3 2) and turns the handles", () => {
    const m = motion({ nodes: nodes.map((n, i) => (i === 1 ? { ...n, tx: 5, ty: 6 } : n)) }), r = reversePath(m);
    expect(nodeLabels(r)).toEqual([1, 4, 3, 2]);
    expect(r.nodes[3]).toMatchObject({ tx: -5, ty: -6 });
    expect(nodeLabels(reversePath(motion({ closed: false })))).toEqual([4, 3, 2, 1]);
  });
});

describe("sorting the numbers", () => {
  it("renumbers 1 4 3 2 as 1 2 3 4 and touches nothing else", () => {
    const r = reversePath(motion({ nodes: nodes.map((n, i) => (i === 1 ? { ...n, tx: 5, ty: 6 } : n)) })), s = renumberNodes(r);
    expect(nodeLabels(s)).toEqual([1, 2, 3, 4]);
    expect(s.nodes).toEqual(r.nodes.map(({ id: _id, ...n }) => n));
  });
});

describe("breaking the legs of a node", () => {
  it("keeps the curve as it is, then moves the way in alone", () => {
    const m = motion(), b = breakLegs(m, 1);
    expect(b.nodes[1]).toMatchObject({ tx: expect.any(Number), bx: expect.any(Number) });
    expect(curveOf(b).length).toBeCloseTo(curveOf(m).length, 3);
    const moved = { ...b, nodes: b.nodes.map((n, i) => (i === 1 ? { ...n, bx: -30, by: 0 } : n)) };
    expect(handleOffsets(moved.nodes, true)[1]!.in).toEqual({ x: -30, y: 0 });
    expect(handleOffsets(moved.nodes, true)[1]!.out).toEqual(handleOffsets(b.nodes, true)[1]!.out);
    expect(breakLegs(b, 1)).toBe(b);
  });
  it("mirrors them again: the way in is the way out turned round", () => {
    const b = breakLegs(motion(), 2), moved = { ...b, nodes: b.nodes.map((n, i) => (i === 2 ? { ...n, bx: 9, by: 9 } : n)) }, back = mirrorLegs(moved, 2);
    expect(back.nodes[2]!.bx).toBeUndefined();
    const h = handleOffsets(back.nodes, true)[2]!;
    expect(h.in).toEqual({ x: -h.out.x, y: -h.out.y });
    expect(mirrorLegs(back, 2)).toBe(back);
  });
  it("reverses with the legs swapped", () => {
    const b = breakLegs(motion(), 1), moved = { ...b, nodes: b.nodes.map((n, i) => (i === 1 ? { ...n, bx: 7, by: 8 } : n)) }, out = handleOffsets(moved.nodes, true)[1]!.out;
    const r = reversePath(moved), at = r.nodes.findIndex((n) => n.bx !== undefined);
    expect(r.nodes[at]).toMatchObject({ tx: 7, ty: 8, bx: out.x, by: out.y });
  });
});

describe("the path's run", () => {
  it("the duration is at least 0.1 s and changes nothing else; the loop switch only the loop", () => {
    const m = motion({ nodes: nodes.map((n, i) => (i === 2 ? { ...n, speed: 1.5 } : n)) }), w = withDuration(m, 1.25);
    expect(w.duration).toBe(1.25);
    expect(w.nodes).toBe(m.nodes);
    expect(() => withDuration(m, 0.05)).toThrow();
    expect(() => withDuration(m, Number.NaN)).toThrow();
    expect(withLoop(m, false)).toMatchObject({ loop: false, duration: 0.5 });
    expect(withLoop(m, true)).toBe(m);
  });
});
