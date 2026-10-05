import { describe, expect, it } from "vitest";
import { earClip, triangulate } from "@/core/mesh/triangulate";
import { makeMesh } from "@/core/mesh/makeMesh";
import { inFlatPolygon } from "@/core/math/geom";

/** Total area of the triangles, and whether every one is wound like the outline. */
function check(pts: number[], tris: number[]) {
  let area = 0, flipped = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const s = (pts[b * 2]! - pts[a * 2]!) * (pts[c * 2 + 1]! - pts[a * 2 + 1]!) - (pts[b * 2 + 1]! - pts[a * 2 + 1]!) * (pts[c * 2]! - pts[a * 2]!);
    area += s / 2;
    if (s <= 0) flipped++;
  }
  return { area: Math.abs(area), flipped };
}
const polyArea = (pts: number[], n: number) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += pts[i * 2]! * pts[((i + 1) % n) * 2 + 1]! - pts[((i + 1) % n) * 2]! * pts[i * 2 + 1]!;
  return Math.abs(s / 2);
};

// An L, wound clockwise on screen (y down), as traceContour gives.
const L = [0, 0, 40, 0, 40, 10, 10, 10, 10, 40, 0, 40];

describe("triangulation within an outline", () => {
  it("ear clipping covers a concave outline exactly, every triangle wound one way", () => {
    const tris = earClip(L, 6);
    expect(tris.length / 3).toBe(4);
    const c = check(L, tris);
    expect(c.area).toBeCloseTo(polyArea(L, 6), 9);
  });

  it("inner points go in, the area stays the outline's, nothing turns over, every point used", () => {
    const pts = [...L, 5, 5, 25, 5, 5, 25, 5, 35, 10, 5];
    const tris = triangulate(pts, 6);
    const c = check(pts, tris);
    expect(c.area).toBeCloseTo(polyArea(L, 6), 6);
    const wound = check(pts, earClip(L, 6)).flipped === 0 ? 0 : tris.length / 3;
    expect(c.flipped).toBe(wound);
    for (let p = 0; p < pts.length / 2; p++) expect(tris).toContain(p);
  });

  it("an outline edge is never flipped away: no triangle crosses the notch", () => {
    const pts = [...L, 9, 9, 11, 11];
    const tris = triangulate(pts, 6);
    for (let t = 0; t < tris.length; t += 3) {
      const cx = (pts[tris[t]! * 2]! + pts[tris[t + 1]! * 2]! + pts[tris[t + 2]! * 2]!) / 3;
      const cy = (pts[tris[t]! * 2 + 1]! + pts[tris[t + 1]! * 2 + 1]! + pts[tris[t + 2]! * 2 + 1]!) / 3;
      expect(inFlatPolygon(L, cx, cy, 6)).toBe(true);
    }
  });

  it("makeMesh: points along the outline and a grid inside, all triangulated", () => {
    const m = makeMesh(L, 5, 40, 40);
    expect(m.hull).toBeGreaterThan(6);
    expect(m.points.length / 2).toBeGreaterThan(m.hull);
    expect(check(m.points, m.triangles).area).toBeCloseTo(polyArea(L, 6), 4);
    for (let p = 0; p < m.points.length / 2; p++) expect(m.triangles).toContain(p);
  });
});

import { autoWeights, paintWeights, withPoint, withPointMoved, withoutPoint, deformsWithoutPoint } from "@/core/mesh/meshEdit";
import { localDelta, meshWorld } from "@/core/mesh/meshPose";
import { deformAt, withDeformKey } from "@/core/mesh/deform";
import { bindPlan, meshableNodes } from "@/core/mesh/meshPlan";
import { matOf } from "@/core/math/Matrix2D";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";
import { DOC_VERSION, type Animation, type MeshData, type SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { loadStickman } from "./fixtures/stickman";
import { moveKeys } from "@/core/doc/keyList";

const A = "a" as NodeId, B = "b" as NodeId;
const square: MeshData = { width: 10, height: 10, points: [0, 0, 10, 0, 10, 10, 0, 10], triangles: [0, 1, 2, 0, 2, 3], hull: 4 };

describe("editing a mesh", () => {
  it("a point inside goes in with weights blended from its triangle; outside, nothing", () => {
    const weighted: MeshData = { ...square, weights: [[[A, 1]], [[B, 1]], [[B, 1]], [[A, 1]]] };
    const m = withPoint(weighted, 5, 5)!;
    expect(m.points.slice(-2)).toEqual([5, 5]);
    expect(m.triangles.length / 3).toBe(4);
    const w = Object.fromEntries(m.weights![4]!);
    expect(w[A]! + w[B]!).toBeCloseTo(1, 9);
    expect(w[A]).toBeCloseTo(0.5, 9);
    expect(withPoint(square, 20, 5)).toBeNull();
  });
  it("removing an outline point shortens the outline; three is the least", () => {
    const five = withPoint(square, 5, 5)!;
    expect(withoutPoint(five, 4)!.hull).toBe(4);
    const tri = withoutPoint(square, 0)!;
    expect(tri.hull).toBe(3);
    expect(withoutPoint(tri, 0)).toBeNull();
    expect(deformsWithoutPoint([{ frame: 0, offsets: [1, 2, 3, 4, 5, 6] }], 1)[0]!.offsets).toEqual([1, 2, 5, 6]);
  });
  it("a moved point keeps the mesh triangulated", () => {
    const m = withPointMoved(withPoint(square, 5, 5)!, 4, 2, 2);
    expect(m.points.slice(-2)).toEqual([2, 2]);
    expect(m.triangles.length / 3).toBe(4);
  });
});

describe("weights", () => {
  const bones = [{ id: A, x0: 0, y0: 0, x1: 0, y1: 10 }, { id: B, x0: 10, y0: 0, x1: 10, y1: 10 }];
  it("each point follows the nearest bones, a point on a bone that bone alone, normalized", () => {
    const w = autoWeights([0, 5, 5, 5, 2, 5], bones);
    expect(w[0]).toEqual([[A, 1]]);
    expect(Object.fromEntries(w[1]!)).toEqual({ [A]: 0.5, [B]: 0.5 });
    expect(w[2]![0]![0]).toBe(A);
    expect(w[2]!.reduce((s, [, x]) => s + x, 0)).toBeCloseTo(1, 2);
  });
  it("the brush adds weight inside its radius, less toward the edge, the rest scaled down", () => {
    const start = [[[A, 1]], [[A, 1]], [[A, 1]]] as Array<Array<[NodeId, number]>>;
    const out = paintWeights(start, [0, 0, 5, 0, 50, 0], 0, 0, 10, B, 0.5);
    expect(Object.fromEntries(out[0]!)).toEqual({ [B]: 0.5, [A]: 0.5 });
    expect(Object.fromEntries(out[1]!)[B]).toBeCloseTo(0.25, 3);
    expect(out[2]).toEqual([[A, 1]]);
  });
});

describe("where points are", () => {
  it("a world drag through localDelta moves the point exactly that far, weighted or not", () => {
    const node = matOf(0.8, 0.6, -0.6, 0.8, 10, 20);
    const deform = [0, 0, 0, 0, 0, 0, 0, 0];
    const l = localDelta(square, 2, node, undefined, 3, -4);
    deform[4] = l.x; deform[5] = l.y;
    const before = meshWorld(square, { x: 0, y: 0 }, node), after = meshWorld(square, { x: 0, y: 0 }, node, deform);
    expect(after[4]! - before[4]!).toBeCloseTo(3, 9);
    expect(after[5]! - before[5]!).toBeCloseTo(-4, 9);
    const weighted: MeshData = { ...square, weights: square.points.filter((_, i) => i % 2 === 0).map(() => [[A, 0.3], [B, 0.7]] as Array<[NodeId, number]>) };
    const bones = {
      now: (id: NodeId) => (id === A ? matOf(1, 0.2, 0, 1.1, 5, 0) : matOf(0.9, 0, 0.3, 1, -2, 4)),
      setup: (id: NodeId) => (id === A ? matOf(1, 0, 0, 1, 0, 0) : matOf(1, 0, 0, 1, 3, 3)),
      node: matOf(1, 0, 0, 1, 1, 1),
    };
    const lw = localDelta(weighted, 1, node, bones, 2, 5);
    const d2 = [0, 0, lw.x, lw.y, 0, 0, 0, 0];
    const b2 = meshWorld(weighted, { x: 0, y: 0 }, node, null, bones), a2 = meshWorld(weighted, { x: 0, y: 0 }, node, d2, bones);
    expect(a2[2]! - b2[2]!).toBeCloseTo(2, 9);
    expect(a2[3]! - b2[3]!).toBeCloseTo(5, 9);
  });
});

describe("deform keys", () => {
  const anim = (keys: Array<{ frame: number; offsets: number[]; tween?: { kind: "none" } }>) =>
    ({ deforms: { [A]: keys } }) as unknown as Animation;
  it.each([
    ["before the first key: none", 1, null],
    ["on a key", 4, [2, 0]],
    ["linear between", 6, [3, 0]],
    ["a stepped key holds", 10, [8, 8]],
    ["past the last", 30, [0, 0]],
  ] as const)("%s", (_, frame, want) => {
    const a = anim([{ frame: 4, offsets: [2, 0] }, { frame: 8, offsets: [4, 0] }, { frame: 9, offsets: [8, 8], tween: { kind: "none" } }, { frame: 20, offsets: [0, 0] }]);
    expect(deformAt(a, A, frame)).toEqual(want);
  });
  it("key, move", () => {
    expect(withDeformKey([], 3, [1.23456, 0]).map((k) => k.offsets)).toEqual([[1.235, 0]]);
    expect(moveKeys([{ frame: 1, offsets: [] }, { frame: 5, offsets: [] }], [1], 4).map((k) => k.frame)).toEqual([5]);
  });
});

describe("what the mesh commands act on", () => {
  it("Make Mesh: selected images of their own without a mesh; Bind: one mesh and some bones", async () => {
    const { rig, node } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!.id;
    expect(meshableNodes(rig, [torso, node("chest")])).toEqual([torso]);
    expect(bindPlan(rig, [torso, node("chest")])).toEqual({ refused: expect.stringContaining("one mesh") });
    rig.nodes[torso] = { ...rig.nodes[torso]!, mesh: square };
    expect(meshableNodes(rig, [torso])).toEqual([]);
    expect(bindPlan(rig, [torso])).toEqual({ refused: expect.stringContaining("bones") });
    expect(bindPlan(rig, [torso, node("chest"), node("hips")])).toEqual({ mesh: torso, bones: [node("chest"), node("hips")] });
  });

  it("a file keeps a consistent mesh, weights of known bones, deform keys sized to it", async () => {
    const { project, rig, node } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!.id;
    rig.nodes[torso] = { ...rig.nodes[torso]!, mesh: { ...square, weights: [[[node("chest"), 1], ["gone", 1]], [], [], []] } as never };
    const head = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("head"))!.id;
    rig.nodes[head] = { ...rig.nodes[head]!, mesh: { ...square, triangles: [0, 1, 9] } };
    rig.animations[0]!.deforms = { [torso]: [{ frame: 2, offsets: [1, 2] }], [head]: [{ frame: 1, offsets: [] }] } as never;
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 20 })))).project;
    const sym = out.items[out.rootSymbolId] as SymbolItem;
    expect(out.version).toBe(DOC_VERSION);
    expect(sym.nodes[torso]!.mesh!.weights![0]).toEqual([[node("chest"), 1]]);
    expect(sym.nodes[head]!.mesh).toBeUndefined();
    expect(sym.animations[0]!.deforms).toEqual({ [torso]: [{ frame: 2, offsets: [1, 2, 0, 0, 0, 0, 0, 0] }] });
  });
});
