import { beforeEach, describe, expect, it } from "vitest";
import { newIkId, type NodeId, reseed } from "@/core/doc/ids";
import { createAnimation, createKeyframe, createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import {
  type DragFrame, keyAt, pathDotAt, pathDragMode, rotateTo, rotateWithParentTo, shiftKeys, translateTo,
  withKeyTransform, withoutRedundantKeys,
} from "@/core/doc/pathEdit";
import { apply, mat, matOf, mul } from "@/core/math/Matrix2D";
import { tf, toMatrix, type Transform } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import type { Animation, Keyframe, Node, SymbolItem, Track } from "@/core/doc/types";
import { DOC_VERSION } from "@/core/doc/types";
import { createProject } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";

beforeEach(() => reseed());

function key(node: Node, frame: number, t: Partial<Transform>, extra: Partial<Keyframe> = {}): Keyframe {
  const k = createKeyframe(frame, node);
  return { ...k, transform: { ...k.transform, ...t }, tween: TWEEN_LINEAR, ...extra };
}

/** hips (root) > thigh > shin, and a free target bone; keyed as asked. */
function rig() {
  const sym: SymbolItem = createSymbol("S");
  const anim: Animation = createAnimation("a", 11);
  sym.animations = [anim];
  const add = (name: string, parent: Node | null, x = 0) => {
    const n = createNode("bone", name, { parentId: parent?.id ?? null, x });
    sym.nodes[n.id] = n;
    sym.layers.push(createLayer(n.id, name, sym.layers.length));
    return n;
  };
  const hips = add("hips", null);
  const thigh = add("thigh", hips);
  const shin = add("shin", thigh, 40);
  const target = add("target", null);
  const track = (n: Node, keys: Keyframe[]) => { anim.tracks[n.id] = { nodeId: n.id, keys, endFrame: 10 }; };
  return { sym, anim, hips, thigh, shin, target, track };
}

describe("pathDragMode", () => {
  it.each([
    ["the tip of a turning bone", "shin", "tip", false, "rotate"],
    ["…with its parent, when asked", "shin", "tip", true, "rotateWithParent"],
    ["the origin of anything", "shin", "origin", false, "translate"],
    ["a bone whose keys only move it", "thigh", "tip", false, "translate"],
    ["a root bone that does not turn", "hips", "tip", false, "translate"],
    ["…but a root that turns", "turningHips", "tip", false, "rotate"],
    ["a root, asked to bring a parent it does not have", "turningHips", "tip", true, "rotate"],
    ["a still bone under a bone", "stillShin", "tip", false, "rotate"],
  ] as const)("%s", (_, who, which, withParent, mode) => {
    const r = rig();
    r.track(r.shin, [key(r.shin, 0, { skewX: 0, skewY: 0 }), key(r.shin, 10, { skewX: 40, skewY: 40 })]);
    r.track(r.thigh, [key(r.thigh, 0, { x: 0 }), key(r.thigh, 10, { x: 30 })]);
    if (who === "turningHips") r.track(r.hips, [key(r.hips, 0, {}), key(r.hips, 10, { skewX: 9, skewY: 9 })]);
    if (who === "stillShin") delete r.anim.tracks[r.shin.id];
    const id = who === "turningHips" ? r.hips.id : who === "stillShin" ? r.shin.id : r[who].id;
    expect(pathDragMode(r.sym, r.anim, id, which, withParent)).toEqual({ mode });
  });

  it("refuses a bone the IK solves, and names the target to drag; a target moves", () => {
    const r = rig();
    r.sym.ik.push({ id: newIkId(), name: "leg", boneId: r.shin.id, targetId: r.target.id, chain: 1, bendPositive: true, weight: 1 });
    for (const n of [r.thigh, r.shin]) {
      const rule = pathDragMode(r.sym, r.anim, n.id, "tip", false);
      expect(rule).toEqual({ refused: expect.stringContaining("Drag the path of target") });
    }
    expect(pathDragMode(r.sym, r.anim, r.target.id, "tip", false)).toEqual({ mode: "translate" });
    // A parent the IK solves is not turned along.
    const foot = createNode("bone", "foot", { parentId: r.shin.id });
    r.sym.nodes[foot.id] = foot;
    r.track(foot, [key(foot, 0, {}), key(foot, 10, { skewX: 20, skewY: 20 })]);
    expect(pathDragMode(r.sym, r.anim, foot.id, "tip", true)).toEqual({ mode: "rotate" });
  });
});

/** A bone at `local` under `parent`, as the stage would pose it. */
function frame(local: Transform, parentWorld = mat(), length = 50): DragFrame {
  return { local, parentWorld, world: mul(mat(), parentWorld, toMatrix(mat(), local)), length };
}
const tip = (f: DragFrame, local: Transform) =>
  apply({ x: 0, y: 0 }, mul(mat(), f.parentWorld, toMatrix(mat(), local)), f.length, 0);

const parents = {
  identity: mat(),
  turned: toMatrix(mat(), { ...tf(100, 50), skewX: 30, skewY: 30 }),
  mirrored: matOf(-1, 0, 0, 1, 20, 0),
  uneven: toMatrix(mat(), { ...tf(0, 0), scaleX: 2, scaleY: 0.5, skewX: 15, skewY: 15 }),
};

describe("translateTo", () => {
  it.each(Object.entries(parents))("puts the tip on the target under a %s parent, keeping the angle", (_, parent) => {
    const f = frame({ ...tf(10, 20), skewX: 25, skewY: 25 }, parent);
    const t = translateTo(f, { x: 300, y: -40 });
    expect(t.skewY).toBe(25);
    expect(tip(f, t)).toMatchObject({ x: expect.closeTo(300, 6), y: expect.closeTo(-40, 6) });
  });

  it("puts the origin on the target when the origin is followed", () => {
    const f = frame(tf(10, 20), parents.turned, 0);
    const t = translateTo(f, { x: 7, y: 8 });
    expect(apply({ x: 0, y: 0 }, f.parentWorld, t.x, t.y)).toMatchObject({ x: expect.closeTo(7, 6), y: expect.closeTo(8, 6) });
  });
});

describe("rotateTo", () => {
  it.each(Object.entries(parents))("points the tip at the target under a %s parent", (_, parent) => {
    const f = frame({ ...tf(10, 20), skewX: 5, skewY: 5 }, parent);
    const target = { x: -200, y: 300 };
    const t = rotateTo(f, target);
    const o = apply({ x: 0, y: 0 }, f.parentWorld, 10, 20);
    const p = tip(f, t);
    const cross = (p.x - o.x) * (target.y - o.y) - (p.y - o.y) * (target.x - o.x);
    const dot = (p.x - o.x) * (target.x - o.x) + (p.y - o.y) * (target.y - o.y);
    expect(Math.abs(cross) / Math.hypot(target.x - o.x, target.y - o.y)).toBeLessThan(1e-6);
    expect(dot).toBeGreaterThan(0);
    expect(t.x).toBe(10);
  });
});

describe("rotateWithParentTo", () => {
  // thigh at the origin pointing down (+y), shin 60 along it bent forward.
  const thigh = frame({ ...tf(0, 0), skewX: 90, skewY: 90 }, mat(), 60);
  const shin = (parentWorld = thigh.world) => frame({ ...tf(60, 0), skewX: -30, skewY: -30 }, parentWorld, 50);
  const bendOf = (a: { x: number; y: number }, c: { x: number; y: number }, t: { x: number; y: number }) =>
    Math.sign((c.x - a.x) * (t.y - c.y) - (c.y - a.y) * (t.x - c.x));

  it.each([
    ["in reach", { x: 40, y: 80 }],
    ["closer in", { x: -20, y: 40 }],
  ])("reaches a target %s and keeps the bend", (_, target) => {
    const s = shin();
    const before = bendOf({ x: 0, y: 0 }, { x: s.world.tx, y: s.world.ty }, tip(s, s.local));
    const out = rotateWithParentTo(s, thigh, target);
    const thighWorld = mul(mat(), thigh.parentWorld, toMatrix(mat(), out.parent));
    const shinFrame = shin(thighWorld);
    const end = tip(shinFrame, out.child);
    expect(end).toMatchObject({ x: expect.closeTo(target.x, 4), y: expect.closeTo(target.y, 4) });
    expect(bendOf({ x: 0, y: 0 }, { x: shinFrame.world.tx, y: shinFrame.world.ty }, end)).toBe(before);
  });

  it("stretches toward a target out of reach", () => {
    const s = shin();
    const out = rotateWithParentTo(s, thigh, { x: 0, y: 500 });
    const end = tip(shin(mul(mat(), thigh.parentWorld, toMatrix(mat(), out.parent))), out.child);
    expect(end.x).toBeCloseTo(0, 2);
    expect(end.y).toBeCloseTo(110, 2);
  });
});

describe("keys", () => {
  const node = createNode("bone", "b");
  const track: Track = {
    nodeId: node.id, endFrame: 10,
    keys: [key(node, 0, { x: 0 }), key(node, 10, { x: 100 })],
  };

  it("keyAt reuses a key, cuts one with F6's rule, or starts a track", () => {
    expect(keyAt(track, node, 10, 11)).toEqual({ track, added: false });
    const cut = keyAt(track, node, 4, 11);
    expect(cut.added).toBe(true);
    expect(cut.track.keys.map((k) => [k.frame, k.transform.x])).toEqual([[0, 0], [4, 40], [10, 100]]);
    const fresh = keyAt(undefined, node, 6, 11);
    expect(fresh.added).toBe(true);
    expect(fresh.track.endFrame).toBe(10);
    expect(fresh.track.keys.map((k) => k.frame)).toEqual([0, 6]);
  });

  it("withKeyTransform and shiftKeys replace, never mutate", () => {
    const before = structuredClone(track);
    const moved = withKeyTransform(track, 10, { ...track.keys[1]!.transform, x: 70 });
    expect(moved.keys[1]!.transform.x).toBe(70);
    const shifted = shiftKeys(track, tf(0, 0), tf(5, -2), "translate");
    expect(shifted.keys.map((k) => [k.transform.x, k.transform.y])).toEqual([[5, -2], [105, -2]]);
    const spun = shiftKeys(track, { ...tf(0, 0), skewY: 10 }, { ...tf(0, 0), skewY: 25 }, "rotate");
    expect(spun.keys.map((k) => [k.transform.skewX, k.transform.skewY])).toEqual([[15, 15], [15, 15]]);
    expect(track).toEqual(before);
  });

  it("drops a key that changes no frame, and keeps one that does", () => {
    const onLine: Track = { ...track, keys: [key(node, 0, { x: 0 }), key(node, 4, { x: 40 }), key(node, 10, { x: 100 })] };
    expect(withoutRedundantKeys(onLine, [4]).keys.map((k) => k.frame)).toEqual([0, 10]);
    const off: Track = { ...onLine, keys: onLine.keys.map((k) => (k.frame === 4 ? { ...k, transform: { ...k.transform, x: 41 } } : k)) };
    expect(withoutRedundantKeys(off, [4]).keys.map((k) => k.frame)).toEqual([0, 4, 10]);
    // Only the candidates: the same key not named stays.
    expect(withoutRedundantKeys(onLine, [10]).keys.map((k) => k.frame)).toEqual([0, 4, 10]);
  });

  it("keeps a key that changes the image or the colour, and never the first", () => {
    const red = { aM: 100, rM: 100, gM: 0, bM: 0, aO: 0, rO: 0, gO: 0, bO: 0 };
    const shown: Track = { ...track, keys: [key(node, 0, { x: 0 }), key(node, 4, { x: 40 }, { displayIndex: -1 }), key(node, 10, { x: 100 })] };
    expect(withoutRedundantKeys(shown, [4]).keys).toHaveLength(3);
    const tinted: Track = { ...track, keys: [key(node, 0, { x: 0 }), key(node, 4, { x: 40 }, { color: red }), key(node, 10, { x: 100 })] };
    expect(withoutRedundantKeys(tinted, [4]).keys).toHaveLength(3);
    const held: Track = { ...track, keys: [key(node, 0, { x: 0 }, { tween: { kind: "none" } }), key(node, 4, { x: 0 })] };
    expect(withoutRedundantKeys(held, [0, 4]).keys.map((k) => k.frame)).toEqual([0]);
  });
});

describe("pathDotAt", () => {
  const a = "a" as NodeId, b = "b" as NodeId;
  const paths = [
    { id: a, closed: false, points: [{ frame: 0, x: 0, y: 0, key: true }, { frame: 1, x: 10, y: 0, key: false }] },
    { id: b, closed: false, points: [{ frame: 0, x: 12, y: 1, key: true }] },
  ];
  it("takes the nearest dot within the radius, a key before an in-between", () => {
    expect(pathDotAt(paths, 11.5, 0.5, 5)).toMatchObject({ id: b, frame: 0 });
    expect(pathDotAt(paths, 9, 0, 5)).toMatchObject({ id: b, frame: 0 });
    expect(pathDotAt(paths, 9, 0, 2)).toMatchObject({ id: a, frame: 1 });
    expect(pathDotAt(paths, 50, 50, 5)).toBeNull();
  });

  it("prefers the playhead's frame where dots pile up, then the earliest", () => {
    const loop = [{ id: a, closed: true, points: [0, 8, 16].map((frame) => ({ frame, x: 0, y: 0, key: true })) }];
    expect(pathDotAt(loop, 0, 0, 5, 8)).toMatchObject({ frame: 8 });
    expect(pathDotAt(loop, 0, 0, 5, 3)).toMatchObject({ frame: 0 });
  });
});

describe("Node.pathDrag in the file", () => {
  it("keeps \"parent\", drops anything else, and opens a v12 file", () => {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const a = createNode("bone", "a"), b = createNode("bone", "b");
    a.pathDrag = "parent";
    (b as { pathDrag?: unknown }).pathDrag = "sideways";
    for (const n of [a, b]) { sym.nodes[n.id] = n; sym.layers.push(createLayer(n.id, n.name, 0)); }
    const raw = JSON.parse(JSON.stringify({ ...project, version: 12 }));
    const out = validateProject(migrate(raw)).project;
    const nodes = (out.items[out.rootSymbolId] as SymbolItem).nodes;
    expect(out.version).toBe(DOC_VERSION);
    expect(nodes[a.id]!.pathDrag).toBe("parent");
    expect(nodes[b.id]!.pathDrag).toBeUndefined();
  });
});

describe("rotateTo on a bone a constraint has moved", () => {
  it("aims from where the bone is, not where its keys put it", () => {
    const local = { ...tf(10, 20), skewX: 5, skewY: 5 };
    // A transform constraint shifted the posed bone 6 px right of its keys.
    const world = toMatrix(mat(), { ...local, x: 16 });
    const f: DragFrame = { local, parentWorld: mat(), world, length: 50 };
    const target = { x: -200, y: 300 };
    const t = rotateTo(f, target);
    const posed = toMatrix(mat(), { ...t, x: 16 });
    const p = apply({ x: 0, y: 0 }, posed, 50, 0);
    const cross = (p.x - 16) * (target.y - 20) - (p.y - 20) * (target.x - 16);
    expect(Math.abs(cross) / Math.hypot(target.x - 16, target.y - 20)).toBeLessThan(1e-6);
  });
});
