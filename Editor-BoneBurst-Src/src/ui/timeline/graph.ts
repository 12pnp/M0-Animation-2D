import type { KeyFields } from "@/edit/keys";
import type { Key } from "@/model/skeleton";
import { channelCount, channelValues, keyTime, pathId, type PathKeys, type TimelinePath } from "@/model/timelines";

/**
 * The curve graph (E6-PLAN step 4g) without the DOM: each channel of the chosen timelines, its
 * intervals as Spine interpolates them (straight, stepped, or a bezier in time and value) with
 * the handles a person grabs, the value range fitted to the height, and the key field a
 * channel's value is written to. `tests/graph.test.ts`.
 */

export interface Channel {
  readonly path: TimelinePath;
  readonly c: number;
  readonly label: string;
  readonly keys: readonly Key[];
}

export interface Interval {
  /** The key the interval starts at (its curve shapes it). */
  readonly i: number;
  readonly t0: number; readonly v0: number;
  readonly t1: number; readonly v1: number;
  readonly kind: "linear" | "stepped" | "bezier";
  /** Its handles, absolute [time1, value1, time2, value2]: the bezier's, or a straight line's thirds. */
  readonly h: readonly [number, number, number, number];
}

const AXES: Record<string, readonly string[]> = {
  translate: ["x", "y"], scale: ["x", "y"], shear: ["x", "y"],
  ik: ["mix", "softness"], transform: ["rotate", "x", "y", "scale x", "scale y", "shear y"], pathmix: ["rotate", "x", "y"],
  rgba: ["r", "g", "b", "a"], rgb: ["r", "g", "b"], rgba2: ["r", "g", "b", "a", "dark r", "dark g", "dark b"], rgb2: ["r", "g", "b", "dark r", "dark g", "dark b"],
};

/** Each channel of the lists, labelled by its owner, timeline and axis. */
export function channelsOf(lists: readonly PathKeys[]): Channel[] {
  const out: Channel[] = [];
  for (const { path, keys } of lists) {
    const n = channelCount(path);
    if (!n || !keys.length) continue;
    const owner = "owner" in path ? path.owner : path.section === "attachments" ? `${path.slot}/${path.attachment}` : path.section;
    const timeline = "timeline" in path ? path.timeline : path.section;
    const axes = AXES[path.section === "path" && timeline === "mix" ? "pathmix" : path.section === "ik" || path.section === "transform" ? path.section : timeline];
    for (let c = 0; c < n; c++) out.push({ path, c, keys, label: `${owner} · ${timeline}${n > 1 ? ` ${axes?.[c] ?? c}` : ""}` });
  }
  return out;
}

/** The channel's intervals, key to key. */
export function intervals(ch: Channel): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i + 1 < ch.keys.length; i++) {
    const k = ch.keys[i]!, n = ch.keys[i + 1]!;
    const t0 = keyTime(k), t1 = keyTime(n), v0 = channelValues(ch.path, k, "start")[ch.c]!, v1 = channelValues(ch.path, n, "end")[ch.c]!;
    const third: Interval["h"] = [t0 + (t1 - t0) / 3, v0 + (v1 - v0) / 3, t0 + (2 * (t1 - t0)) / 3, v0 + (2 * (v1 - v0)) / 3];
    if (k.curve === "stepped") out.push({ i, t0, v0, t1, v1, kind: "stepped", h: third });
    else if (Array.isArray(k.curve) && k.curve.length >= (ch.c + 1) * 4) {
      const b = k.curve.slice(ch.c * 4, ch.c * 4 + 4) as number[];
      out.push({ i, t0, v0, t1, v1, kind: "bezier", h: [b[0]!, b[1]!, b[2]!, b[3]!] });
    } else out.push({ i, t0, v0, t1, v1, kind: "linear", h: third });
  }
  return out;
}

/** The key values of every channel and their handles, as a range with a margin (a flat range opened up). */
export function fitValues(chs: readonly Channel[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  const see = (v: number) => { if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); } };
  for (const ch of chs) {
    for (const k of ch.keys) see(channelValues(ch.path, k, "start")[ch.c]!);
    for (const iv of intervals(ch)) if (iv.kind === "bezier") { see(iv.h[1]); see(iv.h[3]); }
  }
  if (!(min <= max)) return { min: -1, max: 1 };
  if (max - min < 1e-6) { const m = Math.max(1, Math.abs(min) * 0.1); return { min: min - m, max: max + m }; }
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}

/** A value's y in a band from `top` to `bottom` (pixels), and back. */
export const valueY = (fit: { min: number; max: number }, top: number, bottom: number, v: number) => bottom - ((v - fit.min) / (fit.max - fit.min)) * (bottom - top);
export const yValue = (fit: { min: number; max: number }, top: number, bottom: number, y: number) => fit.min + ((bottom - y) / (bottom - top)) * (fit.max - fit.min);

/** The key field channel `c` of `path` is written to, or null for channels set elsewhere (colours, deform). */
export function channelField(path: TimelinePath, c: number): keyof KeyFields | null {
  switch (path.section) {
    case "bones": return ["translate", "scale", "shear"].includes(path.timeline) ? (c === 0 ? "x" : "y") : path.timeline === "inherit" ? null : "value";
    case "ik": return (["mix", "softness"] as const)[c] ?? null;
    case "transform": return (["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const)[c] ?? null;
    case "path": return path.timeline === "mix" ? (["mixRotate", "mixX", "mixY"] as const)[c] ?? null : "value";
    case "physics": case "slider": return "value";
    default: return null;
  }
}

/** A stable id for a channel (the list and its channel). */
export const channelId = (ch: Channel) => `${pathId(ch.path)}#${ch.c}`;
