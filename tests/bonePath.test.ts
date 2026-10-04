import { beforeEach, describe, expect, it } from "vitest";
import { MixFrom, Physics, Skeleton, SkeletonJson } from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import { createAnimation, createKeyframe, createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import { evaluateSymbol } from "@/core/doc/pose";
import { bonePaths, keyedIn, pathFrames, pathPoint } from "@/core/doc/bonePath";
import { TWEEN_LINEAR, type TweenSpec } from "@/core/math/easing";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import type { Animation, Keyframe, Node, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

function key(node: Node, frame: number, deg: number, tween: TweenSpec = TWEEN_LINEAR): Keyframe {
  const k = createKeyframe(frame, node);
  return { ...k, transform: { ...k.transform, skewX: deg, skewY: deg }, tween };
}

/** One bone of length 100 at the origin, turning as keyed. */
function arm(keys: (n: Node) => Keyframe[], anim: Animation = createAnimation("a", 11)) {
  const sym: SymbolItem = createSymbol("S");
  const node = createNode("bone", "arm");
  node.boneLength = 100;
  sym.nodes[node.id] = node;
  sym.layers.push(createLayer(node.id, "arm", 0));
  anim.tracks[node.id] = { nodeId: node.id, keys: keys(node), endFrame: anim.duration - 1 };
  sym.animations = [anim];
  return { sym, node, anim };
}

function pathOf(sym: SymbolItem, anim: Animation, id: Node["id"], span?: { start: number; end: number }) {
  const { frames, closed } = pathFrames(anim, span);
  return bonePaths({
    sample: (f) => evaluateSymbol(sym, anim, f), ids: [id], frames, closed, which: "tip", isKey: keyedIn(anim),
  })[0]!;
}

const steps = (pts: { x: number; y: number }[]) =>
  pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));

describe("pathPoint", () => {
  it("is the tip of a bone, the origin of anything else", () => {
    const { sym, node, anim } = arm((n) => [key(n, 0, 90)]);
    const img = createNode("image", "pic", { x: 5, y: 6 });
    sym.nodes[img.id] = img;
    sym.layers.push(createLayer(img.id, "pic", 1));
    const pose = evaluateSymbol(sym, anim, 0);
    // y is down on the stage, so +90° points the bone down.
    expect(pathPoint(pose, node.id, "tip")).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(100, 6) });
    expect(pathPoint(pose, node.id, "origin")).toEqual({ x: 0, y: 0 });
    expect(pathPoint(pose, img.id, "tip")).toEqual({ x: 5, y: 6 });
    expect(pathPoint(pose, "nope" as Node["id"], "tip")).toBeNull();
  });
});

describe("bonePaths", () => {
  it("follows the tip round a quarter arc, evenly spaced on a linear tween", () => {
    const { sym, node, anim } = arm((n) => [key(n, 0, 0), key(n, 10, 90)]);
    const path = pathOf(sym, anim, node.id);
    expect(path.closed).toBe(false);
    expect(path.points.map((p) => p.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(path.points.filter((p) => p.key).map((p) => p.frame)).toEqual([0, 10]);
    for (const p of path.points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
    const d = steps(path.points);
    for (const s of d) expect(s).toBeCloseTo(d[0]!, 6);
  });

  it("bunches the dots where an ease is slow", () => {
    const { sym, node, anim } = arm((n) => [key(n, 0, 0, { kind: "ease", value: -1 }), key(n, 10, 90)]);
    const d = steps(pathOf(sym, anim, node.id).points);
    // Ease in: slow out of the first key, fast into the last.
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThan(d[i - 1]!);
  });

  it("runs a cycle up to the join and closes it", () => {
    const cycle = { ...createAnimation("a", 9), endsAtLastFrame: true as const };
    const { sym, node, anim } = arm((n) => [key(n, 0, 0), key(n, 4, 90), key(n, 8, 0)], cycle);
    const path = pathOf(sym, anim, node.id);
    expect(path.closed).toBe(true);
    expect(path.points.map((p) => p.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("poses each frame once for all the paths", () => {
    const { sym, node, anim } = arm((n) => [key(n, 0, 0), key(n, 10, 90)]);
    const child = createNode("bone", "hand", { parentId: node.id, x: 100 });
    sym.nodes[child.id] = child;
    sym.layers.push(createLayer(child.id, "hand", 1));
    const posed: number[] = [];
    const paths = bonePaths({
      sample: (f) => { posed.push(f); return evaluateSymbol(sym, anim, f); },
      ids: [node.id, child.id], frames: [0, 5, 10], closed: false, which: "origin",
    });
    expect(posed).toEqual([0, 5, 10]);
    expect(paths[1]!.points.at(-1)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(100, 6), key: false });
  });
});

describe("pathFrames", () => {
  const cycle = { ...createAnimation("a", 9), endsAtLastFrame: true as const };
  it.each([
    ["the whole animation", createAnimation("a", 5), undefined, [0, 1, 2, 3, 4], false],
    ["a span inside it", createAnimation("a", 20), { start: 3, end: 6 }, [3, 4, 5, 6], false],
    ["a span clamped to it", createAnimation("a", 5), { start: -2, end: 2 }, [0, 1, 2], false],
    ["a whole cycle", cycle, undefined, [0, 1, 2, 3, 4, 5, 6, 7], true],
    ["a span across the join, in playing order", cycle, { start: -2, end: 2 }, [6, 7, 0, 1, 2], false],
    ["a span as long as the cycle", cycle, { start: -3, end: 7 }, [5, 6, 7, 0, 1, 2, 3, 4], true],
  ] as const)("%s", (_, anim, span, frames, closed) => {
    expect(pathFrames(anim, span)).toEqual({ frames, closed });
  });
});

describe("the path of an IK-solved bone is the one spine-core plays", () => {
  it("the stickman's near foot over the run", async () => {
    const { project, rig, node } = await loadStickman();
    const run = rig.animations.find((a) => a.name === "run")!;
    const shin = node("leg_near_shin");
    const path = pathOf(rig, run, shin);
    // The shin has no keys of its own: the IK moves it.
    expect(path.points.some((p) => p.key)).toBe(false);

    // Bones only: no attachment loader needed.
    const file = JSON.parse(spineJson(exportSpine(project).skeleton));
    delete file.skins;
    const skeleton = new Skeleton(new SkeletonJson({} as never).readSkeletonData(file));
    const animation = skeleton.data.findAnimation("run")!;
    const bone = skeleton.findBone(rig.nodes[shin]!.name)!;
    expect(bone.data.length).toBeGreaterThan(10);
    let moved = 0;
    for (const p of path.points) {
      skeleton.setupPose();
      animation.apply(skeleton, 0, p.frame / project.frameRate, false, null, 1, MixFrom.setup, false, false, false);
      skeleton.updateWorldTransform(Physics.none);
      const b = bone.appliedPose;
      const tipX = b.worldX + b.a * bone.data.length;
      const tipY = -(b.worldY + b.c * bone.data.length);
      expect(Math.abs(tipX - p.x), `frame ${p.frame}`).toBeLessThan(1e-3);
      expect(Math.abs(tipY - p.y), `frame ${p.frame}`).toBeLessThan(1e-3);
      moved = Math.max(moved, Math.hypot(p.x - path.points[0]!.x, p.y - path.points[0]!.y));
    }
    // A run moves the foot a long way: the comparison is not of a still bone.
    expect(moved).toBeGreaterThan(50);
  });
});
