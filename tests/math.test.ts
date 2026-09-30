import { describe, it, expect } from "vitest";
import { mat, mul, invert, apply, equalsEps, matOf } from "@/core/math/Matrix2D";
import { tf, toMatrix, fromMatrix, rotateBy, matrixOf, shearOf } from "@/core/math/Transform";
import { wrapTo180, turnsOf, shortestDelta, DEG_RAD } from "@/core/math/angle";
import { applyTween } from "@/core/math/easing";

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("Transform <-> Matrix", () => {
  it("matches the DragonBones runtime composition", () => {
    // Runtime: a=cos(rotation)*scaleX, b=sin(rotation)*scaleX,
    //          c=-sin(skew+rotation)*scaleY, d=cos(skew+rotation)*scaleY
    // with rotation = skY, skew = skX - skY.
    const t = tf(10, -20, 35, 12, 1.3, 0.7);
    const m = matrixOf(t);
    const rotation = t.skewY * DEG_RAD;
    const skew = t.skewX * DEG_RAD - rotation;
    expect(m.a).toBeCloseTo(Math.cos(rotation) * t.scaleX, 12);
    expect(m.b).toBeCloseTo(Math.sin(rotation) * t.scaleX, 12);
    expect(m.c).toBeCloseTo(-Math.sin(skew + rotation) * t.scaleY, 12);
    expect(m.d).toBeCloseTo(Math.cos(skew + rotation) * t.scaleY, 12);
    expect(m.tx).toBe(t.x);
    expect(m.ty).toBe(t.y);
  });

  it("round-trips the MATRIX for 100k random transforms including negative scale", () => {
    const r = rng(0xC0FFEE);
    const a = mat(), b = mat();
    for (let i = 0; i < 100_000; i++) {
      const src = tf(
        (r() - 0.5) * 2000,
        (r() - 0.5) * 2000,
        (r() - 0.5) * 720,
        (r() - 0.5) * 720,
        (r() - 0.5) * 6 || 0.5,
        (r() - 0.5) * 6 || 0.5,
      );
      if (Math.abs(src.scaleX) < 1e-3) src.scaleX = 1;
      if (Math.abs(src.scaleY) < 1e-3) src.scaleY = 1;

      toMatrix(a, src);
      const back = fromMatrix(tf(), a, src);
      toMatrix(b, back);
      // Parameters carry a sign/branch ambiguity; the MATRIX does not.
      expect(equalsEps(a, b, 1e-9)).toBe(true);
    }
  });

  it("recovers exact parameters when sign continuity is supplied", () => {
    const src = tf(3, 4, -140, 70, -2.5, 1.75);
    const back = fromMatrix(tf(), matrixOf(src), src);
    expect(back.scaleX).toBeCloseTo(src.scaleX, 9);
    expect(back.scaleY).toBeCloseTo(src.scaleY, 9);
    expect(back.skewX).toBeCloseTo(src.skewX, 9);
    expect(back.skewY).toBeCloseTo(src.skewY, 9);
  });

  it("is well-conditioned at +/-90 degrees, where a candidate-table decomposition is not", () => {
    for (const ang of [89.999, 90, 90.001, -90, 269.999, 270]) {
      const src = tf(0, 0, ang, ang, 1.5, 0.5);
      const back = fromMatrix(tf(), matrixOf(src), src);
      expect(equalsEps(matrixOf(back), matrixOf(src), 1e-9)).toBe(true);
    }
  });

  it("rotateBy preserves shear and both scales exactly", () => {
    const src = tf(5, 5, 40, 10, 1.4, 0.6);   // sheared by 30 degrees
    const out = rotateBy(tf(), src, 137.5);
    expect(shearOf(out)).toBeCloseTo(shearOf(src), 12);
    expect(out.scaleX).toBe(src.scaleX);
    expect(out.scaleY).toBe(src.scaleY);
    // and it really is a rotation of the linear part
    const expected = mul(mat(), matOf(
      Math.cos(137.5 * DEG_RAD), Math.sin(137.5 * DEG_RAD),
      -Math.sin(137.5 * DEG_RAD), Math.cos(137.5 * DEG_RAD), 0, 0,
    ), matrixOf({ ...src, x: 0, y: 0 }));
    expect(equalsEps(matrixOf({ ...out, x: 0, y: 0 }), expected, 1e-9)).toBe(true);
  });
});

describe("Matrix2D", () => {
  it("invert round-trips a point", () => {
    const m = matrixOf(tf(120, -30, 25, 25, 2, 0.5));
    const inv = mat();
    expect(invert(inv, m)).toBe(true);
    const p = apply({ x: 0, y: 0 }, m, 17, -4);
    const q = apply({ x: 0, y: 0 }, inv, p.x, p.y);
    expect(q.x).toBeCloseTo(17, 9);
    expect(q.y).toBeCloseTo(-4, 9);
  });

  it("reports singular matrices instead of producing NaN", () => {
    expect(invert(mat(), matOf(0, 0, 0, 0, 0, 0))).toBe(false);
  });

  it("mul composes parent-then-child in scene-graph order", () => {
    const parent = matrixOf(tf(100, 0, 90, 90, 1, 1));
    const child = matrixOf(tf(10, 0, 0, 0, 1, 1));
    const world = mul(mat(), parent, child);
    // child sits 10 along the parent's local +x, which the parent rotated to +y
    const p = apply({ x: 0, y: 0 }, world, 0, 0);
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.y).toBeCloseTo(10, 9);
  });
});

describe("angles", () => {
  it("wraps into (-180, 180]", () => {
    expect(wrapTo180(180)).toBe(180);
    expect(wrapTo180(-180)).toBe(180);
    expect(wrapTo180(190)).toBe(-170);
    expect(wrapTo180(720)).toBe(0);
  });

  it("derives clockwise turns the way rotateFrame needs", () => {
    expect(turnsOf(0)).toBe(0);
    expect(turnsOf(90)).toBe(0);
    expect(turnsOf(360)).toBe(1);
    expect(turnsOf(450)).toBe(1);
    expect(turnsOf(720 + 90)).toBe(2);
    expect(turnsOf(-360)).toBe(-1);
    expect(turnsOf(-810)).toBe(-2);
  });

  it("shortestDelta never exceeds a half turn", () => {
    expect(shortestDelta(350, 10)).toBe(20);
    expect(shortestDelta(10, 350)).toBe(-20);
  });
});

describe("easing", () => {
  it("linear and endpoints, for every kind", () => {
    expect(applyTween({ kind: "linear" }, 0.5, 10)).toBe(0.5);
    for (const spec of [{ kind: "ease", value: -2 }, { kind: "ease", value: 1.5 }, { kind: "curve", curve: [0.2, 0.8, 0.4, 1] }, { kind: "preset", family: "back", dir: "out" }] as const) {
      expect(applyTween(spec, 0, 10)).toBe(0);
      expect(applyTween(spec, 1, 10)).toBe(1);
    }
  });

  it("a 'none' tween holds at the start value", () => {
    expect(applyTween({ kind: "none" }, 0.99, 10)).toBe(0);
  });
});
