import { type Keyframe, type Node, TIMELINE_PROPS, type TimelineProp, type Track } from "./types";
import {
  applyTween, type ChannelEases, CURVE_Y_LIMIT, type EaseSpec, easeOf, polylineCurve, sameEase, splitTween,
  TWEEN_LINEAR, type TweenChannel, type TweenSpec,
} from "@/core/math/easing";
import { cutKeepingEase, keyIndexAt, rotationDelta, sampleTransformRaw } from "./timeline";
import { withoutRedundantKeys } from "./pathEdit";
import { LEAVES, type Leaf, leafValue, sameValues as same, valuesOf } from "./keyed";

export { TIMELINE_PROPS, type TimelineProp };

/**
 * A bone's properties as Spine's dopesheet shows them, each on a row of its
 * own, over keys that here hold the whole pose.
 *
 * A property is a CHANNEL: its value at each key and, between two keys, the
 * ease that key gives it (`Keyframe.eases`). Its own keys (`channelKeys`) are
 * the whole keys that list it (`Keyframe.keyed`), or, on keys that list
 * nothing, the ones where it changes. Between two of them it may pass through
 * keys other properties need; it is read there as one ease through its value
 * at every whole frame. So a channel can be rewritten on its own
 * (`setChannel`): the whole keys it needs are cut in without moving any other
 * channel (`cutKeepingEase`), every whole key gets the channel's value and
 * the part of its ease that interval covers (`splitTween`), and the keys
 * that end up carrying nothing are dropped.
 */

/** Every leaf an interval can ease on its own (`easeOf`). */
const ALL_LEAVES: readonly TweenChannel[] = ["x", "y", "rotation", "shear", "scaleX", "scaleY", "color"];

const EPS = 1e-6;

/** A property's own key: its values (one per leaf) and the eases it leaves
 *  with, toward the next key of the same property ("none": it holds). */
export interface ChannelKey {
  frame: number;
  values: number[];
  eases: TweenSpec[];
}

function withLeaf(t: Keyframe["transform"], leaf: Leaf, v: number): Keyframe["transform"] {
  switch (leaf) {
    case "x": return { ...t, x: v };
    case "y": return { ...t, y: v };
    case "rotation": return { ...t, skewY: v, skewX: v - (t.skewY - t.skewX) };
    case "shear": return { ...t, skewX: t.skewY - v };
    case "scaleX": return { ...t, scaleX: v };
    case "scaleY": return { ...t, scaleY: v };
  }
}

/**
 * The track with every key's rotation written as the angle it reaches, turns
 * included, and no `rotateDir` / `rotateTurns`: it samples the same (a whole
 * turn apart at most), and a channel can then be read as plain numbers.
 */
export function unwrapTurns(track: Track): Track {
  if (!track.keys.some((k) => k.rotateDir || k.rotateTurns)) return track;
  let angle = track.keys[0]!.transform.skewY;
  const keys = track.keys.map((k, i) => {
    if (i > 0) angle += rotationDelta(track.keys[i - 1]!, k);
    const offset = angle - k.transform.skewY;
    const out: Keyframe = { ...k, transform: { ...k.transform, skewY: angle, skewX: k.transform.skewX + offset } };
    delete out.rotateDir;
    delete out.rotateTurns;
    return out;
  });
  return { ...track, keys };
}

/**
 * The ease from key `a` to key `b` of a property across the whole keys
 * between them: the property's value at every whole frame, as a fraction of
 * the way from a to b. Null where that is no ease: the two ends are equal
 * while the frames between are not, or it overshoots past what a curve holds.
 */
function easeAcross(t: Track, leaf: Leaf, a: number, b: number): EaseSpec | null {
  const va = leafValue(t.keys.find((k) => k.frame === a)!.transform, leaf);
  const vb = leafValue(t.keys.find((k) => k.frame === b)!.transform, leaf);
  const at = Array.from({ length: b - a + 1 }, (_, n) => leafValue(sampleTransformRaw(t, a + n)!, leaf));
  if (Math.abs(vb - va) <= EPS) return at.every((v) => Math.abs(v - va) <= EPS) ? TWEEN_LINEAR as EaseSpec : null;
  const r = at.map((v) => (v - va) / (vb - va));
  if (r.some((v) => Math.abs(v) > CURVE_Y_LIMIT)) return null;
  if (r.every((v, n) => Math.abs(v - n / (b - a)) <= EPS)) return TWEEN_LINEAR as EaseSpec;
  return { kind: "curve", curve: polylineCurve(r) };
}

/**
 * The property's own keys (`Keyframe.keyed`, or where it changes on keys
 * that list nothing). A run between two of them that no ease can carry
 * makes the keys inside it keys of the property too, so reading a track
 * and writing it back changes nothing.
 */
export function channelKeys(track: Track | undefined, prop: TimelineProp): ChannelKey[] {
  if (!track || !track.keys.length) return [];
  const t = unwrapTurns(track);
  const keys = t.keys;
  const vals = keys.map((k) => valuesOf(prop, k.transform));
  const moves = !vals.every((v) => same(v, vals[0]!));
  const picked = new Set<number>();
  keys.forEach((k, i) => {
    const prev = vals[i - 1], next = vals[i + 1];
    const changes = (!!prev && !same(prev, vals[i]!)) || (!!next && !same(next, vals[i]!));
    if (k.keyed ? k.keyed.includes(prop) : moves && changes) picked.add(i);
  });
  // Keys that list properties but not this one, while it moves: read where it
  // changes, as on keys that list nothing.
  if (!picked.size && moves) {
    keys.forEach((_, i) => {
      const prev = vals[i - 1], next = vals[i + 1];
      if ((!!prev && !same(prev, vals[i]!)) || (!!next && !same(next, vals[i]!))) picked.add(i);
    });
  }
  // Before the first key and after the last the property holds still; a key
  // out there with another value is one of its keys.
  const list = () => [...picked].sort((a, b) => a - b);
  if (picked.size) {
    const order = list();
    const first = order[0]!, last = order[order.length - 1]!;
    keys.forEach((_, i) => {
      if ((i < first && !same(vals[i]!, vals[first]!)) || (i > last && !same(vals[i]!, vals[last]!))) picked.add(i);
    });
  }
  const eases = new Map<number, TweenSpec[]>();
  for (let grew = true; grew;) {
    grew = false;
    const order = list();
    for (let n = 0; n + 1 < order.length && !grew; n++) {
      const i = order[n]!, j = order[n + 1]!;
      const key = keys[i]!;
      if (j === i + 1) {
        eases.set(i, LEAVES[prop].map((l) => (key.tween.kind === "none" ? key.tween : easeOf(key, l))));
        continue;
      }
      const across = LEAVES[prop].map((l) => easeAcross(t, l, key.frame, keys[j]!.frame));
      if (across.some((e) => !e)) {
        for (let m = i + 1; m < j; m++) picked.add(m);
        grew = true;
      } else {
        eases.set(i, across as TweenSpec[]);
      }
    }
  }
  return list().map((i) => ({
    frame: keys[i]!.frame,
    values: vals[i]!,
    eases: eases.get(i) ?? LEAVES[prop].map(() => TWEEN_LINEAR as TweenSpec),
  }));
}

/** The frames of `channelKeys`: where the property's row shows a key. */
export function propertyKeys(track: Track | undefined, prop: TimelineProp): number[] {
  return channelKeys(track, prop).map((k) => k.frame);
}

/** The property's values at `frame` along `keys`; `rest` with no keys. */
export function sampleChannel(keys: readonly ChannelKey[], frame: number, rest: readonly number[]): number[] {
  if (!keys.length) return [...rest];
  if (frame <= keys[0]!.frame) return [...keys[0]!.values];
  const b = keys.findIndex((k) => k.frame > frame);
  if (b < 0) return [...keys[keys.length - 1]!.values];
  const from = keys[b - 1]!, to = keys[b]!;
  const span = to.frame - from.frame;
  const p = (frame - from.frame) / span;
  return from.values.map((v, i) => {
    const e = from.eases[i]!;
    return e.kind === "none" ? v : v + (to.values[i]! - v) * applyTween(e, p, span);
  });
}

/** The part of an ease over `span` frames that runs from frame `s` to `e`,
 *  as an ease of its own; straight where a part shows no progress. */
function restrictEase(ease: TweenSpec, span: number, s: number, e: number): EaseSpec {
  if (ease.kind === "none") return TWEEN_LINEAR as EaseSpec;
  let spec: EaseSpec = ease;
  let len = span;
  if (s > 0) {
    const halves = splitTween(spec, len, s);
    if (!halves) return TWEEN_LINEAR as EaseSpec;
    spec = halves[1];
    len -= s;
  }
  const end = e - s;
  if (end < len) {
    const halves = splitTween(spec, len, end);
    if (!halves) return TWEEN_LINEAR as EaseSpec;
    spec = halves[0];
  }
  return spec;
}

/** Every leaf's ease written out on the key, so setting one leaf cannot
 *  change another through `CHANNEL_PARENT` (shear follows rotation). */
function materialize(k: Keyframe): Record<string, TweenSpec> {
  return Object.fromEntries(ALL_LEAVES.map((l) => [l, easeOf(k, l)]));
}

/** The leaves that differ from the key's own tween, and nothing else. */
function compact(k: Keyframe, leaves: Record<string, TweenSpec>): Keyframe {
  const out: Keyframe = { ...k };
  delete out.eases;
  if (k.tween.kind === "none") return out;
  const eases: ChannelEases = {};
  for (const l of ALL_LEAVES) {
    const e = leaves[l]!;
    if (!sameEase(e, k.tween) && e.kind !== "none") eases[l] = e;
  }
  if (Object.keys(eases).length) out.eases = eases;
  return out;
}

/**
 * The track with `prop` following `keys` and every other property as it
 * was at every whole frame; each whole key lists the properties it is a key
 * of (`Keyframe.keyed`). `cleanup`: frames whose whole keys may now carry
 * nothing (a key moved or deleted away from them); those, and the keys cut
 * in here, are dropped when they key nothing and the track samples the same
 * without them. With no keys the property holds `rest`, by default the value
 * it has at the first key.
 */
export function setChannel(
  track: Track, node: Node, prop: TimelineProp, keys: readonly ChannelKey[], cleanup: readonly number[] = [],
  rest?: readonly number[],
): Track {
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  // Which keys the other properties have now; cutting keys in does not change them.
  const keyedBy = new Map(TIMELINE_PROPS.filter((q) => q !== prop)
    .map((q) => [q, new Set(propertyKeys(track, q))] as const));
  const own = new Set(sorted.map((k) => k.frame));
  let t = prop === "rotate" || prop === "shear" ? unwrapTurns(track) : track;
  const inserted: number[] = [];
  for (const k of sorted) {
    if (keyIndexAt(t, k.frame) >= 0) continue;
    const next = cutKeepingEase(t, k.frame, node);
    if (next) { t = next; inserted.push(k.frame); }
  }
  const hold = rest ?? valuesOf(prop, t.keys[0]?.transform ?? node.bind);
  const leaves = LEAVES[prop];
  const out = t.keys.map((key, i) => {
    let transform = key.transform;
    const values = sampleChannel(sorted, key.frame, hold);
    leaves.forEach((l, n) => { transform = withLeaf(transform, l, values[n]!); });
    const eases = materialize(key);
    const next = t.keys[i + 1];
    if (next && key.tween.kind !== "none") {
      // The property's interval this one lies in, and the part of its ease
      // between these two whole keys.
      const b = sorted.findIndex((c) => c.frame > key.frame);
      const a = b > 0 ? sorted[b - 1]! : null;
      leaves.forEach((l, n) => {
        eases[l] = a && b >= 0
          ? restrictEase(a.eases[n]!, sorted[b]!.frame - a.frame, key.frame - a.frame, next.frame - a.frame)
          : TWEEN_LINEAR;
      });
    }
    const keyed = TIMELINE_PROPS.filter((q) => (q === prop ? own.has(key.frame) : keyedBy.get(q)!.has(key.frame)));
    return compact({ ...key, transform, keyed }, eases);
  });
  const edited: Track = { ...t, keys: out };
  const spare = [...new Set([...cleanup, ...inserted])]
    .filter((f) => !out.find((k) => k.frame === f)?.keyed?.length);
  return withoutRedundantKeys(edited, spare);
}

/** The property's keys at `frames` moved by `delta`, onto any key of its
 *  own already there. */
export function moveChannelKeys(
  track: Track, node: Node, prop: TimelineProp, frames: readonly number[], delta: number,
): Track {
  if (delta === 0 || !frames.length) return track;
  const keys = channelKeys(track, prop);
  const pick = new Set(frames);
  const moved = keys.filter((k) => pick.has(k.frame)).map((k) => ({ ...k, frame: Math.max(0, k.frame + delta) }));
  const landed = new Set(moved.map((k) => k.frame));
  const kept = keys.filter((k) => !pick.has(k.frame) && !landed.has(k.frame));
  return setChannel(track, node, prop, [...kept, ...moved], frames);
}

/** The property without its keys at `frames`: it eases straight from the
 *  key before to the key after, as in Spine. */
export function deleteChannelKeys(track: Track, node: Node, prop: TimelineProp, frames: readonly number[]): Track {
  const pick = new Set(frames);
  const keys = channelKeys(track, prop);
  if (!keys.some((k) => pick.has(k.frame))) return track;
  // No keys left: back to the setup pose, as in Spine.
  return setChannel(track, node, prop, keys.filter((k) => !pick.has(k.frame)), frames, valuesOf(prop, node.bind));
}

/**
 * A key of the property at `frame`, holding the value it has there, the
 * interval it cuts eased in two so nothing moves (Spine's key button for one
 * property). No-op where it already has one.
 */
export function keyChannelAt(track: Track, node: Node, prop: TimelineProp, frame: number): Track {
  const keys = channelKeys(track, prop);
  if (keys.some((k) => k.frame === frame)) return track;
  const t = prop === "rotate" || prop === "shear" ? unwrapTurns(track) : track;
  const values = valuesOf(prop, sampleTransformRaw(t, frame) ?? node.bind);
  const b = keys.findIndex((k) => k.frame > frame);
  const a = b > 0 ? keys[b - 1]! : null;
  let added: ChannelKey = { frame, values, eases: LEAVES[prop].map(() => TWEEN_LINEAR as TweenSpec) };
  let next = keys;
  if (a && b >= 0) {
    const span = keys[b]!.frame - a.frame;
    const halves = a.eases.map((e) => (e.kind === "none" ? null : splitTween(e, span, frame - a.frame)));
    next = keys.map((k) => (k === a
      ? { ...a, eases: a.eases.map((e, n) => halves[n]?.[0] ?? e) }
      : k));
    added = { ...added, eases: a.eases.map((e, n) => halves[n]?.[1] ?? (e.kind === "none" ? e : TWEEN_LINEAR)) };
  }
  return setChannel(track, node, prop, [...next, added]);
}
