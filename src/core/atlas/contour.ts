/**
 * An image's alpha as one polygon, for a Spine clipping attachment.
 *
 * Spine clips with a single polygon and a hard edge; the stage masks with
 * the image's alpha. So the shape is the outline of the pixels at least
 * half opaque (`threshold`), walked along pixel edges, the largest outer
 * loop kept and simplified to within `tolerance` pixels. What a single
 * polygon cannot say is reported, for the exporter to warn about: other
 * islands, holes, and a soft edge (many semi-transparent pixels for the
 * outline's length).
 *
 * Pure: the caller decodes the pixels. Coordinates are image pixels, y
 * down, origin at the top-left corner.
 */

export interface Contour {
  /** Flat [x0, y0, x1, y1, …]; empty when nothing is opaque enough. */
  points: number[];
  /** Area of the other outer loops, as a fraction of the kept one's. */
  islands: number;
  /** Area of the holes in the kept loop, as a fraction of its area. */
  holes: number;
  /** Many semi-transparent pixels for the outline's length: a soft mask. */
  soft: boolean;
}

export function traceContour(
  alpha: Uint8Array | Uint8ClampedArray, width: number, height: number,
  opts: { threshold?: number; tolerance?: number; stride?: number } = {},
): Contour {
  const threshold = opts.threshold ?? 128;
  const tolerance = opts.tolerance ?? 1;
  // Alpha may be one byte per pixel, or the fourth of RGBA.
  const stride = opts.stride ?? 1;
  const offset = stride === 4 ? 3 : 0;
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && alpha[(y * width + x) * stride + offset]! >= threshold;

  // Directed boundary edges, filled on the right when walking in screen
  // space (y down): clockwise round each filled region, counter-clockwise
  // round each hole. Keyed by start vertex.
  const W = width + 1;
  const out = new Map<number, number[]>();
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = out.get(k);
    const v = y1 * W + x1;
    if (list) list.push(v); else out.set(k, [v]);
  };
  let semi = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[(y * width + x) * stride + offset]!;
      if (a >= 16 && a <= 239) semi++;
      if (a < threshold) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  // Link edges into loops. At a vertex where two regions touch diagonally
  // there are two ways on; turning right keeps them apart.
  const loops: number[][] = [];
  for (const [start] of out) {
    while ((out.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [start];
      let prev = start, cur = popEdge(out, start, -1, W);
      while (cur !== start) {
        loop.push(cur);
        const next = popEdge(out, cur, prev, W);
        prev = cur;
        cur = next;
      }
      loops.push(loop);
    }
  }

  const area = (loop: number[]) => {
    let s = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      s += (a % W) * Math.floor(b / W) - (b % W) * Math.floor(a / W);
    }
    return s / 2;
  };
  const measured = loops.map((l) => ({ l, a: area(l) }));
  const outer = measured.filter((m) => m.a > 0).sort((p, q) => q.a - p.a);
  const main = outer[0];
  if (!main) return { points: [], islands: 0, holes: 0, soft: false };
  const others = outer.slice(1).reduce((t, m) => t + m.a, 0);
  const holeArea = measured.filter((m) => m.a < 0).reduce((t, m) => t - m.a, 0);

  const pts = main.l.map((v) => [v % W, Math.floor(v / W)] as [number, number]);
  const simplified = simplifyClosed(pts, tolerance);
  return {
    points: simplified.flat(),
    islands: others / main.a,
    holes: holeArea / main.a,
    soft: semi > 2 * main.l.length,
  };
}

/** Take an edge leaving `v`: the rightmost turn from the way we came. */
function popEdge(out: Map<number, number[]>, v: number, prev: number, W: number): number {
  const list = out.get(v)!;
  let pick = 0;
  if (list.length > 1 && prev >= 0) {
    const inX = (v % W) - (prev % W), inY = Math.floor(v / W) - Math.floor(prev / W);
    let best = -Infinity;
    list.forEach((n, i) => {
      const oX = (n % W) - (v % W), oY = Math.floor(n / W) - Math.floor(v / W);
      // In y-down screen space, a positive cross product is a right turn.
      const score = inX * oY - inY * oX;
      if (score > best) { best = score; pick = i; }
    });
  }
  return list.splice(pick, 1)[0]!;
}

/** Douglas–Peucker on a closed loop, split at its two farthest-apart points. */
function simplifyClosed(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  // Straight runs first: the pixel walk has a point at every step.
  const lean = pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length]!, b = pts[(i + 1) % pts.length]!;
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) !== 0;
  });
  if (lean.length <= 4) return lean;
  let far = 0, best = -1;
  for (let i = 1; i < lean.length; i++) {
    const d = (lean[i]![0] - lean[0]![0]) ** 2 + (lean[i]![1] - lean[0]![1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const first = rdp(lean.slice(0, far + 1), tol);
  const second = rdp([...lean.slice(far), lean[0]!], tol);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : lean;
}

function rdp(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0]!, [bx, by] = pts[pts.length - 1]!;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = -1, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i]!;
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0]!, pts[pts.length - 1]!];
  const left = rdp(pts.slice(0, at + 1), tol);
  const right = rdp(pts.slice(at), tol);
  return [...left.slice(0, -1), ...right];
}
