import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import {
  attachmentPlan, boxFromOutline, roundMoved, boxNodeBounds, boxWeightsWithPoint, inPolygon, outlineWeightsKept, POINT_RADIUS, pointMatrix, pointToSpine,
  uniqueNodeName, withBoxPoint, withOutlinePoints, withoutBoxPoint,
} from "@/core/doc/boxes";
import { evaluateSymbol } from "@/core/doc/pose";
import { apply } from "@/core/math/Matrix2D";
import type { NodeId } from "@/core/doc/ids";
import { createNode } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine } from "@/core/spine/exportSpine";
import { createLayer } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

const square = [0, 0, 10, 0, 10, 10, 0, 10];

describe("box geometry", () => {
  it.each([
    { x: 5, y: 5, inside: true }, { x: 11, y: 5, inside: false }, { x: -1, y: 5, inside: false }, { x: 9.9, y: 0.1, inside: true },
  ])("($x, $y) inside the square: $inside", ({ x, y, inside }) => {
    expect(inPolygon(square, x, y)).toBe(inside);
  });

  it.each([
    { name: "near the bottom edge", at: [5, 9], want: [0, 0, 10, 0, 10, 10, 5, 9, 0, 10] },
    { name: "near the left edge", at: [1, 5], want: [0, 0, 10, 0, 10, 10, 0, 10, 1, 5] },
    { name: "near the top edge", at: [5, 1], want: [0, 0, 5, 1, 10, 0, 10, 10, 0, 10] },
  ])("a point added $name goes into that edge", ({ at, want }) => {
    expect(withBoxPoint(square, at[0]!, at[1]!)).toEqual(want);
  });

  it("a point taken out, never below three", () => {
    expect(withoutBoxPoint(square, 1)).toEqual([0, 0, 10, 10, 0, 10]);
    expect(withoutBoxPoint([0, 0, 1, 0, 0, 1], 0)).toBeNull();
  });

  it("bounds: a box's polygon, a point's ring", () => {
    const box = { ...createNode("box", "b"), box: { points: [-5, 2, 7, -3, 1, 9] } };
    expect(boxNodeBounds(box)).toEqual({ x: -5, y: -3, w: 12, h: 12 });
    expect(boxNodeBounds(createNode("point", "p"))).toEqual({ x: -POINT_RADIUS, y: -POINT_RADIUS, w: 2 * POINT_RADIUS, h: 2 * POINT_RADIUS });
    expect(boxNodeBounds(createNode("image", "i"))).toBeNull();
    expect(boxFromOutline([10, 20, 30, 20, 30, 40], { x: 10, y: 20 })).toEqual([0, 0, 20, 0, 20, 20]);
  });
});

describe("where a new box or point goes", () => {
  it("on a picture: in its place, a box its outline about the pivot (else its rectangle)", async () => {
    const { rig, node } = await loadStickman();
    const torso = rig.nodes[node("torso")]!;
    const plan = attachmentPlan(rig, "box", torso, [0, 0, 98, 0, 98, 46], { w: 98, h: 46 });
    expect(plan).toMatchObject({ name: "torso_box", parentId: torso.parentId, bind: torso.bind });
    expect(plan.points).toEqual(boxFromOutline([0, 0, 98, 0, 98, 46], torso.pivot));
    expect(attachmentPlan(rig, "box", torso, null, { w: 98, h: 46 }).points).toEqual(boxFromOutline([0, 0, 98, 0, 98, 46, 0, 46], torso.pivot));
    expect(rig.layers[plan.layerIndex]!.nodeId).toBe(torso.id);
  });

  it("on a bone: under it at its origin; with nothing selected: at the origin; names kept unique", async () => {
    const { rig, node } = await loadStickman();
    const plan = attachmentPlan(rig, "point", rig.nodes[node("head")]!, null);
    expect(plan).toMatchObject({ name: "head_point", parentId: node("head"), layerIndex: rig.layers.findIndex((l) => l.nodeId === node("head")) });
    expect(plan.points).toBeUndefined();
    expect(attachmentPlan(rig, "box", null, null)).toMatchObject({ name: "box", parentId: null, layerIndex: 0 });
    expect(uniqueNodeName(rig, "head")).toBe("head 2");
  });
});

describe("boxes and points in the document and the file", () => {
  it("load: a box keeps finite points of three or more; a point or bone drops a box", async () => {
    const { project, rig } = await loadStickman();
    const good = { ...createNode("box", "good"), box: { points: [0, 0, 5, 0, 0, 5] } };
    const bad = { ...createNode("box", "bad"), box: { points: [0, 0, 5, Number.NaN, 0, 5] } };
    const stray = { ...createNode("point", "stray"), box: { points: [0, 0, 5, 0, 0, 5] } };
    for (const n of [good, bad, stray]) { rig.nodes[n.id] = n; rig.layers.push(createLayer(n.id, n.name, 0)); }
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const nodes = (out.items[out.rootSymbolId] as SymbolItem).nodes;
    expect(nodes[good.id]!.box).toEqual({ points: [0, 0, 5, 0, 0, 5] });
    expect(nodes[bad.id]!.box).toBeUndefined();
    expect(nodes[stray.id]!.box).toBeUndefined();
  });

  it("export: a slot each, on its own bone, the box y up; a box short of points warns and is left out", async () => {
    const { project, rig, node } = await loadStickman();
    const box = { ...createNode("box", "hit", { parentId: node("chest") }), box: { points: [0, 0, 10, 0, 0, -10] } };
    const point = createNode("point", "tip", { parentId: node("head") });
    const empty = { ...createNode("box", "empty") };
    for (const n of [box, point, empty]) { rig.nodes[n.id] = n; rig.layers.unshift(createLayer(n.id, n.name, 0)); }
    const out = exportSpine(project);
    const atts = out.skeleton.skins![0]!.attachments!;
    expect(atts.hit).toEqual({ hit: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 10, 0, 0, 10] } });
    expect(atts.tip).toEqual({ tip: { type: "point" } });
    expect(out.skeleton.slots!.find((s) => s.name === "hit")).toMatchObject({ bone: "hit", attachment: "hit" });
    expect(atts.empty).toBeUndefined();
    expect(out.diagnostics.some((d) => d.message.includes("fewer than three points"))).toBe(true);
  });
});

describe("a point with an offset", () => {
  it("placed by its offset, then turned clockwise (y down); written y up and counterclockwise", () => {
    const p = { ...createNode("point", "muzzle"), point: { x: 10, y: 5, rotation: 90 } };
    const m = pointMatrix(p);
    const at = apply({ x: 0, y: 0 }, m, 0, 0), along = apply({ x: 0, y: 0 }, m, 1, 0);
    expect([at.x, at.y]).toEqual([10, 5]);
    expect(along.x).toBeCloseTo(10, 9);
    expect(along.y).toBeCloseTo(6, 9);
    expect(pointToSpine(p)).toEqual({ x: 10, y: -5, rotation: -90 });
    expect(pointToSpine(createNode("point", "origin"))).toEqual({});
    expect(boxNodeBounds(p)).toEqual({ x: 10 - POINT_RADIUS, y: 5 - POINT_RADIUS, w: POINT_RADIUS * 2, h: POINT_RADIUS * 2 });
  });
});

describe("weighted boxes and paths", () => {
  const a = "a" as NodeId, b = "b" as NodeId;
  const box = { points: [0, 0, 10, 0, 10, 10], weights: [[[a, 1]], [[a, 0.5], [b, 0.5]], [[b, 1]]] as Array<Array<[NodeId, number]>>, boneOffsets: [[[0, 0]], [[1, 1], [2, 2]], [[3, 3]]] as Array<Array<[number, number]>> };
  it("a moved point drops its own offsets; the others keep theirs", () => {
    const out = withOutlinePoints(box, [0, 0, 12, 0, 10, 10], [1]);
    expect(out.boneOffsets).toEqual([[[0, 0]], [], [[3, 3]]]);
    expect(out.weights).toBe(box.weights);
    expect(withOutlinePoints({ ...box, boneOffsets: [[[0, 0]], [], []] }, box.points, [0]).boneOffsets).toBeUndefined();
  });
  it("a drag rounds the points it moved and leaves an opened file's others exactly", () => {
    expect(roundMoved([0.123456, 1.987654, 5.55555, 6.66666], [0.123456, 1.987654, 7.0049, 6.66666])).toEqual({ points: [0.123456, 1.987654, 7, 6.67], moved: [1] });
  });
  it("a point put in between two takes half of each, merged by bone, and no offsets", () => {
    expect(boxWeightsWithPoint(box, 2)).toEqual({
      weights: [[[a, 1]], [[a, 0.5], [b, 0.5]], [[a, 0.25], [b, 0.75]], [[b, 1]]],
      boneOffsets: [[[0, 0]], [[1, 1], [2, 2]], [], [[3, 3]]],
    });
    expect(boxWeightsWithPoint({ points: box.points }, 1)).toEqual({});
  });
  it("deleted points take their weights with them", () => {
    expect(outlineWeightsKept(box, (i) => i !== 1)).toEqual({ weights: [[[a, 1]], [[b, 1]]], boneOffsets: [[[0, 0]], [[3, 3]]] });
  });
  it("the stage places a weighted box's points by its bones", async () => {
    const { rig, node } = await loadStickman();
    const n = { ...createNode("box", "sleeve", { parentId: node("chest") }), box: { points: [0, 0, 20, 0, 20, 20], weights: [[[node("head"), 1]], [[node("head"), 1]], [[node("head"), 1]]] as Array<Array<[NodeId, number]>> } };
    rig.nodes[n.id] = n;
    rig.layers.unshift(createLayer(n.id, n.name, 0));
    const setup = evaluateSymbol(rig, null, 0, "setup", null).byNode.get(n.id)!;
    // At the setup pose each point is where the node puts it.
    const at = apply({ x: 0, y: 0 }, setup.world, 20, 0);
    expect(setup.outline![2]).toBeCloseTo(at.x, 6);
    expect(setup.outline![3]).toBeCloseTo(at.y, 6);
    // The head turns in an animation; the box goes with it, not with the chest.
    const anim = rig.animations.find((x) => x.tracks[node("head")]);
    expect(anim).toBeDefined();
    {
      const f = Math.floor(anim!.duration / 2);
      const pose = evaluateSymbol(rig, anim!, f, "animate", null).byNode;
      const headNow = pose.get(node("head"))!.world, headSetup = evaluateSymbol(rig, null, 0, "setup", null).byNode.get(node("head"))!.world;
      const inv = { x: 0, y: 0 };
      // The point in the head's setup space, carried by the head now.
      const dx = at.x - headSetup.tx, dy = at.y - headSetup.ty, det = headSetup.a * headSetup.d - headSetup.b * headSetup.c;
      inv.x = (headSetup.d * dx - headSetup.c * dy) / det; inv.y = (headSetup.a * dy - headSetup.b * dx) / det;
      const want = apply({ x: 0, y: 0 }, headNow, inv.x, inv.y);
      expect(pose.get(n.id)!.outline![2]).toBeCloseTo(want.x, 4);
      expect(pose.get(n.id)!.outline![3]).toBeCloseTo(want.y, 4);
    }
  });
});

describe("loading points, turned regions and weighted outlines", () => {
  it("kept when well formed, dropped when not", async () => {
    const { project, rig, node } = await loadStickman();
    const p = { ...createNode("point", "p", { parentId: node("chest") }), point: { x: 1, y: 2, rotation: 3 } };
    const q = { ...createNode("point", "q", { parentId: node("chest") }), point: { x: 0, y: 0, rotation: 0 } };
    const bx = { ...createNode("box", "b", { parentId: node("chest") }), box: { points: [0, 0, 1, 0, 1, 1], weights: [[[node("head"), 1]], [], [["gone", 1]]], boneOffsets: [[[1, 2]], [], []] } };
    const torso = rig.nodes[node("torso")]!;
    rig.nodes[node("torso")] = { ...torso, region: { rotation: 30, scaleX: 1 } } as never;
    for (const n of [p, q, bx]) { rig.nodes[n.id] = n as never; rig.layers.unshift(createLayer(n.id, n.name, 0)); }
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const nodes = (out.items[out.rootSymbolId] as SymbolItem).nodes;
    expect(nodes[p.id]!.point).toEqual({ x: 1, y: 2, rotation: 3 });
    expect(nodes[q.id]!.point).toBeUndefined();
    expect(nodes[bx.id]!.box).toEqual({ points: [0, 0, 1, 0, 1, 1], weights: [[[node("head"), 1]], [], []], boneOffsets: [[[1, 2]], [], []] });
    expect(nodes[node("torso")]!.region).toEqual(torso.itemId ? { rotation: 30 } : undefined);
  });
});
