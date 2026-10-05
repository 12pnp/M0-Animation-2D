import { pick } from "./importRead";
import type { IkConstraint, IkKey, TcChannel, Node, TransformConstraint, TcFrom, TcTo, TcKey } from "@/core/doc/types";
import { newTcId, newIkId } from "@/core/doc/ids";
import { num, obj, str } from "./importRead";
import type { BoneBurstRaw } from "./types";

/** The bones local-source transform constraints read. */
export function localSourceBones(constraints: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(constraints)) return out;
  for (const c of constraints) {
    if (obj(c) && c.type === "transform" && c.localSource === true && str(c.source)) out.add(c.source);
  }
  return out;
}
/**
 * A Spine `ik` timeline as the document's keys, or null when it holds what
 * the editor does not key: a time off the frames, a compress or stretch
 * other than the constraint's own, or a curve whose mix and softness halves
 * are not one cubic. A softness equal to the constraint's is left off the
 * key. The bend is inverted, as `ikOf` does.
 */
export function ikKeysOf(list: unknown[], k: IkConstraint, rate: number): IkKey[] | null {
  const setup = k.softness ?? 0, compress = k.spine?.compress === true, stretch = k.spine?.stretch === true;
  const keys: IkKey[] = [];
  /** One half of a Spine curve as the editor's cubic, from `v0` to `v1`;
   *  undefined when the value does not change (any cubic will do), null when
   *  a constant value is bent. */
  const half = (c: number[], at: number, t0: number, span: number, v0: number, v1: number): number[] | undefined | null => {
    const dv = v1 - v0;
    if (Math.abs(dv) > 1e-9) return [(c[at]! - t0) / span, (c[at + 1]! - v0) / dv, (c[at + 2]! - t0) / span, (c[at + 3]! - v0) / dv];
    return Math.abs(c[at + 1]! - v0) > 1e-6 || Math.abs(c[at + 3]! - v0) > 1e-6 ? null : undefined;
  };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!obj(r)) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    if ((r.compress === true) !== compress || (r.stretch === true) !== stretch) return null;
    const soft = Math.max(0, num(r.softness, 0));
    const key: IkKey = { frame: Math.round(at), mix: Math.min(1, Math.max(0, num(r.mix, 1))), bendPositive: r.bendPositive === false };
    if (Math.abs(soft - setup) > 1e-9) key.softness = soft;
    const next = list[i + 1];
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && obj(next)) {
      const c = r.curve.map((v) => num(v, 0));
      const t0 = num(r.time, 0), span = num(next.time, 0) - t0;
      if (span <= 0 || c.length < 8) return null;
      const m = half(c, 0, t0, span, key.mix, num(next.mix, 1));
      const sh = half(c, 4, t0, span, soft, Math.max(0, num(next.softness, 0)));
      if (m === null || sh === null) return null;
      if (m && sh && m.some((v, j) => Math.abs(v - sh[j]!) > 1e-4)) return null;
      const curve = m ?? sh;
      if (curve) key.tween = { kind: "curve", curve: curve.map((v) => v + 0) };
    }
    keys.push(key);
  }
  return keys.length && new Set(keys.map((x) => x.frame)).size === keys.length ? keys : null;
}
const TC_FIELDS = new Set([
  "type", "name", "bones", "source", "localSource", "localTarget", "additive", "clamp", "properties",
  "rotation", "x", "y", "scaleX", "scaleY", "shearY", "mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY",
]);
const TC_NAMES: readonly TcChannel[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];
const isTcName = (v: string): v is TcChannel => (TC_NAMES as readonly string[]).includes(v);
/**
 * A Spine 4.3 transform constraint as the document's, or null when a bone
 * it names is not a bone of the file (then it is carried). Mixes as
 * `SkeletonJson` reads them: `mixY` defaults to `mixX`, `mixScaleY` to
 * `mixScaleX`, the rest to 1.
 */
export function transformOf(c: BoneBurstRaw, bones: Map<string, Node>): TransformConstraint | null {
  const names = Array.isArray(c.bones) ? c.bones.map(String) : [];
  const source = str(c.source) ? bones.get(c.source) : undefined;
  const targets = names.map((n) => bones.get(n));
  if (!source || !targets.length || targets.some((b) => !b)) return null;
  const properties: TcFrom[] = [];
  for (const [from, rawFrom] of Object.entries(obj(c.properties) ? c.properties : {})) {
    if (!isTcName(from) || !obj(rawFrom)) return null;
    const to: TcTo[] = [];
    for (const [t, rawTo] of Object.entries(obj(rawFrom.to) ? rawFrom.to : {})) {
      if (!isTcName(t)) return null;
      const r = obj(rawTo) ? rawTo : {};
      to.push({ to: t, offset: num(r.offset, 0), max: num(r.max, 1), scale: num(r.scale, 1) });
    }
    if (to.length) properties.push({ from, offset: num(rawFrom.offset, 0), to });
  }
  const mixX = num(c.mixX, 1), mixScaleX = num(c.mixScaleX, 1);
  const tc: TransformConstraint = {
    id: newTcId(), name: String(c.name), boneIds: targets.map((b) => b!.id), sourceId: source.id,
    mix: { rotate: num(c.mixRotate, 1), x: mixX, y: num(c.mixY, mixX), scaleX: mixScaleX, scaleY: num(c.mixScaleY, mixScaleX), shearY: num(c.mixShearY, 1) },
    properties,
  };
  const offsets: Partial<Record<TcChannel, number>> = {};
  const offsetField: Record<TcChannel, string> = { rotate: "rotation", x: "x", y: "y", scaleX: "scaleX", scaleY: "scaleY", shearY: "shearY" };
  for (const ch of TC_NAMES) if (num(c[offsetField[ch]], 0)) offsets[ch] = num(c[offsetField[ch]], 0);
  if (Object.keys(offsets).length) tc.offsets = offsets;
  for (const f of ["localSource", "localTarget", "additive", "clamp"] as const) if (c[f] === true) tc[f] = true;
  const rest = pick(c, (k) => !TC_FIELDS.has(k));
  if (rest) tc.spine = rest;
  return tc;
}
/** A Spine `transform` timeline as the document's keys, or null when a key
 *  falls between frames or a curve's six halves are not one cubic. */
export function transformKeysOf(list: unknown[], rate: number): TcKey[] | null {
  const keys: TcKey[] = [];
  const mixesOf = (r: BoneBurstRaw) => {
    const x = num(r.mixX, 1), sx = num(r.mixScaleX, 1);
    return { rotate: num(r.mixRotate, 1), x, y: num(r.mixY, x), scaleX: sx, scaleY: num(r.mixScaleY, 1), shearY: num(r.mixShearY, 1) };
  };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!obj(r)) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    const key: TcKey = { frame: Math.round(at), mix: mixesOf(r) };
    const next = list[i + 1];
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && obj(next)) {
      const c = r.curve.map((v) => num(v, 0));
      const t0 = num(r.time, 0), span = num(next.time, 0) - t0;
      if (span <= 0 || c.length < 24) return null;
      const to = mixesOf(next);
      let shape: number[] | null = null;
      for (const [n, ch] of TC_NAMES.entries()) {
        const v0 = key.mix[ch], dv = to[ch] - v0, at4 = n * 4;
        if (Math.abs(dv) <= 1e-9) {
          if (Math.abs(c[at4 + 1]! - v0) > 1e-6 || Math.abs(c[at4 + 3]! - v0) > 1e-6) return null;
          continue;
        }
        const h = [(c[at4]! - t0) / span, (c[at4 + 1]! - v0) / dv, (c[at4 + 2]! - t0) / span, (c[at4 + 3]! - v0) / dv].map((v) => v + 0);
        if (shape && shape.some((v, j) => Math.abs(v - h[j]!) > 1e-4)) return null;
        shape ??= h;
      }
      if (shape) key.tween = { kind: "curve", curve: shape };
    }
    keys.push(key);
  }
  return keys.length && new Set(keys.map((x) => x.frame)).size === keys.length ? keys : null;
}
export function ikOf(c: BoneBurstRaw, bones: Map<string, Node>, warn: (m: string) => void): IkConstraint | null {
  const names = Array.isArray(c.bones) ? c.bones.map(String) : [];
  const chain = names.map((n) => bones.get(n));
  const target = str(c.target) ? bones.get(c.target) : undefined;
  if (!target || chain.length < 1 || chain.length > 2 || chain.some((b) => !b)) {
    warn(`IK "${String(c.name)}" does not name its bones as Spine 4.3 does; it is carried as it came.`);
    return null;
  }
  if (chain.length === 2 && chain[1]!.parentId !== chain[0]!.id) return null;
  const ik: IkConstraint = {
    id: newIkId(),
    name: String(c.name),
    boneId: chain[chain.length - 1]!.id,
    targetId: target.id,
    chain: chain.length === 2 ? 1 : 0,
    bendPositive: c.bendPositive === false,
    weight: num(c.mix, 1),
  };
  if (num(c.softness, 0) > 0) ik.softness = num(c.softness, 0);
  if (c.stretch === true) ik.stretch = true;
  if (c.compress === true) ik.compress = true;
  // The runtime reads any other scaleY as none.
  if (c.scaleY === "uniform" || c.scaleY === "volume") ik.scaleY = c.scaleY;
  const rest = pick(c, (k) => !IK_FIELDS.has(k));
  if (rest) ik.spine = rest;
  return ik;
}
export const IK_FIELDS = new Set(["type", "name", "bones", "target", "mix", "bendPositive", "softness", "stretch", "compress", "scaleY"]);
