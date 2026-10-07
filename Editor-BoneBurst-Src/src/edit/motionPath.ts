import { boneNumber } from "@/model/defaults";
import type { Key, Skeleton } from "@/model/skeleton";
import type { MotionNode, MotionPath } from "@/model/sidecar";
import { frameTime, keyLists, keyTime, shortFloat } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { deleteKeys, type KeyRef, onAnimation, withKeys } from "./keys";

/**
 * A bone's preserved motion path (docs/PATH-FRAMES-PLAN.md): a spline through its nodes (a ring unless
 * opened), cut into blocks by node times at frames, a time multiplier for each block, and the keys baked
 * from them. Pure: the curve, the blocks and the key edit. Posing the parent to turn a point into a bone's
 * local x and y is the Motion Path panel's business (`ui/motion.ts`).
 */

export interface Pt { readonly x: number; readonly y: number }

/** A node of the path: its place, and the handle of the curve there when one was dragged (`tx`, `ty`: the way out, as an offset). */
export interface PathNode extends Pt { readonly tx?: number; readonly ty?: number }

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
 * previous one. A node whose handle was dragged has it (`tx`, `ty`) and its mirror; any other has an
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

/** The frames a path shows by default: 15, written 14 + 0 (frames 1 to 14 and frame 0). */
export const DEFAULT_FRAMES = 15;

/** The last frame of the path's run: a ring ends where it began (frame `frames`, which is frame 0 again); an open path ends on its last frame shown. */
export function endFrame(m: Pick<MotionPath, "frames" | "closed">): number {
  return m.closed ? m.frames : m.frames - 1;
}

/** The node times' frames: the first is always 0; the others are `starts`, in order, inside the run. */
export function nodeTimeFrames(m: Pick<MotionPath, "starts" | "frames" | "closed">): number[] {
  const end = endFrame(m), seen = new Set<number>([0]);
  for (const f of [...m.starts].sort((a, b) => a - b)) if (Number.isInteger(f) && f > 0 && f < end) seen.add(f);
  return [...seen].sort((a, b) => a - b);
}

/** What the timing of a path is made of. */
export type Timing = Pick<MotionPath, "starts" | "frames" | "closed" | "speeds" | "curves">;

/** A point of a block's speed graph: how fast the bone goes (1 is even) at `u` (0..1 of the block's frames). */
export interface SpeedPoint { readonly u: number; readonly v: number }

/** The speed graph of a block: the default is a straight line at 1. */
export const FLAT_SPEED: readonly SpeedPoint[] = [{ u: 0, v: 1 }, { u: 1, v: 1 }];

/** A block: from a node time to the next (the last to the end of the run), with its time multiplier and its speed graph. */
export interface Block { readonly start: number; readonly end: number; readonly speed: number; readonly graph: readonly SpeedPoint[] }

function pointsOf(flat: readonly number[] | undefined): readonly SpeedPoint[] {
  if (!flat || flat.length < 4 || flat.length % 2) return FLAT_SPEED;
  const out: SpeedPoint[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ u: flat[i]!, v: flat[i + 1]! });
  return out;
}

/** How much of a block's path is covered by `u` (0..1 of its frames), by the area under its speed graph, as a share of the whole area. */
export function graphShare(graph: readonly SpeedPoint[], u: number): number {
  const x = Math.min(1, Math.max(0, u));
  let part = 0, all = 0;
  for (let i = 0; i + 1 < graph.length; i++) {
    const a = graph[i]!, b = graph[i + 1]!, w = b.u - a.u;
    if (w <= 0) continue;
    all += (w * (a.v + b.v)) / 2;
    if (x <= a.u) continue;
    const t = Math.min(w, x - a.u), vt = a.v + ((b.v - a.v) * t) / w;
    part += (t * (a.v + vt)) / 2;
  }
  return all > 0 ? part / all : x;
}

export function blocksOf(m: Timing): Block[] {
  const times = nodeTimeFrames(m), end = endFrame(m);
  return times.map((start, i) => ({ start, end: times[i + 1] ?? end, speed: m.speeds[i] !== undefined && m.speeds[i]! > 0 ? m.speeds[i]! : 1, graph: pointsOf(m.curves?.[i]) }));
}

/** How far along the path each block begins (0..1), and the last 1: the path covered in a block is proportional to its frames × its multiplier. */
export function boundaryProgress(m: Timing): number[] {
  const blocks = blocksOf(m), shares = blocks.map((b) => (b.end - b.start) * b.speed), total = shares.reduce((a, b) => a + b, 0) || 1;
  const out = [0];
  for (const s of shares) out.push(out.at(-1)! + s / total);
  out[out.length - 1] = 1;
  return out;
}

/** The progress (0..1 of the path) at a frame: the block's share, spread by its speed graph (even when it is a straight line). */
export function progressAtFrame(m: Timing, frame: number): number {
  const blocks = blocksOf(m), bp = boundaryProgress(m), f = Math.min(endFrame(m), Math.max(0, frame));
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (f <= b.end || i === blocks.length - 1) return bp[i]! + (bp[i + 1]! - bp[i]!) * graphShare(b.graph, (f - b.start) / Math.max(1, b.end - b.start));
  }
  return 1;
}

/** The path's point at a frame. */
export function placeAtFrame(m: MotionPath, frame: number): Pt {
  const c = curveOf(m);
  return c.at(progressAtFrame(m, frame) * c.length);
}

/** The frames the keys of a bake go on: the node times, then the end of the run. */
export function keyFrames(m: Pick<MotionPath, "starts" | "frames" | "closed">): number[] {
  return [...nodeTimeFrames(m), endFrame(m)];
}

/** The number each node's button shows: its own once nodes have been reordered, else its place in the list. */
export function nodeLabels(m: Pick<MotionPath, "nodes">): number[] {
  return m.nodes.map((n, i) => n.id ?? i + 1);
}

/** Every node given the number it shows now, so it keeps it when the order changes. */
function withIds(m: MotionPath): MotionPath {
  return m.nodes.every((n) => n.id !== undefined) ? m : { ...m, nodes: m.nodes.map((n, i) => ({ ...n, id: n.id ?? i + 1 })) };
}

/** A node added at the end (`at` undefined) or before place `at`; it gets the next free number. */
export function withNode(m: MotionPath, node: MotionNode, at?: number): MotionPath {
  const i = at ?? m.nodes.length;
  // Appending to a path never reordered needs no numbers: the new one is next in the list.
  const plain = at === undefined && m.nodes.every((n) => n.id === undefined), base = plain ? m : withIds(m);
  const id = plain ? undefined : Math.max(...nodeLabels(base)) + 1;
  const added = id === undefined ? node : { ...node, id };
  return { ...base, nodes: [...base.nodes.slice(0, i), added, ...base.nodes.slice(i)] };
}

/** The point of the path halfway (by length) between the node at place `i` and the next one (on a ring the last one's next is the first); null for the last node of an open path. */
export function midAfter(m: MotionPath, i: number): Pt | null {
  const curve = curveOf(m), a = curve.nodeAt[i], b = curve.nodeAt[i + 1];
  if (a === undefined || b === undefined || i >= m.nodes.length || (!m.closed && i === m.nodes.length - 1)) return null;
  return curve.at((a + b) / 2);
}

/** The nodes at the places `picked` joined into one: at their centre, in the place of the first of them, with its number and an automatic handle. */
export function mergeNodes(m0: MotionPath, picked: readonly number[]): MotionPath {
  const at = [...new Set(picked)].filter((i) => i >= 0 && i < m0.nodes.length).sort((a, b) => a - b);
  if (at.length < 2) throw new EditRefused("Pick two or more spline nodes to merge (Command + click).");
  if (m0.nodes.length - at.length + 1 < 2) throw new EditRefused("A path keeps two spline nodes.");
  const m = withIds(m0), x = at.reduce((s, i) => s + m.nodes[i]!.x, 0) / at.length, y = at.reduce((s, i) => s + m.nodes[i]!.y, 0) / at.length;
  const merged: MotionNode = { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, id: m.nodes[at[0]!]!.id! };
  return { ...m, nodes: m.nodes.flatMap((n, i) => (i === at[0] ? [merged] : at.includes(i) ? [] : [n])) };
}

/** The path run the other way round: a ring keeps its first node first (1, 2, 3, 4 becomes 1, 4, 3, 2), an open path is turned end for end; each handle turns with it. */
export function reversePath(m0: MotionPath): MotionPath {
  const m = withIds(m0), flip = (n: MotionNode): MotionNode => (n.tx === undefined && n.ty === undefined ? n : { ...n, tx: -(n.tx ?? 0) || 0, ty: -(n.ty ?? 0) || 0 });
  const nodes = m.closed ? [m.nodes[0]!, ...m.nodes.slice(1).reverse()] : m.nodes.slice().reverse();
  return { ...m, nodes: nodes.map(flip) };
}

/** The node at place `from` moved to place `to` (the others shift by one): it keeps its handle and its number; the path is the same set of places run in another order. */
export function moveNode(m0: MotionPath, from: number, to: number): MotionPath {
  if (from === to || from < 0 || to < 0 || from >= m0.nodes.length || to >= m0.nodes.length) throw new EditRefused("There is no such spline node.");
  const m = withIds(m0), nodes = m.nodes.slice(), [held] = nodes.splice(from, 1);
  nodes.splice(to, 0, held!);
  return { ...m, nodes };
}

/** The ring started at node `i` (the origin): the order is the same going round, from that node (3, 1, 2, 4 started at 2 is 2, 4, 3, 1). Only a ring can start elsewhere: an open path has two ends. */
export function withOrigin(m0: MotionPath, i: number): MotionPath {
  if (i < 0 || i >= m0.nodes.length) throw new EditRefused("There is no such spline node.");
  if (!m0.closed) throw new EditRefused("Only a ring can start at another node: an open path has two ends.");
  if (i === 0) throw new EditRefused("That node is already the origin.");
  const m = withIds(m0);
  return { ...m, nodes: [...m.nodes.slice(i), ...m.nodes.slice(0, i)] };
}

/** A node time added at `frame` (inside the run, not on another); the block it falls in is split in two, each keeping its multiplier. */
export function addNodeTime(m: MotionPath, frame: number): MotionPath {
  const times = nodeTimeFrames(m), end = endFrame(m);
  if (!Number.isInteger(frame) || frame <= 0 || frame >= end) throw new EditRefused(`A node time goes on a frame from 1 to ${end - 1}.`);
  if (times.includes(frame)) throw new EditRefused(`There is already a node time on frame ${frame}.`);
  const at = times.filter((f) => f < frame).length, speeds = blocksOf(m).map((b) => b.speed);
  return { ...m, starts: [...times.slice(1), frame].sort((a, b) => a - b), speeds: [...speeds.slice(0, at), speeds[at - 1]!, ...speeds.slice(at)], curves: curvesWith(m, (c) => [...c.slice(0, at - 1), [], [], ...c.slice(at)]) };
}

/** A node time removed (an index into `nodeTimeFrames`; the first stays, and a path keeps two). The two blocks join and take the multiplier of the earlier. */
export function removeNodeTime(m: MotionPath, i: number): MotionPath {
  const times = nodeTimeFrames(m);
  if (i <= 0) throw new EditRefused("The first node time (frame 0) stays.");
  if (times.length <= 2) throw new EditRefused("A path keeps two node times.");
  if (i >= times.length) throw new EditRefused("There is no such node time.");
  const speeds = blocksOf(m).map((b) => b.speed);
  return { ...m, starts: times.slice(1).filter((_, k) => k + 1 !== i), speeds: speeds.filter((_, k) => k !== i), curves: curvesWith(m, (c) => [...c.slice(0, i - 1), [], ...c.slice(i + 1)]) };
}

/** A node time moved to `frame`, held a frame inside its neighbours (an index into `nodeTimeFrames`, not the first). */
export function moveNodeTime(m: MotionPath, i: number, frame: number): MotionPath {
  const times = nodeTimeFrames(m), end = endFrame(m);
  if (i <= 0 || i >= times.length) throw new EditRefused("The first node time stays on frame 0.");
  const lo = times[i - 1]! + 1, hi = (times[i + 1] ?? end) - 1;
  if (lo > hi) throw new EditRefused("There is no room between its neighbours.");
  const f = Math.min(hi, Math.max(lo, Math.round(frame)));
  return { ...m, starts: times.slice(1).map((t, k) => (k + 1 === i ? f : t)) };
}

/** The path running `frames` frames: the node times keep their share of it (and always stay inside). */
export function withFrames(m: MotionPath, frames: number): MotionPath {
  if (!Number.isInteger(frames) || frames < 4) throw new EditRefused("A path takes at least 4 frames.");
  const before = endFrame(m), next = { ...m, frames }, end = endFrame(next), k = end / before;
  const times = nodeTimeFrames(m).slice(1).map((f) => Math.round(f * k)), kept: number[] = [];
  for (const f of times) if (f >= 1 && f <= end - 1 && !kept.includes(f)) kept.push(f);
  // At least two node times: if shrinking squeezed them out, one goes in the middle.
  if (!kept.length) kept.push(Math.max(1, Math.round(end / 2)));
  const speeds = blocksOf(m).map((b) => b.speed);
  return { ...next, starts: kept, speeds: speeds.slice(0, kept.length + 1), curves: curvesWith(m, (c) => c.slice(0, kept.length + 1)) };
}

/** The block graphs of `m` as one flat list per block, changed by `f`; left off when none is bent. */
function curvesWith(m: Timing, f: (c: readonly (readonly number[])[]) => (readonly number[])[]): (readonly number[])[] | undefined {
  const n = blocksOf(m).length, c = Array.from({ length: n }, (_, i) => m.curves?.[i] ?? []);
  const out = f(c);
  return out.some((q) => q.length) ? out : undefined;
}

/** A block's speed graph set (points from u 0 to 1, in order, each speed from 0.05 to 4); `null` puts the straight line back. */
export function withBlockGraph(m: MotionPath, block: number, graph: readonly SpeedPoint[] | null): MotionPath {
  const blocks = blocksOf(m);
  if (block < 0 || block >= blocks.length) throw new EditRefused("There is no such block.");
  let flat: number[] = [];
  if (graph) {
    if (graph.length < 2 || graph[0]!.u !== 0 || graph.at(-1)!.u !== 1) throw new EditRefused("A speed graph runs from the block's first frame to its last.");
    for (let i = 1; i < graph.length; i++) if (!(graph[i]!.u > graph[i - 1]!.u)) throw new EditRefused("The points of a speed graph go in order.");
    if (graph.some((p) => !(p.v >= 0.05 && p.v <= 4))) throw new EditRefused("A speed is from 0.05 to 4.");
    if (!graph.every((p) => p.v === 1)) flat = graph.flatMap((p) => [shortFloat(p.u), shortFloat(p.v)]);
  }
  const curves = curvesWith(m, (c) => c.map((q, i) => (i === block ? flat : q)));
  const { curves: _drop, ...rest } = m;
  return curves ? { ...rest, curves } : rest;
}

/** A block's time multiplier set (1 is even; between 0.1 and 10). */
export function withSpeed(m: MotionPath, block: number, speed: number): MotionPath {
  const blocks = blocksOf(m);
  if (block < 0 || block >= blocks.length) throw new EditRefused("There is no such block.");
  if (!(speed >= 0.1 && speed <= 10)) throw new EditRefused("A time multiplier is from 0.1 to 10.");
  return { ...m, speeds: blocks.map((b, i) => (i === block ? speed : b.speed)) };
}

/**
 * Fit a Spine channel curve to one segment: the value at `u` = 0, 1/n … 1 (even steps in time, the
 * first and last the keys' values). The Bézier's control times sit a third and two thirds of the way,
 * so only the two control values are free: the least-squares pair for the samples. Returns them and
 * how far the fitted curve is from the samples at worst.
 */
export function fitChannel(values: readonly number[]): { c1: number; c2: number; error: number } {
  const n = values.length - 1, v0 = values[0]!, v3 = values[n]!;
  if (n < 2) return { c1: v0 + (v3 - v0) / 3, c2: v0 + ((v3 - v0) * 2) / 3, error: 0 };
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const basis = (u: number) => { const w = 1 - u; return [w * w * w, 3 * w * w * u, 3 * w * u * u, u * u * u] as const; };
  for (let k = 1; k < n; k++) {
    const [e0, e1, e2, e3] = basis(k / n), r = values[k]! - e0 * v0 - e3 * v3;
    a11 += e1 * e1; a12 += e1 * e2; a22 += e2 * e2; b1 += e1 * r; b2 += e2 * r;
  }
  const det = a11 * a22 - a12 * a12;
  let c1 = v0 + (v3 - v0) / 3, c2 = v0 + ((v3 - v0) * 2) / 3;
  if (Math.abs(det) > 1e-12) { c1 = (b1 * a22 - b2 * a12) / det; c2 = (a11 * b2 - a12 * b1) / det; }
  let error = 0;
  for (let k = 0; k <= n; k++) { const [e0, e1, e2, e3] = basis(k / n); error = Math.max(error, Math.abs(e0 * v0 + e1 * c1 + e2 * c2 + e3 * v3 - values[k]!)); }
  return { c1, c2, error };
}

const keyed = (n: number) => shortFloat(Math.round(n * 1e4) / 1e4);

/** One baked key: the bone's local x and y (as offsets from its setup pose when written) at a frame, and the control values of the curve to the next key. */
export interface BakedKey {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  /** [x's c1, x's c2, y's c1, y's c2]: control values (local, absolute), absent on the last key. */
  readonly control?: readonly [number, number, number, number];
}

/** The translate keys for `keys` at `fps`, as offsets from the setup pose, each with its curve to the next key (control times at thirds). */
export function translateKeys(boneSetup: { x: number; y: number }, keys: readonly BakedKey[], fps: number): Key[] {
  return keys.map((k, i) => {
    const time = k.frame === 0 ? undefined : frameTime(k.frame, fps), next = keys[i + 1];
    let curve: number[] | undefined;
    if (k.control && next) {
      const t0 = frameTime(k.frame, fps), t1 = frameTime(next.frame, fps), ta = t0 + (t1 - t0) / 3, tb = t0 + ((t1 - t0) * 2) / 3;
      const [xc1, xc2, yc1, yc2] = k.control;
      curve = [ta, keyed(xc1 - boneSetup.x), tb, keyed(xc2 - boneSetup.x), ta, keyed(yc1 - boneSetup.y), tb, keyed(yc2 - boneSetup.y)].map((v) => shortFloat(v));
    }
    return { ...(time !== undefined ? { time } : {}), x: keyed(k.x - boneSetup.x), y: keyed(k.y - boneSetup.y), ...(curve ? { curve } : {}), extra: new Map() } as Key;
  });
}

/** A short signature of the path's own settings (nodes, handles, frames, node times, multipliers, closed): what a bake to the timeline was made from. */
export function pathSignature(m: Timing & Pick<MotionPath, "nodes">): string {
  const text = JSON.stringify([m.nodes.map((n) => [n.x, n.y, n.tx ?? null, n.ty ?? null]), m.closed, m.frames, [...m.starts].sort((a, b) => a - b), m.speeds, m.curves ?? []]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A short signature of a bone's translate keys in an animation, to tell when they were edited since a bake. */
export function keysSignature(keys: readonly Key[]): string {
  let h = 5381;
  for (const k of keys) for (const v of [k.time ?? 0, k.x ?? 0, k.y ?? 0]) h = ((h * 33) ^ Math.round(v * 1e4)) | 0;
  return (h >>> 0).toString(36) + "." + keys.length;
}

/** Replace the bone's translate timelines in an animation with `keys` (the combined `translate` list; the split ones go). */
export function bakeTranslate(animation: string, bone: string, keys: readonly Key[]): Edit<Skeleton> {
  return (s) => {
    const b = s.bones?.find((x) => x.name === bone);
    if (!b) throw new EditRefused(`There is no bone "${bone}".`);
    const baked = onAnimation(animation, (a) => {
      let out = a;
      for (const timeline of ["translatex", "translatey"]) out = withKeys(out, { section: "bones", owner: bone, timeline }, []);
      return withKeys(out, { section: "bones", owner: bone, timeline: "translate" }, keys);
    })(s);
    // The path sets the animation's length: keys past its last one (an older, longer take) go, on every timeline.
    const end = keys.length ? keyTime(keys.at(-1)!) : 0, a = baked.animations?.find((x) => x.name === animation);
    const late: KeyRef[] = [];
    for (const l of a ? keyLists(a) : []) for (const k of l.keys) if (keyTime(k) > end + 1e-6) late.push({ path: l.path, time: keyTime(k) });
    return late.length ? deleteKeys(animation, late)(baked) : baked;
  };
}

/** The bone's setup x and y (what a translate key is an offset from). */
export function setupXY(s: Skeleton, bone: string): { x: number; y: number } {
  const b = s.bones?.find((x) => x.name === bone);
  if (!b) throw new EditRefused(`There is no bone "${bone}".`);
  return { x: boneNumber(b, "x"), y: boneNumber(b, "y") };
}
