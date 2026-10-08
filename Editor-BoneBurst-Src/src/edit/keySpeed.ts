import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { channelValues, keyTime, keysAt, type TimelinePath } from "@/model/timelines";
import { type Segment, type Shape, shapeCurve } from "./curves";
import { EditRefused, type Edit } from "./history";
import { onAnimation, withKeys } from "./keys";

/**
 * A FramePath node's speed (docs/FRAMEPATH-SPEED-PLAN.md): the bone's translate keys stay on their frames and the speed at a
 * key is written into the Bezier of the span before it and the span after it. Speed s means the bone moves 1 + s times as
 * fast as the span's even pace there. One normalised shape on both channels keeps the bone on the line between the keys.
 */

const translatePath = (bone: string): TimelinePath => ({ section: "bones", owner: bone, timeline: "translate" });

/** The bone's combined translate keys in the animation, or null when it keys translate as split x and y (not handled). */
export function translateNodes(a: Animation, bone: string): readonly Key[] | null {
  const split = ["translatex", "translatey"].some((t) => (keysAt(a, { section: "bones", owner: bone, timeline: t })?.length ?? 0) > 0);
  if (split) return null;
  return keysAt(a, translatePath(bone)) ?? [];
}

function segmentOf(bone: string, k: Key, next: Key): Segment {
  const p = translatePath(bone);
  return { t0: keyTime(k), t1: keyTime(next), v0: channelValues(p, k, "start"), v1: channelValues(p, next, "end") };
}

/** The channel that moves most over the span (0: x, 1: y), or -1 when neither moves. */
function mainChannel(s: Segment): number {
  const dx = Math.abs(s.v1[0]! - s.v0[0]!), dy = Math.abs(s.v1[1]! - s.v0[1]!);
  return dx === 0 && dy === 0 ? -1 : dx >= dy ? 0 : 1;
}

/** The span's normalised handles (u: time, w: value, 0..1) on its main channel; null for a straight span. */
function handles(k: Key, s: Segment): [number, number, number, number] | null {
  const c = mainChannel(s), dt = s.t1 - s.t0;
  if (c < 0 || !Array.isArray(k.curve) || k.curve.length < (c + 1) * 4 || dt <= 0) return null;
  const v0 = s.v0[c]!, dv = s.v1[c]! - v0, h = k.curve.slice(c * 4, c * 4 + 4) as number[];
  return [(h[0]! - s.t0) / dt, (h[1]! - v0) / dv, (h[2]! - s.t0) / dt, (h[3]! - v0) / dv];
}

/** A slope as a speed (slope 1 is the even pace, speed 0); a vertical handle reads as very fast. */
const speedOfSlope = (dw: number, du: number): number => (du > 1e-9 ? dw / du - 1 : dw > 0 ? 1e3 : dw < 0 ? -1 : 0);

/** The speed at the start and the end of the span from `k` to `next`; null for a stepped span. */
export function spanEnds(bone: string, k: Key, next: Key): { start: number; end: number } | null {
  if (k.curve === "stepped") return null;
  const h = handles(k, segmentOf(bone, k, next));
  if (!h) return { start: 0, end: 0 };
  // The handles are stored as short floats: a speed reads back to four places.
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0;
  return { start: r4(speedOfSlope(h[1], h[0])), end: r4(speedOfSlope(1 - h[3], 1 - h[2])) };
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

/** The span's speed across its time, `n` + 1 samples from its start to its end ({ t: seconds, v: speed }); [] for a stepped span. */
export function spanSpeedSamples(bone: string, k: Key, next: Key, n: number): { t: number; v: number }[] {
  if (k.curve === "stepped") return [];
  const s = segmentOf(bone, k, next), h = handles(k, s), out: { t: number; v: number }[] = [];
  for (let j = 0; j <= n; j++) {
    const u = j / n;
    out.push({ t: s.t0 + u * (s.t1 - s.t0), v: h ? speedOnBezier(h, u) : 0 });
  }
  return out;
}

/** The speed of a normalised cubic (0,0)–(u1,w1)–(u2,w2)–(1,1) at time u: dw/du − 1, the curve's s found by bisection. */
function speedOnBezier([u1, w1, u2, w2]: readonly number[], u: number): number {
  const at = (a: number, b: number, s: number): number => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  const d = (a: number, b: number, s: number): number => 3 * (1 - s) * (1 - s) * a + 6 * (1 - s) * s * (b - a) + 3 * s * s * (1 - b);
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (at(u1!, u2!, mid) < u) lo = mid; else hi = mid; }
  const s = (lo + hi) / 2;
  return speedOfSlope(d(w1!, w2!, s), d(u1!, u2!, s));
}

/** The span's curve for a speed at its start and its end: none when both are 0 (the straight line). */
function curveFor(a: number, b: number, s: Segment): number[] | undefined {
  if (a === 0 && b === 0) return undefined;
  const shape: Shape = [1 / 3, (1 + a) / 3, 2 / 3, 1 - (1 + b) / 3];
  return shapeCurve(shape, s);
}

/** Each key's speed arriving (`in`, null on the first key or after a stepped span) and leaving (`out`, null on the last key or into a stepped span). */
export function keySpeedPairs(bone: string, keys: readonly Key[]): { in: number | null; out: number | null }[] {
  return keys.map((k, i) => {
    const prev = keys[i - 1], next = keys[i + 1];
    return { in: prev ? spanEnds(bone, prev, k)?.end ?? null : null, out: next ? spanEnds(bone, k, next)?.start ?? null : null };
  });
}

/**
 * The speed at the bone's translate key `index` set, on both sides: the span before it ends at that speed and the span after it
 * starts at it; each span's other end keeps the speed it had (a stepped span's other end: 0).
 */
export function setTranslateKeySpeed(animation: string, bone: string, index: number, speed: number): Edit<Skeleton> {
  return setTranslateKeySpeeds(animation, bone, index, { in: speed, out: speed });
}

/** The speed arriving at (`in`) and leaving (`out`) the bone's translate key `index`; a side left out keeps what it has. */
export function setTranslateKeySpeeds(animation: string, bone: string, index: number, speeds: { in?: number | undefined; out?: number | undefined }): Edit<Skeleton> {
  return (doc) => {
    if ([speeds.in, speeds.out].some((v) => v !== undefined && !Number.isFinite(v))) throw new EditRefused("A speed must be a number.");
    return onAnimation(animation, (a) => {
      const keys = translateNodes(a, bone);
      if (keys === null) throw new EditRefused(`${bone} keys translate as separate x and y: a speed needs the combined translate keys.`);
      if (!(index >= 0 && index < keys.length)) throw new EditRefused(`${bone} has no translate key ${index + 1} in ${animation}.`);
      if (keys.length < 2) throw new EditRefused(`${bone} has one translate key in ${animation}: a speed needs a span to the next key.`);
      const next = keys.map((k, j) => {
        const after = keys[j + 1];
        // Only the spans a given side touches: the one before for `in`, the one after for `out`.
        if (!after || !((j === index && speeds.out !== undefined) || (j === index - 1 && speeds.in !== undefined))) return k;
        const was = spanEnds(bone, k, after) ?? { start: 0, end: 0 };
        const start = j === index ? speeds.out ?? was.start : was.start, end = j + 1 === index ? speeds.in ?? was.end : was.end;
        const curve = curveFor(start, end, segmentOf(bone, k, after));
        const { curve: _, ...rest } = k;
        return (curve ? { ...rest, curve } : rest) as Key;
      });
      return withKeys(a, translatePath(bone), next);
    })(doc);
  };
}
