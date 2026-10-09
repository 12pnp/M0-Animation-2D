import type { Key, Skeleton } from "@/model/skeleton";
import { animationDuration, channelCount, channelValues, frameTime, keyLists, keyTime, shortFloat, timeFrame, type TimelinePath } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { onAnimation, withList } from "./keys";

/**
 * An animation fitted into a last frame (docs/FRAME-LIMIT-PLAN.md): Pack scales every key into it, Trim cuts the keys after it and
 * keys the value there. Both change the whole animation: every key list (`keyLists`).
 */

/** A key at `time` (0 written as no time, as the file does). */
function at(k: Key, time: number): Key {
  const { time: _, ...rest } = k;
  return (time !== 0 ? { ...rest, time } : rest) as Key;
}

/** A list's name for a message. */
function listName(p: TimelinePath): string {
  switch (p.section) {
    case "drawOrder": case "events": return p.section === "events" ? "the events" : "the draw order";
    case "attachments": return `${p.slot}'s ${p.attachment} ${p.timeline}`;
    case "ik": case "transform": return `${p.section} ${p.owner}`;
    default: return `${p.owner}'s ${p.timeline}`;
  }
}

/**
 * Every key of `animation` scaled into frames 0 … `toFrame` (its last key, at frame N, lands on `toFrame`), rounded to frames; each
 * bezier carried to its interval's new ends. Refused, changing nothing, when two keys of one list (events aside) would land on one
 * frame. The animation already ending by `toFrame` is left as it is.
 */
export function packAnimation(animation: string, toFrame: number, fps: number): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    if (!(Number.isInteger(toFrame) && toFrame >= 1)) throw new EditRefused("A last frame is a whole number from 1.");
    const end = timeFrame(animationDuration(a), fps);
    if (end <= toFrame) return a;
    let out = a;
    for (const { path, keys } of keyLists(a)) {
      const frames = keys.map((k) => Math.round((timeFrame(keyTime(k), fps) * toFrame) / end));
      if (path.section !== "events") {
        for (let i = 1; i < frames.length; i++) {
          if (frames[i] === frames[i - 1]) throw new EditRefused(`Packing into ${toFrame} frames would put keys ${i} and ${i + 1} of ${listName(path)} on frame ${frames[i]}: nothing was changed. Try Trim, or a later last frame.`);
        }
      }
      out = withList(out, path, () => ({ keys: keys.map((k, i) => at(k, frameTime(frames[i]!, fps))), origin: keys.map((_, i) => i) }));
    }
    return out;
  });
}

type Pt = readonly [number, number];
const mid = (p: Pt, q: Pt, s: number): Pt => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];

/** One channel's interval as a cubic in (time, value), and where it reaches time `t`: the value there and the cubic's left part's handles. */
function splitChannel(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): { value: number; left: [Pt, Pt] } {
  const x = (s: number): number => (1 - s) ** 3 * p0[0] + 3 * (1 - s) ** 2 * s * p1[0] + 3 * (1 - s) * s * s * p2[0] + s ** 3 * p3[0];
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (x(m) < t) lo = m; else hi = m; }
  const s = (lo + hi) / 2, a = mid(p0, p1, s), b = mid(p1, p2, s), c = mid(p2, p3, s), d = mid(a, b, s), e = mid(b, c, s), f = mid(d, e, s);
  return { value: f[1], left: [a, d] };
}

/** `n` channels 0..1 as the file's hex (two digits each). */
const hex = (vs: readonly number[]): string => vs.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");

/** A key `k` with channel values `vs` written into the fields its list keeps them in. */
function withValues(p: TimelinePath, k: Key, vs: readonly number[], k0: Key, k1: Key): Key {
  const r = (v: number): number => shortFloat(v);
  switch (p.section) {
    case "bones":
      if (["translate", "scale", "shear"].includes(p.timeline)) return { ...k, x: r(vs[0]!), y: r(vs[1]!) };
      return { ...k, value: r(vs[0]!) };
    case "slots":
      switch (p.timeline) {
        case "rgba": case "rgb": return { ...k, color: hex(vs) };
        case "rgba2": return { ...k, light: hex(vs.slice(0, 4)), dark: hex(vs.slice(4, 7)) };
        case "rgb2": return { ...k, light: hex(vs.slice(0, 3)), dark: hex(vs.slice(3, 6)) };
        default: return { ...k, value: r(vs[0]!) };
      }
    case "ik": return { ...k, mix: r(vs[0]!), softness: r(vs[1]!) };
    case "transform": return { ...k, mixRotate: r(vs[0]!), mixX: r(vs[1]!), mixY: r(vs[2]!), mixScaleX: r(vs[3]!), mixScaleY: r(vs[4]!), mixShearY: r(vs[5]!) };
    case "path": return p.timeline === "mix" ? { ...k, mixRotate: r(vs[0]!), mixX: r(vs[1]!), mixY: r(vs[2]!) } : { ...k, value: r(vs[0]!) };
    case "attachments": {
      // Deform: the vertices between the two keys' at the channel's 0..1.
      const full = (q: Key): number[] => { const o = q.offset ?? 0, v = q.vertices ?? []; return [...new Array<number>(o).fill(0), ...v]; };
      const a = full(k0), b = full(k1), n = Math.max(a.length, b.length), t = vs[0]!;
      const { offset: _o, vertices: _v, ...rest } = k;
      return { ...rest, vertices: Array.from({ length: n }, (_, i) => r((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t)) } as Key;
    }
    default: return { ...k, value: r(vs[0]!) };
  }
}

/**
 * The keys of `animation` after `toFrame` deleted. Where the cut falls inside an interval, a key at the cut with the value there, and
 * the interval's bezier split at the cut, so the curve up to it is the same; a list without values (attachment, draw order, events,
 * inherit, physics reset) only loses its later keys, its last key before the cut holding. A list whose every key is after the cut keeps
 * its first key, moved to the cut.
 */
export function trimAnimation(animation: string, toFrame: number, fps: number): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    if (!(Number.isInteger(toFrame) && toFrame >= 0)) throw new EditRefused("A last frame is a whole number from 0.");
    const cut = frameTime(toFrame, fps), eps = 1e-6;
    let out = a;
    for (const { path, keys } of keyLists(a)) {
      const after = keys.findIndex((k) => keyTime(k) > cut + eps);
      if (after < 0) continue;
      const kept = keys.slice(0, after), origin: (number | null)[] = kept.map((_, i) => i), prev = kept.at(-1), next = keys[after]!;
      const n = path.section === "events" ? 0 : channelCount(path);
      if (!prev) {
        if (path.section !== "events") { kept.push(at(next, cut)); origin.push(null); }
      } else if (n > 0 && Math.abs(keyTime(prev) - cut) > eps) {
        let left: Key = prev, made: Key;
        if (prev.curve === "stepped") made = at(withoutCurve(prev), cut);
        else {
          const t0 = keyTime(prev), t1 = keyTime(next), v0 = channelValues(path, prev, "start"), v1 = channelValues(path, next, "end");
          const curve = Array.isArray(prev.curve) && prev.curve.length >= n * 4 ? (prev.curve as readonly number[]) : null, vs: number[] = [], lefts: number[] = [];
          for (let c = 0; c < n; c++) {
            const p1: Pt = curve ? [curve[c * 4]!, curve[c * 4 + 1]!] : [t0 + (t1 - t0) / 3, v0[c]! + (v1[c]! - v0[c]!) / 3];
            const p2: Pt = curve ? [curve[c * 4 + 2]!, curve[c * 4 + 3]!] : [t0 + ((t1 - t0) * 2) / 3, v0[c]! + ((v1[c]! - v0[c]!) * 2) / 3];
            const sp = splitChannel([t0, v0[c]!], p1, p2, [t1, v1[c]!], cut);
            vs.push(sp.value);
            lefts.push(shortFloat(sp.left[0][0]), shortFloat(sp.left[0][1]), shortFloat(sp.left[1][0]), shortFloat(sp.left[1][1]));
          }
          // A linear interval stays linear up to the cut; a bezier keeps its shape there, its left part.
          if (curve) left = { ...prev, curve: lefts };
          made = at(withValues(path, withoutCurve(prev), vs, prev, next), cut);
        }
        kept[kept.length - 1] = left;
        kept.push(made);
        origin.push(null);
      }
      out = withList(out, path, () => ({ keys: kept, origin, settled: true }));
    }
    return out;
  });
}

const withoutCurve = (k: Key): Key => { const { curve: _, ...rest } = k; return rest as Key; };
