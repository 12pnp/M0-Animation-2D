import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { frameTime, keysAt, keyTime, shortFloat, timeFrame, type TimelinePath } from "@/model/timelines";
import { DEFAULT_FPS } from "@/model/timelines";
import { withKeys } from "./keys";

/**
 * A Spine export's translate keys made into what FramePath edits (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md): one combined `translate` list
 * per bone, x and y timed together. No DOM.
 *
 * 1. Split `translatex` / `translatey` lists are merged into one `translate` list, keyed at every time either was: each channel's curve
 *    is cut at the new keys (de Casteljau), so it is the same curve. An axis without a list is 0 (a translate key is an offset from the
 *    setup pose), as is an axis before its list's first key. Where one axis jumps (a stepped key, or its list starting late) while the
 *    other moves, the jump becomes a one-frame ramp into it: the same at every whole frame.
 * 2. A span whose x and y are timed apart gets one timing, by the chosen mode: `split` matches it and first cuts the span at a whole
 *    frame wherever matching would move the bone more than the tolerance; `match` matches it as it is; `leave` keeps it.
 */

export type TimingMode = "split" | "match" | "leave";
export interface FramePathOptions { readonly timing: TimingMode; readonly tolerance: number }

/** One animation and bone FramePath cannot take as it is: split x / y lists (their key counts), or curves timing x and y apart. */
export interface FramePathFinding {
  readonly animation: string;
  readonly bone: string;
  readonly split?: { readonly x: number; readonly y: number };
  readonly apart?: number;
}

/** What a conversion did: keys added (merges, ramps, cuts), and the largest move it made, in units (0 where it was exact). */
export interface FramePathResult { readonly doc: Skeleton; readonly added: number; readonly worst: number }

const EPS = 1e-6;
const path = (bone: string, timeline: string): TimelinePath => ({ section: "bones", owner: bone, timeline });

/** Whether a combined translate key's curve times x and y apart. */
function timedApart(k: Key): boolean {
  const c = k.curve;
  return Array.isArray(c) && c.length >= 8 && (Math.abs(c[0]! - c[4]!) > EPS || Math.abs(c[2]! - c[6]!) > EPS);
}

/** Every animation and bone whose translate FramePath cannot take as it is, in the file's order. */
export function framePathReport(doc: Skeleton): FramePathFinding[] {
  const out: FramePathFinding[] = [];
  for (const a of doc.animations ?? []) {
    for (const g of a.bones ?? []) {
      const x = keysAt(a, path(g.name, "translatex"))?.length ?? 0, y = keysAt(a, path(g.name, "translatey"))?.length ?? 0;
      const apart = (keysAt(a, path(g.name, "translate")) ?? []).filter(timedApart).length;
      if (x || y || apart) out.push({ animation: a.name, bone: g.name, ...(x || y ? { split: { x, y } } : {}), ...(apart ? { apart } : {}) });
    }
  }
  return out;
}

// ── One channel's curve as cubics in (time, value) ──────────────────────────────────────────────────────────────────────────────

type Pt = readonly [number, number];
/** A piece of one channel between two times: a cubic (four points), or a jump at its end from `p0`'s value to `to`. */
type Piece = { readonly kind: "cubic"; readonly p: readonly [Pt, Pt, Pt, Pt] } | { readonly kind: "jump"; readonly t0: number; readonly t1: number; readonly from: number; readonly to: number };

const lerp = (p: Pt, q: Pt, s: number): Pt => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
/** A straight line from (t0, v0) to (t1, v1) as a cubic: its handles at the thirds. */
const straight = (t0: number, v0: number, t1: number, v1: number): [Pt, Pt, Pt, Pt] => [[t0, v0], [t0 + (t1 - t0) / 3, v0 + (v1 - v0) / 3], [t0 + ((t1 - t0) * 2) / 3, v0 + ((v1 - v0) * 2) / 3], [t1, v1]];
const line = (t0: number, v0: number, t1: number, v1: number): Piece => ({ kind: "cubic", p: straight(t0, v0, t1, v1) });

/** The cubic's parameter where its time reaches `t`. */
function paramAt(p: readonly [Pt, Pt, Pt, Pt], t: number): number {
  const x = (s: number): number => (1 - s) ** 3 * p[0][0] + 3 * (1 - s) ** 2 * s * p[1][0] + 3 * (1 - s) * s * s * p[2][0] + s ** 3 * p[3][0];
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (x(m) < t) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** The cubic cut at parameter `s`: its left part and its right part (de Casteljau), exactly the same curve. */
function cut(p: readonly [Pt, Pt, Pt, Pt], s: number): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] {
  const a = lerp(p[0], p[1], s), b = lerp(p[1], p[2], s), c = lerp(p[2], p[3], s), d = lerp(a, b, s), e = lerp(b, c, s), f = lerp(d, e, s);
  return [[p[0], a, d, f], [f, e, c, p[3]]];
}

/** The part of a cubic between times `t0` and `t1`. */
function between(p: readonly [Pt, Pt, Pt, Pt], t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  let q: readonly [Pt, Pt, Pt, Pt] = p;
  if (t0 > q[0][0] + EPS) q = cut(q, paramAt(q, t0))[1];
  if (t1 < q[3][0] - EPS) q = cut(q, paramAt(q, t1))[0];
  return [[t0, q[0][1]], q[1], q[2], [t1, q[3][1]]];
}

/** The cubic's value at time `t`. */
function valueAt(p: readonly [Pt, Pt, Pt, Pt], t: number): number {
  const s = paramAt(p, t);
  return (1 - s) ** 3 * p[0][1] + 3 * (1 - s) ** 2 * s * p[1][1] + 3 * (1 - s) * s * s * p[2][1] + s ** 3 * p[3][1];
}

/** One channel (a split list's keys, `value` its value; none: 0) between two times both on its key times' union. */
function piece(keys: readonly Key[], t0: number, t1: number): Piece {
  const v = (k: Key): number => k.value ?? 0;
  if (!keys.length) return line(t0, 0, t1, 0);
  const first = keyTime(keys[0]!), last = keys.at(-1)!;
  // Before the first key the axis is the setup pose (0); at it, the key's value.
  if (t1 <= first + EPS) return Math.abs(t1 - first) <= EPS ? { kind: "jump", t0, t1, from: 0, to: v(keys[0]!) } : line(t0, 0, t1, 0);
  if (t0 >= keyTime(last) - EPS) return line(t0, v(last), t1, v(last));
  let i = 0;
  while (i + 1 < keys.length && keyTime(keys[i + 1]!) <= t0 + EPS) i++;
  const k = keys[i]!, n = keys[i + 1]!, ka = keyTime(k), kb = keyTime(n);
  if (k.curve === "stepped") return Math.abs(t1 - kb) <= EPS ? { kind: "jump", t0, t1, from: v(k), to: v(n) } : line(t0, v(k), t1, v(k));
  const c = Array.isArray(k.curve) && k.curve.length >= 4 ? (k.curve as readonly number[]) : null;
  const whole: [Pt, Pt, Pt, Pt] = c ? [[ka, v(k)], [c[0]!, c[1]!], [c[2]!, c[3]!], [kb, v(n)]] : straight(ka, v(k), kb, v(n));
  return { kind: "cubic", p: between(whole, t0, t1) };
}

const isFlat = (pc: Piece): boolean => pc.kind === "cubic" && pc.p.every((q) => Math.abs(q[1] - pc.p[0][1]) <= EPS);
const startOf = (pc: Piece): number => (pc.kind === "cubic" ? pc.p[0][1] : pc.from);
/** A cubic as a curve's four numbers; a straight one as none (linear). */
const curveOf4 = (pc: Piece & { kind: "cubic" }): number[] => [pc.p[1][0], pc.p[1][1], pc.p[2][0], pc.p[2][1]].map(shortFloat);
const isLine = (pc: Piece & { kind: "cubic" }): boolean => {
  const [a, , , d] = pc.p, at = (s: number): Pt => lerp(a, d, s);
  return [1 / 3, 2 / 3].every((s, j) => { const q = pc.p[j + 1]!, w = at(s); return Math.abs(q[0] - w[0]) <= 1e-4 && Math.abs(q[1] - w[1]) <= 1e-4; });
};

/** A combined key at `t` with x, y and the curve to the next key from the two channels' pieces; null curve: linear, "stepped": held. */
function combined(t: number, x: Piece, y: Piece): Key {
  const base = { extra: new Map() } as unknown as Key;
  const k = { ...base, ...(t !== 0 ? { time: shortFloat(t) } : {}), x: shortFloat(startOf(x)), y: shortFloat(startOf(y)) } as Key;
  const held = (pc: Piece): boolean => pc.kind === "jump" || isFlat(pc);
  if (held(x) && held(y) && (x.kind === "jump" || y.kind === "jump")) return { ...k, curve: "stepped" } as Key;
  const cx = x as Piece & { kind: "cubic" }, cy = y as Piece & { kind: "cubic" };
  if (isLine(cx) && isLine(cy)) return k;
  return { ...k, curve: [...curveOf4(cx), ...curveOf4(cy)] } as Key;
}

/**
 * The bone's split `translatex` / `translatey` lists in `a` as one `translate` list (step 1 above), and how many keys it has beyond the
 * split lists' own. `fps` places the one-frame ramps. Null when the bone has no split list.
 */
function mergeSplit(a: Animation, bone: string, fps: number): { keys: Key[]; added: number } | null {
  const xs = keysAt(a, path(bone, "translatex")) ?? [], ys = keysAt(a, path(bone, "translatey")) ?? [];
  if (!xs.length && !ys.length) return null;
  const times = [...new Set([...xs, ...ys].map((k) => keyTime(k)))].sort((p, q) => p - q);
  const out: Key[] = [], frame = 1 / fps;
  for (let i = 0; i < times.length; i++) {
    const t0 = times[i]!, t1 = times[i + 1];
    if (t1 === undefined) {
      // The last time is every list's last key or after it: each axis is at its last value (or 0 with no list).
      const last = (ks: readonly Key[]): number => ks.at(-1)?.value ?? 0;
      out.push({ extra: new Map(), ...(t0 !== 0 ? { time: shortFloat(t0) } : {}), x: shortFloat(last(xs)), y: shortFloat(last(ys)) } as unknown as Key);
      break;
    }
    const px = piece(xs, t0, t1), py = piece(ys, t0, t1);
    const jx = px.kind === "jump" && !isFlat(py) && py.kind !== "jump", jy = py.kind === "jump" && !isFlat(px) && px.kind !== "jump";
    if (!jx && !jy) { out.push(combined(t0, px, py)); continue; }
    // One axis jumps while the other moves: a key a frame before the jump (when there is room), the jump a one-frame ramp into it.
    const ramp = (pc: Piece, from: number, to: number): Piece => (pc.kind === "jump" ? line(from, pc.from, to, pc.to) : pc);
    const hold = (pc: Piece, from: number, to: number): Piece => (pc.kind === "jump" ? line(from, pc.from, to, pc.from) : pc);
    const tm = t1 - frame;
    if (tm > t0 + EPS) {
      const sx = jx ? hold(px, t0, tm) : cubicPart(px, t0, tm), sy = jy ? hold(py, t0, tm) : cubicPart(py, t0, tm);
      const ex = jx ? ramp(px, tm, t1) : cubicPart(px, tm, t1), ey = jy ? ramp(py, tm, t1) : cubicPart(py, tm, t1);
      out.push(combined(t0, sx, sy), combined(tm, ex, ey));
    } else out.push(combined(t0, ramp(px, t0, t1), ramp(py, t0, t1)));
  }
  return { keys: out, added: out.length - times.length };
}

/** A moving piece's part between two times inside it. */
function cubicPart(pc: Piece, t0: number, t1: number): Piece {
  return pc.kind === "cubic" ? { kind: "cubic", p: between(pc.p, t0, t1) } : pc;
}


// ── x and y timed together ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A combined key's span to `next` as its two channels' cubics. */
function channels(k: Key, next: Key): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] {
  const c = k.curve as readonly number[], t0 = keyTime(k), t1 = keyTime(next);
  const ch = (i: number, v0: number, v1: number): [Pt, Pt, Pt, Pt] => [[t0, v0], [c[i * 4]!, c[i * 4 + 1]!], [c[i * 4 + 2]!, c[i * 4 + 3]!], [t1, v1]];
  return [ch(0, k.x ?? 0, next.x ?? 0), ch(1, k.y ?? 0, next.y ?? 0)];
}

/** The times a span is measured at: 24 between its ends, and each whole frame inside it. */
function samples(t0: number, t1: number, fps: number): number[] {
  const ts: number[] = [];
  for (let i = 1; i < 24; i++) ts.push(t0 + ((t1 - t0) * i) / 24);
  for (let f = Math.ceil(t0 * fps); f / fps < t1; f++) if (f / fps > t0 + EPS) ts.push(f / fps);
  return ts;
}

/**
 * One timing for both channels of the span from `k` to `next`: the shared time handles (each a share of the span, searched on a grid,
 * the two channels' average among them) whose best value handles (least squares, per channel) follow the old curves closest; the
 * curve, and the largest distance from the old place over the span.
 */
function fitSpan(k: Key, next: Key, fps: number): { curve: number[]; move: number } {
  const [cx, cy] = channels(k, next), t0 = keyTime(k), t1 = keyTime(next), dt = t1 - t0, ts = samples(t0, t1, fps);
  const want = ts.map((t) => [valueAt(cx, t), valueAt(cy, t)] as const);
  const c = k.curve as readonly number[], avg = [((c[0]! + c[4]!) / 2 - t0) / dt, ((c[2]! + c[6]!) / 2 - t0) / dt];
  const shares: number[] = [];
  for (let i = 0; i <= 20; i++) shares.push(i / 20);
  let best: { curve: number[]; move: number } | null = null;
  const tryTiming = (ua: number, ub: number): void => {
    const timing: [Pt, Pt, Pt, Pt] = [[t0, 0], [t0 + ua * dt, 1 / 3], [t0 + ub * dt, 2 / 3], [t1, 1]];
    const ss = ts.map((t) => valueAt(timing, t));
    const handles = [cx, cy].map((ch, j) => {
      // value(s) = (1-s)^3 v0 + b1 h1 + b2 h2 + s^3 v1: least squares for h1, h2.
      const v0 = ch[0][1], v1 = ch[3][1];
      let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
      ss.forEach((sv, i) => {
        const b1 = 3 * (1 - sv) ** 2 * sv, b2 = 3 * (1 - sv) * sv * sv, rest = want[i]![j]! - (1 - sv) ** 3 * v0 - sv ** 3 * v1;
        a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2; r1 += b1 * rest; r2 += b2 * rest;
      });
      const det = a11 * a22 - a12 * a12;
      return Math.abs(det) < 1e-12 ? [ch[1][1], ch[2][1]] : [(r1 * a22 - r2 * a12) / det, (a11 * r2 - a12 * r1) / det];
    });
    let move = 0;
    ss.forEach((sv, i) => {
      const at = (j: number): number => { const [h1, h2] = handles[j]!, ch = j ? cy : cx; return (1 - sv) ** 3 * ch[0][1] + 3 * (1 - sv) ** 2 * sv * h1! + 3 * (1 - sv) * sv * sv * h2! + sv ** 3 * ch[3][1]; };
      move = Math.max(move, Math.hypot(at(0) - want[i]![0], at(1) - want[i]![1]));
    });
    if (!best || move < best.move - 1e-9) {
      const ta = shortFloat(t0 + ua * dt), tb = shortFloat(t0 + ub * dt);
      best = { curve: [ta, shortFloat(handles[0]![0]!), tb, shortFloat(handles[0]![1]!), ta, shortFloat(handles[1]![0]!), tb, shortFloat(handles[1]![1]!)], move };
    }
  };
  tryTiming(Math.min(1, Math.max(0, avg[0]!)), Math.min(1, Math.max(0, avg[1]!)));
  for (const ua of shares) for (const ub of shares) tryTiming(ua, ub);
  return best!;
}

/** The span from `k` to `next` cut at time `t` (exact, per channel): the key at `t` and the two keys' new curves. */
function cutSpan(k: Key, next: Key, t: number): [Key, Key] {
  const [cx, cy] = channels(k, next), sx = cut(cx, paramAt(cx, t)), sy = cut(cy, paramAt(cy, t));
  const four = (q: readonly [Pt, Pt, Pt, Pt]): number[] => [q[1][0], q[1][1], q[2][0], q[2][1]].map(shortFloat);
  const left = { ...k, curve: [...four(sx[0]), ...four(sy[0])] } as Key;
  const mid = { ...k, time: shortFloat(t), x: shortFloat(sx[0][3][1]), y: shortFloat(sy[0][3][1]), curve: [...four(sx[1]), ...four(sy[1])] } as Key;
  return [left, mid];
}

/**
 * A combined list with every span timed together by `mode` (one timing fitted to both channels, `fitSpan`); in `split`, a span the fit
 * moves the bone more than the tolerance is cut at the whole frame nearest its middle first (exact), down to one frame. The keys added
 * and the largest move made.
 */
function matchTiming(keys: readonly Key[], mode: TimingMode, tolerance: number, fps: number): { keys: Key[]; added: number; worst: number } {
  if (mode === "leave") return { keys: [...keys], added: 0, worst: 0 };
  const out: Key[] = [];
  let added = 0, worst = 0;
  const span = (k: Key, next: Key): void => {
    if (!timedApart(k)) { out.push(k); return; }
    const fit = fitSpan(k, next, fps), f0 = timeFrame(keyTime(k), fps), f1 = timeFrame(keyTime(next), fps);
    if (mode === "split" && fit.move > tolerance && f1 - f0 >= 2) {
      const [left, mid] = cutSpan(k, next, frameTime(Math.round((f0 + f1) / 2), fps));
      added++;
      span(left, mid);
      span(mid, next);
      return;
    }
    worst = Math.max(worst, fit.move);
    out.push({ ...k, curve: fit.curve } as Key);
  };
  keys.forEach((k, i) => { const next = keys[i + 1]; if (next) span(k, next); else out.push(k); });
  return { keys: out, added, worst };
}

/** The document converted for FramePath (both steps, every animation and bone), with what it did. */
export function convertToFramePath(doc: Skeleton, options: FramePathOptions): FramePathResult {
  const fps = doc.header?.fps ?? DEFAULT_FPS;
  let added = 0, worst = 0;
  const animations = (doc.animations ?? []).map((a) => {
    let out = a;
    for (const g of a.bones ?? []) {
      const merged = mergeSplit(out, g.name, fps);
      if (merged) {
        added += merged.added;
        out = withKeys(withKeys(withKeys(out, path(g.name, "translatex"), []), path(g.name, "translatey"), []), path(g.name, "translate"), merged.keys);
      }
      const list = keysAt(out, path(g.name, "translate"));
      if (!list?.some(timedApart)) continue;
      const m = matchTiming(list, options.timing, options.tolerance, fps);
      added += m.added;
      worst = Math.max(worst, m.worst);
      out = withKeys(out, path(g.name, "translate"), m.keys);
    }
    return out;
  });
  return { doc: doc.animations ? { ...doc, animations } : doc, added, worst };
}
