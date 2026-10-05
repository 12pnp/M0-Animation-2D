import { type TweenSpec, CURVE_Y_LIMIT, EASE_FAMILIES } from "@/core/math/easing";
import { displaysOf } from "./displays";
import type { Node, SkinDef, DisplayRef, MeshData, OutlineWeights, RegionTurn, DeformKey, TransformConstraint, EventDef } from "./types";

const TC_NAMES = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const;
type TcName = (typeof TC_NAMES)[number];
const isTc = (v: unknown): v is TcName => typeof v === "string" && (TC_NAMES as readonly string[]).includes(v);
export const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
/** A mesh read from disk, or null when it cannot be one: an even list of
 *  finite points, triangles of existing points, an outline of 3 or more,
 *  weights (when present) per point, of bones the symbol has. */
export function sanitizeSkin(
  raw: unknown, nodes: Record<string, Node>, ikIds: Set<string>, tcIds: Set<string>, isImage: (id: string) => boolean, cnIds: Set<string> = new Set()): SkinDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name === "default") return null;
  const def: SkinDef = { name };
  if (typeof r.color === "string" && /^[0-9a-fA-F]{8}$/.test(r.color)) def.color = r.color.toLowerCase();
  const displays: Record<string, Record<string, DisplayRef>> = {};
  for (const [nodeId, byIndex] of Object.entries(r.displays && typeof r.displays === "object" ? r.displays as Record<string, unknown> : {})) {
    const node = nodes[nodeId];
    if (!node || !byIndex || typeof byIndex !== "object") continue;
    const count = displaysOf(node).length;
    const out: Record<string, DisplayRef> = {};
    for (const [index, ref] of Object.entries(byIndex as Record<string, unknown>)) {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= count || !ref || typeof ref !== "object") continue;
      const d = ref as Record<string, unknown>;
      if (typeof d.itemId !== "string" || !isImage(d.itemId)) continue;
      const pv = d.pivot && typeof d.pivot === "object" ? d.pivot as Record<string, unknown> : {};
      const clean: DisplayRef = { itemId: d.itemId as DisplayRef["itemId"], pivot: { x: num(pv.x, 0), y: num(pv.y, 0) } };
      const a = d.attachment as Record<string, unknown> | undefined;
      if (a && typeof a === "object" && typeof a.name === "string" && a.data && typeof a.data === "object") clean.attachment = { name: a.name, data: a.data as Record<string, unknown> };
      // A skin's own mesh, or a link to a mesh (checked once every skin is read).
      if (typeof d.key === "string" && d.key) clean.key = d.key;
      if (typeof d.name === "string" && d.name) clean.name = d.name;
      const mesh = d.mesh !== undefined ? sanitizeMesh(d.mesh, nodes) : null;
      if (mesh) clean.mesh = mesh;
      const l = d.linked as { to?: unknown; deform?: unknown; skin?: unknown; } | undefined;
      if (!mesh && l && typeof l === "object" && Number.isInteger(l.to) && (l.to as number) >= 0 && (l.to as number) < count) {
        clean.linked = { to: l.to as number, ...(l.deform === false ? { deform: false as const } : {}), ...(typeof l.skin === "string" && l.skin ? { skin: l.skin } : {}) };
      }
      const turn = regionOf(d.region);
      if (turn) clean.region = turn;
      const tint = tintRead(d.tint);
      if (tint) clean.tint = tint;
      out[String(i)] = clean;
    }
    if (Object.keys(out).length) displays[nodeId] = out;
  }
  if (Object.keys(displays).length) def.displays = displays as SkinDef["displays"];
  const ids = (v: unknown, keep: (id: string) => boolean) => [...new Set(Array.isArray(v) ? v.filter((id): id is string => typeof id === "string" && keep(id)) : [])];
  const bones = ids(r.bones, (id) => !!nodes[id]);
  const ik = ids(r.ik, (id) => ikIds.has(id));
  const transforms = ids(r.transforms, (id) => tcIds.has(id));
  if (bones.length) def.bones = bones as SkinDef["bones"];
  if (ik.length) def.ik = ik as SkinDef["ik"];
  if (transforms.length) def.transforms = transforms as SkinDef["transforms"];
  const constraints = ids(r.constraints, (id) => cnIds.has(id));
  if (constraints.length) def.constraints = constraints as SkinDef["constraints"];
  // Its own boxes, points and paths: for nodes of that kind, well formed.
  const outlines: NonNullable<SkinDef["outlines"]> = {};
  for (const [nodeId, raw] of Object.entries(r.outlines && typeof r.outlines === "object" ? r.outlines as Record<string, unknown> : {})) {
    const node = nodes[nodeId];
    const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    if (!node || !o) continue;
    const pts = (v: unknown) => { const q = v && typeof v === "object" ? (v as Record<string, unknown>).points : undefined; return Array.isArray(q) ? q.map((x) => num(x, NaN)) : []; };
    if (node.kind === "box") {
      const p = pts(o.box);
      if (p.length >= 6 && p.length % 2 === 0 && p.every(Number.isFinite)) outlines[nodeId as never] = { box: { points: p, ...weightsOf(o.box as Record<string, unknown>, p.length / 2, nodes) } };
    } else if (node.kind === "path") {
      const p = pts(o.path), r2 = o.path as Record<string, unknown>;
      if (p.length >= 12 && p.length % 6 === 0 && p.every(Number.isFinite)) {
        outlines[nodeId as never] = { path: { points: p, ...(r2.closed === true ? { closed: true } : {}), ...(r2.constantSpeed === false ? { constantSpeed: false } : {}), ...weightsOf(r2, p.length / 2, nodes) } };
      }
    } else if (node.kind === "point") {
      const q = o.point && typeof o.point === "object" ? o.point as Record<string, unknown> : {};
      outlines[nodeId as never] = { point: { x: num(q.x, 0), y: num(q.y, 0), rotation: num(q.rotation, 0) } };
    }
  }
  if (Object.keys(outlines).length) def.outlines = outlines;
  return def;
}
export function sanitizeMesh(raw: unknown, nodes: Record<string, unknown>): MeshData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const points = Array.isArray(r.points) ? r.points.map((v) => num(v, NaN)) : [];
  if (points.length < 6 || points.length % 2 || points.some((v) => !Number.isFinite(v))) return null;
  const count = points.length / 2;
  const hull = clampInt(r.hull, 3, count, 3);
  const tris = Array.isArray(r.triangles) ? r.triangles.map((v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < count ? (v as number) : -1)) : [];
  if (!tris.length || tris.length % 3 || tris.some((i) => i < 0)) return null;
  const out: MeshData = { width: Math.max(1, num(r.width, 1)), height: Math.max(1, num(r.height, 1)), points, triangles: tris, hull };
  Object.assign(out, weightsOf(r, count, nodes));
  if (Array.isArray(r.vertices) && r.vertices.length === points.length && r.vertices.every((v) => Number.isFinite(v))) out.vertices = [...r.vertices as number[]];
  if (Array.isArray(r.edges) && r.edges.length % 2 === 0 && r.edges.every((v) => Number.isInteger(v) && (v as number) >= 0)) out.edges = [...r.edges as number[]];
  return out;
}
/** A mesh's, box's or path's weights read from disk: per point, of bones the
 *  symbol has; the file's bone offsets when they fit them. */
export function weightsOf(r: Record<string, unknown>, count: number, nodes: Record<string, unknown>): OutlineWeights {
  const out: OutlineWeights = {};
  if (Array.isArray(r.weights) && r.weights.length === count) {
    const weights = r.weights.map((w) => (Array.isArray(w) ? w : [])
      .filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && !!nodes[e[0]] && Number.isFinite(e[1]))
      .map(([b, v]) => [b, Math.max(0, v)] as [string, number]));
    if (weights.some((w) => w.length)) out.weights = weights as never;
  }
  if (out.weights && Array.isArray(r.boneOffsets) && r.boneOffsets.length === count) {
    const offs = r.boneOffsets as unknown[];
    const fits = offs.every((o, i) => Array.isArray(o) && (o.length === 0 || o.length === out.weights![i]!.length)
      && o.every((e) => Array.isArray(e) && e.length === 2 && e.every((v) => Number.isFinite(v))));
    if (fits) out.boneOffsets = offs.map((o) => (o as Array<[number, number]>).map(([x, y]) => [x, y] as [number, number]));
  }
  return out;
}
/** A region's turn read from disk: finite numbers, the defaults left out. */
export function regionOf(raw: unknown): RegionTurn | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>, out: RegionTurn = {};
  if (num(r.rotation, 0)) out.rotation = num(r.rotation, 0);
  if (num(r.scaleX, 1) !== 1) out.scaleX = num(r.scaleX, 1);
  if (num(r.scaleY, 1) !== 1) out.scaleY = num(r.scaleY, 1);
  return Object.keys(out).length ? out : undefined;
}
/** Deform keys read from disk: one per frame, sorted, `count` offsets each. */
export function deformKeysRead(list: unknown[], count: number): DeformKey[] {
  const byFrame = new Map<number, DeformKey>();
  for (const k of list) {
    if (!k || typeof k !== "object") continue;
    const r = k as Record<string, unknown>;
    const offsets = Array.isArray(r.offsets) ? r.offsets.map((v) => num(v, 0)) : [];
    const key: DeformKey = { frame: clampInt(r.frame, 0, 100000, 0), offsets: Array.from({ length: count }, (_, i) => offsets[i] ?? 0) };
    const tween = sanitizeTween(r.tween);
    if (tween?.kind === "none" || (tween?.kind === "curve" && tween.curve.length === 4)) key.tween = tween;
    byFrame.set(key.frame, key);
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}
/** A tint read from disk: "rrggbbaa", lower case; white is none. */
export function tintRead(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^[0-9a-fA-F]{8}$/.test(v)) return undefined;
  return v.toLowerCase() === "ffffffff" ? undefined : v.toLowerCase();
}
/** Six mixes read from disk, 0..1; a missing one is 1. */
export function mixOf(raw: unknown): Record<TcName, number> {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(TC_NAMES.map((c) => [c, Math.min(1, Math.max(0, num(r[c], 1)))])) as Record<TcName, number>;
}
/** A transform constraint read from disk, or null when its source or every
 *  bone is gone. */
export function sanitizeTransform(raw: unknown, nodes: Record<string, unknown>): TransformConstraint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const sourceId = typeof r.sourceId === "string" && nodes[r.sourceId] ? r.sourceId : null;
  if (!name || !sourceId || typeof r.id !== "string") return null;
  const boneIds = [...new Set((Array.isArray(r.boneIds) ? r.boneIds : []).filter((b): b is string => typeof b === "string" && !!nodes[b] && b !== sourceId))];
  if (!boneIds.length) return null;
  const properties = (Array.isArray(r.properties) ? r.properties : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && isTc((p as { from?: unknown; }).from))
    .map((p) => ({
      from: p.from as TcName,
      offset: num(p.offset, 0),
      to: (Array.isArray(p.to) ? p.to : [])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && isTc((t as { to?: unknown; }).to))
        .map((t) => ({ to: t.to as TcName, offset: num(t.offset, 0), max: num(t.max, 1), scale: num(t.scale, 1) })),
    }))
    .filter((p) => p.to.length);
  const offsetsRaw = r.offsets && typeof r.offsets === "object" ? (r.offsets as Record<string, unknown>) : {};
  const offsets: Partial<Record<TcName, number>> = {};
  for (const c of TC_NAMES) if (num(offsetsRaw[c], 0) !== 0) offsets[c] = num(offsetsRaw[c], 0);
  const out: TransformConstraint = { id: r.id as never, name, boneIds: boneIds as never, sourceId: sourceId as never, mix: mixOf(r.mix), properties };
  if (Object.keys(offsets).length) out.offsets = offsets;
  for (const f of ["localSource", "localTarget", "additive", "clamp"] as const) if (r[f] === true) out[f] = true;
  if (r.spine && typeof r.spine === "object") out.spine = r.spine as Record<string, unknown>;
  return out;
}
/** An event's or a key's values read from disk: the right types only. */
export function eventFields(r: Record<string, unknown>, def: boolean): Partial<EventDef> {
  const out: Partial<EventDef> = {};
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (finite(r.int)) out.int = Math.trunc(r.int);
  if (finite(r.float)) out.float = r.float;
  if (typeof r.string === "string") out.string = r.string;
  if (def && typeof r.audio === "string" && r.audio) out.audio = r.audio;
  if (finite(r.volume)) out.volume = Math.max(0, Math.min(1, r.volume));
  if (finite(r.balance)) out.balance = Math.max(-1, Math.min(1, r.balance));
  return out;
}
/** A tween read from disk, or null when it is not one this build knows. */
export function sanitizeTween(raw: unknown): TweenSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  switch (t.kind) {
    case "none": return { kind: "none" };
    case "linear": return { kind: "linear" };
    case "ease":
      return finite(t.value) ? { kind: "ease", value: Math.min(2, Math.max(-1, t.value)) } : null;
    case "curve": {
      const c = t.curve;
      if (!Array.isArray(c) || c.length < 4 || c.length % 6 !== 4 || !c.every(finite)) return null;
      return { kind: "curve", curve: c.map((v, i) => (i % 2 ? Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v)) : Math.min(1, Math.max(0, v)))) };
    }
    case "preset": {
      const fam = EASE_FAMILIES.find((f) => f.id === t.family);
      if (!fam || (t.dir !== "in" && t.dir !== "out" && t.dir !== "inOut")) return null;
      const spec: TweenSpec = { kind: "preset", family: fam.id, dir: t.dir };
      if (fam.amount && finite(t.amount)) spec.amount = Math.min(fam.amount.max, Math.max(fam.amount.min, t.amount));
      return spec;
    }
    default: return null;
  }
}
export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}
