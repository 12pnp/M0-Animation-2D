import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { channelValues, keyTime, keysAt, shortFloat, type TimelinePath } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { onAnimation, withKeys } from "./keys";

/**
 * FramePath's handles and speeds (docs/FRAMEPATH-SPEED-PLAN.md, steps 1–5). Each translate key has a handle out (into the span after
 * it) and a handle in (from the span before), vectors in the bone's translate units. A span is written with its time handles at a third
 * and two thirds and its value handles at `key + out` and `next + in` on x and y: both channels then share one parameter, so the span is
 * exactly the 2D Bezier of those four points. The speed at a side is the handle's length over a third of that span's chord, minus 1:
 * speed s means the bone moves 1 + s times as fast as the span's even pace there. Handles on the chord at a third are the straight,
 * even line, written as no curve.
 */

export type Vec = readonly [number, number];

const translatePath = (bone: string): TimelinePath => ({ section: "bones", owner: bone, timeline: "translate" });

/** The bone's combined translate keys in the animation, or null when it keys translate as split x and y (not handled). */
export function translateNodes(a: Animation, bone: string): readonly Key[] | null {
  const split = ["translatex", "translatey"].some((t) => (keysAt(a, { section: "bones", owner: bone, timeline: t })?.length ?? 0) > 0);
  if (split) return null;
  return keysAt(a, translatePath(bone)) ?? [];
}

const place = (bone: string, k: Key): Vec => {
  const v = channelValues(translatePath(bone), k, "start");
  return [v[0]!, v[1]!];
};
const len = (v: Vec): number => Math.hypot(v[0], v[1]);
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0;

/** The handles of the span from `k` to `next` (out of `k`, into `next`); null for a stepped span. A straight span's are on its chord at a third. */
export function spanHandles(bone: string, k: Key, next: Key): { out: Vec; in: Vec } | null {
  if (k.curve === "stepped") return null;
  const a = place(bone, k), b = place(bone, next), t0 = keyTime(k), dt = keyTime(next) - t0;
  const third: { out: Vec; in: Vec } = { out: [(b[0] - a[0]) / 3, (b[1] - a[1]) / 3], in: [(a[0] - b[0]) / 3, (a[1] - b[1]) / 3] };
  if (!Array.isArray(k.curve) || k.curve.length < 8 || dt <= 0) return third;
  const c = k.curve as readonly number[], out: number[] = [], into: number[] = [];
  for (let ch = 0; ch < 2; ch++) {
    // A handle whose time is not at the third reads as the velocity it gives: its value offset scaled to a time offset of a third.
    const u1 = (c[ch * 4]! - t0) / dt, u2 = (c[ch * 4 + 2]! - t0) / dt;
    const o = c[ch * 4 + 1]! - a[ch]!, i = c[ch * 4 + 3]! - b[ch]!;
    out.push(u1 > 1e-9 ? o / (3 * u1) : o);
    into.push(1 - u2 > 1e-9 ? i / (3 * (1 - u2)) : i);
  }
  // The times are stored as short floats, so a third is not exactly a third: a handle reads back to four places.
  return { out: [r4(out[0]!), r4(out[1]!)], in: [r4(into[0]!), r4(into[1]!)] };
}

/** A handle's speed over a span's chord: |handle| ÷ (|chord| ÷ 3) − 1; 0 on a span that does not move. */
function speedOf(handle: Vec, chord: number): number {
  return chord > 1e-9 ? r4(len(handle) / (chord / 3) - 1) : 0;
}

/** The speed at the start and the end of the span from `k` to `next`; null for a stepped span. */
export function spanEnds(bone: string, k: Key, next: Key): { start: number; end: number } | null {
  const h = spanHandles(bone, k, next);
  if (!h) return null;
  const a = place(bone, k), b = place(bone, next), chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { start: speedOf(h.out, chord), end: speedOf(h.in, chord) };
}

/** Each key's speed: where the bone leaves it (the last key: where it arrives); null where that span is stepped. */
export function keySpeeds(bone: string, keys: readonly Key[]): (number | null)[] {
  return keys.map((k, i) => {
    const next = keys[i + 1];
    if (next) return spanEnds(bone, k, next)?.start ?? null;
    const prev = keys[i - 1];
    return prev ? spanEnds(bone, prev, k)?.end ?? null : 0;
  });
}

/** Each key's speed arriving (`in`, null on the first key or after a stepped span) and leaving (`out`, null on the last key or into a stepped span). */
export function keySpeedPairs(bone: string, keys: readonly Key[]): { in: number | null; out: number | null }[] {
  return keys.map((k, i) => {
    const prev = keys[i - 1], next = keys[i + 1];
    return { in: prev ? spanEnds(bone, prev, k)?.end ?? null : null, out: next ? spanEnds(bone, k, next)?.start ?? null : null };
  });
}

/** Each key's handles: `in` (null on the first key or after a stepped span) and `out` (null on the last key or into a stepped span). */
export function keyHandles(bone: string, keys: readonly Key[]): { in: Vec | null; out: Vec | null }[] {
  return keys.map((k, i) => {
    const prev = keys[i - 1], next = keys[i + 1];
    return { in: prev ? spanHandles(bone, prev, k)?.in ?? null : null, out: next ? spanHandles(bone, k, next)?.out ?? null : null };
  });
}

/** Each key's chords: to it from the key before (`in`) and from it to the key after (`out`), null at the ends. */
export function keyChords(bone: string, keys: readonly Key[]): { in: Vec | null; out: Vec | null }[] {
  return keys.map((k, i) => {
    const here = place(bone, k), prev = keys[i - 1], next = keys[i + 1];
    const to = (o: Key | undefined, from: Vec, at: Vec): Vec | null => (o ? [at[0] - from[0], at[1] - from[1]] : null);
    return { in: to(prev, prev ? place(bone, prev) : here, here), out: to(next, here, next ? place(bone, next) : here) };
  });
}

/** The span's speed across its time, `n` + 1 samples from its start to its end ({ t: seconds, v: speed }); [] for a stepped span. */
export function spanSpeedSamples(bone: string, k: Key, next: Key, n: number): { t: number; v: number }[] {
  if (k.curve === "stepped") return [];
  const a = place(bone, k), b = place(bone, next), t0 = keyTime(k), dt = keyTime(next) - t0, chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const c = Array.isArray(k.curve) && k.curve.length >= 8 ? (k.curve as readonly number[]) : null, out: { t: number; v: number }[] = [];
  for (let j = 0; j <= n; j++) {
    const u = j / n, t = t0 + u * dt;
    if (chord <= 1e-9 || dt <= 0) { out.push({ t, v: 0 }); continue; }
    const vx = c ? channelRate(c, 0, t0, dt, a[0], b[0], u) : (b[0] - a[0]) / dt, vy = c ? channelRate(c, 1, t0, dt, a[1], b[1], u) : (b[1] - a[1]) / dt;
    out.push({ t, v: Math.hypot(vx, vy) / (chord / dt) - 1 });
  }
  return out;
}

/** Channel `ch`'s rate of change (units a second) at the span's time `u` (0..1): its Bezier's s found by bisection on time. */
function channelRate(c: readonly number[], ch: number, t0: number, dt: number, v0: number, v1: number, u: number): number {
  const u1 = (c[ch * 4]! - t0) / dt, u2 = (c[ch * 4 + 2]! - t0) / dt, w1 = c[ch * 4 + 1]!, w2 = c[ch * 4 + 3]!;
  const at = (p0: number, p1: number, p2: number, p3: number, s: number): number => (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3 * p3;
  const d = (p0: number, p1: number, p2: number, p3: number, s: number): number => 3 * (1 - s) ** 2 * (p1 - p0) + 6 * (1 - s) * s * (p2 - p1) + 3 * s * s * (p3 - p2);
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (at(0, u1, u2, 1, mid) < u) lo = mid; else hi = mid; }
  const s = (lo + hi) / 2, du = d(0, u1, u2, 1, s);
  return du > 1e-9 ? d(v0, w1, w2, v1, s) / du / dt : 0;
}

/** The span's curve for its handles: none when both lie on the chord at a third (the straight, even line). */
function curveFor(a: Vec, b: Vec, t0: number, t1: number, out: Vec, into: Vec): number[] | undefined {
  const near = (h: Vec, w: Vec): boolean => Math.abs(h[0] - w[0]) <= 1e-4 && Math.abs(h[1] - w[1]) <= 1e-4;
  const chord: Vec = [b[0] - a[0], b[1] - a[1]];
  if (near(out, [chord[0] / 3, chord[1] / 3]) && near(into, [-chord[0] / 3, -chord[1] / 3])) return undefined;
  const dt = t1 - t0, curve: number[] = [];
  for (let ch = 0; ch < 2; ch++) curve.push(shortFloat(t0 + dt / 3), shortFloat(a[ch]! + out[ch]!), shortFloat(t1 - dt / 3), shortFloat(b[ch]! + into[ch]!));
  return curve;
}

/** The handles at the bone's translate key `index` set: `in` shapes the span before it, `out` the span after; a side left out keeps its span as it was. */
export function setKeyHandles(animation: string, bone: string, index: number, handles: { in?: Vec | undefined; out?: Vec | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([handles.in, handles.out].some((h) => h !== undefined && !(Number.isFinite(h[0]) && Number.isFinite(h[1])))) throw new EditRefused("A handle must be two numbers.");
    return onAnimation(animation, (a) => {
      const keys = translateNodes(a, bone);
      if (keys === null) throw new EditRefused(`${bone} keys translate as separate x and y: FramePath needs the combined translate keys.`);
      if (!(index >= 0 && index < keys.length)) throw new EditRefused(`${bone} has no translate key ${index + 1} in ${animation}.`);
      if (keys.length < 2) throw new EditRefused(`${bone} has one translate key in ${animation}: a handle needs a span to the next key.`);
      const next = keys.map((k, j) => {
        const after = keys[j + 1];
        // Only the spans a given side touches: the one before for `in`, the one after for `out`.
        if (!after || !((j === index && handles.out !== undefined) || (j === index - 1 && handles.in !== undefined))) return k;
        // A stepped span's other side starts from the straight line.
        const { curve: _, ...rest } = k, was = spanHandles(bone, k, after) ?? spanHandles(bone, rest as Key, after)!;
        const out = j === index ? handles.out ?? was.out : was.out, into = j + 1 === index ? handles.in ?? was.in : was.in;
        const curve = curveFor(place(bone, k), place(bone, after), keyTime(k), keyTime(after), out, into);
        return (curve ? { ...rest, curve } : rest) as Key;
      });
      return withKeys(a, translatePath(bone), next);
    })(doc);
  };
}

/** A handle with the length for `speed` over a span's chord, along `dir` (or along `fallback` when `dir` has no length). */
function handleFor(speed: number, chord: Vec, dir: Vec | null, fallback: Vec): Vec {
  const c = len(chord), d = dir && len(dir) > 1e-9 ? dir : fallback, l = len(d);
  if (c <= 1e-9 || l <= 1e-9) return [0, 0];
  const k = ((1 + speed) * c) / 3 / l;
  return [d[0] * k, d[1] * k];
}

/**
 * The speed at the bone's translate key `index` set, on both sides: the span before it ends at that speed and the span after it
 * starts at it; each span's other end keeps the speed it had (a stepped span's other end: 0).
 */
export function setTranslateKeySpeed(animation: string, bone: string, index: number, speed: number): Edit<Skeleton> {
  return setTranslateKeySpeeds(animation, bone, index, { in: speed, out: speed });
}

/** The speed arriving at (`in`) and leaving (`out`) the bone's translate key `index`: each handle's length, its direction kept; a side left out keeps what it has. */
export function setTranslateKeySpeeds(animation: string, bone: string, index: number, speeds: { in?: number | undefined; out?: number | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([speeds.in, speeds.out].some((v) => v !== undefined && !Number.isFinite(v))) throw new EditRefused("A speed must be a number.");
    const a = doc.animations?.find((x) => x.name === animation), keys = a ? translateNodes(a, bone) : null, k = keys?.[index];
    // No such key: setKeyHandles gives the refusal.
    if (!keys || !k || keys.length < 2) return setKeyHandles(animation, bone, index, { out: [0, 0] })(doc);
    const h = keyHandles(bone, keys)[index]!, c = keyChords(bone, keys)[index]!, handles: { in?: Vec; out?: Vec } = {};
    if (speeds.out !== undefined && c.out) handles.out = handleFor(speeds.out, c.out, h.out, c.out);
    if (speeds.in !== undefined && c.in) handles.in = handleFor(speeds.in, c.in, h.in, [-c.in[0], -c.in[1]]);
    return setKeyHandles(animation, bone, index, handles)(doc);
  };
}
