import { beforeEach, describe, expect, it } from "vitest";
import { type NodeId, reseed } from "@/core/doc/ids";
import { createAnimation, createKeyframe, createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import { evaluateSymbol } from "@/core/doc/pose";
import { isCycle, seamFrame, seamGap, seamKeys } from "@/core/doc/cycle";
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
