import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSkeleton } from "@/io/skeletonRead";
import type { MotionPath } from "@/model/sidecar";
import { fromView, parentChoices, pathFromView, pathToView, refBoneName, toView } from "@/ui/motion";
import type { Matrix } from "@/ui/stage/gizmo";

const doc = readSkeleton(readFileSync(join(__dirname, "fixtures", "stickman", "Stickman_IK.json"), "utf8")).skeleton;

// A bone turned 90° and scaled 2 along x, 0.5 along y, its joint at (30, -10).
const M: Matrix = [0, -0.5, 2, 0, 30, -10];
const path: MotionPath = {
  animation: "run", bone: "head", parent: "hips",
  nodes: [{ x: 10, y: 0, id: 1 }, { x: 20, y: 6, tx: 4, ty: -2, bx: -3, by: 1, id: 2 }, { x: 5, y: -8, id: 3 }],
  closed: true, duration: 0.5, loop: true,
};

describe("a path relative to a parent bone: its nodes through that bone's matrix", () => {
  it("toView is the matrix's linear part (the joint is the panel's origin) and fromView undoes it", () => {
    const [x, y] = toView(M, 4, 6);
    expect([x, y]).toEqual([-3, 8]);
    const [a, b] = fromView(M, x, y);
    expect(a).toBeCloseTo(4, 9);
    expect(b).toBeCloseTo(6, 9);
  });

  it("pathToView carries the nodes and their handles, and pathFromView brings them back exactly", () => {
    const view = pathToView(path, M);
    expect(view.nodes[0]).toMatchObject({ x: 0, y: 20, id: 1 });
    expect(view.nodes[1]!.tx).toBeCloseTo(1, 9);
    const back = pathFromView(view, M, path);
    expect(back).toEqual(path);
  });

  it("a node dragged in the view is written back in the parent's space; the others keep their stored numbers", () => {
    const view = pathToView(path, M), moved = { ...view, nodes: view.nodes.map((n, i) => (i === 2 ? { ...n, x: n.x + 3, y: n.y - 4 } : n)) };
    const back = pathFromView(moved, M, path);
    expect(back.nodes[0]).toBe(path.nodes[0]);
    expect(back.nodes[1]).toBe(path.nodes[1]);
    const [dx, dy] = fromView(M, 3, -4);
    expect(back.nodes[2]!.x).toBeCloseTo(path.nodes[2]!.x + dx, 3);
    expect(back.nodes[2]!.y).toBeCloseTo(path.nodes[2]!.y + dy, 3);
  });

  it("a handle bent in the view leaves its node's place exactly as stored", () => {
    const view = pathToView(path, M), bent = { ...view, nodes: view.nodes.map((n, i) => (i === 1 ? { ...n, tx: 9, ty: 9 } : n)) };
    const back = pathFromView(bent, M, path);
    expect(back.nodes[1]!.x).toBe(20);
    expect(back.nodes[1]!.y).toBe(6);
    expect(back.nodes[1]!.bx).toBe(-3);
    expect(back.nodes[1]!.tx).not.toBe(4);
  });
});

describe("the parent bone a path is relative to", () => {
  it("is the chosen one; a path made before the choice takes the bone's own parent", () => {
    expect(refBoneName(doc, { bone: "head", parent: "hips" })).toBe("hips");
    const own = doc.bones!.find((b) => b.name === "head")!.parent ?? null;
    expect(refBoneName(doc, { bone: "head" })).toBe(own);
    expect(refBoneName(doc, { bone: "root" })).toBeNull();
  });

  it("is chosen from every bone but the bone and the bones under it", () => {
    const names = parentChoices(doc, "hips");
    expect(names).not.toContain("hips");
    expect(names).toContain("root");
    for (const b of doc.bones!) if (b.parent === "hips") expect(names).not.toContain(b.name);
    expect(parentChoices(doc, "hand_near_target")).toContain("hips");
  });
});
