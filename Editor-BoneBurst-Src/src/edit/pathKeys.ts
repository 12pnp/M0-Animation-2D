import { boneNumber } from "@/model/defaults";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { frameTime, keyLists, keyTime, shortFloat } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { deleteKeys, type KeyRef, onAnimation, withKeys } from "./keys";

/**
 * Keys from a motion path (docs/TWO-SYSTEMS-PLAN.md): fitting Spine curves to the path's motion and writing them as a bone's translate
 * keys, for the one-time "Make keys from path". The path itself is `src/motion/`; nothing here remembers where keys came from.
 */

/**
 * Fit a Spine channel curve to one segment: the value at `u` = 0, 1/n … 1 (even steps in time, the
 * first and last the keys' values). The Bézier's control times sit a third and two thirds of the way,
 * so only the two control values are free: the least-squares pair for the samples. Returns them and
 * how far the fitted curve is from the samples at worst.
 */
export function fitChannel(values: readonly number[]): { c1: number; c2: number; error: number } {
  const n = values.length - 1, v0 = values[0]!, v3 = values[n]!;
  if (n < 2) return { c1: v0 + (v3 - v0) / 3, c2: v0 + ((v3 - v0) * 2) / 3, error: 0 };
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const basis = (u: number) => { const w = 1 - u; return [w * w * w, 3 * w * w * u, 3 * w * u * u, u * u * u] as const; };
  for (let k = 1; k < n; k++) {
    const [e0, e1, e2, e3] = basis(k / n), r = values[k]! - e0 * v0 - e3 * v3;
    a11 += e1 * e1; a12 += e1 * e2; a22 += e2 * e2; b1 += e1 * r; b2 += e2 * r;
  }
  const det = a11 * a22 - a12 * a12;
  let c1 = v0 + (v3 - v0) / 3, c2 = v0 + ((v3 - v0) * 2) / 3;
  if (Math.abs(det) > 1e-12) { c1 = (b1 * a22 - b2 * a12) / det; c2 = (a11 * b2 - a12 * b1) / det; }
  let error = 0;
  for (let k = 0; k <= n; k++) { const [e0, e1, e2, e3] = basis(k / n); error = Math.max(error, Math.abs(e0 * v0 + e1 * c1 + e2 * c2 + e3 * v3 - values[k]!)); }
  return { c1, c2, error };
}

const keyed = (n: number) => shortFloat(Math.round(n * 1e4) / 1e4);

/** One key made from a path: the bone's local x and y (as offsets from its setup pose when written) at a frame, and the control values of the curve to the next key. */
export interface PathKey {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  /** [x's c1, x's c2, y's c1, y's c2]: control values (local, absolute), absent on the last key. */
  readonly control?: readonly [number, number, number, number];
}

/** The translate keys for `keys` at `fps`, as offsets from the setup pose, each with its curve to the next key (control times at thirds). */
export function translateKeys(boneSetup: { x: number; y: number }, keys: readonly PathKey[], fps: number): Key[] {
  return keys.map((k, i) => {
    const time = k.frame === 0 ? undefined : frameTime(k.frame, fps), next = keys[i + 1];
    let curve: number[] | undefined;
    if (k.control && next) {
      const t0 = frameTime(k.frame, fps), t1 = frameTime(next.frame, fps), ta = t0 + (t1 - t0) / 3, tb = t0 + ((t1 - t0) * 2) / 3;
      const [xc1, xc2, yc1, yc2] = k.control;
      curve = [ta, keyed(xc1 - boneSetup.x), tb, keyed(xc2 - boneSetup.x), ta, keyed(yc1 - boneSetup.y), tb, keyed(yc2 - boneSetup.y)].map((v) => shortFloat(v));
    }
    return { ...(time !== undefined ? { time } : {}), x: keyed(k.x - boneSetup.x), y: keyed(k.y - boneSetup.y), ...(curve ? { curve } : {}), extra: new Map() } as Key;
  });
}

/** Replace the bone's translate timelines in an animation with `keys` (the combined `translate` list; the split ones go). */
export function writeTranslateKeys(animation: string, bone: string, keys: readonly Key[]): Edit<Skeleton> {
  return (s) => {
    const b = s.bones?.find((x) => x.name === bone);
    if (!b) throw new EditRefused(`There is no bone "${bone}".`);
    const baked = onAnimation(animation, (a) => {
      let out = a;
      for (const timeline of ["translatex", "translatey"]) out = withKeys(out, { section: "bones", owner: bone, timeline }, []);
      return withKeys(out, { section: "bones", owner: bone, timeline: "translate" }, keys);
    })(s);
    // The path sets the animation's length: keys past its last one (an older, longer take) go, on every timeline.
    const end = keys.length ? keyTime(keys.at(-1)!) : 0, a = baked.animations?.find((x) => x.name === animation);
    const late: KeyRef[] = [];
    for (const l of a ? keyLists(a) : []) for (const k of l.keys) if (keyTime(k) > end + 1e-6) late.push({ path: l.path, time: keyTime(k) });
    return late.length ? deleteKeys(animation, late)(baked) : baked;
  };
}

/** The bone's setup x and y (what a translate key is an offset from). */
export function setupXY(s: Skeleton, bone: string): { x: number; y: number } {
  const b = s.bones?.find((x) => x.name === bone);
  if (!b) throw new EditRefused(`There is no bone "${bone}".`);
  return { x: boneNumber(b, "x"), y: boneNumber(b, "y") };
}

/** The timelines a bone's translation is keyed on: the combined one and the split ones. */
export const TRANSLATE_TIMELINES = ["translate", "translatex", "translatey"] as const;

/** How many translate keys a bone has in an animation, on any of its translate timelines. */
export function translateKeyCount(a: Animation, bone: string): number {
  return keyLists(a).filter((l) => l.path.section === "bones" && l.path.owner === bone && (TRANSLATE_TIMELINES as readonly string[]).includes(l.path.timeline)).reduce((n, l) => n + l.keys.length, 0);
}

/** The bone's translate keys in an animation deleted (every other timeline kept): what "Delete" does when a path is made on a bone that has them. */
export function deleteTranslateKeys(animation: string, bone: string): Edit<Skeleton> {
  return (s) => {
    if (!s.bones?.some((x) => x.name === bone)) throw new EditRefused(`There is no bone "${bone}".`);
    return onAnimation(animation, (a) => {
      let out = a;
      for (const timeline of TRANSLATE_TIMELINES) out = withKeys(out, { section: "bones", owner: bone, timeline }, []);
      return out;
    })(s);
  };
}
