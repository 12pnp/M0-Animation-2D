import { boneburstPolyline } from "./bezier";
import { type Json, list, num, parseColor, obj } from "./rigJson";
import { type BoneBurstInherit, type TimelineBody, type Timeline, type SkinData, type SequenceMode, type PhysicsProp, type PathData, type MeshData, type Interval, type EventFire, type ClippingData, type Channel, type BoxData, type BoneProp, type AnimationData, TRANSFORM_PROPS, PHYSICS_PROPS, type TransformMix, type TransformProp } from "./rigTypes";

/** A transform key's mixes: absent ones 1, except y, which takes x's
 *  (scale y does not take scale x's; measured). */
export function keyMixes(k: Json): TransformMix {
  const x = num(k.mixX, 1);
  return {
    rotate: num(k.mixRotate, 1), x, y: num(k.mixY, x),
    scaleX: num(k.mixScaleX, 1), scaleY: num(k.mixScaleY, 1), shearY: num(k.mixShearY, 1),
  };
}
/** The latest key time anywhere under `v`: every timeline counts toward the
 *  duration, including the ones this runtime does not play. */
function lastTime(v: unknown): number {
  if (Array.isArray(v)) {
    let t = 0;
    for (const e of v) {
      // As the runtime stores key times: 32-bit, so a loop wraps where it does.
      if (e && typeof e === "object" && !Array.isArray(e)) t = Math.max(t, Math.fround(num((e as Json).time, 0)));
      t = Math.max(t, lastTime(e));
    }
    return t;
  }
  if (v && typeof v === "object") {
    let t = 0;
    for (const e of Object.values(v as Json)) if (e && typeof e === "object") t = Math.max(t, lastTime(e));
    return t;
  }
  return 0;
}
/** The scalar channels of a timeline's keys: `pick(key, i)` reads channel
 *  `i`; the key's curve holds four numbers per channel, in order. */
function channels(keys: Json[], count: number, pick: (k: Json, i: number, at: number) => number): Channel[] {
  const out: Channel[] = [];
  // The runtime keeps key times, values and its curve polylines in 32-bit
  // floats; matching that is what holds the pose to it within rounding.
  const f = Math.fround;
  for (let c = 0; c < count; c++) {
    const times = keys.map((k) => f(num(k.time, 0)));
    const values = keys.map((k, at) => f(pick(k, c, at)));
    const curves = keys.map((k, i): Interval => {
      const next = i + 1 < keys.length;
      if (!next || k.curve === undefined) return null;
      if (k.curve === "stepped") return "stepped";
      if (!Array.isArray(k.curve)) return null;
      const cv = k.curve as number[];
      return boneburstPolyline({
        x0: times[i]!, y0: values[i]!,
        c1x: num(cv[c * 4], times[i]!), c1y: num(cv[c * 4 + 1], values[i]!),
        c2x: num(cv[c * 4 + 2], times[i + 1]!), c2y: num(cv[c * 4 + 3], values[i + 1]!),
        x1: times[i + 1]!, y1: values[i + 1]!,
      }).map(f);
    });
    out.push({ times, values, curves });
  }
  return out;
}
const BONE_TIMELINES: Record<string, { props: BoneProp[]; fields: string[]; neutral: number; }> = {
  rotate: { props: ["rotate"], fields: ["value"], neutral: 0 },
  translate: { props: ["x", "y"], fields: ["x", "y"], neutral: 0 },
  translatex: { props: ["x"], fields: ["value"], neutral: 0 },
  translatey: { props: ["y"], fields: ["value"], neutral: 0 },
  scale: { props: ["scaleX", "scaleY"], fields: ["x", "y"], neutral: 1 },
  scalex: { props: ["scaleX"], fields: ["value"], neutral: 1 },
  scaley: { props: ["scaleY"], fields: ["value"], neutral: 1 },
  shear: { props: ["shearX", "shearY"], fields: ["x", "y"], neutral: 0 },
  shearx: { props: ["shearX"], fields: ["value"], neutral: 0 },
  sheary: { props: ["shearY"], fields: ["value"], neutral: 0 },
};
/** A stable number per attachment, for the property ids of its deform and sequence keys. */
const attachmentIds = new WeakMap<object, number>();
let nextAttachmentId = 1;
function attachmentId(a: object): number {
  let id = attachmentIds.get(a);
  if (id === undefined) attachmentIds.set(a, (id = nextAttachmentId++));
  return id;
}
/** The property ids a bone timeline kind sets, as the mix's hold modes count them. */
const BONE_IDS: Record<string, string[]> = {
  rotate: ["r"], translate: ["x", "y"], translatex: ["x"], translatey: ["y"],
  scale: ["sx", "sy"], scalex: ["sx"], scaley: ["sy"], shear: ["hx", "hy"], shearx: ["hx"], sheary: ["hy"],
};
/** The animation sections `readAnimation` plays. */
const PLAYED_SECTIONS = new Set(["bones", "slots", "ik", "transform", "path", "physics", "slider", "attachments", "drawOrder", "draworder", "events"]);
export function readAnimation(
  name: string, raw: Json, boneIndex: Map<string, number>, slotIndex: Map<string, number>,
  constraintIndex: Map<string, number>, slotCount: number, skins: SkinData[],
  eventData: Map<string, EventFire>, unsupported: Set<string>): AnimationData {
  const timelines: Timeline[] = [];
  // Each of the file's timelines is one unit, which may be several of ours
  // (one per value channel); a unit's property ids decide its hold mode.
  let units = 0, sealed = 0;
  const seal = (ids: string[]) => {
    const unit = units++;
    for (let i = sealed; i < timelines.length; i++) Object.assign(timelines[i]!, { unit, ids });
    sealed = timelines.length;
  };
  const push = (t: TimelineBody) => timelines.push(t as Timeline);

  // In spine-core's order: slots, bones, constraints, attachments, draw order, events.
  for (const [slotName, groups] of Object.entries(obj(raw.slots))) {
    const slot = slotIndex.get(slotName);
    if (slot === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "attachment") {
        push({
          kind: "attachment", slot, times: keys.map((k) => Math.fround(num(k.time, 0))),
          names: keys.map((k) => (typeof k.name === "string" ? k.name : null)),
        });
        seal([`attachment ${slot}`]);
      } else if (kind === "rgba" || kind === "rgb") {
        const n = kind === "rgba" ? 4 : 3;
        const chans = channels(keys, n, (k, i) => parseColor(k.color)[i]!);
        chans.forEach((channel, index) => push({ kind: "color", slot, index, channel }));
        seal(kind === "rgba" ? [`rgb ${slot}`, `alpha ${slot}`] : [`rgb ${slot}`]);
      } else if (kind === "rgba2" || kind === "rgb2") {
        // The light colour's channels, then the dark's r g b.
        const light = kind === "rgba2" ? 4 : 3;
        const chans = channels(keys, light + 3, (k, i) => (i < light ? parseColor(k.light)[i]! : parseColor(k.dark)[i - light]!));
        chans.forEach((channel, i) => push({ kind: "color", slot, index: i < light ? i : 4 + i - light, channel }));
        seal(kind === "rgba2" ? [`rgb ${slot}`, `alpha ${slot}`, `rgb2 ${slot}`] : [`rgb ${slot}`, `rgb2 ${slot}`]);
      } else if (kind === "alpha") {
        const [channel] = channels(keys, 1, (k) => num(k.value, 1));
        push({ kind: "color", slot, index: 3, channel: channel! });
        seal([`alpha ${slot}`]);
      } else {
        unsupported.add(`${kind} keys`);
      }
    }
  }

  for (const [boneName, groups] of Object.entries(obj(raw.bones))) {
    const bone = boneIndex.get(boneName);
    if (bone === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "inherit") {
        push({
          kind: "inherit", bone, times: keys.map((k) => Math.fround(num(k.time, 0))),
          modes: keys.map((k) => (typeof k.inherit === "string" ? k.inherit : "normal") as BoneBurstInherit),
        });
        seal([`inherit ${bone}`]);
        continue;
      }
      const spec = BONE_TIMELINES[kind];
      if (!spec) { unsupported.add(`${kind} keys`); continue; }
      const chans = channels(keys, spec.props.length, (k, i) => num(k[spec.fields[i]!], spec.neutral));
      spec.props.forEach((prop, i) => push({ kind: "bone", bone, prop, channel: chans[i]! }));
      seal(BONE_IDS[kind]!.map((id) => `${id} ${bone}`));
    }
  }

  for (const [constraintName, keysRaw] of Object.entries(obj(raw.ik))) {
    const constraint = constraintIndex.get(constraintName);
    const keys = list(keysRaw);
    if (constraint === undefined || !keys.length) continue;
    // Absolute values; a key without one takes the default, not the setup value.
    const [mix, softness] = channels(keys, 2, (k, i) => (i === 0 ? num(k.mix, 1) : num(k.softness, 0)));
    push({
      kind: "ik", constraint, times: mix!.times, mix: mix!, softness: softness!,
      bendPositive: keys.map((k) => k.bendPositive !== false),
      compress: keys.map((k) => k.compress === true),
      stretch: keys.map((k) => k.stretch === true),
    });
    seal([`ik ${constraint}`]);
  }

  for (const [constraintName, keysRaw] of Object.entries(obj(raw.transform))) {
    const constraint = constraintIndex.get(constraintName);
    const keys = list(keysRaw);
    if (constraint === undefined || !keys.length) continue;
    const mixes = keys.map(keyMixes);
    const chans = channels(keys, 6, (_, i, at) => mixes[at]![TRANSFORM_PROPS[i]!]);
    push({
      kind: "transform", constraint, times: chans[0]!.times,
      mixes: Object.fromEntries(TRANSFORM_PROPS.map((p, i) => [p, chans[i]!])) as Record<TransformProp, Channel>,
    });
    seal([`transform ${constraint}`]);
  }

  for (const [constraintName, groups] of Object.entries(obj(raw.path))) {
    const constraint = constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "position" || kind === "spacing") {
        const [channel] = channels(keys, 1, (k) => num(k.value, 0));
        push({ kind: kind === "position" ? "pathPosition" : "pathSpacing", constraint, times: channel!.times, channel: channel! });
        seal([`path ${kind} ${constraint}`]);
      } else if (kind === "mix") {
        const [rotate, x, y] = channels(keys, 3, (k, i) => {
          const mx = num(k.mixX, 1);
          return i === 0 ? num(k.mixRotate, 1) : i === 1 ? mx : num(k.mixY, mx);
        });
        push({ kind: "pathMix", constraint, times: rotate!.times, rotate: rotate!, x: x!, y: y! });
        seal([`path mix ${constraint}`]);
      } else unsupported.add(`path ${kind} keys`);
    }
  }

  for (const [skinName, bySlot] of Object.entries(obj(raw.attachments))) {
    const skin = skins.find((s) => s.name === skinName);
    for (const [slotName, byAttachment] of Object.entries(obj(bySlot))) {
      const slot = slotIndex.get(slotName);
      if (!skin || slot === undefined) continue;
      for (const [key, groups] of Object.entries(obj(byAttachment))) {
        const attachment = skin.attachments.get(slot)?.get(key);
        if (!attachment) continue;
        for (const [kind, keysRaw] of Object.entries(obj(groups))) {
          const keys = list(keysRaw);
          if (!keys.length) continue;
          if (kind === "deform" && attachment.kind !== "region" && attachment.kind !== "point") {
            push(readDeform(slot, attachment, keys));
            seal([`deform ${slot} ${attachmentId(attachment)}`]);
          } else if (kind === "sequence") {
            // A key without a delay keeps the one before it; mode and index
            // do not carry (measured against spine-core).
            let delay = 0;
            const delays = keys.map((k) => (delay = typeof k.delay === "number" ? Math.fround(k.delay) : delay));
            push({
              kind: "sequence", slot, attachment, times: keys.map((k) => Math.fround(num(k.time, 0))),
              modes: keys.map((k) => (typeof k.mode === "string" ? k.mode : "hold") as SequenceMode),
              indices: keys.map((k) => num(k.index, 0)),
              delays,
            });
            seal([`sequence ${slot} ${attachmentId(attachment)}`]);
          } else unsupported.add(`${kind} keys`);
        }
      }
    }
  }

  // Sections this runtime does not play are said, never dropped silently:
  // 4.3's draw order folders (Timelines.md §3.7) are not played yet.
  for (const section of Object.keys(raw)) if (!PLAYED_SECTIONS.has(section)) unsupported.add(`${section} keys`);

  const drawOrder = list(raw.drawOrder ?? raw.draworder);
  if (drawOrder.length) {
    push({
      kind: "drawOrder", times: drawOrder.map((k) => Math.fround(num(k.time, 0))),
      orders: drawOrder.map((k) => (Array.isArray(k.offsets) ? orderFromOffsets(list(k.offsets), slotIndex, slotCount) : null)),
    });
    seal(["drawOrder"]);
  }

  const events = list(raw.events).filter((k) => eventData.has(String(k.name)));
  if (events.length) {
    push({
      kind: "event", times: events.map((k) => Math.fround(num(k.time, 0))),
      events: events.map((k): EventFire => {
        const e = eventData.get(String(k.name))!;
        return {
          name: e.name, int: num(k.int, e.int), float: num(k.float, e.float),
          string: typeof k.string === "string" ? k.string : e.string, audio: e.audio,
          // Volume and balance only for an event with audio; 0 otherwise (measured).
          volume: e.audio ? num(k.volume, e.volume) : 0, balance: e.audio ? num(k.balance, e.balance) : 0,
        };
      }),
    });
    seal(["event"]);
  }
  for (const [constraintName, groups] of Object.entries(obj(raw.slider))) {
    const constraint = constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind !== "time" && kind !== "mix") { unsupported.add(`slider ${kind} keys`); continue; }
      // Both default to 1 (Format-Json-Atlas.md §11.9; spine-core reads a bare time key as 1).
      const [channel] = channels(keys, 1, (k) => num(k.value, 1));
      push({ kind: kind === "time" ? "sliderTime" : "sliderMix", constraint, times: channel!.times, channel: channel! });
      seal([`slider ${kind} ${constraint}`]);
    }
  }
  for (const [constraintName, groups] of Object.entries(obj(raw.physics))) {
    // An unnamed timeline sets every constraint whose value is global.
    const constraint = constraintName === "" ? -1 : constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "reset") {
        push({ kind: "physicsReset", constraint, times: keys.map((k) => Math.fround(num(k.time, 0))) });
        seal([`physics reset ${constraint}`]);
      } else if ((PHYSICS_PROPS as readonly string[]).includes(kind)) {
        // Mass keys hold the mass; the pose keeps 1 / mass (`Rig.applyTimeline`). Mix defaults
        // to 1, the others to 0 (Format-Json-Atlas.md §11.8).
        const [channel] = channels(keys, 1, (k) => num(k.value, kind === "mix" ? 1 : 0));
        push({ kind: "physics", constraint, prop: kind as PhysicsProp, times: channel!.times, channel: channel! });
        seal([`physics ${kind} ${constraint}`]);
      } else unsupported.add(`physics ${kind} keys`);
    }
  }

  return { name, duration: lastTime(raw), timelines, units, ids: new Set(timelines.flatMap((t) => t.ids)) };
}
/**
 * A deform timeline. A key lists vertex values from `offset`, the rest 0; an
 * unweighted mesh's key is stored as the setup vertices plus those values (so
 * the pose reads it as positions), a weighted one's as the values alone. As
 * the runtime does, both in 32-bit floats.
 */
function readDeform(slot: number, mesh: MeshData | PathData | ClippingData | BoxData, keys: Json[]): TimelineBody {
  const times = keys.map((k) => Math.fround(num(k.time, 0)));
  const vertices = keys.map((k) => {
    const out = new Float64Array(mesh.deformLength);
    if (!mesh.weighted) out.set(mesh.vertices.subarray(0, mesh.deformLength));
    const values = (k.vertices as number[] | undefined) ?? [];
    const at = num(k.offset, 0);
    for (let i = 0; i < values.length && at + i < out.length; i++) out[at + i] = out[at + i]! + values[i]!;
    return out.map(Math.fround);
  });
  const curves = keys.map((k, i): Interval => {
    if (i + 1 >= keys.length || k.curve === undefined) return null;
    if (k.curve === "stepped") return "stepped";
    if (!Array.isArray(k.curve)) return null;
    const cv = k.curve as number[];
    return boneburstPolyline({
      x0: times[i]!, y0: 0, c1x: num(cv[0], times[i]!), c1y: num(cv[1], 0),
      c2x: num(cv[2], times[i + 1]!), c2y: num(cv[3], 1), x1: times[i + 1]!, y1: 1,
    }).map(Math.fround);
  });
  return { kind: "deform", slot, attachment: mesh, times, curves, vertices };
}
/**
 * A draw order key: each listed slot moves `offset` places from where the
 * setup order has it; every other slot keeps its setup order in the places
 * left. Plays a malformed key as spine-core does.
 */
export function orderFromOffsets(offsets: Json[], slotIndex: Map<string, number>, count: number): number[] {
  const order = new Array<number>(count).fill(-1);
  const moved = new Set<number>();
  for (const o of offsets) {
    const slot = slotIndex.get(String(o.slot));
    if (slot === undefined) continue;
    const at = slot + num(o.offset, 0);
    if (at >= 0 && at < count) { order[at] = slot; moved.add(slot); }
  }
  let next = 0;
  for (let slot = 0; slot < count; slot++) {
    if (moved.has(slot)) continue;
    while (order[next] !== -1) next++;
    order[next++] = slot;
  }
  return order;
}
