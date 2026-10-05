/**
 * A mesh's triangles (ARCHITECTURE ▸ Meshes): the outline (the first `hull`
 * points, in order) ear-clipped, every other point inserted into the
 * triangle it falls in, then edges flipped until each pair of triangles is
 * Delaunay, never an outline edge. So every triangle stays inside the
 * outline, whatever its shape, and the inner ones are as even as the points
 * allow. Pure; flat `[x0, y0, x1, y1, …]` in, triangle indices out.
 */

type P = { x: number; y: number };

const pt = (pts: readonly number[], i: number): P => ({ x: pts[i * 2]!, y: pts[i * 2 + 1]! });
const cross = (a: P, b: P, c: P) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Twice the signed area of the outline: its winding. */
function windingOf(pts: readonly number[], hull: number): number {
  let s = 0;
  for (let i = 0; i < hull; i++) {
    const a = pt(pts, i), b = pt(pts, (i + 1) % hull);
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

function inTriangle(p: P, a: P, b: P, c: P, eps = 1e-9): boolean {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < -eps || d2 < -eps || d3 < -eps, pos = d1 > eps || d2 > eps || d3 > eps;
  return !(neg && pos);
}

/** Ear clipping of a simple polygon; triangles wound like the polygon. */
export function earClip(pts: readonly number[], hull: number): number[] {
  const sign = windingOf(pts, hull) >= 0 ? 1 : -1;
  const idx = Array.from({ length: hull }, (_, i) => i);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < hull * hull + 10) {
    let clipped = false;
    for (let n = 0; n < idx.length; n++) {
      const i0 = idx[(n + idx.length - 1) % idx.length]!, i1 = idx[n]!, i2 = idx[(n + 1) % idx.length]!;
      const a = pt(pts, i0), b = pt(pts, i1), c = pt(pts, i2);
      if (cross(a, b, c) * sign <= 1e-12) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTriangle(pt(pts, j), a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      out.push(i0, i1, i2);
      idx.splice(n, 1);
      clipped = true;
      break;
    }
    // A self-touching outline: clip the flattest corner rather than stop.
    if (!clipped) {
      out.push(idx[idx.length - 1]!, idx[0]!, idx[1]!);
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/** Is `d` inside the circle through a, b, c (wound with `sign`)? */
function inCircle(a: P, b: P, c: P, d: P, sign: number): boolean {
  const ax = a.x - d.x, ay = a.y - d.y, bx = b.x - d.x, by = b.y - d.y, cx = c.x - d.x, cy = c.y - d.y;
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det * sign > 1e-9;
}

/**
 * Every point triangulated within the outline formed by the first `hull`
 * points. A point outside the outline is left out of every triangle.
 */
export function triangulate(pts: readonly number[], hull: number): number[] {
  if (hull < 3) return [];
  const sign = windingOf(pts, hull) >= 0 ? 1 : -1;
  const tris: number[][] = [];
  const ears = earClip(pts, hull);
  for (let t = 0; t < ears.length; t += 3) tris.push([ears[t]!, ears[t + 1]!, ears[t + 2]!]);
  const n = pts.length / 2;
  const hullEdge = (i: number, j: number) => i < hull && j < hull && ((i + 1) % hull === j || (j + 1) % hull === i);

  for (let p = hull; p < n; p++) {
    const q = pt(pts, p);
    const at = tris.findIndex((t) => inTriangle(q, pt(pts, t[0]!), pt(pts, t[1]!), pt(pts, t[2]!), 1e-9));
    if (at < 0) continue;
    const [a, b, c] = tris[at]!;
    // On an edge: split the triangles either side of it in two each.
    const onEdge = ([[a, b, c], [b, c, a], [c, a, b]] as const).find(([u, v]) => Math.abs(cross(pt(pts, u), pt(pts, v), q)) < 1e-9);
    if (onEdge) {
      const [u, v, w] = onEdge;
      tris.splice(at, 1, [u, p, w], [p, v, w]);
      const other = tris.findIndex((t) => t.includes(u) && t.includes(v) && !t.includes(p));
      if (other >= 0) {
        const o = tris[other]!;
        const x = o.find((i) => i !== u && i !== v)!;
        // Keep the winding: the edge runs v -> u in the other triangle.
        const k = o.indexOf(v);
        const ordered = o[(k + 1) % 3] === u ? [v, u, x] : [u, v, x];
        tris.splice(other, 1, [ordered[0]!, p, ordered[2]!], [p, ordered[1]!, ordered[2]!]);
      }
      continue;
    }
    tris.splice(at, 1, [a!, b!, p], [b!, c!, p], [c!, a!, p]);
  }

  // Lawson flips: any inner edge whose opposite corner falls in the other
  // triangle's circle is flipped, until none does.
  for (let pass = 0; pass < 100; pass++) {
    let flipped = false;
    const byEdge = new Map<string, number[]>();
    tris.forEach((t, i) => {
      for (let e = 0; e < 3; e++) {
        const u = t[e]!, v = t[(e + 1) % 3]!;
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push(i);
      }
    });
    const touched = new Set<number>();
    for (const [key, owners] of byEdge) {
      if (owners.length !== 2) continue;
      const [i, j] = owners as [number, number];
      if (touched.has(i) || touched.has(j)) continue;
      const [u, v] = key.split(",").map(Number) as [number, number];
      if (hullEdge(u, v)) continue;
      const ti = tris[i]!, tj = tris[j]!;
      const x = ti.find((k) => k !== u && k !== v)!, y = tj.find((k) => k !== u && k !== v)!;
      // Wind ti as u -> v -> x.
      const k = ti.indexOf(u);
      const [s, e2] = ti[(k + 1) % 3] === v ? [u, v] : [v, u];
      if (!inCircle(pt(pts, s), pt(pts, e2), pt(pts, x), pt(pts, y), sign)) continue;
      // The flip must leave a convex quad, or a triangle would turn over.
      if (cross(pt(pts, x), pt(pts, y), pt(pts, e2)) * sign <= 1e-12 || cross(pt(pts, y), pt(pts, x), pt(pts, s)) * sign <= 1e-12) continue;
      tris[i] = [x, s, y];
      tris[j] = [y, e2, x];
      touched.add(i);
      touched.add(j);
      flipped = true;
    }
    if (!flipped) break;
  }
  return tris.flat();
}
