import { boneNumber } from "@/model/defaults";
import type { Key, Skeleton } from "@/model/skeleton";
import type { MotionPath } from "@/model/sidecar";
import { frameTime, keyLists, keyTime, shortFloat } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { deleteKeys, type KeyRef, onAnimation, withKeys } from "./keys";

/**
 * Keys from a motion path (docs/TWO-SYSTEMS-PLAN.md): fitting Spine curves to the path's motion and writing them as a bone's translate
 * keys. This is the key system's side of the old bake; it goes in step 4 of the plan (the path itself is `src/motion/`).
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

/** One baked key: the bone's local x and y (as offsets from its setup pose when written) at a frame, and the control values of the curve to the next key. */
export interface BakedKey {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  /** [x's c1, x's c2, y's c1, y's c2]: control values (local, absolute), absent on the last key. */
  readonly control?: readonly [number, number, number, number];
}

/** The translate keys for `keys` at `fps`, as offsets from the setup pose, each with its curve to the next key (control times at thirds). */
export function translateKeys(boneSetup: { x: number; y: number }, keys: readonly BakedKey[], fps: number): Key[] {
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

/** A short signature of the path's own settings (nodes, handles, speeds, duration, closed): what a bake to the timeline was made from. */
export function pathSignature(m: Pick<MotionPath, "nodes" | "closed" | "duration">): string {
  const text = JSON.stringify([m.nodes.map((n) => [n.x, n.y, n.tx ?? null, n.ty ?? null, n.bx ?? null, n.by ?? null, n.speed ?? 0]), m.closed, m.duration]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A short signature of a bone's translate keys in an animation, to tell when they were edited since a bake. */
export function keysSignature(keys: readonly Key[]): string {
  let h = 5381;
  for (const k of keys) for (const v of [k.time ?? 0, k.x ?? 0, k.y ?? 0]) h = ((h * 33) ^ Math.round(v * 1e4)) | 0;
  return (h >>> 0).toString(36) + "." + keys.length;
}

/** Replace the bone's translate timelines in an animation with `keys` (the combined `translate` list; the split ones go). */
export function bakeTranslate(animation: string, bone: string, keys: readonly Key[]): Edit<Skeleton> {
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
