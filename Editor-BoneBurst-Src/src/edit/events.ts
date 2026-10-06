import type { Animation, EventDef, Key, Skeleton } from "@/model/skeleton";
import { EditRefused, type Edit } from "./history";

/**
 * Events (Format-Json-Atlas.md §6, §11.13): the skeleton's named events with their values and
 * sound, and the keys that fire them in animations (E5 step 4). Several events may fire on one
 * frame; they keep the order they were keyed in.
 */

export type EventPatch = { -readonly [K in "int" | "float" | "string" | "audio" | "volume" | "balance"]?: EventDef[K] };
export type EventOverrides = { -readonly [K in "int" | "float" | "string" | "volume" | "balance"]?: Key[K] };

const sameTime = (a: number, b: number) => Math.abs(a - b) <= 1e-5;

/** Add the event `name`, or change the values given (a value left out is unchanged). */
export function defineEvent(name: string, patch: EventPatch): Edit<Skeleton> {
  return (s) => {
    if (!name.trim()) throw new EditRefused("An event needs a name.");
    if (patch.volume !== undefined && !(patch.volume >= 0 && patch.volume <= 1)) throw new EditRefused("Volume is from 0 to 1.");
    if (patch.balance !== undefined && !(patch.balance >= -1 && patch.balance <= 1)) throw new EditRefused("Balance is from -1 to 1.");
    const all = s.events ?? [], i = all.findIndex((e) => e.name === name);
    const next = { ...(i >= 0 ? all[i]! : { name, extra: new Map() }), ...patch } as EventDef;
    return { ...s, events: i >= 0 ? all.map((e, j) => (j === i ? next : e)) : [...all, next] };
  };
}

/** Every animation's event keys, rebuilt by `f`. */
function onEventKeys(s: Skeleton, f: (keys: readonly Key[], a: Animation) => readonly Key[]): Skeleton {
  if (!s.animations) return s;
  const animations = s.animations.map((a) => {
    if (!a.events) return a;
    const keys = f(a.events, a);
    if (keys === a.events) return a;
    const { events: _, ...rest } = a;
    return (keys.length ? { ...rest, events: keys } : rest) as Animation;
  });
  return { ...s, animations };
}

export function renameEvent(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    if (!s.events?.some((e) => e.name === from)) throw new EditRefused(`There is no event "${from}".`);
    if (!to.trim()) throw new EditRefused("An event needs a name.");
    if (from === to) return s;
    if (s.events.some((e) => e.name === to)) throw new EditRefused(`There is already an event "${to}".`);
    const out = { ...s, events: s.events.map((e) => (e.name === from ? { ...e, name: to } : e)) };
    return onEventKeys(out, (keys) => (keys.some((k) => k.name === from) ? keys.map((k) => (k.name === from ? { ...k, name: to } : k)) : keys));
  };
}

/** Delete the event and every key that fires it. */
export function deleteEvent(name: string): Edit<Skeleton> {
  return (s) => {
    if (!s.events?.some((e) => e.name === name)) throw new EditRefused(`There is no event "${name}".`);
    const events = s.events.filter((e) => e.name !== name);
    const { events: _, ...rest } = s;
    const out = (events.length ? { ...rest, events } : rest) as Skeleton;
    return onEventKeys(out, (keys) => (keys.some((k) => k.name === name) ? keys.filter((k) => k.name !== name) : keys));
  };
}

/** Fire `name` at `time` in `animation`, after any events already on that frame. */
export function keyEvent(animation: string, time: number, name: string, overrides: EventOverrides = {}): Edit<Skeleton> {
  return (s) => {
    if (!s.events?.some((e) => e.name === name)) throw new EditRefused(`There is no event "${name}": define it first.`);
    if (time < 0) throw new EditRefused("A key cannot be before 0.");
    const a = s.animations?.find((x) => x.name === animation);
    if (!a) throw new EditRefused(`There is no animation "${animation}".`);
    const keys = a.events ?? [], at = keys.findIndex((k) => (k.time ?? 0) > time + 1e-5);
    const key = { ...(time ? { time } : {}), name, ...overrides, extra: new Map() } as Key;
    const next = at < 0 ? [...keys, key] : [...keys.slice(0, at), key, ...keys.slice(at)];
    return { ...s, animations: s.animations!.map((x) => (x === a ? { ...x, events: next } : x)) };
  };
}

/** Remove the keys firing `name` at `time` in `animation`. */
export function deleteEventKeys(animation: string, time: number, name: string): Edit<Skeleton> {
  return (s) => {
    const a = s.animations?.find((x) => x.name === animation);
    if (!a) throw new EditRefused(`There is no animation "${animation}".`);
    const keys = (a.events ?? []).filter((k) => !(k.name === name && sameTime(k.time ?? 0, time)));
    if (keys.length === (a.events ?? []).length) throw new EditRefused(`"${name}" does not fire at ${time}s in "${animation}".`);
    const { events: _, ...rest } = a;
    const next = (keys.length ? { ...rest, events: keys } : rest) as Animation;
    return { ...s, animations: s.animations!.map((x) => (x === a ? next : x)) };
  };
}
