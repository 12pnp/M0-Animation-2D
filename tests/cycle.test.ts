import { beforeEach, describe, expect, it } from "vitest";
import { type NodeId, reseed } from "@/core/doc/ids";
import { createAnimation, createKeyframe, createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import { evaluateSymbol } from "@/core/doc/pose";
import { cyclePlan, isCycle, seamFrame, seamGap, seamKeys } from "@/core/doc/cycle";
import { createProject } from "@/core/doc/defaults";
import { Store } from "@/app/Store";
import { doCloseLoop, doToggleCycle } from "@/app/TimelineOps";
import { TWEEN_LINEAR } from "@/core/math/easing";
import type { Animation, Keyframe, Node, SymbolItem, Track } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

function cycle(duration: number): Animation {
  return { ...createAnimation("walk", duration), endsAtLastFrame: true };
}

function key(node: Node, frame: number, t: Partial<Keyframe["transform"]>, extra: Partial<Keyframe> = {}): Keyframe {
  const k = createKeyframe(frame, node);
  return { ...k, transform: { ...k.transform, ...t }, tween: TWEEN_LINEAR, ...extra };
}

/** One bone, keyed as given, in a symbol of its own. */
function rig(keys: (n: Node) => Keyframe[], anim: Animation, endFrame = anim.duration - 1) {
  const sym: SymbolItem = createSymbol("S");
  const node = createNode("bone", "arm");
  sym.nodes[node.id] = node;
  sym.layers.push(createLayer(node.id, "arm", 0));
  anim.tracks[node.id] = { nodeId: node.id, keys: keys(node), endFrame };
  sym.animations = [anim];
  return { sym, node, anim };
}

const gaps = (sym: SymbolItem, anim: Animation) =>
  seamGap(evaluateSymbol(sym, anim, 0), evaluateSymbol(sym, anim, seamFrame(anim)!));

function closed(anim: Animation, tracks: Track[]): Animation {
  return { ...anim, tracks: { ...anim.tracks, ...Object.fromEntries(tracks.map((t) => [t.nodeId, t])) } };
}

describe("isCycle and seamFrame", () => {
  it.each([
    [0, true, 24, true, 23],
    [0, undefined, 24, false, null],
    [1, true, 24, false, null],
    [0, true, 1, true, null],
  ] as const)("playTimes %s, endsAtLastFrame %s, %s frames", (playTimes, ends, duration, is, seam) => {
    const anim: Animation = { ...createAnimation("a", duration), playTimes, ...(ends ? { endsAtLastFrame: ends } : {}) };
    expect(isCycle(anim)).toBe(is);
    expect(seamFrame(anim)).toBe(seam);
  });
});

describe("seamGap", () => {
  it("is empty for a loop that closes", () => {
    const { sym, anim } = rig((n) => [key(n, 0, { x: 0 }), key(n, 12, { x: 50 }), key(n, 24, { x: 0 })], cycle(25));
    expect(gaps(sym, anim)).toEqual([]);
  });

  it("reports how far the join is from frame 0", () => {
    const { sym, node, anim } = rig(
      (n) => [key(n, 0, { x: 0, skewX: 0, skewY: 0 }), key(n, 24, { x: 3, y: 4, skewX: 30, skewY: 30 })], cycle(25));
    const [g] = gaps(sym, anim);
    expect(g!.nodeId).toBe(node.id);
    expect(g!.distance).toBeCloseTo(5);
    expect(g!.rotation).toBeCloseTo(30);
    expect(g!.color).toBe(false);
    expect(g!.display).toBe(false);
  });

  it("reads a whole turn as no gap", () => {
    const { sym, anim } = rig((n) => [key(n, 0, { skewX: 10, skewY: 10 }), key(n, 24, { skewX: 370, skewY: 370 })], cycle(25));
    expect(gaps(sym, anim)).toEqual([]);
  });

  it("reports colour and display", () => {
    const red = { aM: 100, rM: 100, gM: 0, bM: 0, aO: 0, rO: 0, gO: 0, bO: 0 };
    const { sym, anim } = rig((n) => [key(n, 0, {}), key(n, 24, {}, { color: red, displayIndex: -1 })], cycle(25));
    const [g] = gaps(sym, anim);
    expect(g!.color).toBe(true);
    expect(g!.display).toBe(true);
  });

  it("shows the bones an IK target moves when the target's keys do not close", async () => {
    const f = await loadStickman();
    const run = f.rig.animations.find((a) => a.name === "run")!;
    const anim = { ...run, playTimes: 0, endsAtLastFrame: true as const };
    const ids = Object.keys(f.rig.nodes) as NodeId[];
    const looped = closed(anim, seamKeys(anim, f.rig.nodes, ids));
    expect(seamGap(evaluateSymbol(f.rig, looped, 0), evaluateSymbol(f.rig, looped, seamFrame(looped)!))).toEqual([]);

    const target = f.node("foot_near_target");
    const end = seamFrame(looped)!;
    const track = looped.tracks[target]!;
    const moved = closed(looped, [{
      ...track,
      keys: track.keys.map((k) => (k.frame === end ? { ...k, transform: { ...k.transform, x: k.transform.x + 20 } } : k)),
    }]);
    const named = seamGap(evaluateSymbol(f.rig, moved, 0), evaluateSymbol(f.rig, moved, end))
      .map((g) => f.rig.nodes[g.nodeId]!.name);
    expect(named).toContain("foot_near_target");
    expect(named).toContain("leg_near_thigh");
    expect(named).toContain("leg_near_shin");
    expect(named).not.toContain("leg_far_thigh");
  });
});

describe("seamKeys", () => {
  it("is nothing for an animation that is not a cycle", () => {
    const anim = createAnimation("a", 25);
    const { node } = rig((n) => [key(n, 0, { x: 0 }), key(n, 12, { x: 50 })], anim);
    expect(seamKeys(anim, { [node.id]: node }, [node.id])).toEqual([]);
  });

  it("keys frame 0's pose at the join, and leaves the input alone", () => {
    const { sym, node, anim } = rig((n) => [key(n, 0, { x: 0, y: 7 }), key(n, 12, { x: 50, y: 0 })], cycle(25));
    const before = structuredClone(anim);
    const [t] = seamKeys(anim, sym.nodes, [node.id]);
    expect(anim).toEqual(before);
    expect(t!.keys.map((k) => k.frame)).toEqual([0, 12, 24]);
    expect(t!.keys[2]!.transform).toMatchObject({ x: 0, y: 7 });
    expect(gaps(sym, closed(anim, [t!]))).toEqual([]);
  });

  it("carries a track that ends early out to the join", () => {
    const { sym, node, anim } = rig((n) => [key(n, 0, { x: 0 }), key(n, 10, { x: 50 })], cycle(25), 10);
    const [t] = seamKeys(anim, sym.nodes, [node.id]);
    expect(t!.endFrame).toBe(24);
    expect(t!.keys.at(-1)!.frame).toBe(24);
  });

  it("replaces a key already at the join", () => {
    const { sym, node, anim } = rig((n) => [key(n, 0, { x: 0 }), key(n, 24, { x: 9 })], cycle(25));
    const [t] = seamKeys(anim, sym.nodes, [node.id]);
    expect(t!.keys).toHaveLength(2);
    expect(t!.keys[1]!.transform.x).toBe(0);
  });

  it("keeps the whole turns made by the join", () => {
    const { sym, node, anim } = rig((n) => [key(n, 0, { skewX: 10, skewY: 10 }), key(n, 24, { skewX: 365, skewY: 365 })], cycle(25));
    const [t] = seamKeys(anim, sym.nodes, [node.id]);
    expect(t!.keys[1]!.transform).toMatchObject({ skewX: 370, skewY: 370 });
  });

  it("copies colour and display, and drops a colour frame 0 does not have", () => {
    const red = { aM: 100, rM: 100, gM: 0, bM: 0, aO: 0, rO: 0, gO: 0, bO: 0 };
    const { sym, node, anim } = rig((n) => [key(n, 0, {}, { color: red }), key(n, 24, {}, { displayIndex: -1 })], cycle(25));
    const [t] = seamKeys(anim, sym.nodes, [node.id]);
    expect(t!.keys[1]!.color).toEqual(red);
    expect(t!.keys[1]!.displayIndex).toBe(0);
  });

  it("returns nothing for a track that already closes, or shows nothing at frame 0", () => {
    const shut = rig((n) => [key(n, 0, { x: 4 }), key(n, 12, { x: 50 }), key(n, 24, { x: 4 })], cycle(25));
    expect(seamKeys(shut.anim, shut.sym.nodes, [shut.node.id])).toEqual([]);
    const late = rig((n) => [key(n, 5, { x: 4 }), key(n, 12, { x: 50 })], cycle(25));
    expect(seamKeys(late.anim, late.sym.nodes, [late.node.id])).toEqual([]);
  });

  it("skips nodes without a track", () => {
    const { sym, anim } = rig((n) => [key(n, 0, {})], cycle(25));
    const other = createNode("bone", "other");
    expect(seamKeys(anim, { ...sym.nodes, [other.id]: other }, [other.id])).toEqual([]);
  });
});

describe("seamGap, each node in its parent's frame", () => {
  it("reports a child that only moves with its parent on the parent alone", () => {
    const { sym, node, anim } = rig((n) => [key(n, 0, { x: 0 }), key(n, 24, { x: 10 })], cycle(25));
    const child = createNode("bone", "hand", { parentId: node.id, x: 30 });
    sym.nodes[child.id] = child;
    sym.layers.push(createLayer(child.id, "hand", 1));
    const start = evaluateSymbol(sym, anim, 0), end = evaluateSymbol(sym, anim, 24);
    expect(seamGap(start, end).map((g) => g.nodeId)).toEqual([node.id, child.id].reverse());
    expect(seamGap(start, end, undefined, true).map((g) => g.nodeId)).toEqual([node.id]);
  });
});

describe("cyclePlan", () => {
  it("adds the join after the last frame of an animation on Flash's timing", () => {
    const anim = createAnimation("a", 24);
    const { sym, node } = rig((n) => [key(n, 0, { x: 0 }), key(n, 23, { x: 50 })], anim);
    const plan = cyclePlan(anim, sym.nodes);
    expect(plan.duration).toBe(25);
    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0]!.nodeId).toBe(node.id);
    expect(plan.tracks[0]!.keys.map((k) => [k.frame, k.transform.x])).toEqual([[0, 0], [23, 50], [24, 0]]);
  });

  it("keeps the length of an animation already on Spine's timing", () => {
    const { sym, anim } = rig((n) => [key(n, 0, { x: 0 }), key(n, 12, { x: 50 })], cycle(25));
    const plan = cyclePlan({ ...anim, playTimes: 1 }, sym.nodes);
    expect(plan.duration).toBe(25);
    expect(plan.tracks[0]!.keys.at(-1)).toMatchObject({ frame: 24, transform: { x: 0 } });
  });

  it("leaves a key already at the join, and a track that stops early", () => {
    const keyed = rig((n) => [key(n, 0, { x: 0 }), key(n, 24, { x: 9 })], { ...cycle(25), playTimes: 1 });
    expect(cyclePlan(keyed.anim, keyed.sym.nodes).tracks).toEqual([]);
    const early = rig((n) => [key(n, 0, { x: 0 }), key(n, 5, { x: 9 })], createAnimation("a", 24), 10);
    early.anim.duration = 24;
    expect(cyclePlan(early.anim, early.sym.nodes).tracks).toEqual([]);
  });
});

describe("Cycle and Close Loop in the store", () => {
  function storeWith(keys: (n: Node) => Keyframe[], duration: number, endsAtLastFrame = false) {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const node = createNode("bone", "arm");
    sym.nodes[node.id] = node;
    sym.layers.push(createLayer(node.id, "arm", 0));
    const anim = sym.animations[0]!;
    anim.duration = duration;
    if (endsAtLastFrame) anim.endsAtLastFrame = true;
    anim.tracks[node.id] = { nodeId: node.id, keys: keys(node), endFrame: duration - 1 };
    return { store: new Store(project), node };
  }

  it("turns on as one undo step, and off again without touching the keys", () => {
    const { store, node } = storeWith((n) => [key(n, 0, { x: 0 }), key(n, 23, { x: 50 })], 24);
    const before = store.currentAnimation!;
    doToggleCycle(store);
    const on = store.currentAnimation!;
    expect(isCycle(on)).toBe(true);
    expect(on.duration).toBe(25);
    expect(on.tracks[node.id]!.keys.map((k) => k.frame)).toEqual([0, 23, 24]);

    doToggleCycle(store);
    const off = store.currentAnimation!;
    expect(isCycle(off)).toBe(false);
    expect(off.playTimes).toBe(1);
    expect(off.endsAtLastFrame).toBe(true);
    expect(off.tracks[node.id]).toBe(on.tracks[node.id]);

    store.undo();
    store.undo();
    const back = store.currentAnimation!;
    expect(back.duration).toBe(24);
    expect(back.playTimes).toBe(0);
    expect(back.endsAtLastFrame).toBeUndefined();
    expect(back.tracks[node.id]).toBe(before.tracks[node.id]);

    store.redo();
    expect(isCycle(store.currentAnimation!)).toBe(true);
    expect(store.currentAnimation!.tracks[node.id]).toBe(on.tracks[node.id]);
  });

  it("closes the loop on the layers given", () => {
    const { store, node } = storeWith((n) => [key(n, 0, { x: 0 }), key(n, 24, { x: 9 })], 25, true);
    expect(isCycle(store.currentAnimation!)).toBe(true);
    expect(store.currentAnimation!.tracks[node.id]!.keys[1]!.transform.x).toBe(9);
    doCloseLoop(store, [node.id]);
    expect(store.currentAnimation!.tracks[node.id]!.keys[1]!.transform.x).toBe(0);
    store.undo();
    expect(store.currentAnimation!.tracks[node.id]!.keys[1]!.transform.x).toBe(9);
  });
});
