import { type Attachment, attachmentType, type Skeleton } from "@/model/skeleton";
import { type AttachmentRef, findAttachment, replaceAttachment } from "./attachments";
import { refuseNonFinite } from "./finite";
import { EditRefused, type Edit } from "./history";
import { type BoneWorlds, bindAt, decodeBinds, encodeBinds, type Frame, frameFor, isWeighted, positions, round } from "./meshLayout";

/**
 * Path attachment edits (docs/PATH-PLAN.md): the points of a spline that a path constraint lays its
 * bones along. A path has `vertexCount` vertices, three to a point (handle in, the point, handle
 * out), written as x, y pairs in the slot bone's space, or, bound to bones, as each vertex's binds
 * (the layout a mesh uses). Coordinates here are the slot bone's space on the setup pose ("Local");
 * `worldOf` and `localOf` go to and from the skeleton's ("World").
 */

/** The path at `r`, or the reason it is not one. */
export function editablePath(s: Skeleton, r: AttachmentRef): Attachment {
  const a = findAttachment(s, r);
  if (!a) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
  const type = attachmentType(a);
  if (type !== "path") throw new EditRefused(`"${r.key}" is a ${type}, not a path.`);
  if (!a.vertices || a.vertexCount === undefined) throw new EditRefused(`"${r.key}" is missing its vertices.`);
  return a;
}

/**
 * A new path of two points, 100 units apart along x from (x, y) in the slot bone's space, with
 * handles a third of the way along: a straight, open path at constant speed (Spine's default).
 */
export function newPathAttachment(x = 0, y = 0): Attachment {
  const r = (n: number) => round(n, 2);
  return { type: "path", vertexCount: 6, vertices: [r(x - 100 / 3), r(y), r(x), r(y), r(x + 100 / 3), r(y), r(x + 200 / 3), r(y), r(x + 100), r(y), r(x + 400 / 3), r(y)], lengths: [0, 0], extra: new Map() };
}

/** The number of points: three vertices each. */
export const pointCount = (a: Attachment): number => Math.floor((a.vertexCount ?? 0) / 3);

/** Where a path is: its slot's bone and the setup bones (null when it is not bound and no bones were given). */
export function pathFrame(s: Skeleton, r: AttachmentRef, a: Attachment, bones: BoneWorlds | undefined): Frame | null {
  return frameFor(s, r, a, bones);
}

/** Every vertex of the path in the slot bone's space on the setup pose, as x, y pairs. */
export function pathPositions(a: Attachment, f: Frame | null): number[] {
  return positions(a, f);
}

const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!];

/** A slot-space point in the skeleton's space, on the setup pose. */
export function worldOf(f: Frame, x: number, y: number): [number, number] {
  return apply(f.slot, x, y);
}

/** A skeleton-space point in the slot bone's space. */
export function localOf(f: Frame, x: number, y: number): [number, number] {
  const [a, b, c, d, tx, ty] = f.slot as [number, number, number, number, number, number], det = a * d - b * c, dx = x - tx, dy = y - ty;
  return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
}

/**
 * The path with its vertices at `pos` (slot-space pairs). Unbound, they are written as given;
 * bound, each vertex that moved keeps its weights and is bound again where it lands. Lengths follow
 * unless the path runs at constant speed (it does not read them).
 */
function written(s: Skeleton, r: AttachmentRef, a: Attachment, f: Frame | null, was: readonly number[], pos: readonly number[]): Skeleton {
  let vertices: number[];
  if (isWeighted(a)) {
    const binds = decodeBinds(a.vertices!);
    for (let i = 0; i < binds.length; i++) {
      if (round(was[i * 2]!, 4) === round(pos[i * 2]!, 4) && round(was[i * 2 + 1]!, 4) === round(pos[i * 2 + 1]!, 4)) continue;
      binds[i] = bindAt(f!, binds[i]!, pos[i * 2]!, pos[i * 2 + 1]!);
    }
    vertices = encodeBinds(binds);
  } else {
    vertices = pos.map((n) => round(n, 4));
  }
  return replaceAttachment(s, r, withLengths({ ...a, vertices }, f, pos));
}

/** Spine's default: a path runs at constant speed unless the file says `constantSpeed: false`. */
export const runsAtConstantSpeed = (a: Attachment): boolean => a.constantSpeed !== false;

/** `a` with `lengths` worked out from `pos`, when it does not run at constant speed: cumulative curve lengths, as many as it had. */
function withLengths(a: Attachment, f: Frame | null, pos: readonly number[]): Attachment {
  if (runsAtConstantSpeed(a) || !a.lengths) return a;
  const world = Array.from({ length: pos.length / 2 }, (_, i) => (f ? worldOf(f, pos[i * 2]!, pos[i * 2 + 1]!) : [pos[i * 2]!, pos[i * 2 + 1]!] as [number, number]));
  const points = Math.floor(world.length / 3), curves = a.closed ? points : points - 1, out: number[] = [];
  let total = 0;
  for (let c = 0; c < curves; c++) {
    const j = (c + 1) % points, p0 = world[c * 3 + 1]!, p1 = world[c * 3 + 2]!, p2 = world[j * 3]!, p3 = world[j * 3 + 1]!;
    let prev = p0;
    for (let k = 1; k <= 32; k++) {
      const t = k / 32, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      const q: [number, number] = [w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0], w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]];
      total += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
    out.push(round(total, 4));
  }
  // As many entries as the file had (or one for each point); the last curve's total fills the rest.
  const count = Math.max(a.lengths.length, points);
  while (out.length < count) out.push(out.at(-1) ?? 0);
  return { ...a, lengths: out.slice(0, count) };
}

function pathAt(s: Skeleton, r: AttachmentRef, bones: BoneWorlds | undefined): { a: Attachment; f: Frame | null; pos: number[] } {
  const a = editablePath(s, r), f = pathFrame(s, r, a, bones);
  return { a, f, pos: pathPositions(a, f) };
}

/** Move vertex `i` (a handle) to the slot-space point (x, y); the point it belongs to stays. */
export function movePathVertex(r: AttachmentRef, i: number, x: number, y: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite("The vertex", { x, y });
    const { a, f, pos } = pathAt(s, r, bones);
    if (!(i >= 0 && i < (a.vertexCount ?? 0))) throw new EditRefused(`The path has no vertex ${i}.`);
    if (round(pos[i * 2]!, 4) === round(x, 4) && round(pos[i * 2 + 1]!, 4) === round(y, 4)) return s;
    const next = [...pos];
    next[i * 2] = x; next[i * 2 + 1] = y;
    return written(s, r, a, f, pos, next);
  };
}

/** Move point `p` (its middle vertex) to the slot-space point (x, y); its two handles go with it. */
export function movePathPoint(r: AttachmentRef, p: number, x: number, y: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite("The point", { x, y });
    const { a, f, pos } = pathAt(s, r, bones);
    if (!(p >= 0 && p < pointCount(a))) throw new EditRefused(`The path has no point ${p}.`);
    const c = (p * 3 + 1) * 2, dx = x - pos[c]!, dy = y - pos[c + 1]!;
    if (round(dx, 4) === 0 && round(dy, 4) === 0) return s;
    const next = [...pos];
    for (let k = 0; k < 3; k++) { next[(p * 3 + k) * 2] = pos[(p * 3 + k) * 2]! + dx; next[(p * 3 + k) * 2 + 1] = pos[(p * 3 + k) * 2 + 1]! + dy; }
    return written(s, r, a, f, pos, next);
  };
}

/** Whether an animation keys the vertices of the attachment at `r` (a deform timeline). */
export function hasDeform(s: Skeleton, r: AttachmentRef): boolean {
  return (s.animations ?? []).some((an) => (an.attachments ?? []).some((t) => t.skin === r.skin && t.slots.some((sl) => sl.slot === r.slot && sl.attachments.some((g) => g.name === r.key))));
}

/** Add a point at the slot-space point (x, y), last; its handles lie either side along the path's direction. */
export function addPathPoint(r: AttachmentRef, x: number, y: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite("The point", { x, y });
    const { a, f, pos } = pathAt(s, r, bones);
    if (hasDeform(s, r)) throw new EditRefused(`"${r.key}" has deform keys; points cannot be added to a path whose vertices are keyed.`);
    const n = pointCount(a), last = n ? [pos[(n * 3 - 2) * 2]!, pos[(n * 3 - 2) * 2 + 1]!] : [x - 60, y];
    const dx = x - last[0]!, dy = y - last[1]!, len = Math.hypot(dx, dy) || 1, h = Math.max(10, len / 3), ux = dx / len, uy = dy / len;
    const added = [x - ux * h, y - uy * h, x, y, x + ux * h, y + uy * h];
    const next = [...pos, ...added];
    let vertices: number[];
    if (isWeighted(a)) {
      const slotBone = (s.bones ?? []).findIndex((b) => b.name === s.slots?.find((sl) => sl.name === r.slot)?.bone);
      const binds = decodeBinds(a.vertices!);
      for (let k = 0; k < 3; k++) binds.push(bindAt(f!, [{ bone: slotBone, w: 1 }], added[k * 2]!, added[k * 2 + 1]!));
      vertices = encodeBinds(binds);
    } else {
      vertices = next.map((v) => round(v, 4));
    }
    const lengths = a.lengths ? [...a.lengths, 0] : a.lengths;
    return replaceAttachment(s, r, withLengths({ ...a, vertices, vertexCount: (a.vertexCount ?? 0) + 3, ...(lengths ? { lengths } : {}) }, f, next));
  };
}

/** Delete point `p`, with its handles. A path keeps at least two points (one curve). */
export function deletePathPoint(r: AttachmentRef, p: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const { a, f, pos } = pathAt(s, r, bones), n = pointCount(a);
    if (!(p >= 0 && p < n)) throw new EditRefused(`The path has no point ${p}.`);
    if (hasDeform(s, r)) throw new EditRefused(`"${r.key}" has deform keys; points cannot be removed from a path whose vertices are keyed.`);
    if (n <= 2) throw new EditRefused("A path keeps at least two points.");
    const drop = (v: readonly number[]) => [...v.slice(0, p * 6), ...v.slice(p * 6 + 6)];
    const next = drop(pos);
    const vertices = isWeighted(a) ? encodeBinds(decodeBinds(a.vertices!).filter((_, v) => Math.floor(v / 3) !== p)) : next.map((v) => round(v, 4));
    const lengths = a.lengths ? a.lengths.slice(0, Math.max(a.lengths.length - 1, 0)) : a.lengths;
    return replaceAttachment(s, r, withLengths({ ...a, vertices, vertexCount: (a.vertexCount ?? 0) - 3, ...(lengths ? { lengths } : {}) }, f, next));
  };
}

/** Close or open the path, or make it run at constant speed or not; lengths follow. */
export function setPathFlags(r: AttachmentRef, flags: { closed?: boolean; constantSpeed?: boolean }, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const { a, f, pos } = pathAt(s, r, bones);
    const next = { ...a } as { -readonly [K in keyof Attachment]: Attachment[K] };
    // As Spine writes them: `closed` only when true, `constantSpeed` only when false (it defaults to true).
    if (flags.closed !== undefined) { if (flags.closed) next.closed = true; else delete next.closed; }
    if (flags.constantSpeed !== undefined) { if (flags.constantSpeed) delete next.constantSpeed; else next.constantSpeed = false; }
    if (!!next.closed === !!a.closed && runsAtConstantSpeed(next) === runsAtConstantSpeed(a)) return s;
    return replaceAttachment(s, r, withLengths(next, f, pos));
  };
}
