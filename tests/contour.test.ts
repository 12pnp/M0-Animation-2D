import { describe, expect, it } from "vitest";
import { traceContour } from "@/core/atlas/contour";

/** An alpha plane from a predicate on pixel centres. */
function plane(w: number, h: number, inside: (x: number, y: number) => number | boolean): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = inside(x + 0.5, y + 0.5);
      a[y * w + x] = typeof v === "number" ? v : v ? 255 : 0;
    }
  }
  return a;
}

function polyArea(p: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i]! * p[j + 1]! - p[j]! * p[i + 1]!;
  }
  return Math.abs(s) / 2;
}

/** Point in polygon, even-odd. */
function inside(p: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i]!, yi = p[i + 1]!, xj = p[j]!, yj = p[j + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe("tracing a mask's alpha", () => {
  it("gives a pixel-exact rectangle its four corners", () => {
    // Pixel centres 3.5 … 14.5 by 2.5 … 7.5: a 12 × 6 block.
    const c = traceContour(plane(20, 10, (x, y) => x > 3 && x < 15 && y > 2 && y < 8), 20, 10);
    expect(c.points.length).toBe(8);
    expect(polyArea(c.points)).toBe(12 * 6);
    expect(c.islands).toBe(0);
    expect(c.holes).toBe(0);
    expect(c.soft).toBe(false);
  });

  it("follows a circle to within the tolerance, with few points", () => {
    const r = 40;
    const c = traceContour(plane(100, 100, (x, y) => (x - 50) ** 2 + (y - 50) ** 2 <= r * r), 100, 100);
    expect(Math.abs(polyArea(c.points) - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.02);
    expect(c.points.length / 2).toBeLessThan(40);
    for (let i = 0; i < c.points.length; i += 2) {
      expect(Math.abs(Math.hypot(c.points[i]! - 50, c.points[i + 1]! - 50) - r)).toBeLessThan(1.5);
    }
  });

  it("keeps a concave shape concave", () => {
    const L = plane(40, 40, (x, y) => (x < 15 && y < 35) || (y > 25 && y < 35 && x < 35));
    const c = traceContour(L, 40, 40);
    expect(inside(c.points, 5, 5)).toBe(true);
    expect(inside(c.points, 30, 30)).toBe(true);
    expect(inside(c.points, 30, 10)).toBe(false);
  });

  it("keeps the largest island and says how much the rest is", () => {
    const c = traceContour(plane(60, 20, (x) => x < 20 || (x > 40 && x < 50)), 60, 20);
    expect(polyArea(c.points)).toBe(20 * 20);
    expect(c.islands).toBeCloseTo(0.5, 6);
  });

  it("reports a hole, which one polygon cannot carry", () => {
    const ring = plane(50, 50, (x, y) => {
      const d = Math.hypot(x - 25, y - 25);
      return d < 20 && d > 10;
    });
    const c = traceContour(ring, 50, 50);
    expect(c.holes).toBeGreaterThan(0.2);
  });

  it("tells a soft mask from a hard one", () => {
    const soft = plane(80, 80, (x, y) => Math.round(255 * Math.max(0, 1 - Math.hypot(x - 40, y - 40) / 40)));
    expect(traceContour(soft, 80, 80).soft).toBe(true);
    const hard = plane(80, 80, (x, y) => (Math.hypot(x - 40, y - 40) < 30 ? 255 : 0));
    expect(traceContour(hard, 80, 80).soft).toBe(false);
  });

  it("reads RGBA as well as a bare alpha plane", () => {
    const a = plane(10, 10, (x, y) => x > 2 && y > 2);
    const rgba = new Uint8ClampedArray(400);
    a.forEach((v, i) => { rgba[i * 4 + 3] = v; });
    expect(traceContour(rgba, 10, 10, { stride: 4 }).points).toEqual(traceContour(a, 10, 10).points);
  });

  it("keeps two regions touching at a corner apart", () => {
    // Two 2 × 2 blocks meeting only at (2, 2).
    const c = traceContour(plane(4, 4, (x, y) => (x < 2 && y < 2) || (x > 2 && y > 2)), 4, 4);
    expect(polyArea(c.points)).toBe(4);
    expect(c.islands).toBeCloseTo(1, 6);
  });

  it("gives nothing for an image with nothing opaque", () => {
    expect(traceContour(new Uint8Array(16), 4, 4).points).toEqual([]);
  });
});
