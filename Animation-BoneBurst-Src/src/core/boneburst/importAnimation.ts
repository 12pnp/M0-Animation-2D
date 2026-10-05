import { inheritKeysFromBoneBurst } from "@/core/doc/inherit";
import type { NodeId } from "@/core/doc/ids";
import { fromOffsets } from "@/core/doc/drawOrder";
import { eventValues } from "@/core/doc/events";
import { newAnimId } from "@/core/doc/ids";
import type { Animation, DrawOrderKey, ColorTransform, EventDef, EventKey, Keyframe, Node, SymbolItem, Track } from "@/core/doc/types";
import { sampleColorRaw, sampleTransformRaw } from "@/core/doc/timeline";
import { IDENTITY, cloneTf, type Transform } from "@/core/math/Transform";
import { lastTime } from "./carry";
import { boneComps, boneLocalAt, type ChannelGroup, colorComps, type KeyTiming, mergeKeys, slotColorAt, slotSetup } from "./importKeys";
import { fromBoneBurstLocal, type BoneBurstLocal } from "./transform";
import type { BoneBurstRaw } from "./types";
import { displayNames, num, obj, pick, str } from "./importRead";
import { ikKeysOf, transformKeysOf } from "./importConstraints";

/** What an animation's import reads from the skeleton's: the document so far
 *  and how the file's bones and slots became its nodes. */
export interface AnimationImport {
  sym: SymbolItem;
  rate: number;
  toFrame: (t: unknown) => number;
  switchFrame: (t: unknown) => number;
  boneNode: ReadonlyMap<string, Node>;
  boneSetup: ReadonlyMap<string, BoneBurstLocal>;
  shearKept: ReadonlySet<string>;
  slotNode: ReadonlyMap<string, Node>;
  slotsIn: readonly BoneBurstRaw[];
  warn: (message: string) => void;
}

/**
 * One animation of the file as the document's: bone and slot keys as tracks,
 * draw order, event, transform and IK keys where they land on frames; what
 * does not fit is carried (`Animation.spine`). `baked` counts the tweens
 * written frame by frame.
 */
export function importAnimation(ctx: AnimationImport, animName: string, animRaw: BoneBurstRaw): { anim: Animation; baked: number } {
  const { sym, rate, toFrame, switchFrame, boneNode, boneSetup, shearKept, slotNode, slotsIn, warn } = ctx;
  let baked = 0;
  const end = toFrame(lastTime(animRaw));
  const anim: Animation = {
    id: newAnimId(), name: animName, duration: end + 1, playTimes: 0, tracks: {}, endsAtLastFrame: true,
  };
  const carried: BoneBurstRaw = pick(animRaw, (k) => k !== "bones" && k !== "slots") ?? {};

  const bonesAnim = obj(animRaw.bones) ? animRaw.bones : {};
  for (const [boneName, timelines] of Object.entries(bonesAnim)) {
    const node = boneNode.get(boneName);
    if (!node || !obj(timelines)) { warn(`"${animName}" keys a bone "${boneName}" that does not exist; dropped.`); continue; }
    const setup = boneSetup.get(boneName)!;
    const { groups, rest } = boneComps(timelines, setup, rate, shearKept.has(boneName));
    // Inherit keys become the document's when each lands on a frame.
    const inherits = rest && "inherit" in rest ? inheritKeysFromBoneBurst(rest.inherit, rate) : null;
    if (inherits) {
      (anim.inherits ??= {})[node.id] = inherits;
      delete rest!.inherit;
    }
    if (rest && Object.keys(rest).length) ((carried.bones ??= {}) as BoneBurstRaw)[boneName] = rest;
    if (groups.length === 0) continue;
    const frameOf = (f: number): Transform => fromBoneBurstLocal(boneLocalAt(groups, setup, f));
    const made = trackOf(node, groups, [], end, (f) => ({ transform: frameOf(f), displayIndex: 0 }), (track, f) => {
      const got = sampleTransformRaw(track, f)!, want = frameOf(f);
      return close(got.x, want.x, 1e-3) && close(got.y, want.y, 1e-3) && close(got.skewX, want.skewX, 1e-3)
        && close(got.skewY, want.skewY, 1e-3) && close(got.scaleX, want.scaleX, 1e-5) && close(got.scaleY, want.scaleY, 1e-5);
    });
    anim.tracks[node.id] = made.track;
    baked += made.baked;
  }

  const slotsAnim = obj(animRaw.slots) ? animRaw.slots : {};
  for (const [slotName, timelines] of Object.entries(slotsAnim)) {
    const node = slotNode.get(slotName);
    if (!node || !obj(timelines)) { warn(`"${animName}" keys a slot "${slotName}" that does not exist; dropped.`); continue; }
    const setup = slotSetup(slotsIn.find((s) => s.name === slotName)!);
    const { group, rest: colorRest } = colorComps(timelines, setup, rate);
    let rest = colorRest;
    const names = displayNames(node);
    let switches: Array<{ frame: number; name: string | null }> = [];
    if (Array.isArray(timelines.attachment)) {
      const keys = timelines.attachment.filter(obj).map((k) => ({ frame: switchFrame(k.time), name: str(k.name) ? k.name : null }));
      if (keys.every((k) => k.name === null || names.includes(k.name))) switches = keys;
      else (rest ??= {}).attachment = timelines.attachment;
    }
    if (rest) ((carried.slots ??= {}) as BoneBurstRaw)[slotName] = rest;
    if (!group && switches.length === 0) continue;
    const setupDisplay = node.setupDisplay ?? 0;
    const shownAt = (f: number) => {
      let shown = setupDisplay;
      for (const k of switches) if (k.frame <= f) shown = k.name === null ? -1 : names.indexOf(k.name);
      return shown;
    };
    const colorOf = (f: number) => (group ? slotColorAt(group, f) : undefined);
    const made = trackOf(node, group ? [group] : [], switches.map((k) => k.frame), end,
      (f) => ({ transform: cloneTf(IDENTITY), displayIndex: shownAt(f), ...(group ? { color: colorOf(f) } : {}) }),
      (track, f) => {
        if (!group) return true;
        const got = sampleColorRaw(track, f)!, want = colorOf(f)!;
        return (Object.keys(want) as Array<keyof ColorTransform>).every((ch) => close(got[ch], want[ch], ch.endsWith("M") ? 1e-2 : 1e-2));
      });
    anim.tracks[node.id] = made.track;
    baked += made.baked;
  }
  // Draw order keys become the document's (`Animation.drawOrder`) when each
  // lands on a frame and reads as an order of known slots; otherwise the
  // timeline is carried as it came.
  if (Array.isArray(animRaw.drawOrder)) {
    const setup = slotsIn.map((sl) => slotNode.get(String(sl.name))?.id).filter((id): id is NodeId => !!id);
    const keys: DrawOrderKey[] = [];
    for (const k of animRaw.drawOrder) {
      if (!obj(k)) { keys.length = 0; break; }
      const at = num(k.time, 0) * rate;
      if (Math.abs(at - Math.round(at)) > 1e-6) { keys.length = 0; break; }
      const offsets = Array.isArray(k.offsets) ? k.offsets.filter(obj) : [];
      const mapped = offsets.map((o) => ({ item: slotNode.get(String(o.slot))?.id, offset: num(o.offset, 0) }));
      if (mapped.some((o) => !o.item)) { keys.length = 0; break; }
      const order = fromOffsets(mapped as Array<{ item: NodeId; offset: number }>, setup);
      if (!order) { keys.length = 0; break; }
      keys.push(offsets.length ? { frame: Math.round(at), order } : { frame: Math.round(at) });
    }
    if (keys.length === animRaw.drawOrder.length && keys.length) {
      anim.drawOrder = keys;
      delete carried.drawOrder;
    }
  }
  // Event keys become the document's (`Animation.events`) when each lands
  // on a frame and names a known event; otherwise the timeline is carried.
  if (Array.isArray(animRaw.events)) {
    const keys = eventKeysOf(animRaw.events, sym.events ?? [], rate);
    if (keys) {
      if (keys.length) anim.events = keys;
      delete carried.events;
    }
  }
  // Transform constraint keys likewise (`Animation.transforms`).
  if (obj(animRaw.transform)) {
    const rest: BoneBurstRaw = {};
    for (const [name, list] of Object.entries(animRaw.transform)) {
      const k = sym.transforms?.find((c) => c.name === name);
      const keys = k && Array.isArray(list) ? transformKeysOf(list, rate) : null;
      if (keys && k) (anim.transforms ??= {})[k.id] = keys;
      else rest[name] = list;
    }
    if (Object.keys(rest).length) carried.transform = rest;
    else delete carried.transform;
  }
  // IK keys become the document's (`Animation.ik`) per constraint when each
  // lands on a frame and changes only what the editor keys (the mix, the
  // bend); otherwise that constraint's timeline is carried as it came.
  if (obj(animRaw.ik)) {
    const rest: BoneBurstRaw = {};
    for (const [name, list] of Object.entries(animRaw.ik)) {
      const k = sym.ik.find((c) => c.name === name);
      const keys = k && Array.isArray(list) ? ikKeysOf(list, k, rate) : null;
      if (keys && k) (anim.ik ??= {})[k.id] = keys;
      else rest[name] = list;
    }
    if (Object.keys(rest).length) carried.ik = rest;
    else delete carried.ik;
  }
  if (Object.keys(carried).length) anim.spine = carried;
  return { anim, baked };
}
/* ── tracks ──────────────────────────────────────────────────────────────── */
/**
 * A node's track from its keyed values: the merged key frames
 * (`mergeKeys`), each key's state from `state(frame)`, every interval
 * checked through the stage's own sampler by `matches`.
 */
function trackOf(
  node: Node, groups: ChannelGroup[], extra: number[], end: number,
  state: (f: number) => Pick<Keyframe, "transform" | "displayIndex" | "color">,
  matches: (track: Track, f: number) => boolean
): { track: Track; baked: number; } {
  const keyAt = (t: KeyTiming): Keyframe => {
    const s = state(t.frame);
    const k: Keyframe = { frame: t.frame, transform: s.transform, displayIndex: s.displayIndex, tween: t.tween };
    if (s.color) k.color = s.color;
    if (t.eases) k.eases = t.eases;
    return k;
  };
  const { keys, baked } = mergeKeys(groups, extra, end, (a, b) => {
    const track: Track = { nodeId: node.id, keys: [keyAt(a), keyAt({ frame: b, tween: { kind: "none" } })], endFrame: b };
    for (let f = a.frame + 1; f < b; f++) if (!matches(track, f)) return false;
    return true;
  });
  return { track: { nodeId: node.id, keys: keys.map(keyAt), endFrame: end }, baked };
}
/* ── constraints ─────────────────────────────────────────────────────────── */
/**
 * An IK constraint as the editor's, when it can hold it: one bone, or a
 * parent and its child, aiming at a bone. The editor's bend is mirrored by
 * the y flip (the exporter's rule, inverted). What it does not solve rides
 * along in `spine` and the Spine pose applies it.
 */
/**
 * A Spine `events` timeline as the document's keys, or null when a key falls
 * between frames or names an event the file does not define. A key keeps
 * only the values that differ from its event's. A key of an event with a
 * sound and no balance played the event's VOLUME as its balance in
 * spine-core 4.3.13; that is the balance it gets.
 */
function eventKeysOf(list: unknown[], defs: readonly EventDef[], rate: number): EventKey[] | null {
  const keys: EventKey[] = [];
  for (const r of list) {
    if (!obj(r) || !str(r.name)) return null;
    const def = defs.find((d) => d.name === r.name);
    if (!def) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    const own = eventValues(def);
    const key: EventKey = { frame: Math.round(at), name: def.name };
    if (typeof r.int === "number" && Math.trunc(r.int) !== own.int) key.int = Math.trunc(r.int);
    if (typeof r.float === "number" && r.float !== own.float) key.float = r.float;
    if (typeof r.string === "string" && r.string !== own.string) key.string = r.string;
    if (def.audio) {
      const volume = num(r.volume, own.volume), balance = num(r.balance, own.volume);
      if (volume !== own.volume) key.volume = volume;
      if (balance !== own.balance) key.balance = balance;
    }
    keys.push(key);
  }
  return keys;
}
function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b) * 1e-3);
}
