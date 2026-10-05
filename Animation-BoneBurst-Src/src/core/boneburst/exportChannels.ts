import { rotationDelta, sampleTransformRaw, sampleColorRaw } from "@/core/doc/timeline";
import { type ColorTransform, type Track, DEFAULT_COLOR, type Animation } from "@/core/doc/types";
import { type EaseSegment, type TweenSpec, easeSegments, type TweenChannel, easeOf } from "@/core/math/easing";
import type { Transform } from "@/core/math/Transform";
import type { FrameAt, Run } from "./exportTypes";
import { keyTime } from "./transform";
import type { BoneBurstCurve } from "./types";

/** Consecutive frames on one animation, advancing one frame per frame. */
export function runsOf(frames: FrameAt[]): Run[] {
  const runs: Run[] = [];
  frames.forEach((fa, f) => {
    if (!fa) return;
    const last = runs[runs.length - 1];
    if (last && last.end === f && last.anim === fa.anim && last.local0 + (f - last.start) === fa.frame) last.end = f + 1;
    else runs.push({ start: f, end: f + 1, anim: fa.anim, local0: fa.frame });
  });
  return runs;
}
export function scaleAlpha(c: ColorTransform, k: number): ColorTransform {
  return k === 1 ? c : { ...c, aM: c.aM * k };
}
/* ── rows ────────────────────────────────────────────────────────────────── */
/**
 * The bezier leaving a key, as Spine takes it: the segment's control points
 * in the INTERVAL's 0..1 space, and the interval's two ends, so each
 * channel's control values follow from its values there (timelines are
 * linear in their values, so this is exact).
 */
interface RowCurve { seg: EaseSegment; frame0: number; span: number; }
/** One key. `sub` marks a curve segment starting inside its interval (not
 *  where an interval starts). */
export type Row<T> = { frame: number; t: T; stepped: boolean; sub?: boolean; curve?: RowCurve & { from: T; to: T; }; };
/** A channel of one track: its keys, and the stage's value at any frame. */

export interface Channel<T> { rows: Row<T>[]; at: (frame: number) => T; }
/**
 * The keys an interval needs, per channel ease: a hold one stepped key, a
 * linear tween one key, an ease or custom curve one key per bezier segment
 * carrying its curve, and a preset (no cubic holds it) one key per frame of
 * the stage's own values. `at(f)` is the stage's value at frame f,
 * `lerp(a, b, s)` a value part way (a segment starting inside the interval).
 */
function intervalRows<T>(
  frame0: number, next: number, from: T, to: T, ease: TweenSpec,
  at: (f: number) => T, lerp: (a: T, b: T, s: number) => T
): Row<T>[] {
  if (ease.kind === "none") return [{ frame: frame0, t: from, stepped: true }];
  if (ease.kind === "linear") return [{ frame: frame0, t: from, stepped: false }];
  const span = next - frame0;
  const segs = easeSegments(ease);
  if (!segs) {
    return Array.from({ length: span }, (_, i) => ({ frame: frame0 + i, t: at(frame0 + i), stepped: false }));
  }
  return segs.map((seg, i) => ({
    frame: frame0 + seg.x0 * span,
    t: seg.y0 === 0 ? from : lerp(from, to, seg.y0),
    stepped: false,
    ...(i > 0 ? { sub: true } : {}),
    curve: { seg, frame0, span, from, to },
  }));
}
/**
 * A transform channel of a track, angles unwrapped across keys so direction
 * and extra turns survive (the stage restarts each interval from the keyed
 * angle, a whole number of turns away: the same matrix, but Spine
 * interpolates the numbers). No track: the bind pose, held.
 */
export function transformChannel(track: Track | undefined, bind: Transform, channel: TweenChannel): Channel<Transform> {
  if (!track || track.keys.length === 0) return { rows: [{ frame: 0, t: bind, stepped: false }], at: () => bind };
  const keys = track.keys;
  const turn: number[] = [0];
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1]!, k = keys[i]!;
    const unwrapped = prev.transform.skewY + turn[i - 1]! + rotationDelta(prev, k);
    turn.push(unwrapped - k.transform.skewY);
  }
  const shifted = (t: Transform, by: number): Transform => by === 0 ? t : { ...t, skewX: t.skewX + by, skewY: t.skewY + by };
  const governing = (f: number): number => {
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1]!.frame <= f) i++;
    return i;
  };
  // Before its first key the stage composes the node at its bind pose.
  const at = (f: number): Transform => (f < keys[0]!.frame ? bind : shifted(sampleTransformRaw(track, f)!, turn[governing(f)]!));

  const rows: Row<Transform>[] = [];
  if (keys[0]!.frame > 0) rows.push({ frame: 0, t: bind, stepped: true });
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    const t = shifted(k.transform, turn[i]!);
    if (!next) { rows.push({ frame: k.frame, t, stepped: false }); return; }
    rows.push(...intervalRows(k.frame, next.frame, t, shifted(next.transform, turn[i + 1]!), easeOf(k, channel), at, lerpTransform));
  });
  return { rows, at };
}
/** The colour channel of a track: an AUTHORED colour anywhere means the
 *  timeline governs (`sampleColorRaw`'s rule); otherwise the bind colour. */
export function colorChannel(track: Track | undefined, bind: ColorTransform): Channel<ColorTransform> {
  if (!track || !track.keys.some((k) => k.color !== undefined)) {
    return { rows: [{ frame: 0, t: bind, stepped: false }], at: () => bind };
  }
  const keys = track.keys;
  const at = (f: number): ColorTransform => sampleColorRaw(track, f) ?? bind;
  const rows: Row<ColorTransform>[] = [];
  if (keys[0]!.frame > 0) rows.push({ frame: 0, t: bind, stepped: true });
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    const c = k.color ?? DEFAULT_COLOR;
    if (!next) { rows.push({ frame: k.frame, t: c, stepped: false }); return; }
    rows.push(...intervalRows(k.frame, next.frame, c, next.color ?? DEFAULT_COLOR, easeOf(k, "color"), at, lerpColor));
  });
  return { rows, at };
}
function lerpTransform(a: Transform, b: Transform, s: number): Transform {
  const l = (p: number, q: number) => p + (q - p) * s;
  return {
    x: l(a.x, b.x), y: l(a.y, b.y), skewX: l(a.skewX, b.skewX), skewY: l(a.skewY, b.skewY),
    scaleX: l(a.scaleX, b.scaleX), scaleY: l(a.scaleY, b.scaleY),
  };
}
/**
 * A symbol's keys laid onto the exported animation, run by run. Inside a
 * run the keys and their curves are copied, shifted in time. Where a run
 * starts inside an interval, the frames up to the next key are baked (the
 * stage's value per frame, straight between); where one ends inside an
 * interval, its tail is baked the same way, so no curve reaches past the
 * run — except a tween whose end key lands exactly on the run's end with
 * nothing starting there, which keeps its curve and ends on that key (a
 * key at the animation's end is how its length is written anyway). A run's
 * last key is stepped when another run follows: a loop restarting, a swap.
 */

export function sliceRuns<T>(runs: Run[], channelFor: (anim: Animation | null) => Channel<T>): Row<T>[] {
  const out: Row<T>[] = [];
  runs.forEach((run, ri) => {
    const { rows, at } = channelFor(run.anim);
    const l0 = run.local0, l1 = run.local0 + (run.end - run.start);
    const shift = run.start - l0;
    const starts = rows.map((r, i) => (r.sub ? -1 : i)).filter((i) => i >= 0);
    const nextStart = (i: number) => starts.find((j) => j > i);
    const bake = (from: number, to: number) => {
      for (let f = from; f < to; f++) out.push({ frame: f + shift, t: at(f), stepped: false });
    };
    const runOut = out.length;

    // The interval governing l0.
    let g = -1;
    for (const i of starts) if (rows[i]!.frame <= l0) g = i;
    let j: number;
    if (g >= 0 && rows[g]!.frame === l0) j = g;
    else {
      const n = g >= 0 ? nextStart(g) : starts[0];
      const stop = Math.min(l1, n === undefined ? l1 : Math.ceil(rows[n]!.frame));
      bake(l0, stop);
      j = n === undefined || rows[n]!.frame >= l1 ? rows.length : n;
    }
    for (; j < rows.length && rows[j]!.frame < l1; j++) {
      const r = rows[j]!;
      out.push({ ...r, frame: r.frame + shift, ...(r.curve ? { curve: { ...r.curve, frame0: r.curve.frame0 + shift } } : {}) });
    }
    // The last interval started in the run, if it reaches past it.
    let last = -1;
    for (const i of starts) if (rows[i]!.frame < l1 && rows[i]!.frame >= l0) last = i;
    const later = runs[ri + 1];
    if (last >= 0) {
      const n = nextStart(last);
      if (n !== undefined && rows[n]!.frame >= l1 && !rows[last]!.stepped) {
        if (rows[n]!.frame === l1 && later?.start !== run.end) {
          const end = rows[n]!;
          out.push({ frame: end.frame + shift, t: end.t, stepped: false });
        } else {
          const from = rows[last]!.frame + shift;
          while (out.length > runOut && out[out.length - 1]!.frame >= from) out.pop();
          bake(rows[last]!.frame, l1);
        }
      }
    }
    if (later && out.length > runOut) out[out.length - 1] = { ...out[out.length - 1]!, stepped: true, curve: undefined };
  });
  return out;
}
/**
 * A key's time and curve. `channels` gives the timeline's values, in its
 * order, for any row value; a bezier's control values are those at the
 * interval's ends, mixed by the control's y.
 */
export function keyBase<T>(r: Row<T>, fps: number, channels: (t: T) => number[]): { time?: number; curve?: BoneBurstCurve; } {
  const k: { time?: number; curve?: BoneBurstCurve; } = {};
  if (r.frame !== 0) k.time = keyTime(r.frame, fps);
  if (r.stepped) k.curve = "stepped";
  else if (r.curve) {
    const { seg, frame0, span, from, to } = r.curve;
    const a = channels(from), b = channels(to);
    const t1 = (frame0 + seg.c1x * span) / fps, t2 = (frame0 + seg.c2x * span) / fps;
    k.curve = a.flatMap((v, i) => [t1, v + (b[i]! - v) * seg.c1y, t2, v + (b[i]! - v) * seg.c2y]);
  }
  return k;
}
export function lerpColor(a: ColorTransform, b: ColorTransform, s: number): ColorTransform {
  const l = (p: number, q: number) => p + (q - p) * s;
  return {
    rM: l(a.rM, b.rM), gM: l(a.gM, b.gM), bM: l(a.bM, b.bM), aM: l(a.aM, b.aM),
    rO: l(a.rO, b.rO), gO: l(a.gO, b.gO), bO: l(a.bO, b.bO), aO: l(a.aO, b.aO),
  };
}
