import { addAnimation } from "@/edit/animations";
import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { updateBone } from "@/edit/bones";
import { CONSTRAINT_KEYS, keyConstraint } from "@/edit/constraintKeys";
import type { Shape } from "@/edit/curves";
import { drawOrderAt, offsetsFor, reorderFront } from "@/edit/drawOrder";
import { defineEvent, deleteEvent, deleteEventKeys, type EventOverrides, type EventPatch, keyEvent, renameEvent } from "@/edit/events";
import type { Edit } from "@/edit/history";
import { deleteKeys, type KeyRef, setKey, setKeyCurve } from "@/edit/keys";
import { boneNumber } from "@/model/defaults";
import type { ConstraintType, Skeleton } from "@/model/skeleton";
import { animationDuration, frameTime, keyLists, keyTime, timeFrame, type TimelinePath } from "@/model/timelines";
import { applyEdit } from "./apply";
import { AI_EASES } from "./eases";
import { type AgentContext, AgentRefused } from "./context";
import { animationOf, docOf, fpsOf } from "./read";

/**
 * The key tools (E5-PLAN step 4): animations made, bones keyed (absolute local values, eases per
 * key and per property), keys deleted, constraints, draw order, events and inherit modes keyed,
 * poses pinned. Each call is one History step labelled "AI: …".
 */

type Args = Record<string, unknown>;
type Ease = string | readonly number[];

const PROPS = ["x", "y", "rotation", "scaleX", "scaleY"] as const;
type Prop = (typeof PROPS)[number];
const TIMELINE_OF: Record<Prop, BoneProperty> = { x: "translate", y: "translate", rotation: "rotate", scaleX: "scale", scaleY: "scale" };
/** The properties each bone timeline's channels hold, in channel order. */
const CHANNEL_PROPS: Record<string, readonly Prop[]> = {
  rotate: ["rotation"], translate: ["x", "y"], translatex: ["x"], translatey: ["y"], scale: ["scaleX", "scaleY"], scalex: ["scaleX"], scaley: ["scaleY"],
};

/** A key's ease as a shape (null: straight), "stepped" for hold. */
function shapeOf(e: Ease | undefined): Shape | null | "stepped" {
  if (e === undefined || e === "linear") return null;
  if (e === "hold" || e === "stepped") return "stepped";
  if (e === "in") return AI_EASES.in;
  if (e === "out") return AI_EASES.out;
  if (e === "inout" || e === "smooth") return AI_EASES.inout;
  return e as unknown as Shape;
}

/** Said when an ease is given to a key with nothing after it yet. */
const LAST_KEY = "This is the last key on its timeline, so its ease has no interval to shape and was not kept: key the next frame first, or set the ease again once it exists.";

const lastFrame = (doc: Skeleton, name: string) => timeFrame(animationDuration(doc.animations!.find((a) => a.name === name)!), fpsOf(doc));

function boneOf(doc: Skeleton, name: string) {
  const b = doc.bones?.find((x) => x.name === name);
  if (!b) throw new AgentRefused(`There is no bone "${name}".`);
  return b;
}

/** Edits applied one after another, as one. */
const all = (edits: readonly Edit<Skeleton>[]): Edit<Skeleton> => (s) => edits.reduce((d, e) => e(d), s);

// ── animations and bone keys ──

function newAnimation(args: Args, ctx: AgentContext) {
  const name = String(args.name);
  applyEdit(ctx, `new_animation ${name}`, addAnimation(name));
  return { animation: name, frames: 0, note: `A Spine animation lasts until its last key: key frame ${args.frames} (set_keys) to make it ${args.frames} frames long.` };
}

interface KeyArg { bone: string; frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; ease?: Ease; eases?: Partial<Record<Prop, Ease>> }

function setKeys(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, fps = fpsOf(doc), skin = ctx.view().skin;
  // Merged by bone and frame: a later key's values over an earlier one's.
  const groups = new Map<string, KeyArg>();
  for (const k of args.keys as KeyArg[]) {
    boneOf(doc, k.bone);
    const id = `${k.bone}\u0000${k.frame}`;
    groups.set(id, { ...groups.get(id), ...k });
  }
  const values: Edit<Skeleton>[] = [], curves: { bone: string; time: number; ease?: Ease; eases?: KeyArg["eases"]; props: Set<BoneProperty> }[] = [];
  const poses = new Map<number, Map<string, readonly number[]>>();
  for (const g of groups.values()) {
    const given = PROPS.filter((p) => g[p] !== undefined);
    if (!given.length) throw new AgentRefused(`The key for "${g.bone}" at frame ${g.frame} sets nothing: give x, y, rotation, scaleX or scaleY.`);
    const time = frameTime(g.frame, fps);
    // What the key leaves out: the animation's value there before this call.
    if (!poses.has(time)) poses.set(time, new Map(ctx.pose(skin, anim, time).map((b) => [b.name, b.local])));
    const [x, y, rotation, scaleX, scaleY, shearX, shearY] = poses.get(time)!.get(g.bone)! as number[];
    const local: LocalPose = { x: g.x ?? x!, y: g.y ?? y!, rotation: g.rotation ?? rotation!, scaleX: g.scaleX ?? scaleX!, scaleY: g.scaleY ?? scaleY!, shearX: shearX!, shearY: shearY! };
    const props = new Set(given.map((p) => TIMELINE_OF[p]));
    values.push(keyBone(anim, g.bone, [...props], local, time));
    curves.push({ bone: g.bone, time, ...(g.ease !== undefined ? { ease: g.ease } : {}), ...(g.eases ? { eases: g.eases } : {}), props });
  }
  // Curves after every value is in place, so each interval is measured to its final next key.
  const shaped: Edit<Skeleton> = (s) => {
    let out = s;
    const a = s.animations!.find((x) => x.name === anim)!;
    for (const c of curves) {
      for (const { path, keys } of keyLists(a)) {
        if (path.section !== "bones" || !("owner" in path) || path.owner !== c.bone || !("timeline" in path)) continue;
        const props = CHANNEL_PROPS[path.timeline];
        if (!props || !props.some((p) => c.props.has(TIMELINE_OF[p]))) continue;
        if (!keys.some((k) => Math.abs(keyTime(k) - c.time) <= 1e-5)) continue;
        const whole = shapeOf(c.ease);
        const curve = whole === "stepped" ? "stepped" : props.map((p) => { const e = shapeOf(c.eases?.[p] ?? c.ease); return e === "stepped" ? null : e; });
        out = setKeyCurve(anim, { path, time: c.time }, curve)(out);
      }
    }
    return out;
  };
  applyEdit(ctx, `set_keys ${groups.size} key${groups.size === 1 ? "" : "s"} in ${anim}`, all([...values, shaped]));
  const doc2 = docOf(ctx), a2 = doc2.animations!.find((x) => x.name === anim)!;
  // Eases given to keys that are still the last on their timeline: nothing to shape yet.
  const unshaped = curves.filter((c) => (c.ease !== undefined && c.ease !== "linear") || (c.eases && Object.values(c.eases).some((e) => e !== "linear")))
    .filter((c) => !keyLists(a2).some((l) => l.path.section === "bones" && "owner" in l.path && l.path.owner === c.bone && l.keys.some((k) => keyTime(k) > c.time + 1e-5)))
    .map((c) => `${c.bone} at frame ${timeFrame(c.time, fps)}`);
  return { animation: anim, keyed: groups.size, bones: [...new Set([...groups.values()].map((g) => g.bone))], frames: lastFrame(doc2, anim), ...(unshaped.length ? { note: `${LAST_KEY} (${unshaped.join(", ")})` } : {}) };
}

function deleteKeysTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), fps = fpsOf(doc);
  const refs: KeyRef[] = [], missing: string[] = [];
  for (const { bone, frame } of args.keys as { bone: string; frame: number }[]) {
    boneOf(doc, bone);
    const time = frameTime(frame, fps);
    const here = keyLists(a).filter((l) => l.path.section === "bones" && "owner" in l.path && l.path.owner === bone && l.keys.some((k) => Math.abs(keyTime(k) - time) <= 1e-5));
    if (!here.length) missing.push(`${bone} at frame ${frame}`);
    for (const l of here) refs.push({ path: l.path, time: l.keys.find((k) => Math.abs(keyTime(k) - time) <= 1e-5)!.time ?? 0 });
  }
  if (!refs.length) throw new AgentRefused(`No key to delete: ${missing.join(", ")} has none.`);
  applyEdit(ctx, `delete_keys in ${a.name}`, deleteKeys(a.name, refs));
  return { animation: a.name, deleted: refs.length, ...(missing.length ? { missing } : {}), frames: lastFrame(docOf(ctx), a.name) };
}

function keyPropertiesTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, fps = fpsOf(doc), frame = args.frame as number, time = frameTime(frame, fps);
  const which = (args.properties ?? "changed") as "changed" | "all" | BoneProperty[];
  const posed = new Map(ctx.pose(ctx.view().skin, anim, time).map((b) => [b.name, b.local]));
  const edits: Edit<Skeleton>[] = [], keyed: Record<string, BoneProperty[]> = {};
  for (const name of args.layers as string[]) {
    const b = boneOf(doc, name), [x, y, rotation, scaleX, scaleY, shearX, shearY] = posed.get(name)! as number[];
    const local = { x: x!, y: y!, rotation: rotation!, scaleX: scaleX!, scaleY: scaleY!, shearX: shearX!, shearY: shearY! };
    const off = (v: number, k: Parameters<typeof boneNumber>[1]) => Math.abs(v - boneNumber(b, k)) > 1e-4;
    const props: BoneProperty[] = which === "all" ? ["rotate", "translate", "scale", "shear"]
      : which === "changed" ? ([
        off(local.rotation, "rotation") && "rotate", (off(local.x, "x") || off(local.y, "y")) && "translate",
        (off(local.scaleX, "scaleX") || off(local.scaleY, "scaleY")) && "scale", (off(local.shearX, "shearX") || off(local.shearY, "shearY")) && "shear",
      ].filter(Boolean) as BoneProperty[]) : which;
    if (!props.length) continue;
    keyed[name] = props;
    edits.push(keyBone(anim, name, props, local, time));
  }
  if (!edits.length) return { animation: anim, frame, keyed, note: "Nothing differs from the setup pose there; nothing keyed." };
  applyEdit(ctx, `key_properties at frame ${frame} in ${anim}`, all(edits));
  return { animation: anim, frame, keyed };
}

// ── constraints ──

function constraintOf(doc: Skeleton, name: string, types: readonly ConstraintType[]) {
  const c = doc.constraints?.find((k) => k.name === name && types.includes(k.type));
  if (!c) {
    const names = (doc.constraints ?? []).filter((k) => types.includes(k.type)).map((k) => k.name);
    throw new AgentRefused(`There is no ${types.join(" or ")} constraint "${name}"${names.length ? `; the rig has ${names.join(", ")}` : ""}.`);
  }
  return c;
}

/**
 * Key `fields` of a constraint at `time` (the others at their values in force there), the key's
 * curve set by `ease`, or `remove` the key.
 */
function keyConstraintFields(ctx: AgentContext, anim: string, type: ConstraintType, name: string, path: TimelinePath, time: number, fields: Record<string, number | boolean>, ease: Ease | undefined, remove: boolean, label: string) {
  if (remove) {
    const a = animationOf(docOf(ctx), anim);
    const here = keyLists(a).find((l) => JSON.stringify(l.path) === JSON.stringify(path))?.keys.find((k) => Math.abs(keyTime(k) - time) <= 1e-5);
    if (!here) throw new AgentRefused(`"${name}" has no key at that frame in "${anim}".`);
    applyEdit(ctx, `${label} (delete)`, deleteKeys(anim, [{ path, time: here.time ?? 0 }]));
    return { deleted: true };
  }
  const now: Record<string, number | boolean> = { ...(ctx.constraintNow(ctx.view().skin, anim, time, type, name) ?? {}) };
  const edits: Edit<Skeleton>[] = [];
  const entries = Object.entries(fields);
  // With nothing given, the key holds what is in force there.
  if (!entries.length) {
    const first = Object.keys(CONSTRAINT_KEYS[type]).find((f) => (CONSTRAINT_KEYS[type][f]!.timeline ?? null) === ("timeline" in path ? path.timeline : null))!;
    entries.push([first, now[first]!]);
  }
  for (const [field, value] of entries) {
    now[field] = value;
    edits.push(keyConstraint(anim, { type, name }, field, value, { ...now }, time));
  }
  const shape = shapeOf(ease);
  const last = !keyLists(animationOf(docOf(ctx), anim)).find((l) => JSON.stringify(l.path) === JSON.stringify(path))?.keys.some((k) => keyTime(k) > time + 1e-5);
  const n = type === "transform" ? 6 : type === "ik" ? 2 : "timeline" in path && path.timeline === "mix" && type === "path" ? 3 : 1;
  edits.push(setKeyCurve(anim, { path, time }, shape === "stepped" ? "stepped" : new Array(n).fill(shape)));
  applyEdit(ctx, label, all(edits));
  return { keyed: Object.fromEntries(entries), ...(last && shape !== null ? { note: LAST_KEY } : {}) };
}

function keyIk(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, name = String(args.ik), c = constraintOf(doc, name, ["ik"]);
  const time = frameTime(args.frame as number, fpsOf(doc));
  const fields = Object.fromEntries((["mix", "bendPositive", "softness"] as const).filter((f) => args[f] !== undefined).map((f) => [f, args[f] as number | boolean]));
  const out = keyConstraintFields(ctx, anim, "ik", c.name, { section: "ik", owner: c.name }, time, fields, args.ease as Ease | undefined, args.delete === true, `key_ik ${c.name} at frame ${args.frame}`);
  return { animation: anim, ik: c.name, frame: args.frame, ...out };
}

const TRANSFORM_MIX: Record<string, string> = { rotate: "mixRotate", x: "mixX", y: "mixY", scaleX: "mixScaleX", scaleY: "mixScaleY", shearY: "mixShearY" };

function keyTransform(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, name = String(args.constraint), c = constraintOf(doc, name, ["transform"]);
  const time = frameTime(args.frame as number, fpsOf(doc));
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries((args.mix ?? {}) as Record<string, number>)) {
    const f = TRANSFORM_MIX[k];
    if (!f) throw new AgentRefused(`key_transform: mix.${k} is not a mix (it takes ${Object.keys(TRANSFORM_MIX).join(", ")}).`);
    if (!(v >= 0 && v <= 1)) throw new AgentRefused(`key_transform: mix.${k} is from 0 to 1.`);
    fields[f] = v;
  }
  const out = keyConstraintFields(ctx, anim, "transform", c.name, { section: "transform", owner: c.name }, time, fields, args.ease as Ease | undefined, args.delete === true, `key_transform ${c.name} at frame ${args.frame}`);
  return { animation: anim, constraint: c.name, frame: args.frame, ...out };
}

/** key_constraint's channels per kind, and the key fields each sets. */
const CHANNELS: Partial<Record<ConstraintType, Record<string, readonly string[]>>> = {
  physics: Object.fromEntries(["mix", "inertia", "strength", "damping", "mass", "wind", "gravity"].map((c) => [c, [c]])),
  slider: { time: ["time"], mix: ["mix"] },
  path: { position: ["position"], spacing: ["spacing"], mix: ["mixRotate", "mixX", "mixY"] },
};

function keyConstraintTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, name = String(args.constraint);
  const c = constraintOf(doc, name, ["physics", "slider", "path"]), channel = String(args.channel);
  const sets = CHANNELS[c.type]![channel];
  if (!sets) throw new AgentRefused(`A ${c.type} constraint keys ${Object.keys(CHANNELS[c.type]!).join(", ")}, not ${channel}.`);
  const frame = args.frame as number;
  if (!(frame >= 0)) throw new AgentRefused("key_constraint: frame is 0 or more.");
  if (args.delete !== true && args.value === undefined) throw new AgentRefused("key_constraint: give the value to key (or delete: true).");
  const spec = CONSTRAINT_KEYS[c.type][sets[0]!]!;
  const path = { section: c.type, owner: c.name, timeline: spec.timeline! } as TimelinePath;
  const fields = Object.fromEntries(sets.map((f) => [f, args.value as number]));
  const out = keyConstraintFields(ctx, anim, c.type, c.name, path, frameTime(frame, fpsOf(doc)), args.delete === true ? {} : fields, args.ease as Ease | undefined, args.delete === true, `key_constraint ${c.name} ${channel} at frame ${frame}`);
  return { animation: anim, constraint: c.name, channel, frame, ...out };
}

// ── draw order, events, inherit ──

function keyDrawOrder(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), fps = fpsOf(doc), frame = args.frame as number, time = frameTime(frame, fps);
  const slots = (doc.slots ?? []).map((s) => s.name), path: TimelinePath = { section: "drawOrder" };
  if (args.setup === true) {
    applyEdit(ctx, `key_draw_order setup at frame ${frame} in ${a.name}`, setKey(a.name, path, time, {}, ["offsets"]));
    return { animation: a.name, frame, front: [...slots].reverse() };
  }
  const front = args.front as string[] | undefined;
  if (!front?.length) throw new AgentRefused("key_draw_order: give `front` (slots or bones, front first) or setup: true.");
  const current = drawOrderAt(a, slots, time);
  // A bone stands for the slots directly on it, front first as they draw there.
  const named: string[] = [];
  for (const n of front) {
    if (slots.includes(n)) { named.push(n); continue; }
    const on = (doc.slots ?? []).filter((s) => s.bone === n).map((s) => s.name);
    if (!doc.bones?.some((b) => b.name === n)) throw new AgentRefused(`There is no slot or bone "${n}".`);
    if (!on.length) throw new AgentRefused(`The bone "${n}" has no slot on it.`);
    named.push(...[...current].reverse().filter((s) => on.includes(s)));
  }
  const order = reorderFront(current, [...new Set(named)]), offsets = offsetsFor(slots, order);
  applyEdit(ctx, `key_draw_order at frame ${frame} in ${a.name}`, offsets.length ? setKey(a.name, path, time, { offsets }) : setKey(a.name, path, time, {}, ["offsets"]));
  return { animation: a.name, frame, front: [...order].reverse() };
}

function defineEventTool(args: Args, ctx: AgentContext) {
  const name = String(args.name);
  if (args.delete === true) { applyEdit(ctx, `define_event ${name} (delete)`, deleteEvent(name)); return { deleted: name }; }
  const patch = Object.fromEntries((["int", "float", "string", "audio", "volume", "balance"] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]])) as EventPatch;
  const rename = args.rename as string | undefined;
  const exists = docOf(ctx).events?.some((e) => e.name === name);
  if (rename !== undefined && !exists) throw new AgentRefused(`There is no event "${name}" to rename.`);
  applyEdit(ctx, `define_event ${name}`, all([...(Object.keys(patch).length || !exists ? [defineEvent(name, patch)] : []), ...(rename !== undefined ? [renameEvent(name, rename)] : [])]));
  const e = docOf(ctx).events!.find((x) => x.name === (rename ?? name))!;
  return { event: { name: e.name, int: e.int ?? 0, float: e.float ?? 0, string: e.string ?? "", ...(e.audio ? { audio: e.audio, volume: e.volume ?? 1, balance: e.balance ?? 0 } : {}) } };
}

function keyEventTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), frame = args.frame as number, time = frameTime(frame, fpsOf(doc)), event = String(args.event);
  if (args.delete === true) {
    applyEdit(ctx, `key_event ${event} at frame ${frame} (delete)`, deleteEventKeys(a.name, time, event));
    return { animation: a.name, frame, event, deleted: true };
  }
  const overrides = Object.fromEntries((["int", "float", "string", "volume", "balance"] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]])) as EventOverrides;
  applyEdit(ctx, `key_event ${event} at frame ${frame} in ${a.name}`, keyEvent(a.name, time, event, overrides));
  return { animation: a.name, frame, event, ...overrides };
}

function setInherit(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), bone = boneOf(doc, String(args.bone)).name, inherit = args.inherit as string | undefined;
  if (args.animation === undefined) {
    if (!inherit) throw new AgentRefused("set_inherit: give `inherit`.");
    applyEdit(ctx, `set_inherit ${bone} ${inherit}`, updateBone(bone, { inherit: inherit === "normal" ? undefined : inherit }));
    return { bone, inherit };
  }
  const a = animationOf(doc, args.animation), frame = args.frame as number | undefined;
  if (frame === undefined || !(frame >= 0)) throw new AgentRefused("set_inherit: keying in an animation needs `frame` (0 or more).");
  const time = frameTime(frame, fpsOf(doc)), path: TimelinePath = { section: "bones", owner: bone, timeline: "inherit" };
  if (args.delete === true) {
    applyEdit(ctx, `set_inherit ${bone} at frame ${frame} (delete)`, deleteKeys(a.name, [{ path, time }]));
    return { bone, animation: a.name, frame, deleted: true };
  }
  if (!inherit) throw new AgentRefused("set_inherit: give `inherit` (or delete: true).");
  applyEdit(ctx, `set_inherit ${bone} ${inherit} at frame ${frame}`, setKey(a.name, path, time, { inherit }));
  return { bone, animation: a.name, frame, inherit };
}

export const KEY_TOOLS = {
  new_animation: newAnimation,
  set_keys: setKeys,
  delete_keys: deleteKeysTool,
  key_properties: keyPropertiesTool,
  key_ik: keyIk,
  key_transform: keyTransform,
  key_constraint: keyConstraintTool,
  key_draw_order: keyDrawOrder,
  define_event: defineEventTool,
  key_event: keyEventTool,
  set_inherit: setInherit,
} as const;
