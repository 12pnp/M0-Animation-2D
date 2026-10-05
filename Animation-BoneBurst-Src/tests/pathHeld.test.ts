import { describe, it, expect } from "vitest";
import { heldParent } from "@/view/panels/pathHeld";
import { apply, mat, matOf, mul } from "@/core/math/Matrix2D";

describe("heldParent", () => {
  const at0 = matOf(1, 0, 0, 1, 100, 50);
  const turned = matOf(0, 1, -1, 0, 300, 80);

  it("puts a frame's parent back where it was at frame 0", () => {
    const m = mul(mat(), heldParent(at0, turned), turned);
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) expect(m[k]).toBeCloseTo(at0[k]);
  });

  it("a child point keeps its place on the parent", () => {
    const child = mul(mat(), turned, matOf(1, 0, 0, 1, 20, 0));
    const p = apply({ x: 0, y: 0 }, mul(mat(), heldParent(at0, turned), child), 0, 0);
    expect(p.x).toBeCloseTo(120);
    expect(p.y).toBeCloseTo(50);
  });

  it("identity when a pose is missing or flat", () => {
    expect(heldParent(undefined, turned)).toEqual(mat());
    expect(heldParent(at0, undefined)).toEqual(mat());
    expect(heldParent(at0, matOf(0, 0, 0, 0, 1, 1))).toEqual(mat());
  });
});
