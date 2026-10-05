import { apply, type Matrix2D } from "./Matrix2D";

export interface Point { x: number; y: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

export function pt(x = 0, y = 0): Point { return { x, y }; }
export function rect(x = 0, y = 0, w = 0, h = 0): Rect { return { x, y, w, h }; }

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Normalise a rect built from two drag corners. */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
  };
}

/** Axis-aligned bounds of a rect after an affine transform. */
export function transformRect(m: Matrix2D, r: Rect): Rect {
  const p = pt();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const xs = [r.x, r.x + r.w];
  const ys = [r.y, r.y + r.h];
  for (const x of xs) {
    for (const y of ys) {
      apply(p, m, x, y);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The four corners of a rect after a transform, in TL, TR, BR, BL order. */
export function transformCorners(m: Matrix2D, r: Rect): [Point, Point, Point, Point] {
  return [
    apply(pt(), m, r.x, r.y),
    apply(pt(), m, r.x + r.w, r.y),
    apply(pt(), m, r.x + r.w, r.y + r.h),
    apply(pt(), m, r.x, r.y + r.h),
  ];
}

/** Distance from (x, y) to the segment (ax, ay)–(bx, by). */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Even-odd: whether (x, y) is inside the polygon of the first `n` points of
 *  the flat list `pts` (x, y, x, y…). */
export function inFlatPolygon(pts: readonly number[], x: number, y: number, n = pts.length / 2): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2]!, yi = pts[i * 2 + 1]!, xj = pts[j * 2]!, yj = pts[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Winding test — used for marquee selection against rotated bounds. */
export function polygonContains(poly: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    if ((pi.y > y) !== (pj.y > y) &&
        x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}
