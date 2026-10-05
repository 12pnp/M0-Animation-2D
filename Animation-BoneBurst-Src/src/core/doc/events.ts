import type { AnimId } from "./ids";
import type { Animation, EventDef, EventKey } from "./types";

/**
 * Events (ARCHITECTURE ▸ Events): a symbol's named events and the keys its
 * animations fire them at, as Spine's skeleton `events` and animation
 * `events` timeline. Several keys may share a frame; they fire in list order.
 */

/** Every value an event fires with. */
export interface EventValues {
  int: number;
  float: number;
  string: string;
  audio: string | null;
  volume: number;
  balance: number;
}

/** The values a key overrides; the rest are the event's. */
export type EventOverrides = Partial<Pick<EventKey, "int" | "float" | "string" | "volume" | "balance">>;

export const EVENT_OVERRIDES = ["int", "float", "string", "volume", "balance"] as const;

/** What `key` fires with (the event's own values without a key). */
export function eventValues(def: EventDef, key?: EventKey): EventValues {
  return {
    int: key?.int ?? def.int ?? 0,
    float: key?.float ?? def.float ?? 0,
    string: key?.string ?? def.string ?? "",
    audio: def.audio ?? null,
    volume: key?.volume ?? def.volume ?? 1,
    balance: key?.balance ?? def.balance ?? 0,
  };
}

/** The frames that have keys, sorted. */
export function eventFrames(keys: readonly EventKey[]): number[] {
  return [...new Set(keys.map((k) => k.frame))].sort((a, b) => a - b);
}

/** Sorted by frame; keys sharing a frame keep their order (a stable sort). */
function sorted(keys: EventKey[]): EventKey[] {
  return keys.map((k, i) => ({ k, i })).sort((a, b) => a.k.frame - b.k.frame || a.i - b.i).map((x) => x.k);
}

/** `keys` with `name` fired at `frame` too, after the keys already there. */
export function withEventKey(keys: readonly EventKey[], frame: number, name: string): EventKey[] {
  return sorted([...keys, { frame: Math.max(0, frame), name }]);
}

/** The keys at `frames` moved by `delta` frames (not before 0), after any
 *  keys already on the frames they land on. */
export function moveEventKeys(keys: readonly EventKey[], frames: readonly number[], delta: number): EventKey[] {
  const at = new Set(frames);
  const stay = keys.filter((k) => !at.has(k.frame));
  const moved = keys.filter((k) => at.has(k.frame)).map((k) => ({ ...k, frame: Math.max(0, k.frame + delta) }));
  return sorted([...stay, ...moved]);
}

export function deleteEventKeys(keys: readonly EventKey[], frames: readonly number[]): EventKey[] {
  const at = new Set(frames);
  return keys.filter((k) => !at.has(k.frame));
}

/** The `nth` key at `frame` with `patch` applied; `undefined` clears an
 *  override, so the event's own value fires. */
export function withEventKeyValues(
  keys: readonly EventKey[], frame: number, nth: number, patch: { [K in keyof EventOverrides]?: EventOverrides[K] | undefined },
): EventKey[] {
  let seen = -1;
  return keys.map((k) => {
    if (k.frame !== frame || ++seen !== nth) return k;
    const out: EventKey = { ...k };
    for (const f of EVENT_OVERRIDES) {
      if (!(f in patch)) continue;
      const v = patch[f];
      if (v === undefined) delete out[f];
      else (out as unknown as Record<string, unknown>)[f] = v;
    }
    return out;
  });
}

/** A name not taken among `defs`: `base`, then `base 2`, `base 3`… */
export function uniqueEventName(defs: readonly EventDef[], base: string): string {
  const taken = new Set(defs.map((d) => d.name));
  const b = base.trim() || "event";
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b} ${i}`)) return `${b} ${i}`;
}

/** The event list and each animation's keys after a rename: keys follow it.
 *  Null when `to` is empty or taken. */
export function renamedEvent(
  defs: readonly EventDef[], anims: readonly Animation[], from: string, to: string,
): { defs: EventDef[]; keys: Map<AnimId, EventKey[]> } | null {
  const name = to.trim();
  if (!name || (name !== from && defs.some((d) => d.name === name))) return null;
  const keys = new Map<AnimId, EventKey[]>();
  for (const a of anims) {
    if (a.events?.some((k) => k.name === from)) keys.set(a.id, a.events.map((k) => (k.name === from ? { ...k, name } : k)));
  }
  return { defs: defs.map((d) => (d.name === from ? { ...d, name } : d)), keys };
}

/** The event list and each animation's keys without event `name`. */
export function withoutEvent(
  defs: readonly EventDef[], anims: readonly Animation[], name: string,
): { defs: EventDef[]; keys: Map<AnimId, EventKey[]> } {
  const keys = new Map<AnimId, EventKey[]>();
  for (const a of anims) {
    if (a.events?.some((k) => k.name === name)) keys.set(a.id, a.events.filter((k) => k.name !== name));
  }
  return { defs: defs.filter((d) => d.name !== name), keys };
}

/** `def` with `patch`; a value equal to Spine's default is left off. */
export function withEventDefValues(def: EventDef, patch: Partial<Omit<EventDef, "name">>): EventDef {
  const out: EventDef = { ...def, ...patch };
  if (!out.int) delete out.int;
  if (!out.float) delete out.float;
  if (!out.string) delete out.string;
  if (!out.audio) delete out.audio;
  if (out.volume === undefined || out.volume === 1) delete out.volume;
  if (!out.balance) delete out.balance;
  return out;
}

/** Spine's skeleton `events` (`{ name: { int, float, string, audio, volume,
 *  balance } }`) as the event list; volume and balance only with a sound. */
export function eventDefsFromBoneBurst(raw: Record<string, unknown>): EventDef[] {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return Object.entries(raw).map(([name, v]) => {
    const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const audio = typeof r.audio === "string" ? r.audio : "";
    return withEventDefValues({ name }, {
      int: Math.trunc(num(r.int, 0)), float: num(r.float, 0), string: typeof r.string === "string" ? r.string : "",
      ...(audio ? { audio, volume: num(r.volume, 1), balance: num(r.balance, 0) } : {}),
    });
  });
}
