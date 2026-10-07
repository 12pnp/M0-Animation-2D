import type { MotionNode, MotionPath } from "@/model/sidecar";
import { EditRefused } from "@/model/refused";
import { curveOf, handleOffsets, type Pt } from "./curve";

/** The path's nodes and run: labels, adding, merging, legs, order, origin, frames (docs/TWO-SYSTEMS-PLAN.md, P). Pure. */

/** The seconds a new path runs when nothing says otherwise. */
export const DEFAULT_DURATION = 0.5;

/** The shortest run a path can have, in seconds. */
export const MIN_DURATION = 0.1;

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
  const speed = at.reduce((q, i) => q + (m.nodes[i]!.speed ?? 0), 0) / at.length;
  const merged: MotionNode = { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, id: m.nodes[at[0]!]!.id!, ...(speed ? { speed: Math.round(speed * 1e4) / 1e4 } : {}) };
  return { ...m, nodes: m.nodes.flatMap((n, i) => (i === at[0] ? [merged] : at.includes(i) ? [] : [n])) };
}

/** The legs of the node at place `i` broken: each handle moves on its own from now on; the curve stays as it is. A node already broken is left. */
export function breakLegs(m: MotionPath, i: number): MotionPath {
  const n = m.nodes[i];
  if (!n) throw new EditRefused("There is no such spline node.");
  if (n.bx !== undefined) return m;
  const h = handleOffsets(m.nodes, m.closed)[i]!, r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ...m, nodes: m.nodes.map((q, k) => (k === i ? { ...q, tx: r(h.out.x), ty: r(h.out.y), bx: r(h.in.x), by: r(h.in.y) } : q)) };
}

/** The legs of the node at place `i` mirrored again: the way in follows the way out (which stays as it is). */
export function mirrorLegs(m: MotionPath, i: number): MotionPath {
  const n = m.nodes[i];
  if (!n) throw new EditRefused("There is no such spline node.");
  if (n.bx === undefined) return m;
  const { bx: _a, by: _b, ...rest } = n;
  return { ...m, nodes: m.nodes.map((q, k) => (k === i ? rest : q)) };
}

/** The path run the other way round: a ring keeps its first node first (1, 2, 3, 4 becomes 1, 4, 3, 2), an open path is turned end for end; each handle turns with it. */
export function reversePath(m0: MotionPath): MotionPath {
  const m = withIds(m0), h = handleOffsets(m.nodes, m.closed), r = (v: number) => Math.round(v * 1e4) / 1e4;
  // A node turned round: its way out is what its way in was (a broken leg swaps with it), a mirrored handle is negated.
  const flip = (n: MotionNode, k: number): MotionNode => {
    if (n.bx !== undefined && n.by !== undefined) return { ...n, tx: n.bx, ty: n.by, bx: r(h[k]!.out.x), by: r(h[k]!.out.y) };
    return n.tx === undefined && n.ty === undefined ? n : { ...n, tx: -(n.tx ?? 0) || 0, ty: -(n.ty ?? 0) || 0 };
  };
  // The speed spline runs the other way too: its legs swap sides and their slopes change sign.
  const flipSpeed = (n: MotionNode): MotionNode => {
    if (n.ss === undefined) return n;
    const { ss, sb, ...rest } = n, neg = (v: number): number => -v || 0;
    return sb === undefined ? { ...rest, ss: neg(ss) } : { ...rest, ss: neg(sb), sb: neg(ss) };
  };
  const order = m.nodes.map((_, k) => k), turned = m.closed ? [0, ...order.slice(1).reverse()] : order.slice().reverse();
  return { ...m, nodes: turned.map((k) => flipSpeed(flip(m.nodes[k]!, k))) };
}

/** Only the numbers on the buttons put back in order (1, 4, 3, 2 shown as 1, 2, 3, 4): every node keeps its place, its position and its handle. */
export function renumberNodes(m: MotionPath): MotionPath {
  return { ...m, nodes: m.nodes.map((n) => { const { id: _id, ...rest } = n; return rest; }) };
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

/** The path running `seconds` seconds (at least 0.1). The speed spline stays as it is: it is over the path's length, not over time. */
export function withDuration(m: MotionPath, seconds: number): MotionPath {
  if (!Number.isFinite(seconds) || seconds < MIN_DURATION) throw new EditRefused(`A path takes at least ${MIN_DURATION} seconds.`);
  return { ...m, duration: Math.round(seconds * 1e4) / 1e4 };
}

/** The path's clock starting over at the end, or stopping there. */
export function withLoop(m: MotionPath, loop: boolean): MotionPath {
  return m.loop === loop ? m : { ...m, loop };
}
