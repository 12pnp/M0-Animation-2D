import { keyedConstraint, channelTimeline } from "@/core/doc/constraintKeys";
import { orderAt, toOffsets } from "@/core/doc/drawOrder";
import { eventValues } from "@/core/doc/events";
import type { IkId, CnId, TcId, NodeId } from "@/core/doc/ids";
import { localAt } from "@/core/doc/pose";
import { usedMixes } from "@/core/doc/transformKeys";
import { type Node, type SymbolItem, type Animation, type IkKey, type MeshData, type TcChannel, type TransformConstraint, TC_CHANNELS, DEFAULT_COLOR, type ColorTransform } from "@/core/doc/types";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { type TweenChannel, sameEase, easeOf } from "@/core/math/easing";
import type { Transform } from "@/core/math/Transform";
import { type DeformTarget, deformKeysOf } from "@/core/mesh/deform";
import { type MeshBones, boneburstDeform } from "@/core/mesh/meshPose";
import { nonZero } from "./exportStructure";
import { sliceRuns, transformChannel, type Row, keyBase, runsOf, colorChannel, scaleAlpha } from "./exportChannels";
import { lightHex, darkHex, tintChannels, colorHex, byte } from "./exportColor";
import type { Run, SlotPlan } from "./exportTypes";
import { type BoneBurstLocal, keyValues, toBoneBurstLocal, type BoneBurstKeyValues, keyTime } from "./transform";
import type { BoneBurstBoneTimelines, BoneBurstCurve, BoneBurstIkConstraint, BoneBurstIkKey, BoneBurstTransformConstraint, BoneBurstTransformKey, BoneBurstEventData, BoneBurstEventKey, BoneBurstDrawOrderKey, BoneBurstSlotTimelines, BoneBurstAttachmentKey, BoneBurstRgba2Key, BoneBurstRgbaKey } from "./types";

/* ── bone timelines ──────────────────────────────────────────────────────── */
export function boneTimelines(
  node: Node, runs: Run[], setup: BoneBurstLocal, fps: number, diags: ExportDiagnostic[]): { timelines: BoneBurstBoneTimelines; lastFrame: number; } | null {
  const out: BoneBurstBoneTimelines = {};
  let lastFrame = 0;
  const kv = (t: Transform) => keyValues(toBoneBurstLocal(t), setup);
  const rowsOf = (channel: TweenChannel) => sliceRuns(runs, (anim) => transformChannel(anim?.tracks[node.id], node.bind, channel)).map((r) => ({ r, v: kv(r.t) }));
  const base = (r: Row<Transform>, channels: (v: BoneBurstKeyValues) => number[]) => {
    lastFrame = Math.max(lastFrame, r.frame);
    return keyBase(r, fps, (t) => channels(kv(t)));
  };
  const moves = (vs: Array<{ v: BoneBurstKeyValues; }>, pick: (v: BoneBurstKeyValues) => number[], rest: number) => vs.some(({ v }) => pick(v).some((x) => Math.abs(x - rest) > 1e-9));

  // Two axes eased apart anywhere: a timeline per axis (translatex and
  // translatey), each with its own keys. Otherwise one timeline for both.
  const apart = (p: TweenChannel, q: TweenChannel) => runs.some(({ anim }) => anim?.tracks[node.id]?.keys.some((k) => !sameEase(easeOf(k, p), easeOf(k, q))));
  type Axis = { key: keyof BoneBurstKeyValues; channel: TweenChannel; timeline: string; };
  const perAxis = (axes: Axis[], rest: number) => {
    for (const { key, channel, timeline } of axes) {
      const rows = rowsOf(channel);
      if (!moves(rows, (v) => [v[key]!], rest)) continue;
      out[timeline] = rows.map(({ r, v }) => {
        const k: { time?: number; curve?: BoneBurstCurve; value?: number; } = base(r, (w) => [w[key]!]);
        if (v[key] !== rest) k.value = v[key]!;
        return k;
      });
    }
  };

  if (apart("x", "y")) {
    perAxis([{ key: "x", channel: "x", timeline: "translatex" }, { key: "y", channel: "y", timeline: "translatey" }], 0);
  } else {
    const pos = rowsOf("x");
    if (moves(pos, (v) => [v.x, v.y], 0)) {
      out.translate = pos.map(({ r, v }) => ({ ...base(r, (w) => [w.x, w.y]), ...nonZero({ x: v.x, y: v.y }) }));
    }
  }

  const rot = rowsOf("rotation");
  if (moves(rot, (v) => [v.rotate], 0)) {
    out.rotate = rot.map(({ r, v }) => ({ ...base(r, (w) => [w.rotate]), ...nonZero({ value: v.rotate }) }));
  }
  const shr = rowsOf("shear");
  if (moves(shr, (v) => [v.shearX, v.shearY], 0)) {
    out.shear = shr.map(({ r, v }) => ({ ...base(r, (w) => [w.shearX, w.shearY]), ...nonZero({ x: v.shearX, y: v.shearY }) }));
  }

  const scl = rowsOf("scaleX");
  if (scl.some(({ v }) => v.scaleX === null || v.scaleY === null)) {
    diags.push({
      severity: "error",
      message: `"${node.name}" is keyed away from a setup scale of 0, which Spine cannot animate (its scale keys multiply the setup scale).`,
    });
  } else if (apart("scaleX", "scaleY")) {
    perAxis([{ key: "scaleX", channel: "scaleX", timeline: "scalex" }, { key: "scaleY", channel: "scaleY", timeline: "scaley" }], 1);
  } else if (moves(scl, (v) => [v.scaleX!, v.scaleY!], 1)) {
    out.scale = scl.map(({ r, v }) => {
      const k: { time?: number; curve?: BoneBurstCurve; x?: number; y?: number; } = base(r, (w) => [w.scaleX!, w.scaleY!]);
      if (v.scaleX !== 1) k.x = v.scaleX!;
      if (v.scaleY !== 1) k.y = v.scaleY!;
      return k;
    });
  }

  return Object.keys(out).length ? { timelines: out, lastFrame } : null;
}
/* ── IK keys ─────────────────────────────────────────────────────────────── */
/**
 * The animation's IK keys as Spine's `ik` timelines, one per constraint the
 * export wrote. The bend is inverted like the constraint's (the y flip).
 * Every key writes its softness (the constraint's when it has none) and the
 * compress and stretch an opened constraint carries, since a key without
 * them sets them back to Spine's defaults. A tween is one cubic, written
 * over the mix and over the softness: Spine reads both halves.
 */
export function ikTimelines(
  sym: SymbolItem, anim: Animation, written: ReadonlyMap<IkId, BoneBurstIkConstraint>, fps: number): Record<string, BoneBurstIkKey[]> | null {
  const out: Record<string, BoneBurstIkKey[]> = {};
  for (const k of sym.ik) {
    const keys = anim.ik?.[k.id];
    const c = written.get(k.id);
    if (!keys?.length || !c) continue;
    const softOf = (key: IkKey) => key.softness ?? k.softness ?? 0;
    out[c.name] = keys.map((key, i) => {
      const o: BoneBurstIkKey = {};
      const time = keyTime(key.frame, fps);
      if (time) o.time = time;
      if (key.mix !== 1) o.mix = key.mix;
      const soft = softOf(key);
      if (soft) o.softness = soft;
      if (key.bendPositive) o.bendPositive = false;
      if (c.compress) o.compress = true;
      if (c.stretch) o.stretch = true;
      const next = keys[i + 1];
      if (next && key.tween?.kind === "none") o.curve = "stepped";
      else if (next && key.tween?.kind === "curve") {
        const [x1, y1, x2, y2] = key.tween.curve as [number, number, number, number];
        const t0 = key.frame / fps, span = (next.frame - key.frame) / fps, dv = next.mix - key.mix, ds = softOf(next) - soft;
        o.curve = [t0 + x1 * span, key.mix + y1 * dv, t0 + x2 * span, key.mix + y2 * dv, t0 + x1 * span, soft + y1 * ds, t0 + x2 * span, soft + y2 * ds];
      }
      return o;
    });
  }
  return Object.keys(out).length ? out : null;
}
/**
 * The exported symbol's physics, slider and path keys as Spine's `physics`,
 * `slider` and `path` timelines, by constraint name (`core/doc/constraintKeys.ts`).
 */
export function constraintKeyTimelines(sym: SymbolItem, anim: Animation, fps: number): { timelines: Record<string, Record<string, Record<string, unknown>>>; lastFrame: number; } {
  const timelines: Record<string, Record<string, Record<string, unknown>>> = {};
  let lastFrame = 0;
  for (const [id, channels] of Object.entries(anim.constraintKeys ?? {})) {
    const c = keyedConstraint(sym, id as CnId);
    if (!c) continue;
    for (const [channel, keys] of Object.entries(channels)) {
      if (!keys.length) continue;
      const group = c.kind === "slider" ? "slider" : c.kind;
      ((timelines[group] ??= {})[c.k.name] ??= {})[channel] = channelTimeline(keys, fps, c.kind === "path" && channel === "mix");
      lastFrame = Math.max(lastFrame, keys[keys.length - 1]!.frame);
    }
  }
  return { timelines, lastFrame };
}
/* ── deform keys ─────────────────────────────────────────────────────────── */
/**
 * The animation's deform keys as Spine's `deform` timelines, per mesh display
 * of the exported symbol whose point count the keys fit: offsets in the
 * slot bone's space, or per weighted entry in that bone's setup space
 * (`boneburstDeform`). A tween is one cubic over 0..1, as Spine reads it.
 */
export function deformTimelines(
  anim: Animation,
  meshes: ReadonlyArray<{ target: DeformTarget; slot: string; key: string; mesh: MeshData; bones: MeshBones | null; }>,
  fps: number): { timelines: Record<string, Record<string, Record<string, { deform: Array<{ time?: number; vertices?: number[]; curve?: BoneBurstCurve; }>; }>>>; lastFrame: number; } | null {
  const out: Record<string, Record<string, Record<string, { deform: Array<{ time?: number; vertices?: number[]; curve?: BoneBurstCurve; }>; }>>> = {};
  let lastFrame = 0;
  for (const m of meshes) {
    const keys = deformKeysOf(anim, m.target);
    if (!keys?.length || keys.some((k) => k.offsets.length !== m.mesh.points.length)) continue;
    lastFrame = Math.max(lastFrame, keys[keys.length - 1]!.frame);
    ((out[m.target.skin ?? "default"] ??= {})[m.slot] ??= {})[m.key] = {
      deform: keys.map((key, i) => {
        const o: { time?: number; vertices?: number[]; curve?: BoneBurstCurve; } = {};
        const time = keyTime(key.frame, fps);
        if (time) o.time = time;
        if (key.offsets.some((v) => v !== 0)) o.vertices = boneburstDeform(m.mesh, key.offsets, m.bones);
        const next = keys[i + 1];
        if (next && key.tween?.kind === "none") o.curve = "stepped";
        else if (next && key.tween?.kind === "curve") {
          const [x1, y1, x2, y2] = key.tween.curve as [number, number, number, number];
          const t0 = key.frame / fps, span = (next.frame - key.frame) / fps;
          o.curve = [t0 + x1 * span, y1, t0 + x2 * span, y2];
        }
        return o;
      }),
    };
  }
  return Object.keys(out).length ? { timelines: out, lastFrame } : null;
}
/* ── transform constraints ───────────────────────────────────────────────── */
const TC_MIX: Record<TcChannel, "mixRotate" | "mixX" | "mixY" | "mixScaleX" | "mixScaleY" | "mixShearY"> = {
  rotate: "mixRotate", x: "mixX", y: "mixY", scaleX: "mixScaleX", scaleY: "mixScaleY", shearY: "mixShearY",
};
const TC_OFFSET: Record<TcChannel, "rotation" | "x" | "y" | "scaleX" | "scaleY" | "shearY"> = {
  rotate: "rotation", x: "x", y: "y", scaleX: "scaleX", scaleY: "scaleY", shearY: "shearY",
};
/**
 * A transform constraint as Spine 4.3 writes it. Every mix a property maps
 * to is written, the defaults included: the runtime reads a missing `mixY`
 * as `mixX` and a missing `mixScaleY` as `mixScaleX`, not as 1.
 */
export function transformConstraintOf(k: TransformConstraint, name: string, bones: string[], source: string): BoneBurstTransformConstraint {
  const out: BoneBurstTransformConstraint = { type: "transform", name, bones, source };
  if (k.localSource) out.localSource = true;
  if (k.localTarget) out.localTarget = true;
  if (k.additive) out.additive = true;
  if (k.clamp) out.clamp = true;
  const properties: NonNullable<BoneBurstTransformConstraint["properties"]> = {};
  for (const p of k.properties) {
    const to: Record<string, { offset?: number; max?: number; scale?: number; }> = {};
    for (const t of p.to) {
      const e: { offset?: number; max?: number; scale?: number; } = {};
      if (t.offset) e.offset = t.offset;
      if (t.max !== 1) e.max = t.max;
      if (t.scale !== 1) e.scale = t.scale;
      to[t.to] = e;
    }
    properties[p.from] = p.offset ? { offset: p.offset, to } : { to };
  }
  out.properties = properties;
  for (const c of TC_CHANNELS) {
    const o = k.offsets?.[c];
    if (o) out[TC_OFFSET[c]] = o;
  }
  for (const c of usedMixes(k)) out[TC_MIX[c]] = k.mix[c];
  if (k.spine) Object.assign(out, k.spine);
  return out;
}
/** The animation's transform constraint keys as Spine's `transform`
 *  timelines: all six mixes on every key; a tween is one cubic over each. */
export function transformTimelines(
  sym: SymbolItem, anim: Animation, written: ReadonlyMap<TcId, BoneBurstTransformConstraint>, fps: number): Record<string, BoneBurstTransformKey[]> | null {
  const out: Record<string, BoneBurstTransformKey[]> = {};
  for (const k of sym.transforms ?? []) {
    const keys = anim.transforms?.[k.id];
    const c = written.get(k.id);
    if (!keys?.length || !c) continue;
    out[c.name] = keys.map((key, i) => {
      const o: BoneBurstTransformKey = {};
      const time = keyTime(key.frame, fps);
      if (time) o.time = time;
      for (const ch of TC_CHANNELS) o[TC_MIX[ch]] = key.mix[ch];
      const next = keys[i + 1];
      if (next && key.tween?.kind === "none") o.curve = "stepped";
      else if (next && key.tween?.kind === "curve") {
        const [x1, y1, x2, y2] = key.tween.curve as [number, number, number, number];
        const t0 = key.frame / fps, span = (next.frame - key.frame) / fps;
        o.curve = TC_CHANNELS.flatMap((ch) => {
          const v = key.mix[ch], dv = next.mix[ch] - v;
          return [t0 + x1 * span, v + y1 * dv, t0 + x2 * span, v + y2 * dv];
        });
      }
      return o;
    });
  }
  return Object.keys(out).length ? out : null;
}
/* ── events ──────────────────────────────────────────────────────────────── */
/** The symbol's events as Spine's skeleton `events`, defaults left off. An
 *  event with a sound always writes its volume and balance: spine-core
 *  4.3.13 reads a missing volume as 0 (`Event.volume = 0`), so a volume of 1
 *  left off plays silent. */
export function eventDefsOf(sym: SymbolItem): Record<string, BoneBurstEventData> {
  const out: Record<string, BoneBurstEventData> = {};
  for (const d of sym.events ?? []) {
    const e: BoneBurstEventData = {};
    if (d.int) e.int = d.int;
    if (d.float) e.float = d.float;
    if (d.string) e.string = d.string;
    if (d.audio) {
      e.audio = d.audio;
      e.volume = d.volume ?? 1;
      e.balance = d.balance ?? 0;
    }
    out[d.name] = e;
  }
  return out;
}
/**
 * The animation's event keys as Spine's `events` timeline, each value only
 * where the key overrides the event's. A key of an event with a sound always
 * writes its balance: spine-core 4.3.13 defaults a key's balance to the
 * event's VOLUME (`SkeletonJson`, "balance", setup.volume).
 */
export function eventTimeline(sym: SymbolItem, anim: Animation, fps: number): BoneBurstEventKey[] | null {
  const keys = anim.events?.filter((k) => sym.events?.some((d) => d.name === k.name));
  if (!keys?.length) return null;
  return keys.map((k) => {
    const def = sym.events!.find((d) => d.name === k.name)!;
    const o: BoneBurstEventKey = { name: k.name };
    const time = keyTime(k.frame, fps);
    if (time) o.time = time;
    if (k.int !== undefined) o.int = k.int;
    if (k.float !== undefined) o.float = k.float;
    if (k.string !== undefined) o.string = k.string;
    if (def.audio) {
      if (k.volume !== undefined) o.volume = k.volume;
      o.balance = eventValues(def, k).balance;
    }
    return o;
  });
}
/* ── draw order ──────────────────────────────────────────────────────────── */
/**
 * The animation's draw order keys as Spine's `drawOrder` timeline: each key's
 * order of the top-level layers, as their runs of slots (`blocks`, in setup
 * order) laid out in that order, written as offsets from the setup slot
 * order. A block of layers that do not draw keeps its setup place. A key that
 * is the setup order writes no offsets. Null with no keys.
 */
export function drawOrderTimeline(
  sym: SymbolItem, anim: Animation, setup: readonly string[],
  blocks: ReadonlyArray<{ ids: NodeId[]; start: number; end: number; }>, fps: number): BoneBurstDrawOrderKey[] | null {
  if (!anim.drawOrder?.length) return null;
  return anim.drawOrder.map((k) => {
    const rank = new Map(orderAt(sym, anim, k.frame).map((id, i) => [id, i]));
    // A block goes where the first of its layers is.
    const at = blocks.map((b) => Math.min(...b.ids.map((id) => rank.get(id) ?? Infinity)));
    const moving = blocks.map((b, i) => ({ b, at: at[i]! })).filter((p) => p.at !== Infinity).sort((x, y) => x.at - y.at);
    let m = 0;
    const seq = blocks.map((b, i) => (at[i] === Infinity ? b : moving[m++]!.b));
    const names = seq.flatMap((b) => setup.slice(b.start, b.end));
    const offsets = toOffsets(names, setup).map((o) => ({ slot: o.item, offset: o.offset }));
    const key: BoneBurstDrawOrderKey = {};
    const time = keyTime(k.frame, fps);
    if (time) key.time = time;
    if (offsets.length) key.offsets = offsets;
    return key;
  });
}
export function omitKey(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const out = { ...o };
  delete out[key];
  return out;
}
/* ── slot timelines ──────────────────────────────────────────────────────── */
/**
 * Which attachment a slot shows and in what colour, over one exported
 * animation. Attachments frame by frame from the stage's own `localAt`
 * (nothing outside a track's span, nothing while the instance above is not
 * showing its symbol), written where they change. Colour: the slot's own
 * keys, times the alpha of the instances above; while that alpha is one
 * number the keys are scaled exactly, and while it moves the colour is
 * baked frame by frame.
 */
export function slotTimelines(
  plan: SlotPlan, animName: string, fps: number): { timelines: BoneBurstSlotTimelines; lastFrame: number; } | null {
  const { scope, node, displays, setupName } = plan;
  const frames = scope.frames.get(animName)!;
  const alpha = scope.alpha.get(animName)!;
  const out: BoneBurstSlotTimelines = {};
  let lastFrame = 0;
  const time = (frame: number) => {
    lastFrame = Math.max(lastFrame, frame);
    return frame === 0 ? {} : { time: keyTime(frame, fps) };
  };

  const shownAt = (f: number): string | null => {
    const fa = frames[f];
    if (!fa) return null;
    const st = localAt(node, fa.anim, fa.frame, "animate");
    return st.onTrack && st.displayIndex >= 0 ? displays.get(st.displayIndex) ?? null : null;
  };
  const changes: BoneBurstAttachmentKey[] = [];
  let prev: string | null | undefined;
  for (let f = 0; f < frames.length; f++) {
    const name = shownAt(f);
    if (name !== prev) changes.push({ ...time(f), name });
    prev = name;
  }
  if (changes.length > 1 || (changes.length === 1 && changes[0]!.name !== setupName)) out.attachment = changes;

  if (plan.clip) return Object.keys(out).length ? { timelines: out, lastFrame } : null;
  const runs = runsOf(frames);
  const bind = node.color ?? DEFAULT_COLOR;
  const shown = alpha.filter((_, f) => frames[f]);
  const constant = shown.every((a) => Math.abs(a - shown[0]!) < 1e-12) ? (shown[0] ?? scope.setupAlpha) : null;
  let rows: Row<ColorTransform>[];
  if (constant !== null) {
    rows = sliceRuns(runs, (anim) => {
      const ch = colorChannel(anim?.tracks[node.id], bind);
      const scale = (c: ColorTransform) => scaleAlpha(c, constant);
      return {
        rows: ch.rows.map((r) => ({ ...r, t: scale(r.t), ...(r.curve ? { curve: { ...r.curve, from: scale(r.curve.from), to: scale(r.curve.to) } } : {}) })),
        at: (f) => scale(ch.at(f)),
      };
    });
  } else {
    rows = [];
    frames.forEach((fa, f) => {
      if (!fa) return;
      const c = colorChannel(fa.anim?.tracks[node.id], bind).at(fa.frame);
      rows.push({ frame: f, t: scaleAlpha(c, alpha[f]!), stepped: false });
    });
  }
  // The runtime's frame colours are the 8-bit ones the file holds, so a
  // curve's control values are mixed from those.
  const setupBind = scaleAlpha(bind, scope.setupAlpha);
  if (plan.twoColor) {
    const key = (c: ColorTransform) => lightHex(c) + darkHex(c);
    if (rows.some((r) => key(r.t) !== key(setupBind))) {
      lastFrame = Math.max(lastFrame, ...rows.map((r) => r.frame));
      out.rgba2 = rows.map((r): BoneBurstRgba2Key => ({ ...keyBase(r, fps, tintChannels), light: lightHex(r.t), dark: darkHex(r.t) }));
    }
  } else {
    const setupHex = colorHex(setupBind) ?? "ffffffff";
    if (rows.some((r) => (colorHex(r.t) ?? "ffffffff") !== setupHex)) {
      const channels = (c: ColorTransform) => [c.rM, c.gM, c.bM, c.aM].map((m) => byte(m / 100) / 255);
      lastFrame = Math.max(lastFrame, ...rows.map((r) => r.frame));
      out.rgba = rows.map((r): BoneBurstRgbaKey => ({ ...keyBase(r, fps, channels), color: colorHex(r.t) ?? "ffffffff" }));
    }
  }

  return Object.keys(out).length ? { timelines: out, lastFrame } : null;
}

