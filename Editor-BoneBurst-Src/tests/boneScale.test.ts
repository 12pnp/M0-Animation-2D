import { describe, expect, it } from "vitest";
import { boneHalfWidth, boneUnitOf, jointRadius } from "@/ui/stage/boneScale";

describe("bone size in proportion to the image", () => {
  it("takes 1% of the skeleton's larger side as its unit, never under half a unit", () => {
    expect(boneUnitOf({ minX: 0, minY: 0, maxX: 300, maxY: 800 })).toBe(8);
    expect(boneUnitOf({ minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(0.5);
    expect(boneUnitOf(null)).toBe(0.5);
  });
  it("grows with the zoom and with the size chosen, and stays visible when zoomed far out", () => {
    expect(boneHalfWidth(8, 1, 2)).toBeCloseTo(2 * boneHalfWidth(8, 1, 1));
    expect(boneHalfWidth(8, 2, 1)).toBeCloseTo(2 * boneHalfWidth(8, 1, 1));
    expect(boneHalfWidth(8, 1, 0.01)).toBe(1);
    expect(jointRadius(8, 1, 0.01)).toBe(1.5);
    expect(jointRadius(8, 1, 3)).toBeGreaterThan(jointRadius(8, 1, 1));
  });
});
