import { describe, expect, it } from "vitest";
import { fieldTransform, groupFieldWrite, snapshotOf, type FieldKey } from "@/core/doc/transformOps";
import { tf, matrixOf } from "@/core/math/Transform";
import { mat } from "@/core/math/Matrix2D";
import { colorToHex, deriveColorMode, hexToPct } from "@/core/doc/colorEffect";
import { DEFAULT_COLOR } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

const off = { size: false, scale: false }, on = { size: true, scale: true };
const size = { w: 100, h: 50 };

describe("fieldTransform", () => {
  const t = tf(1, 2, 30, 10, 2, 1);
  it.each([
    ["x", 9, off, { x: 9 }],
    ["w", 100, off, { scaleX: 1, scaleY: 1 }],
    ["w", 100, on, { scaleX: 1, scaleY: 0.5 }],     // 200 → 100: H follows by the same ratio
    ["h", 100, off, { scaleY: 2 }],
    ["scaleX", 4, on, { scaleX: 4, scaleY: 2 }],
    ["scaleY", 0, off, { scaleY: 1e-4 }],           // zero is not a scale
    ["rotation", 50, off, { skewY: 50, skewX: 70 }], // shear kept
    ["skewX", 5, off, { skewX: 5, skewY: 10 }],
  ] as Array<[FieldKey, number, typeof on, object]>)("%s = %s (linked %o)", (key, value, linked, want) => {
    expect(fieldTransform(t, size, key, value, linked)).toMatchObject(want);
  });
  it("leaves size fields alone on a display with no size", () => {
    expect(fieldTransform(t, { w: 0, h: 0 }, "w", 10, off)).toEqual(t);
  });
  it("does not change its input", () => {
    const before = { ...t };
    fieldTransform(t, size, "x", 5, off);
    expect(t).toEqual(before);
  });
});

describe("groupFieldWrite", () => {
  const a = tf(0, 0), b = tf(10, 0);
  const g = {
    bounds: { x: 0, y: 0, w: 20, h: 10 },
    snaps: [snapshotOf("a" as NodeId, a, matrixOf(a), mat()), snapshotOf("b" as NodeId, b, matrixOf(b), mat())],
    first: a,
  };
  it("moves the whole group by the bounds' change", () => {
    const out = groupFieldWrite(g, "x", 5, off)!;
    expect([out.get("a" as NodeId)!.x, out.get("b" as NodeId)!.x]).toEqual([5, 15]);
  });
  it("has nothing to do for the pivot fields", () => expect(groupFieldWrite(g, "pivotX", 1, off)).toBeNull());
});

describe("colour effect", () => {
  it.each([
    [DEFAULT_COLOR, false, "none"],
    [{ ...DEFAULT_COLOR, aM: 50 }, false, "alpha"],
    [{ ...DEFAULT_COLOR, rM: 50, gM: 50, bM: 50 }, false, "brightness"],
    [{ ...DEFAULT_COLOR, rM: 50, gM: 50, bM: 50 }, true, "alpha"],
    [{ ...DEFAULT_COLOR, rM: 20 }, false, "advanced"],
  ])("%o (instance %s) is %s", (c, instance, want) => expect(deriveColorMode(c, instance)).toBe(want));
  it("round-trips hex", () => {
    expect(colorToHex({ ...DEFAULT_COLOR, rM: 100, gM: 0, bM: 50 })).toBe("#ff0080");
    expect(hexToPct("#ff0080")).toEqual({ r: 100, g: 0, b: 50 });
  });
});
