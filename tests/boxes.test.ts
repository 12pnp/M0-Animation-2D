import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { attachmentPlan, boxFromOutline, boxNodeBounds, inPolygon, POINT_RADIUS, uniqueNodeName, withBoxPoint, withoutBoxPoint } from "@/core/doc/boxes";
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
