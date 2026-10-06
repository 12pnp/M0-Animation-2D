/**
 * A mesh's points from an image (E5-PLAN step 8, `make_mesh`): the outline of its opaque pixels
 * and a grid inside it, in image pixels (x right, y down, the image's corner at 0, 0). Pure and
 * deterministic: the same pixels give the same points.
 */

/** Alpha at or above this (of 255) counts as opaque. */
export const OPAQUE = 32;

export interface MeshPoints {
  /** x,y pairs: the outline's points first, in order around it, then the inner ones. */
  readonly xy: number[];
  /** How many of `xy`'s points are the outline. */
  readonly hull: number;
}

/**
 * The outline around the largest opaque piece, one pixel out, on pixel corners; null when no
 * pixel is opaque. Counter-clockwise on screen (y down).
 */
export function traceOutline(alpha: ArrayLike<number>, width: number, height: number): number[] | null {
  // Opaque, grown by a pixel (so the outline clears anti-aliased edges), in a grid one wider each side.
  const W = width + 2, H = height + 2, solid = new Uint8Array(W * H);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha[y * width + x]! < OPAQUE) continue;
    for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) solid[(y + dy) * W + x + dx] = 1;
  }
  // The largest piece (4-connected).
  const piece = new Int32Array(W * H).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let i = 0; i < W * H; i++) {
    if (!solid[i] || piece[i]! >= 0) continue;
    let size = 0;
    const stack = [i];
    piece[i] = id;
    while (stack.length) {
      const p = stack.pop()!, x = p % W, y = (p - x) / W;
      size++;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && solid[q] && piece[q]! < 0) { piece[q] = id; stack.push(q); }
      }
    }
    if (size > bestSize) { best = id; bestSize = size; }
    id++;
  }
  if (best < 0) return null;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && piece[y * W + x] === best;
  // Boundary edges between corners, inside on the left walking on screen; chained into loops.
  const next = new Map<number, number[]>();
  const corner = (x: number, y: number) => y * (W + 1) + x;
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const a = corner(x0, y0);
    (next.get(a) ?? next.set(a, []).get(a)!).push(corner(x1, y1));
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) edge(x + 1, y, x, y);
    if (!inside(x - 1, y)) edge(x, y, x, y + 1);
    if (!inside(x, y + 1)) edge(x, y + 1, x + 1, y + 1);
    if (!inside(x + 1, y)) edge(x + 1, y + 1, x + 1, y);
  }
  let outline: number[] = [], outlineArea = 0;
  const xyOf = (c: number): [number, number] => [c % (W + 1), Math.floor(c / (W + 1))];
  while (next.size) {
    const start = next.keys().next().value!;
    const loop: number[] = [];
    let at = start, from: [number, number] | null = null;
    for (;;) {
      const outs = next.get(at);
      if (!outs?.length) break;
      // Where two pieces touch at a corner, turn left of the way we came (keeps loops simple).
      let k = 0;
      if (outs.length > 1 && from) {
        const [ax, ay] = xyOf(at), dx = ax - from[0], dy = ay - from[1];
        k = outs.findIndex((o) => { const [bx, by] = xyOf(o); return dx * (by - ay) - dy * (bx - ax) < 0; });
        if (k < 0) k = 0;
      }
      const to = outs.splice(k, 1)[0]!;
      if (!outs.length) next.delete(at);
      loop.push(...xyOf(at));
      from = xyOf(at);
      at = to;
      if (at === start) break;
    }
    const a = area(loop);
    if (Math.abs(a) > Math.abs(outlineArea)) { outline = loop; outlineArea = a; }
  }
  // Back to image pixels (the grid was one wider), straight runs merged.
  return straighten(outline.map((v) => v - 1));
}

/** Twice the signed area of a closed polygon (x,y pairs). */
function area(xy: readonly number[]): number {
  let s = 0;
  for (let i = 0, n = xy.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += xy[i * 2]! * xy[j * 2 + 1]! - xy[j * 2]! * xy[i * 2 + 1]!;
  }
  return s;
}

/** The polygon without points that lie on the line through their neighbours. */
function straighten(xy: readonly number[]): number[] {
  const n = xy.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    const cross = (xy[i * 2]! - xy[p * 2]!) * (xy[q * 2 + 1]! - xy[i * 2 + 1]!) - (xy[i * 2 + 1]! - xy[p * 2 + 1]!) * (xy[q * 2]! - xy[i * 2]!);
    if (cross !== 0) out.push(xy[i * 2]!, xy[i * 2 + 1]!);
  }
  return out;
}

/** Douglas–Peucker on a closed polygon: points within `tolerance` of the line kept between their neighbours go. */
export function simplify(xy: readonly number[], tolerance: number): number[] {
  const n = xy.length / 2;
  if (n <= 3) return [...xy];
  // Split at the point farthest from the first, so the two halves are open runs.
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(xy[i * 2]! - xy[0]!, xy[i * 2 + 1]! - xy[1]!); if (d > farD) { far = i; farD = d; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const run = (a: number, b: number) => {
    const ax = xy[a * 2]!, ay = xy[a * 2 + 1]!, bx = xy[(b % n) * 2]!, by = xy[(b % n) * 2 + 1]!, len = Math.hypot(bx - ax, by - ay);
    let worst = -1, worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const px = xy[(i % n) * 2]!, py = xy[(i % n) * 2 + 1]!;
      const d = len > 0 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst < 0) return;
    keep[worst % n] = 1;
    run(a, worst);
    run(worst, b);
  };
  run(0, far);
  run(far, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(xy[i * 2]!, xy[i * 2 + 1]!);
  return out;
}

/** Whether (x, y) is inside the closed polygon (even-odd). */
function within(xy: readonly number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, n = xy.length / 2, j = n - 1; i < n; j = i++) {
    const xi = xy[i * 2]!, yi = xy[i * 2 + 1]!, xj = xy[j * 2]!, yj = xy[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The distance from (x, y) to the polygon's nearest edge. */
function edgeDistance(xy: readonly number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, n = xy.length / 2; i < n; i++) {
    const j = (i + 1) % n, ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, dx = xy[j * 2]! - ax, dy = xy[j * 2 + 1]! - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * A mesh's points for an image `width` × `height`: the traced outline (the rectangle when
 * `alpha` is null or nothing is opaque), simplified to within a pixel, its edges cut every
 * `spacing` pixels at most, and a grid inside at `spacing`, no nearer the outline than half that.
 */
export function meshPoints(alpha: ArrayLike<number> | null, width: number, height: number, spacing: number): MeshPoints & { traced: boolean } {
  const traced = alpha ? traceOutline(alpha, width, height) : null;
  const corners = traced ? simplify(traced, 1) : [0, 0, 0, height, width, height, width, 0];
  const xy: number[] = [];
  for (let i = 0, n = corners.length / 2; i < n; i++) {
    const j = (i + 1) % n, ax = corners[i * 2]!, ay = corners[i * 2 + 1]!, bx = corners[j * 2]!, by = corners[j * 2 + 1]!;
    const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing));
    for (let k = 0; k < parts; k++) xy.push(ax + ((bx - ax) * k) / parts, ay + ((by - ay) * k) / parts);
  }
  const hull = xy.length / 2, outline = xy.slice();
  for (let y = spacing / 2; y < height; y += spacing) for (let x = spacing / 2; x < width; x += spacing) {
    if (within(outline, x, y) && edgeDistance(outline, x, y) >= spacing / 2) xy.push(x, y);
  }
  return { xy, hull, traced: !!traced };
}
