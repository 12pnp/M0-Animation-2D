import type { MotionPath } from "@/model/sidecar";
import { EditRefused } from "@/model/refused";

/**
 * The path's curve (docs/TWO-SYSTEMS-PLAN.md, P): a spline through the nodes of a motion path, a ring unless opened. Numbers in,
 * numbers out: this folder imports no rig, no document and no interface (the guard in `scripts/check.sh`).
 */

export interface Pt { readonly x: number; readonly y: number }

/** A node of the path: its place, and the handle of the curve there when one was dragged (`tx`, `ty`: the way out, as an offset). */
export interface PathNode extends Pt { readonly tx?: number; readonly ty?: number; readonly bx?: number; readonly by?: number }

/** Samples per span of the curve: a distance along the path maps to a point through this table. */
const SAMPLES = 64;

/** The path through the nodes, tabulated by arc length. */
export interface PathCurve {
  readonly length: number;
  /** The point `s` along the path (clamped to 0..length). */
  at(s: number): Pt;
  /**
   * The arc length of the point of the path nearest `p`, and how far `p` is from it. With `near`, an
   * arc length to stay close to: where the path crosses itself or doubles back, the place nearer it wins.
   */
  project(p: Pt, near?: number): { s: number; distance: number };
  /** The arc length at which each node sits (a ring has one more: the way back to the first node). */
  readonly nodeAt: readonly number[];
}

/**
 * The handles of every node, as offsets from it: `out` toward the next node and `in` back toward the
 * previous one. A node whose handle was dragged has it (`tx`, `ty`) and its mirror, unless its leg was broken (`bx`, `by`: the way in on its own); any other has an
 * automatic one: along the line between its neighbours, a third of the way to each. On a ring every node
 * has both sides (the last joins the first); on an open path the first has no way in, the last none out.
 * A ring through two nodes bows out sideways, so it is a loop and not a line there and back.
 */
export function handleOffsets(nodes: readonly PathNode[], closed = false): { out: Pt; in: Pt }[] {
  const n = nodes.length;
  return nodes.map((p, i) => {
    const prev = closed ? nodes[(i + n - 1) % n] : nodes[i - 1], next = closed ? nodes[(i + 1) % n] : nodes[i + 1];
    const lenOut = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0, lenIn = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
    let out: Pt = { x: 0, y: 0 }, back: Pt = { x: 0, y: 0 };
    if (p.tx !== undefined && p.ty !== undefined) {
      if (next) out = { x: p.tx, y: p.ty };
      if (prev) back = { x: -p.tx, y: -p.ty };
    } else if (closed && n === 2) {
      // Prev and next are the same node: bow out to the left of the way from the first node to the second, and back on the right: a lens.
      const a = nodes[0]!, o = nodes[1]!, dx = o.x - a.x, dy = o.y - a.y, d = Math.hypot(dx, dy) || 1, k = i === 0 ? 1 : -1;
      out = { x: (-dy / d) * (d / 2) * k, y: (dx / d) * (d / 2) * k };
      back = { x: -out.x, y: -out.y };
    } else {
      // The direction through the node: from the previous to the next (or along the one segment an end has).
      const a = prev ?? p, b = next ?? p, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (next) out = { x: (dx / d) * lenOut, y: (dy / d) * lenOut };
      if (prev) back = { x: -(dx / d) * lenIn, y: -(dy / d) * lenIn };
    }
    // A broken leg: the way in is its own, not the mirror of the way out.
    if (prev && p.bx !== undefined && p.by !== undefined) back = { x: p.bx, y: p.by };
    return { out, in: back };
  });
}

/** A smooth curve through the nodes: a cubic Bézier between each two, with the nodes' handles; a ring when `closed`. A straight line for two nodes of an open path with no handle dragged. */
export function buildCurve(nodes: readonly PathNode[], closed = false): PathCurve {
  if (nodes.length < 2) throw new EditRefused("A path needs at least two nodes.");
  const pts: Pt[] = [], cum: number[] = [], nodeAt: number[] = [];
  const push = (p: Pt) => {
    const last = pts.at(-1);
    cum.push(last ? cum.at(-1)! + Math.hypot(p.x - last.x, p.y - last.y) : 0);
    pts.push(p);
  };
  const n = nodes.length, first = nodes[0]!, hs = handleOffsets(nodes, closed), spans = closed ? n : n - 1;
  push(first);
  nodeAt.push(0);
  for (let i = 0; i < spans; i++) {
    const j = (i + 1) % n, p0 = nodes[i]!, p3 = nodes[j]!;
    const c1 = { x: p0.x + hs[i]!.out.x, y: p0.y + hs[i]!.out.y }, c2 = { x: p3.x + hs[j]!.in.x, y: p3.y + hs[j]!.in.y };
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      push({ x: b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p3.x, y: b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p3.y });
    }
    nodeAt.push(cum.at(-1)!);
  }
  const length = cum.at(-1)!;
  return {
    length,
    nodeAt,
    at(s) {
      if (!(length > 0)) return first;
      const d = Math.min(length, Math.max(0, s));
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid]! <= d) lo = mid; else hi = mid; }
      const a = pts[lo]!, b = pts[hi]!, span = cum[hi]! - cum[lo]!, f = span > 0 ? (d - cum[lo]!) / span : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    },
    project(p, near) {
      let best = { s: 0, distance: Infinity }, bestScore = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]!, b = pts[i + 1]!, dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
        const f = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
        const distance = Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f)), s = cum[i]! + (cum[i + 1]! - cum[i]!) * f;
        const score = distance + (near === undefined ? 0 : 0.25 * Math.abs(s - near));
        if (score < bestScore) { best = { s, distance }; bestScore = score; }
      }
      return best;
    },
  };
}

/** The path through the nodes of a motion path: a ring unless it was opened. */
export function curveOf(m: Pick<MotionPath, "nodes" | "closed">): PathCurve {
  if (m.nodes.length < 2) throw new EditRefused("A path needs at least two nodes.");
  return buildCurve(m.nodes, m.closed);
}
