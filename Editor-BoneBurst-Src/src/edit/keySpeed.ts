import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { channelValues, keyTime, keysAt, shortFloat, type TimelinePath } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { onAnimation, withKeys } from "./keys";

/**
 * FramePath's handles and speeds (docs/FRAMEPATH-SPEED-PLAN.md, steps 1–8). Each translate key has a handle out (into the span after
 * it) and a handle in (from the span before), vectors in the bone's translate units: the span's value handles are `key + out` and
 * `next + in` on x and y. Both channels share the span's two time handles, so x and y share one parameter and the bone follows exactly
 * the 2D Bezier of those four points, whatever the time handles are: the value handles are the path's shape, the time handles its
 * speed (step 8), and neither moves the other. Speed s at a side means the bone moves 1 + s times as fast as the span's even pace there:
 * on a curved span the pace along its path, from the time handles alone, so a shape never changes a speed (step 9); on a straight span
 * the velocity, which is the same thing there.
 */

export type Vec = readonly [number, number];

/** A key's speed is held between these, so the multiplier `1 + speed` is never 0. */
export const SPEED_MIN = -0.99;
export const SPEED_MAX = 5;

/** A speed value held to its range, to four places. */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) * 1e4) / 1e4;
}

/** A straight span's reach (its time handle, a share of the span): the least, and where a span with no curve has it. */
export const REACH_MIN = 0.02;
export const REACH_PLAIN = 1 / 3;

/** The multiplier a speed value makes: 0.01 to 6. */
export const multiplierOf = (speed: number): number => 1 + clampSpeed(speed);

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

/** A span's ends: places, times, chord. */
interface Span { readonly a: Vec; readonly b: Vec; readonly t0: number; readonly dt: number; readonly chord: Vec; readonly cl: number }

function spanOf(bone: string, k: Key, next: Key): Span {
  const a = place(bone, k), b = place(bone, next), chord: Vec = [b[0] - a[0], b[1] - a[1]];
  return { a, b, t0: keyTime(k), dt: keyTime(next) - keyTime(k), chord, cl: len(chord) };
}

const curveOf = (k: Key): readonly number[] | null => (Array.isArray(k.curve) && k.curve.length >= 8 ? (k.curve as readonly number[]) : null);

/** The path's handles of the span from `k` to `next` (out of `k`, into `next`): its value handles less the keys; null for a stepped span. A straight span's are on its chord at a third. */
export function spanHandles(bone: string, k: Key, next: Key): { out: Vec; in: Vec } | null {
  if (k.curve === "stepped") return null;
  const sp = spanOf(bone, k, next), c = curveOf(k);
  if (!c) return { out: [r4(sp.chord[0] / 3), r4(sp.chord[1] / 3)], in: [r4(-sp.chord[0] / 3), r4(-sp.chord[1] / 3)] };
  return { out: [r4(c[1]! - sp.a[0]), r4(c[5]! - sp.a[1])], in: [r4(c[3]! - sp.b[0]), r4(c[7]! - sp.b[1])] };
}

/** The speed at the start and the end of the span from `k` to `next`: the velocity its handles give there over the even pace; null for a stepped span. */
export function spanEnds(bone: string, k: Key, next: Key): { start: number; end: number } | null {
  if (k.curve === "stepped") return null;
  const sp = spanOf(bone, k, next), c = curveOf(k);
  if (!c || sp.cl <= 1e-9 || sp.dt <= 0) return { start: 0, end: 0 };
  // A curved span's speed is the rate along its path, from the time handles alone (step 9): its shape never changes it.
  if (!isStraight(bone, k, next)) {
    const [u1, u2] = timeHandles(c, sp), rate = (u: number): number => (u > 1e-9 ? 1 / (3 * u) : 1 + SPEED_MAX);
    return { start: r4(rate(u1) - 1), end: r4(rate(1 - u2) - 1) };
  }
  const pace = sp.cl / sp.dt, t1 = sp.t0 + sp.dt;
  // Each channel's slope at the end of its handle; a handle with no time length is as fast as the speed range allows.
  const rate = (dv: number, dtime: number): number => (dtime > 1e-9 ? dv / dtime : Math.sign(dv) * pace * (1 + SPEED_MAX));
  const start = Math.hypot(rate(c[1]! - sp.a[0], c[0]! - sp.t0), rate(c[5]! - sp.a[1], c[4]! - sp.t0));
  const end = Math.hypot(rate(sp.b[0] - c[3]!, t1 - c[2]!), rate(sp.b[1] - c[7]!, t1 - c[6]!));
  return { start: r4(start / pace - 1), end: r4(end / pace - 1) };
}

/** A curve's time handles as fractions of its span (0..1), x's and y's averaged (a file of ours writes them equal). */
function timeHandles(c: readonly number[], sp: Span): [number, number] {
  return [((c[0]! + c[4]!) / 2 - sp.t0) / sp.dt, ((c[2]! + c[6]!) / 2 - sp.t0) / sp.dt];
}

/** Whether the span from `k` to `next` is a straight line: both its path handles along its chord (a stepped span is not). */
export function isStraight(bone: string, k: Key, next: Key): boolean {
  const h = spanHandles(bone, k, next), sp = spanOf(bone, k, next);
  return !!h && sp.cl > 1e-9 && alongChord(h.out, sp.chord, 1, sp.cl) && alongChord(h.in, sp.chord, -1, sp.cl);
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

/**
 * Each key's reach arriving (`in`) and leaving (`out`), a share of that span's time (step 10): how far into the span the key's speed
 * lasts. Only a straight span has one (on a curved span the time handle is the speed); null on a curved, stepped or missing span.
 */
export function keyReaches(bone: string, keys: readonly Key[]): { in: number | null; out: number | null }[] {
  const reach = (k: Key, next: Key, end: 0 | 1): number | null => {
    if (k.curve === "stepped" || !isStraight(bone, k, next)) return null;
    const sp = spanOf(bone, k, next), c = curveOf(k);
    if (sp.dt <= 0) return null;
    if (!c) return REACH_PLAIN;
    const [u1, u2] = timeHandles(c, sp);
    return r4(end === 0 ? u1 : 1 - u2);
  };
  return keys.map((k, i) => {
    const prev = keys[i - 1], next = keys[i + 1];
    return { in: prev ? reach(prev, k, 1) : null, out: next ? reach(k, next, 0) : null };
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
  // A curved span: the rate along its path, the time curve's alone (step 9).
  if (c && chord > 1e-9 && dt > 0 && !isStraight(bone, k, next)) {
    const [u1, u2] = timeHandles(c, spanOf(bone, k, next));
    for (let j = 0; j <= n; j++) { const u = j / n, du = timeSlope(u1, u2, u); out.push({ t: t0 + u * dt, v: du > 1e-9 ? 1 / du - 1 : SPEED_MAX }); }
    return out;
  }
  for (let j = 0; j <= n; j++) {
    const u = j / n, t = t0 + u * dt;
    if (chord <= 1e-9 || dt <= 0) { out.push({ t, v: 0 }); continue; }
    const vx = c ? channelRate(c, 0, t0, dt, a[0], b[0], u) : (b[0] - a[0]) / dt, vy = c ? channelRate(c, 1, t0, dt, a[1], b[1], u) : (b[1] - a[1]) / dt;
    out.push({ t, v: Math.hypot(vx, vy) / (chord / dt) - 1 });
  }
  return out;
}

/** The slope of a span's time curve (0, u1, u2, 1) against its parameter where it reaches time `u` (0..1): 1 is the even pace. */
function timeSlope(u1: number, u2: number, u: number): number {
  const at = (s: number): number => 3 * (1 - s) ** 2 * s * u1 + 3 * (1 - s) * s * s * u2 + s ** 3;
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (at(mid) < u) lo = mid; else hi = mid; }
  const s = (lo + hi) / 2;
  return 3 * (1 - s) ** 2 * u1 + 6 * (1 - s) * s * (u2 - u1) + 3 * s * s * (1 - u2);
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

/** Whether a handle lies along the chord (`sign` 1: forwards from the start, -1: back from the end) and inside it: then the span's line is straight. */
export function alongChord(h: Vec, chord: Vec, sign: number, cl: number = len(chord)): boolean {
  const l = len(h);
  if (l <= 1e-9) return true;
  // Within a thousandth of a radian: handles are kept to four places, so a straight one is a hair off the chord.
  return Math.abs(h[0] * chord[1] - h[1] * chord[0]) <= 1e-3 * l * cl && sign * (h[0] * chord[0] + h[1] * chord[1]) > 0 && l <= cl * (1 + 1e-4) + 1e-4;
}

/**
 * The span's curve for its path handles and the speeds (multipliers `ms`, `me`) at its start and end: the value handles as given,
 * each time handle placed so the bone has that speed there (`u = |handle| ÷ (m · |chord|)`, held inside the span). A straight span's
 * handles are chosen with the speed (a third of the chord up to speed 2, then all of it), which keeps the line and lets every speed
 * fit. None when it is the straight line at an even pace.
 */
function spanCurve(sp: Span, out: Vec, into: Vec, ms: number, me: number, ro?: number, ri?: number): number[] | undefined {
  let o = out, i = into;
  const straight = sp.cl > 1e-9 && alongChord(out, sp.chord, 1, sp.cl) && alongChord(into, sp.chord, -1, sp.cl);
  if (straight) {
    // The handle's share of the chord: the speed times the reach (step 10), else a third of the chord up to speed 2, then all of it.
    const reachOf = (m: number, r: number | undefined): number => Math.min(1 / m, 1, Math.max(REACH_MIN, r ?? REACH_PLAIN));
    let uo = reachOf(ms, ro), ui = reachOf(me, ri);
    // The two reaches of a span cover it at most once (the time curve stays one way); the side not given gives way.
    if (uo + ui > 1) { if (ri === undefined || ro !== undefined) ui = Math.max(REACH_MIN, 1 - uo); else uo = Math.max(REACH_MIN, 1 - ui); }
    const part = (m: number, u: number): number => Math.min(1, m * u);
    o = [sp.chord[0] * part(ms, uo), sp.chord[1] * part(ms, uo)];
    i = [-sp.chord[0] * part(me, ui), -sp.chord[1] * part(me, ui)];
    if (Math.abs(ms - 1) <= 1e-6 && Math.abs(me - 1) <= 1e-6 && Math.abs(uo - REACH_PLAIN) <= 1e-6 && Math.abs(ui - REACH_PLAIN) <= 1e-6) return undefined;
  }
  // Straight: the velocity, |handle| ÷ (u · |chord|). Curved: the rate along the path, 1 ÷ (3 u), whatever the handles (step 9).
  const u = (h: Vec, m: number): number => (sp.cl <= 1e-9 ? 1 / 3 : Math.min(1, Math.max(1e-4, straight ? len(h) / (m * sp.cl) : 1 / (3 * m))));
  const ta = sp.t0 + u(o, ms) * sp.dt, tb = sp.t0 + sp.dt - u(i, me) * sp.dt, curve: number[] = [];
  if (sp.cl <= 1e-9 && len(o) <= 1e-9 && len(i) <= 1e-9) return undefined;
  for (let ch = 0; ch < 2; ch++) curve.push(shortFloat(ta), shortFloat(sp.a[ch]! + o[ch]!), shortFloat(tb), shortFloat(sp.b[ch]! + i[ch]!));
  return curve;
}

/** The translate keys with the spans key `index` touches rewritten: `out` (the span after) and `in` (the span before) give each its handles and speeds. */
function rewrite(animation: string, bone: string, index: number, touch: { in: boolean; out: boolean }, make: (k: Key, after: Key, j: number) => SpanNow): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    const keys = translateNodes(a, bone);
    if (keys === null) throw new EditRefused(`${bone} keys translate as separate x and y: FramePath needs the combined translate keys.`);
    if (!(index >= 0 && index < keys.length)) throw new EditRefused(`${bone} has no translate key ${index + 1} in ${animation}.`);
    if (keys.length < 2) throw new EditRefused(`${bone} has one translate key in ${animation}: a handle or a speed needs a span to the next key.`);
    const next = keys.map((k, j) => {
      const after = keys[j + 1];
      if (!after || !((j === index && touch.out) || (j === index - 1 && touch.in))) return k;
      const { curve: _, ...rest } = k, m = make(k, after, j), curve = spanCurve(spanOf(bone, k, after), m.out, m.in, m.ms, m.me, m.ro, m.ri);
      return (curve ? { ...rest, curve } : rest) as Key;
    });
    return withKeys(a, translatePath(bone), next);
  });
}

/** A span as an edit sees it: its path handles, the speed multipliers at its ends and, on a straight span, the reaches kept. */
interface SpanNow { out: Vec; in: Vec; ms: number; me: number; ro?: number | undefined; ri?: number | undefined }

/**
 * What a span has now: its path handles, the speed multipliers at its ends (a stepped span: the straight line at an even pace) and a
 * straight span's reaches. A handle at the whole chord was put there by a speed over 3, not by a reach: its reach is the usual one.
 */
function spanNow(bone: string, k: Key, after: Key): SpanNow {
  const { curve: _, ...plain } = k, h = spanHandles(bone, k, after) ?? spanHandles(bone, plain as Key, after)!, e = spanEnds(bone, k, after) ?? { start: 0, end: 0 };
  const now: SpanNow = { out: h.out, in: h.in, ms: 1 + clampSpeed(e.start), me: 1 + clampSpeed(e.end) };
  const c = curveOf(k), sp = spanOf(bone, k, after);
  if (c && k.curve !== "stepped" && sp.dt > 0 && isStraight(bone, k, after)) {
    const [u1, u2] = timeHandles(c, sp), full = (v: Vec): boolean => len(v) >= sp.cl * (1 - 1e-3);
    if (!full(h.out)) now.ro = u1;
    if (!full(h.in)) now.ri = 1 - u2;
  }
  return now;
}

/** The path's handles at the bone's translate key `index` set: `in` shapes the span before it, `out` the span after. The speeds stay; a side left out keeps its span as it was. */
export function setKeyHandles(animation: string, bone: string, index: number, handles: { in?: Vec | undefined; out?: Vec | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([handles.in, handles.out].some((h) => h !== undefined && !(Number.isFinite(h[0]) && Number.isFinite(h[1])))) throw new EditRefused("A handle must be two numbers.");
    return rewrite(animation, bone, index, { in: handles.in !== undefined, out: handles.out !== undefined }, (k, after, j) => {
      const now = spanNow(bone, k, after);
      return { ...now, out: j === index ? handles.out ?? now.out : now.out, in: j + 1 === index ? handles.in ?? now.in : now.in };
    })(doc);
  };
}

/**
 * The speed at the bone's translate key `index` set, on both sides: the span before it ends at that speed and the span after it
 * starts at it; each span's other end keeps the speed it had (a stepped span's other end: 0).
 */
export function setTranslateKeySpeed(animation: string, bone: string, index: number, speed: number): Edit<Skeleton> {
  return setTranslateKeySpeeds(animation, bone, index, { in: speed, out: speed });
}

/**
 * The reach arriving at (`in`) and leaving (`out`) the bone's translate key `index` (step 10): how far into each straight span its
 * speed lasts, a share of the span's time, held to REACH_MIN … min(1, 1 ÷ speed). The speeds and the line stay. A curved span has no
 * reach (its time handle is its speed): refused.
 */
export function setTranslateKeyReaches(animation: string, bone: string, index: number, reaches: { in?: number | undefined; out?: number | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([reaches.in, reaches.out].some((v) => v !== undefined && !Number.isFinite(v))) throw new EditRefused("A reach must be a number.");
    return rewrite(animation, bone, index, { in: reaches.in !== undefined, out: reaches.out !== undefined }, (k, after, j) => {
      if (k.curve === "stepped" || !isStraight(bone, k, after)) throw new EditRefused(`Key ${j === index ? index + 1 : index}'s span to key ${j === index ? index + 2 : index + 1} is curved or stepped: only a straight span has a reach (a curved span's time handle is its speed).`);
      const now = spanNow(bone, k, after), c = curveOf(k), [u1, u2] = c ? timeHandles(c, spanOf(bone, k, after)) : [REACH_PLAIN, 1 - REACH_PLAIN];
      // The side set wins over the other: held to what the other side leaves of the span.
      const out = j === index ? reaches.out : undefined, into = j + 1 === index ? reaches.in : undefined;
      return {
        ...now,
        ro: out !== undefined ? Math.min(out, 1 - (into ?? 1 - u2!)) : now.ro,
        ri: into !== undefined ? Math.min(into, 1 - (out ?? u1!)) : now.ri,
      };
    })(doc);
  };
}

/**
 * The speed arriving at (`in`) and leaving (`out`) the bone's translate key `index`, held to the range: the time handles move, the
 * path does not (step 8). On a curved span a speed slower than its handle allows comes out as the slowest it allows; a side left
 * out keeps what it has.
 */
export function setTranslateKeySpeeds(animation: string, bone: string, index: number, speeds: { in?: number | undefined; out?: number | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([speeds.in, speeds.out].some((v) => v !== undefined && !Number.isFinite(v))) throw new EditRefused("A speed must be a number.");
    return rewrite(animation, bone, index, { in: speeds.in !== undefined, out: speeds.out !== undefined }, (k, after, j) => {
      const now = spanNow(bone, k, after);
      return {
        ...now,
        ms: j === index && speeds.out !== undefined ? 1 + clampSpeed(speeds.out) : now.ms,
        me: j + 1 === index && speeds.in !== undefined ? 1 + clampSpeed(speeds.in) : now.me,
      };
    })(doc);
  };
}

/**
 * The bone's translate key `index` moved to `time` (docs/FRAMEPATH-SPEED-PLAN.md, step 16): its place and both spans' path handles stay,
 * so the path is the same; the span before and the span after keep their time handles at the same share of their new length, so
 * each keeps its speed shape. Refused before 0, or at or past a neighbouring key.
 */
export function retimeTranslateKey(animation: string, bone: string, index: number, time: number): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    const keys = translateNodes(a, bone);
    if (keys === null) throw new EditRefused(`${bone} keys translate as separate x and y: FramePath needs the combined translate keys.`);
    const k = keys[index];
    if (!k) throw new EditRefused(`${bone} has no translate key ${index + 1} in ${animation}.`);
    if (!Number.isFinite(time) || time < 0) throw new EditRefused("A key cannot move before 0.");
    const prev = keys[index - 1], next = keys[index + 1], from = keyTime(k);
    if ((prev && time <= keyTime(prev) + 1e-6) || (next && time >= keyTime(next) - 1e-6)) throw new EditRefused(`Key ${index + 1} stays between its neighbours.`);
    if (Math.abs(time - from) <= 1e-9) return a;
    // A curve's time handles (entries 0, 2, 4, 6) from [t0, t1] onto [n0, n1], each the same share of its span.
    const rescale = (c: readonly number[], t0: number, t1: number, n0: number, n1: number): number[] =>
      c.map((v, j) => (j % 2 === 0 && t1 - t0 > 1e-9 ? shortFloat(n0 + ((v - t0) / (t1 - t0)) * (n1 - n0)) : v));
    const out = keys.map((key, j) => {
      if (j === index - 1) { const c = curveOf(key); return c ? ({ ...key, curve: rescale(c, keyTime(key), from, keyTime(key), time) } as Key) : key; }
      if (j !== index) return key;
      const { time: _t, ...rest } = key, c = curveOf(key), t2 = next ? keyTime(next) : from;
      const moved = (time !== 0 ? { ...rest, time } : rest) as Key;
      return c && next ? ({ ...moved, curve: rescale(c, from, t2, time, t2) } as Key) : moved;
    });
    return withKeys(a, translatePath(bone), out);
  });
}

/** A span as Spine's Curves view shows it (docs/CURVES-PANEL-PLAN.md): its kind, and each end's handle as [time across, progress up], 0 to 1 over the span. */
export interface SpanEase {
  readonly kind: "stepped" | "linear" | "bezier";
  readonly out: Vec;
  readonly in: Vec;
}

/**
 * The span from `k` to `next` as a Curves view: across, each time handle's share of the span's time (x's and y's averaged); up, how
 * far each path handle reaches along the chord (`out · chord ÷ |chord|²` from the start, `1 + in · chord ÷ |chord|²` from the end).
 * On a straight span that is the handle's share of the chord (steps 8 and 10); with no chord, the thirds.
 */
export function spanEase(bone: string, k: Key, next: Key): SpanEase {
  const sp = spanOf(bone, k, next), c = curveOf(k), kind = k.curve === "stepped" ? "stepped" : c ? "bezier" : "linear";
  const { curve: _, ...plain } = k, h = spanHandles(bone, c ? k : (plain as Key), next)!;
  const [u1, u2] = c && sp.dt > 0 ? timeHandles(c, sp) : [1 / 3, 2 / 3];
  const c2 = sp.cl * sp.cl, along = (v: Vec): number => (v[0] * sp.chord[0] + v[1] * sp.chord[1]) / c2;
  return { kind, out: [r4(u1), c2 > 1e-12 ? r4(along(h.out)) : 1 / 3], in: [r4(u2), c2 > 1e-12 ? r4(1 + along(h.in)) : 2 / 3] };
}

/**
 * The span after the bone's translate key `index` written as a Curves view (docs/CURVES-PANEL-PLAN.md, step 1). `kind` stepped or
 * linear drops the handles; bezier writes them, a side not given kept as it is. Across, a time handle held inside the span; up, the
 * path handle moved along the chord only (`out + Δup · chord`), so what it has across the chord, its bend, stays (Decision 1). The
 * keys' places stay.
 */
export function setSpanEase(animation: string, bone: string, index: number, ease: { kind: SpanEase["kind"]; out?: Vec | undefined; in?: Vec | undefined }): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    if ([ease.out, ease.in].some((h) => h !== undefined && !(Number.isFinite(h[0]) && Number.isFinite(h[1])))) throw new EditRefused("A handle must be two numbers.");
    const keys = translateNodes(a, bone);
    if (keys === null) throw new EditRefused(`${bone} keys translate as separate x and y: FramePath needs the combined translate keys.`);
    const k = keys[index], next = keys[index + 1];
    if (!k || !next) throw new EditRefused(`${bone}'s translate key ${index + 1} in ${animation} has no span after it.`);
    const { curve: _, ...plain } = k;
    let made: Key;
    if (ease.kind === "stepped") made = { ...plain, curve: "stepped" } as Key;
    else if (ease.kind === "linear") made = plain as Key;
    else {
      const sp = spanOf(bone, k, next), now = spanEase(bone, k, next), h = spanHandles(bone, curveOf(k) ? k : (plain as Key), next)!;
      const out = ease.out ?? now.out, into = ease.in ?? now.in, hold = (x: number): number => Math.min(1, Math.max(0, x));
      // Up moves the path handle along the chord by the change, from where it is now unrounded (nothing to move with no chord).
      const c2 = sp.cl * sp.cl, along = (v: Vec): number => (v[0] * sp.chord[0] + v[1] * sp.chord[1]) / c2;
      // An up value within the read-back's rounding (four places) of where the handle is: unchanged, so an across-only drag moves no path.
      const slide = (v: Vec, dy: number): Vec => (c2 > 1e-12 && Math.abs(dy) > 5e-5 ? [v[0] + dy * sp.chord[0], v[1] + dy * sp.chord[1]] : v);
      const o = ease.out ? slide(h.out, out[1] - along(h.out)) : h.out, i = ease.in ? slide(h.in, into[1] - (1 + along(h.in))) : h.in;
      const ta = sp.t0 + hold(out[0]) * sp.dt, tb = sp.t0 + hold(into[0]) * sp.dt, curve: number[] = [];
      for (let ch = 0; ch < 2; ch++) curve.push(shortFloat(ta), shortFloat(sp.a[ch]! + o[ch]!), shortFloat(tb), shortFloat(sp.b[ch]! + i[ch]!));
      made = { ...plain, curve } as Key;
    }
    return withKeys(a, translatePath(bone), keys.map((key, j) => (j === index ? made : key)));
  });
}
