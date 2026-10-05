import type { Animation, Key, KeyList, Skeleton, TimelineGroup } from "@/model/skeleton";
import {
  channelCount, channelValues, frameTime, keyTime, pathId, timeFrame, type TimelinePath,
} from "@/model/timelines";
import { remapCurve, type Segment, type Shape, shapeCurve } from "./curves";
import { EditRefused, type Edit } from "./history";

/**
 * Key edits on one animation (Format-Json-Atlas.md §11–12). Each rebuilds the touched key list
 * and then settles every bezier whose interval's ends changed (`edit/curves.ts`), so a curve keeps
 * its shape when keys around it move. These are the edits the agent tools call too (E5).
 */

/** One key: its list and its time. */
export interface KeyRef { readonly path: TimelinePath; readonly time: number }

/** The value keys a key may set (anything but `time`, `curve` and `extra`). */
export type KeyFields = { -readonly [K in Exclude<keyof Key, "time" | "curve" | "extra">]?: Key[K] };

/**
 * Two times name the same key when they are within 1e-5 s. Spine stores times as float32, and
 * exports may store a frame a float32 step off the frame's own time (the stickman has 2/24 as
 * 0.0833333283662796, where 2/24 rounds to 0.083333336); no frame rate puts two frames that close.
 */
export const sameTime = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-5;

/** Key `fields` at `time` in the list at `path`, creating the list, or setting a key already there. */
export function setKey(animation: string, path: TimelinePath, time: number, fields: KeyFields): Edit<Skeleton> {
  return onAnimation(animation, (a) => withList(a, path, (keys) => {
    const at = keys.findIndex((k) => sameTime(keyTime(k), time));
    if (at >= 0) {
      const old = keys[at]! as unknown as Record<string, unknown>;
      if (Object.entries(fields).every(([k, v]) => old[k] === v)) return null;
      const next = { ...keys[at]!, ...fields } as Key;
      return { keys: keys.map((k, i) => (i === at ? next : k)), origin: keys.map((_, i) => i) };
    }
    if (time < 0) throw new EditRefused("A key cannot be before 0.");
    const key = { ...(time !== 0 ? { time } : {}), ...fields, extra: new Map() } as Key;
    const i = keys.findIndex((k) => keyTime(k) > time);
    const n = i < 0 ? keys.length : i;
    return {
      keys: [...keys.slice(0, n), key, ...keys.slice(n)],
      origin: [...keys.slice(0, n).map((_, j) => j), null, ...keys.slice(n).map((_, j) => n + j)],
    };
  }));
}

/** Remove the keys. A list left empty goes, and so does a group or section left empty. */
export function deleteKeys(animation: string, refs: readonly KeyRef[]): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    let out = a;
    for (const [, group] of byPath(refs)) {
      out = withList(out, group.path, (keys) => {
        const kept = keys.map((k, i) => [k, i] as const).filter(([k]) => !group.times.some((t) => sameTime(t, keyTime(k))));
        if (kept.length === keys.length) return null;
        return { keys: kept.map(([k]) => k), origin: kept.map(([, i]) => i) };
      });
    }
    return out;
  });
}

/** Shift the keys by `frames` frames at `fps`. Refused below 0, or onto a key that stays. */
export function moveKeys(animation: string, refs: readonly KeyRef[], frames: number, fps: number): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    if (frames === 0) return a;
    let out = a;
    for (const [, group] of byPath(refs)) {
      out = withList(out, group.path, (keys) => {
        const moving = (k: Key) => group.times.some((t) => sameTime(t, keyTime(k)));
        const placed = keys.map((k, i) => {
          if (!moving(k)) return { k, i, t: keyTime(k) };
          const t = frameTime(timeFrame(keyTime(k), fps) + frames, fps);
          if (t < 0) throw new EditRefused("A key cannot move before 0.");
          const { time: _, ...rest } = k;
          return { k: (t !== 0 ? { ...rest, time: t } : rest) as Key, i, t };
        });
        for (const p of placed) {
          if (moving(keys[p.i]!) && placed.some((q) => q !== p && sameTime(q.t, p.t))) {
            throw new EditRefused(`There is already a key at frame ${timeFrame(p.t, fps)} on that timeline.`);
          }
        }
        placed.sort((x, y) => x.t - y.t);
        return { keys: placed.map((p) => p.k), origin: placed.map((p) => p.i) };
      });
    }
    return out;
  });
}

/** The interpolation from each key to the next: linear, stepped, or a preset shape on every channel. */
export function setCurve(animation: string, refs: readonly KeyRef[], curve: "linear" | "stepped" | Shape): Edit<Skeleton> {
  return onAnimation(animation, (a) => {
    let out = a, any = false;
    for (const [, group] of byPath(refs)) {
      const channels = channelCount(group.path);
      if (channels === 0) continue;
      out = withList(out, group.path, (keys) => {
        const next = keys.map((k, i) => {
          const after = keys[i + 1];
          if (!after || !group.times.some((t) => sameTime(t, keyTime(k)))) return k;
          any = true;
          const { curve: _, ...rest } = k;
          if (curve === "linear") return rest as Key;
          if (curve === "stepped") return { ...rest, curve: "stepped" } as Key;
          return { ...rest, curve: shapeCurve(curve, segment(group.path, k, after)) } as Key;
        });
        return { keys: next, origin: keys.map((_, i) => i), settled: true };
      });
    }
    if (!any) throw new EditRefused("Choose keys that have a next key on a timeline with curves.");
    return out;
  });
}

/* ── structure ─────────────────────────────────────────────────────────── */

interface Rebuilt {
  keys: readonly Key[];
  /** Per new key: its index in the old list, or null for a new key. */
  origin: readonly (number | null)[];
  /** The curves are as wanted already (setCurve): do not remap them. */
  settled?: boolean;
}

function onAnimation(name: string, f: (a: Animation) => Animation): Edit<Skeleton> {
  return (s) => {
    const all = s.animations ?? [];
    const i = all.findIndex((a) => a.name === name);
    if (i < 0) throw new EditRefused(`There is no animation "${name}".`);
    const next = f(all[i]!);
    return next === all[i] ? s : { ...s, animations: all.map((a, j) => (j === i ? next : a)) };
  };
}

function byPath(refs: readonly KeyRef[]): Map<string, { path: TimelinePath; times: number[] }> {
  const out = new Map<string, { path: TimelinePath; times: number[] }>();
  for (const r of refs) {
    const id = pathId(r.path);
    const g = out.get(id) ?? { path: r.path, times: [] };
    g.times.push(r.time);
    out.set(id, g);
  }
  return out;
}

/** The interval from `k` to `next` as its curve measures it. */
function segment(path: TimelinePath, k: Key, next: Key): Segment {
  return { t0: keyTime(k), t1: keyTime(next), v0: channelValues(path, k, "start"), v1: channelValues(path, next, "end") };
}

/** Each new key's bezier, moved to its interval's new ends. */
function settle(path: TimelinePath, before: readonly Key[], r: Rebuilt): Key[] {
  return r.keys.map((k, i) => {
    const o = r.origin[i], next = r.keys[i + 1];
    if (r.settled || o === null || o === undefined || !Array.isArray(k.curve) || !next) return k;
    const oldNext = before[o + 1];
    if (!oldNext) return k;
    const curve = remapCurve(k.curve, segment(path, before[o]!, oldNext), segment(path, k, next));
    return curve === k.curve ? k : ({ ...k, curve } as Key);
  });
}

/**
 * The animation with the list at `path` rebuilt by `f` (given [] when there is none yet). `f`
 * returns null for no change; an empty result removes the list, and an emptied group or section.
 */
function withList(a: Animation, path: TimelinePath, f: (keys: readonly Key[]) => Rebuilt | null): Animation {
  const current = listOf(a, path) ?? [];
  const r = f(current);
  if (!r) return a;
  const keys = settle(path, current, r);
  // Nothing changed (no key matched): the same document, so the history records nothing.
  if (keys.length === current.length && keys.every((k, i) => k === current[i])) return a;
  return putList(a, path, keys.length ? keys : null);
}

function listOf(a: Animation, p: TimelinePath): readonly Key[] | undefined {
  switch (p.section) {
    case "drawOrder": case "events": return a[p.section];
    case "ik": case "transform": return a[p.section]?.find((l) => l.name === p.owner)?.keys;
    case "attachments":
      return a.attachments?.find((s) => s.skin === p.skin)?.slots.find((s) => s.slot === p.slot)
        ?.attachments.find((t) => t.name === p.attachment)?.timelines.find((t) => t.name === p.timeline)?.keys;
    default: return a[p.section]?.find((g) => g.name === p.owner)?.timelines.find((t) => t.name === p.timeline)?.keys;
  }
}

/** `a` with `section` set to `v`, or without it when `v` is undefined. */
function setSection<K extends keyof Animation>(a: Animation, section: K, v: Animation[K] | undefined): Animation {
  const { [section]: _, ...rest } = a;
  return (v === undefined ? rest : { ...rest, [section]: v }) as Animation;
}

/** Replace, add or (null) remove one named entry of a list, in place; undefined when the list empties. */
function upsert<T extends { readonly name: string }>(list: readonly T[] | undefined, name: string, f: (old: T | undefined) => T | null): T[] | undefined {
  const all = list ?? [];
  const i = all.findIndex((x) => x.name === name);
  const next = f(all[i]);
  const out = i < 0 ? (next ? [...all, next] : [...all]) : next ? all.map((x, j) => (j === i ? next : x)) : all.filter((_, j) => j !== i);
  return out.length ? out : undefined;
}

function putTimeline(g: TimelineGroup | undefined, name: string, owner: string, keys: readonly Key[] | null): TimelineGroup | null {
  const timelines = upsert<KeyList>(g?.timelines, name, () => (keys ? { name, keys } : null));
  return timelines ? { ...(g ?? {}), name: owner, timelines } : null;
}

function putList(a: Animation, p: TimelinePath, keys: readonly Key[] | null): Animation {
  switch (p.section) {
    case "drawOrder": case "events": return setSection(a, p.section, keys ?? undefined);
    case "ik": case "transform":
      return setSection(a, p.section, upsert<KeyList>(a[p.section], p.owner, () => (keys ? { name: p.owner, keys } : null)));
    case "attachments": {
      const skins = (a.attachments ?? []).map((s) => ({ ...s, name: s.skin }));
      const next = upsert(skins, p.skin, (sk) => {
        const slots = upsert((sk?.slots ?? []).map((s) => ({ ...s, name: s.slot })), p.slot, (sl) => {
          const atts = upsert(sl?.attachments, p.attachment, (at) => putTimeline(at, p.timeline, p.attachment, keys));
          return atts ? { name: p.slot, slot: p.slot, attachments: atts } : null;
        });
        return slots ? { name: p.skin, skin: p.skin, slots: slots.map(({ name: _, ...s }) => s) } : null;
      });
      return setSection(a, "attachments", next?.map(({ name: _, ...s }) => s));
    }
    default: return setSection(a, p.section, upsert<TimelineGroup>(a[p.section], p.owner, (g) => putTimeline(g, p.timeline, p.owner, keys)));
  }
}
