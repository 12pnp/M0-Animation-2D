import { readPolyline, boneburstPolyline, type TweenSpec } from "@/core/math/easing";
import { deleteKeys, keySpan, moveKeys, withKeyAt, withKeyTween } from "./keyList";
import type { CnId, NodeId } from "./ids";
import { PATH_DEFAULTS, PHYSICS_DEFAULTS } from "./constraints";
import type { Animation, PathConstraint, PhysicsConstraint, SliderConstraint, SymbolItem, ValueKey } from "./types";
import { keyTime } from "@/core/boneburst/transform";

/**
 * Keys of physics, slider and path constraints (ARCHITECTURE ▸ Physics,
 * sliders and paths), pure. Each keyable value of a constraint is a channel
 * of one-number keys, as Spine's `physics`, `slider` and `path` timelines are.
 * Before a channel's first key the constraint's own value holds; from a key
 * on it tweens to the next by the key's tween.
 */

export type ConstraintKeyKind = "physics" | "slider" | "path";

export const CONSTRAINT_CHANNELS = {
  physics: ["mix", "inertia", "strength", "damping", "mass", "wind", "gravity"],
  slider: ["time", "mix"],
  // A path's "mix" is its three mixes keyed together (Spine's one `mix` timeline).
  path: ["position", "spacing", "mix"],
} as const satisfies Record<ConstraintKeyKind, readonly string[]>;

export type KeyedConstraint =
  | { kind: "physics"; k: PhysicsConstraint }
  | { kind: "slider"; k: SliderConstraint }
  | { kind: "path"; k: PathConstraint };

/** The symbol's constraint with this id, with its kind. */
export function keyedConstraint(sym: SymbolItem, id: CnId): KeyedConstraint | null {
  const p = sym.physics?.find((k) => k.id === id);
  if (p) return { kind: "physics", k: p };
  const s = sym.sliders?.find((k) => k.id === id);
  if (s) return { kind: "slider", k: s };
  const q = sym.paths?.find((k) => k.id === id);
  return q ? { kind: "path", k: q } : null;
}

/** The channel a constraint field keys, or null when the field is not keyable
 *  (a path's three mixes key together). */
export function channelOf(kind: ConstraintKeyKind, field: string): string | null {
  if (kind === "path" && (field === "mixRotate" || field === "mixX" || field === "mixY")) return "mix";
  return (CONSTRAINT_CHANNELS[kind] as readonly string[]).includes(field) ? field : null;
}

/** The bone a constraint's row sits under: physics and a slider's bone, a
 *  path's first bone; null for a slider without one. */
export function constraintHost(c: KeyedConstraint): NodeId | null {
  return c.kind === "path" ? c.k.boneIds[0] ?? null : c.k.boneId ?? null;
}

/** The constraint's own value of a channel: what holds before its first key. */
export function setupValue(c: KeyedConstraint, channel: string): number {
  switch (c.kind) {
    case "physics": {
      const ch = channel as keyof typeof PHYSICS_DEFAULTS;
      return c.k[ch] ?? PHYSICS_DEFAULTS[ch];
    }
    case "slider": return channel === "time" ? c.k.time ?? 0 : c.k.mix ?? 1;
    case "path": return channel === "position" ? c.k.position ?? PATH_DEFAULTS.position
      : channel === "spacing" ? c.k.spacing ?? PATH_DEFAULTS.spacing : c.k.mixRotate ?? 1;
  }
}

/** A channel's value at `frame` (fractional between frames). */
export function valueAt(keys: readonly ValueKey[] | undefined, frame: number, setup: number): number {
  const s = keySpan(keys, frame);
  if (!s) return setup;
  const { a, b, e } = s;
  return b ? a.value + (b.value - a.value) * e : a.value;
}

/** The channel's keys in `anim`. */
export function channelKeysOf(anim: Animation | null | undefined, id: CnId, channel: string): ValueKey[] {
  return anim?.constraintKeys?.[id]?.[channel] ?? [];
}

/** `keys` with `value` keyed at `frame`; a key there keeps its tween. */
export function withValueKey(keys: readonly ValueKey[], frame: number, value: number): ValueKey[] {
  return withKeyAt(keys, frame, (at): ValueKey => ({ ...at, frame, value }));
}

/** `anim.constraintKeys` with one channel's keys replaced; empty lists drop out. */
export function withChannelKeys(
  all: Animation["constraintKeys"], id: CnId, channel: string, keys: readonly ValueKey[],
): Animation["constraintKeys"] {
  const own = { ...all?.[id] };
  if (keys.length) own[channel] = [...keys]; else delete own[channel];
  const out = { ...all };
  if (Object.keys(own).length) out[id] = own; else delete out[id];
  return Object.keys(out).length ? out : undefined;
}

/** The frames any channel of the constraint keys, sorted: its row's diamonds. */
export function constraintKeyFrames(anim: Animation | null | undefined, id: CnId): number[] {
  const frames = new Set<number>();
  for (const keys of Object.values(anim?.constraintKeys?.[id] ?? {})) for (const k of keys) frames.add(k.frame);
  return [...frames].sort((a, b) => a - b);
}

/** Every channel of the constraint with its keys at `frames` moved by `delta`
 *  (not before 0), replacing keys they land on. */
export function moveConstraintKeys(all: Animation["constraintKeys"], id: CnId, frames: readonly number[], delta: number): Animation["constraintKeys"] {
  let out = all;
  for (const [channel, keys] of Object.entries(all?.[id] ?? {})) out = withChannelKeys(out, id, channel, moveKeys(keys, frames, delta));
  return out;
}

/** Every channel of the constraint without its keys at `frames`. */
export function deleteConstraintKeys(all: Animation["constraintKeys"], id: CnId, frames: readonly number[]): Animation["constraintKeys"] {
  let out = all;
  for (const [channel, keys] of Object.entries(all?.[id] ?? {})) out = withChannelKeys(out, id, channel, deleteKeys(keys, frames));
  return out;
}

/** Every channel's key at each of `frames` tweening by `tween` (none: linear). */
export function withConstraintTween(all: Animation["constraintKeys"], id: CnId, frames: readonly number[], tween: TweenSpec | undefined): Animation["constraintKeys"] {
  let out = all;
  for (const [channel, keys] of Object.entries(all?.[id] ?? {})) out = withChannelKeys(out, id, channel, withKeyTween(keys, frames, tween));
  return out;
}

/* ── to and from Spine ── */

type Raw = Record<string, unknown>;

/** One channel as Spine's timeline: every key writes its value (a physics
 *  channel reads a missing one as 0); a path's mix writes the three mixes. */
export function channelTimeline(keys: readonly ValueKey[], fps: number, pathMix = false): Raw[] {
  return keys.map((key, i) => {
    const o: Raw = {};
    const time = keyTime(key.frame, fps);
    if (time) o.time = time;
    if (pathMix) { o.mixRotate = key.value; o.mixX = key.value; o.mixY = key.value; } else o.value = key.value;
    const next = keys[i + 1];
    if (next && key.tween?.kind === "none") o.curve = "stepped";
    else if (next && key.tween?.kind === "curve") {
      const [x1, y1, x2, y2] = key.tween.curve as [number, number, number, number];
      const t0 = key.frame / fps, span = (next.frame - key.frame) / fps, dv = next.value - key.value;
      const one = [t0 + x1 * span, key.value + y1 * dv, t0 + x2 * span, key.value + y2 * dv];
      o.curve = pathMix ? [...one, ...one, ...one] : one;
    }
    return o;
  });
}

/**
 * A file's channel timeline as keys, or null when a key falls between frames,
 * a path key's three mixes differ, or a curve's halves are not one cubic
 * (then the timeline stays carried). `missing`: what a key without a value reads as.
 */
export function channelKeysFromBoneBurst(raw: unknown, fps: number, missing: number, pathMix = false): ValueKey[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const valueOf = (r: Raw): number | null => {
    if (!pathMix) return num(r.value, missing);
    const rot = num(r.mixRotate, 1), x = num(r.mixX, 1), y = num(r.mixY, x);
    return Math.abs(rot - x) > 1e-9 || Math.abs(x - y) > 1e-9 ? null : rot;
  };
  const keys: ValueKey[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Raw;
    if (!r || typeof r !== "object") return null;
    const at = num(r.time, 0) * fps;
    if (Math.abs(at - Math.round(at)) > 1e-3) return null;
    const value = valueOf(r);
    if (value === null) return null;
    const key: ValueKey = { frame: Math.round(at), value };
    const next = raw[i + 1] as Raw | undefined;
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && next) {
      const c = r.curve.map((v) => num(v, 0));
      const t0 = num(r.time, 0), span = num(next.time, 0) - t0;
      const v1 = valueOf(next);
      if (span <= 0 || c.length < 4 || v1 === null) return null;
      if (pathMix && (c.length < 12 || [4, 8].some((o) => c.slice(o, o + 4).some((v, j) => Math.abs(v - c[j]!) > 1e-6)))) return null;
      const dv = v1 - value;
      if (Math.abs(dv) > 1e-9) key.tween = { kind: "curve", curve: [(c[0]! - t0) / span, (c[1]! - value) / dv, (c[2]! - t0) / span, (c[3]! - value) / dv] };
      else if (Math.abs(c[1]! - value) > 1e-6 || Math.abs(c[3]! - value) > 1e-6) return null;
    }
    keys.push(key);
  }
  return new Set(keys.map((k) => k.frame)).size === keys.length ? keys : null;
}

/**
 * A file's channel with a key between frames, written frame by frame: Spine's
 * value at every whole frame from the first key on to the frame after the
 * last, straight between (as bone keys are, `importKeys`). Exact at every
 * frame. Null when it is not a channel.
 */
export function bakedChannelKeys(raw: unknown, fps: number, missing: number, pathMix = false): ValueKey[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const valueOf = (r: Raw): number | null => {
    if (!pathMix) return num(r.value, missing);
    const rot = num(r.mixRotate, 1), x = num(r.mixX, 1), y = num(r.mixY, x);
    return Math.abs(rot - x) > 1e-9 || Math.abs(x - y) > 1e-9 ? null : rot;
  };
  // Times in frames; a curve's controls too.
  const keys: Array<{ at: number; value: number; curve: null | "stepped" | number[] }> = [];
  for (const r of raw as Raw[]) {
    if (!r || typeof r !== "object") return null;
    const value = valueOf(r);
    if (value === null) return null;
    const at = num(r.time, 0) * fps;
    if (keys.length && at <= keys[keys.length - 1]!.at) return null;
    let curve: null | "stepped" | number[] = null;
    if (r.curve === "stepped") curve = "stepped";
    else if (Array.isArray(r.curve)) {
      const c = r.curve.map((v) => num(v, 0));
      if (c.length < 4 || (pathMix && (c.length < 12 || [4, 8].some((o) => c.slice(o, o + 4).some((v, j) => Math.abs(v - c[j]!) > 1e-6))))) return null;
      curve = [c[0]! * fps, c[1]!, c[2]! * fps, c[3]!];
    }
    keys.push({ at, value, curve });
  }
  const valueAtFrame = (f: number): number => {
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1]!.at <= f + 1e-6) i++;
    const a = keys[i]!, b = keys[i + 1];
    if (!b || a.curve === "stepped" || f <= a.at) return a.value;
    if (!a.curve) return a.value + ((b.value - a.value) * (f - a.at)) / (b.at - a.at);
    const [c1x, c1y, c2x, c2y] = a.curve as [number, number, number, number];
    return readPolyline(boneburstPolyline({ x0: a.at, y0: a.value, c1x, c1y, c2x, c2y, x1: b.at, y1: b.value }), f);
  };
  const first = Math.ceil(keys[0]!.at - 1e-3) || 0, last = Math.ceil(keys[keys.length - 1]!.at - 1e-3) || 0;
  const out: ValueKey[] = [];
  for (let f = first; f <= last; f++) out.push({ frame: f, value: valueAtFrame(f) });
  return out;
}

/** Keys loaded from a file: constraints the symbol has, their channels, whole
 *  frames, finite values, one per frame, tweens kept when well formed. */
export function sanitizeConstraintKeys(raw: unknown, sym: SymbolItem): Animation["constraintKeys"] {
  if (!raw || typeof raw !== "object") return undefined;
  let out: Animation["constraintKeys"];
  for (const [id, channels] of Object.entries(raw as Record<string, unknown>)) {
    const c = keyedConstraint(sym, id as CnId);
    if (!c || !channels || typeof channels !== "object") continue;
    for (const [channel, list] of Object.entries(channels as Record<string, unknown>)) {
      if (!(CONSTRAINT_CHANNELS[c.kind] as readonly string[]).includes(channel) || !Array.isArray(list)) continue;
      const byFrame = new Map<number, ValueKey>();
      for (const k of list as Raw[]) {
        if (!k || typeof k.frame !== "number" || !Number.isFinite(k.frame) || k.frame < 0 || typeof k.value !== "number" || !Number.isFinite(k.value)) continue;
        const key: ValueKey = { frame: Math.round(k.frame), value: k.value };
        const t = k.tween as TweenSpec | undefined;
        if (t?.kind === "none") key.tween = { kind: "none" };
        else if (t?.kind === "curve" && Array.isArray(t.curve) && t.curve.length === 4 && t.curve.every((v) => Number.isFinite(v))) key.tween = { kind: "curve", curve: [...t.curve] };
        byFrame.set(key.frame, key);
      }
      out = withChannelKeys(out, id as CnId, channel, [...byFrame.values()].sort((a, b) => a.frame - b.frame));
    }
  }
  return out;
}
