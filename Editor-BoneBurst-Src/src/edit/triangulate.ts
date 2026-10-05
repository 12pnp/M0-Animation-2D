/**
 * Triangles for a mesh (E4-PLAN step 5): the outline (the first `hull` vertices, in order) ear
 * clipped, each inner vertex inserted into the triangle that holds it, then edges flipped until
 * every edge not on the outline is Delaunay. Deterministic: the same points give the same
 * triangles. Points are x,y pairs.
 */

export interface Triangulation {
  /** Vertex indices, three per triangle, each counter-clockwise. */
  readonly triangles: number[];
  /** Inner vertices that lie outside the outline: in no triangle. */
  readonly outside: number[];
}

const EPS = 1e-9;

function cross(xy: readonly number[], a: number, b: number, c: number): number {
  return (xy[b * 2]! - xy[a * 2]!) * (xy[c * 2 + 1]! - xy[a * 2 + 1]!) - (xy[b * 2 + 1]! - xy[a * 2 + 1]!) * (xy[c * 2]! - xy[a * 2]!);
}

/** Barycentric coordinates of point `p` in triangle a, b, c (counter-clockwise). */
function barycentric(xy: readonly number[], a: number, b: number, c: number, px: number, py: number): [number, number, number] {
  const ax = xy[a * 2]!, ay = xy[a * 2 + 1]!, bx = xy[b * 2]!, by = xy[b * 2 + 1]!, cx = xy[c * 2]!, cy = xy[c * 2 + 1]!;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < EPS) return [-1, -1, -1];
  const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return [u, v, 1 - u - v];
}

/** The outline's area, positive when counter-clockwise. */
export function signedArea(xy: readonly number[], ring: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    s += xy[a * 2]! * xy[b * 2 + 1]! - xy[b * 2]! * xy[a * 2 + 1]!;
  }
  return s / 2;
}

/** Ear clipping of a simple polygon given as vertex indices. */
function earClip(xy: readonly number[], ring0: readonly number[]): number[][] {
  const ring = signedArea(xy, ring0) < 0 ? [...ring0].reverse() : [...ring0];
  const out: number[][] = [];
  while (ring.length > 3) {
    const n = ring.length;
    let ear = -1, best = -Infinity, bestAt = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[(i + n - 1) % n]!, b = ring[i]!, c = ring[(i + 1) % n]!;
      const turn = cross(xy, a, b, c);
      if (turn > best) { best = turn; bestAt = i; }
      if (turn <= EPS) continue;
      let blocked = false;
      for (const p of ring) {
        if (p === a || p === b || p === c) continue;
        const [u, v, w] = barycentric(xy, a, b, c, xy[p * 2]!, xy[p * 2 + 1]!);
        if (u >= -EPS && v >= -EPS && w >= -EPS) { blocked = true; break; }
      }
      if (!blocked) { ear = i; break; }
    }
    // A degenerate outline (crossing itself, all in a line) has no clean ear: cut the most convex corner.
    if (ear < 0) ear = bestAt;
    out.push([ring[(ear + n - 1) % n]!, ring[ear]!, ring[(ear + 1) % n]!]);
    ring.splice(ear, 1);
  }
  if (ring.length === 3) out.push([ring[0]!, ring[1]!, ring[2]!]);
  return out;
}

/** Whether `d` is inside the circle through a, b, c (counter-clockwise). */
function inCircle(xy: readonly number[], a: number, b: number, c: number, d: number): boolean {
  const dx = xy[d * 2]!, dy = xy[d * 2 + 1]!;
  const ax = xy[a * 2]! - dx, ay = xy[a * 2 + 1]! - dy;
  const bx = xy[b * 2]! - dx, by = xy[b * 2 + 1]! - dy;
  const cx = xy[c * 2]! - dx, cy = xy[c * 2 + 1]! - dy;
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det > 1e-7;
}

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Flip edges not on the outline until each is Delaunay (a bounded number of passes). */
function flip(xy: readonly number[], tris: number[][], fixed: ReadonlySet<string>): void {
  for (let pass = 0; pass < 100; pass++) {
    let flipped = false;
    const byEdge = new Map<string, number[]>();
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = edgeKey(t[k]!, t[(k + 1) % 3]!); byEdge.set(key, [...(byEdge.get(key) ?? []), i]); } });
    const changed = new Set<number>();
    for (const [key, users] of [...byEdge].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      if (users.length !== 2 || fixed.has(key)) continue;
      const [i, j] = users as [number, number];
      if (changed.has(i) || changed.has(j)) continue;
      const [a, b] = key.split(",").map(Number) as [number, number];
      const t1 = tris[i]!, t2 = tris[j]!;
      const c = t1.find((v) => v !== a && v !== b)!, d = t2.find((v) => v !== a && v !== b)!;
      // t1 as (p, q, c) counter-clockwise with p, q the shared edge.
      const k1 = t1.indexOf(c), p = t1[(k1 + 1) % 3]!, q = t1[(k1 + 2) % 3]!;
      if (!inCircle(xy, p, q, c, d)) continue;
      // Only a convex quad can flip: the new edge c–d must cross p–q.
      if (cross(xy, c, d, p) * cross(xy, c, d, q) >= 0 || cross(xy, p, q, c) * cross(xy, p, q, d) >= 0) continue;
      tris[i] = [c, p, d];
      tris[j] = [d, q, c];
      for (const t of [i, j]) if (cross(xy, tris[t]![0]!, tris[t]![1]!, tris[t]![2]!) < 0) tris[t]!.reverse();
      changed.add(i); changed.add(j);
      flipped = true;
    }
    if (!flipped) return;
  }
}

/** Triangulate `xy` (x,y pairs) whose first `hull` vertices are the outline, in order around it. */
export function triangulate(xy: readonly number[], hull: number): Triangulation {
  const n = xy.length / 2;
  if (hull < 3) return { triangles: [], outside: Array.from({ length: n - Math.max(hull, 0) }, (_, i) => i + Math.max(hull, 0)) };
  const ring = Array.from({ length: hull }, (_, i) => i);
  const tris = earClip(xy, ring).map((t) => (cross(xy, t[0]!, t[1]!, t[2]!) < 0 ? [t[0]!, t[2]!, t[1]!] : t));
  const fixed = new Set(ring.map((i) => edgeKey(i, (i + 1) % hull)));
  const outside: number[] = [];
  for (let v = hull; v < n; v++) {
    const px = xy[v * 2]!, py = xy[v * 2 + 1]!;
    let at = -1, coords: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < tris.length && at < 0; i++) {
      const [a, b, c] = tris[i]! as [number, number, number];
      const w = barycentric(xy, a, b, c, px, py);
      if (w[0] >= -EPS && w[1] >= -EPS && w[2] >= -EPS) { at = i; coords = w; }
    }
    if (at < 0) { outside.push(v); continue; }
    const [a, b, c] = tris[at]! as [number, number, number];
    // On an edge: split both triangles that share it, so no triangle is flat.
    const onEdge = coords.findIndex((w) => Math.abs(w) <= 1e-7);
    if (onEdge >= 0) {
      const e0 = [b, c, a][onEdge]!, e1 = [c, a, b][onEdge]!, opp = [a, b, c][onEdge]!;
      tris.splice(at, 1, [opp, e0, v], [opp, v, e1]);
      const other = tris.findIndex((t) => t.length === 3 && t.includes(e0) && t.includes(e1) && !t.includes(v));
      if (other >= 0) {
        const t = tris[other]!, o = t.find((x) => x !== e0 && x !== e1)!;
        tris.splice(other, 1, [o, e1, v], [o, v, e0]);
      }
      if (fixed.has(edgeKey(e0, e1))) { fixed.delete(edgeKey(e0, e1)); fixed.add(edgeKey(e0, v)); fixed.add(edgeKey(v, e1)); }
    } else {
      tris.splice(at, 1, [a, b, v], [b, c, v], [c, a, v]);
    }
    for (const t of tris) if (cross(xy, t[0]!, t[1]!, t[2]!) < 0) t.reverse();
    flip(xy, tris, fixed);
  }
  return { triangles: tris.flat(), outside };
}
