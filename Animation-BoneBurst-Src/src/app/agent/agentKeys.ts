import { CONSTRAINT_CHANNELS, channelKeysOf, keyedConstraint, withChannelKeys, withValueKey } from "@/core/doc/constraintKeys";
import { changedProps, KEY_GROUPS, type KeyGroup, keyProps } from "@/core/doc/keyButtons";
import { offsetPlan, offsetTrack } from "@/core/doc/offset";
import { drawingLayers, orderAt, reorderTargets, withDrawOrderKey, withFront } from "@/core/doc/drawOrder";
import type { AnimId, NodeId } from "@/core/doc/ids";
import { type Animation, type EventDef, type EventKey, type IkKey, type ValueKey, type TcKey, type Keyframe, TIMELINE_PROPS, type TimelineProp, type Track } from "@/core/doc/types";
import { createKeyframe } from "@/core/doc/defaults";
import { insertKeyframe, keyIndexAt, setEndFrame } from "@/core/doc/timeline";
import { AddAnimation, EditTracks, SetCycle, SetDrawOrder, SetEventKeys, SetEvents, SetIkKeys } from "@/core/history/timelineCommands";
import { renamedEvent, withEventDefValues, withEventKey, withEventKeyValues, withoutEvent } from "@/core/doc/events";
import { tcMixAt, usedMixes, withTcKey } from "@/core/doc/transformKeys";
import { SetTcKeys } from "@/core/history/transformCommands";
import { TC_CHANNELS } from "@/core/doc/types";
import { ikPoseAt, withIkKey } from "@/core/doc/ikKeys";
import { cyclePlan, isCycle, SEAM_TOLERANCE, seamFrame, seamGap } from "@/core/doc/cycle";
import { SetStageSkins } from "@/core/history/settingsCommands";
import type { TweenSpec } from "@/core/math/easing";
import { SEQUENCE_MODES, withSequenceKey } from "@/core/doc/sequence";
import { SetConstraintKeys, SetSequenceKeys } from "@/core/history/attachmentCommands";
import type { SequenceKey } from "@/core/doc/types";
import { posedSymbol, skinsOf, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { fromBoneBurstLocal, type BoneBurstLocal, toBoneBurstLocal } from "@/core/boneburst/transform";
import { deleteKeys, keyTweenOf, withKeyTween, type KeyTween } from "@/core/doc/keyList";
import { AgentError, easesOf, ikKeyOut, list, round, tweenOf, type Args, type SpineKeyIn } from "./agentArgs";
import type { AgentApi } from "./AgentApi";

/**
 * The AI's keying tools: animations, bone keys, the keys of draw order, IK,
 * constraints, sequences and events, cycles and offsets. Each edit is one
 * labelled command.
 */

/* ── editing ── */

export function newAnimation(api: AgentApi, name: string, frames: number) {
  if (!name.trim()) throw new AgentError("An animation needs a name.");
  if (api.sym.animations.some((a) => a.name === name)) throw new AgentError(`There is already an animation "${name}".`);
  const cmd = new AddAnimation(api.store.currentSymbolId, name, frames + 1, `AI: New Animation "${name}"`);
  // Spine's timing: the loop wraps at `frames`, where its last pose is keyed.
  cmd.animation.endsAtLastFrame = true;
  api.store.apply(cmd);
  api.store.emit("timeline");
  return { created: name, frames };
}

export function setKeys(api: AgentApi, animName: string, keys: SpineKeyIn[]) {
  const anim = api.animation(animName);
  const tracks = new Map<NodeId, Track>();
  for (const k of keys) {
    if (typeof k.bone !== "string") throw new AgentError("Each key needs a bone.");
    if (!Number.isInteger(k.frame) || k.frame < 0) throw new AgentError(`Key for "${k.bone}": frame must be a whole number, 0 or more.`);
    const node = api.bone(k.bone);
    let track = tracks.get(node.id) ?? anim.tracks[node.id] ?? {
      // A bone keyed for the first time starts from its setup pose at 0.
      // It spans the animation, as a track made on the timeline does.
      nodeId: node.id, keys: [{ ...createKeyframe(0, node), tween: { kind: "linear" } as TweenSpec }], endFrame: Math.max(0, anim.duration - 1),
    };
    if (k.frame > track.endFrame) track = setEndFrame(track, k.frame);
    let i = keyIndexAt(track, k.frame);
    const fresh = i < 0;
    if (fresh) {
      track = insertKeyframe(track, k.frame, node) ?? track;
      i = keyIndexAt(track, k.frame);
    }
    const key = track.keys[i]!;
    const now = toBoneBurstLocal(key.transform);
    const next: BoneBurstLocal = { ...now };
    for (const ch of ["x", "y", "rotation", "scaleX", "scaleY"] as const) {
      const v = k[ch];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`Key for "${k.bone}" at ${k.frame}: ${ch} must be a number.`);
      next[ch] = v;
    }
    const patch: Partial<Keyframe> = { transform: fromBoneBurstLocal(next) };
    if (k.ease !== undefined) patch.tween = tweenOf(k.ease);
    else if (fresh) patch.tween = { kind: "linear" };
    const replaced: Keyframe = { ...key, ...patch };
    if (k.eases !== undefined) {
      const eases = easesOf(k.eases, `Key for "${k.bone}" at ${k.frame}`);
      if (eases) replaced.eases = eases; else delete replaced.eases;
    } else if (patch.tween) delete replaced.eases;
    track = { ...track, keys: track.keys.map((x, n) => (n === i ? replaced : x)) };
    tracks.set(node.id, track);
  }
  api.commit(anim, `AI: Set ${keys.length} key${keys.length === 1 ? "" : "s"}`, tracks);
  return { animation: anim.name, keys: keys.length, bones: [...new Set(keys.map((k) => k.bone))], frames: api.frames(api.animation(animName)) };
}

export function deleteBoneKeys(api: AgentApi, animName: string, keys: Array<{ bone: string; frame: number }>) {
  const anim = api.animation(animName);
  const tracks = new Map<NodeId, Track | undefined>();
  let removed = 0;
  for (const k of keys) {
    const node = api.bone(k.bone);
    const track = tracks.has(node.id) ? tracks.get(node.id) : anim.tracks[node.id];
    if (!track || keyIndexAt(track, k.frame) < 0) throw new AgentError(`"${k.bone}" has no key at frame ${k.frame}.`);
    const left = track.keys.filter((x) => x.frame !== k.frame);
    tracks.set(node.id, left.length ? { ...track, keys: left } : undefined);
    removed++;
  }
  api.commit(anim, `AI: Delete ${removed} key${removed === 1 ? "" : "s"}`, tracks);
  return { animation: anim.name, removed };
}

export function show(api: AgentApi, animName: string, frame: number, skins: unknown) {
  const anim = api.animation(animName);
  if (skins !== undefined) {
    if (!Array.isArray(skins) || !skins.every((n) => typeof n === "string")) throw new AgentError("skins is a list of skin names.");
    const named = skinsOf(api.sym).filter((n) => n !== "default");
    const missing = skins.filter((n) => n !== "default" && !named.includes(n));
    if (missing.length) throw new AgentError(`There is no skin "${missing[0]}"; the rig has ${named.length ? named.join(", ") : "only the default skin"}.`);
    const next = named.filter((n) => skins.includes(n));
    if (JSON.stringify(next) !== JSON.stringify(stageSkinOf(api.sym)) || !api.sym.stageSkins) {
      api.store.apply(new SetStageSkins(api.sym.id, next, "AI: Show Skins"));
    }
  }
  api.store.setUi({ animId: anim.id }, "timeline");
  api.store.setFrame(Math.max(0, Math.round(frame)));
  return { showing: anim.name, frame: api.store.ui.frame, ...(skinsOf(api.sym).some((n) => n !== "default") ? { skins: stageSkinOf(api.sym) } : {}) };
}

export function keyDrawOrder(api: AgentApi, animName: string, frame: number, args: Args) {
  const anim = api.animation(animName);
  const s = api.sym;
  let order: NodeId[] | null = null;
  if (args.setup !== true) {
    const names = list<string>(args, "front");
    if (!names.length) throw new AgentError("front lists layers, front first; or pass setup: true.");
    const front = names.flatMap((n) => reorderTargets(s, [api.node(n).id]));
    if (!front.length) throw new AgentError(`None of ${names.map((n) => `"${n}"`).join(", ")} draws anything.`);
    order = withFront(orderAt(s, anim, frame), front);
  }
  const keys = withDrawOrderKey(anim.drawOrder ?? [], frame, order, drawingLayers(s));
  api.store.apply(new SetDrawOrder(`AI: Draw Order at ${frame + 1}`, api.store.currentSymbolId, anim.id, keys));
  api.store.emit("timeline");
  api.store.emit("stage");
  const now = orderAt(s, api.animation(animName), frame);
  return { animation: anim.name, frame, frontToBack: [...now].reverse().map((id) => s.nodes[id]!.name) };
}

export function keyIk(api: AgentApi, animName: string, ikName: string, frame: number, args: Args) {
  const anim = api.animation(animName);
  const k = api.sym.ik.find((c) => c.name === ikName);
  if (!k) throw new AgentError(`There is no IK constraint "${ikName}". get_rig lists them.`);
  if (args.mix !== undefined && (typeof args.mix !== "number" || !(args.mix >= 0 && args.mix <= 1))) throw new AgentError("mix is a number from 0 to 1.");
  if (args.bendPositive !== undefined && typeof args.bendPositive !== "boolean") throw new AgentError("bendPositive is true or false.");
  if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
  if (args.softness !== undefined && (typeof args.softness !== "number" || !(args.softness >= 0))) throw new AgentError("softness is a number of pixels, 0 or more.");
  const before = anim.ik?.[k.id] ?? [];
  let keys: IkKey[];
  if (args.delete === true) {
    if (!before.some((key) => key.frame === frame)) throw new AgentError(`"${ikName}" has no key at frame ${frame}.`);
    keys = deleteKeys(before, [frame]);
  } else {
    const now = ikPoseAt(k, anim, frame);
    keys = withIkKey(before, frame, {
      mix: typeof args.mix === "number" ? args.mix : now.mix,
      bendPositive: typeof args.bendPositive === "boolean" ? args.bendPositive : now.bendPositive,
      softness: typeof args.softness === "number" ? args.softness : now.softness,
    }, k.softness);
    if (args.ease) keys = withKeyTween(keys, [frame], args.ease as KeyTween);
  }
  api.store.apply(new SetIkKeys(`AI: IK "${k.name}" at ${frame + 1}`, api.store.currentSymbolId, anim.id, k.id, keys));
  api.store.emit("timeline");
  api.store.emit("stage");
  return {
    animation: anim.name, ik: k.name,
    keys: keys.map((key) => ({ frame: key.frame, ...ikKeyOut(k, key) })),
  };
}

export function keyConstraint(api: AgentApi, animName: string, name: string, channel: string, frame: number, args: Args) {
  const anim = api.animation(animName);
  const k = [...(api.sym.physics ?? []), ...(api.sym.sliders ?? []), ...(api.sym.paths ?? [])].find((c) => c.name === name);
  const c = k ? keyedConstraint(api.sym, k.id) : null;
  if (!c) throw new AgentError(`There is no physics, slider or path constraint "${name}". get_rig lists them.`);
  const channels = CONSTRAINT_CHANNELS[c.kind] as readonly string[];
  if (!channels.includes(channel)) throw new AgentError(`A ${c.kind} constraint keys ${channels.join(", ")}.`);
  if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
  const before = channelKeysOf(anim, c.k.id, channel);
  let keys: ValueKey[];
  if (args.delete === true) {
    if (!before.some((x) => x.frame === frame)) throw new AgentError(`"${name}" has no ${channel} key at frame ${frame}.`);
    keys = before.filter((x) => x.frame !== frame);
  } else {
    if (typeof args.value !== "number" || !Number.isFinite(args.value)) throw new AgentError("value is a number.");
    keys = withValueKey(before, frame, args.value);
    if (args.ease) {
      keys = withKeyTween(keys, [frame], args.ease as KeyTween);
    }
  }
  api.store.apply(new SetConstraintKeys(`AI: Key "${name}" ${channel} at ${frame + 1}`, api.store.currentSymbolId, anim.id, withChannelKeys(anim.constraintKeys, c.k.id, channel, keys)));
  api.store.emit("timeline");
  api.store.emit("stage");
  return { constraint: name, channel, animation: anim.name, keys };
}

export function keySequence(api: AgentApi, animName: string, layer: string, frame: number, args: Args) {
  const anim = api.animation(animName);
  const node = api.node(layer);
  if (!node.sequence) throw new AgentError(`"${layer}" is not a sequence; make_sequence first.`);
  const before = anim.sequences?.[node.id] ?? [];
  let keys: SequenceKey[];
  if (args.delete === true) {
    if (!before.some((k) => k.frame === frame)) throw new AgentError(`"${layer}" has no sequence key at frame ${frame}.`);
    keys = before.filter((k) => k.frame !== frame);
  } else {
    const mode = args.mode ?? "loop";
    if (!SEQUENCE_MODES.includes(mode as never)) throw new AgentError(`mode is one of ${SEQUENCE_MODES.join(", ")}.`);
    const index = args.index === undefined ? 0 : Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index >= node.sequence.items.length) throw new AgentError(`index is 0 to ${node.sequence.items.length - 1}.`);
    const delay = args.delay === undefined ? 1 : Number(args.delay);
    if (!(delay > 0)) throw new AgentError("delay is a number of frames per image, above 0.");
    keys = withSequenceKey(before, { frame, mode: mode as SequenceKey["mode"], index, delay });
  }
  api.store.apply(new SetSequenceKeys(`AI: Sequence "${layer}" at ${frame + 1}`, api.store.currentSymbolId, anim.id, node.id, keys));
  api.store.emit("timeline");
  api.store.emit("stage");
  return { animation: anim.name, layer, keys };
}

export function keyTransform(api: AgentApi, animName: string, name: string, frame: number, args: Args) {
  const anim = api.animation(animName);
  const k = (api.sym.transforms ?? []).find((c) => c.name === name);
  if (!k) throw new AgentError(`There is no transform constraint "${name}". get_rig lists them.`);
  if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
  const before = anim.transforms?.[k.id] ?? [];
  let keys: TcKey[];
  if (args.delete === true) {
    if (!before.some((key) => key.frame === frame)) throw new AgentError(`"${name}" has no key at frame ${frame}.`);
    keys = deleteKeys(before, [frame]);
  } else {
    const mix = { ...tcMixAt(k, anim, frame) };
    const given = args.mix && typeof args.mix === "object" ? (args.mix as Record<string, unknown>) : {};
    for (const c of TC_CHANNELS) if (typeof given[c] === "number") mix[c] = Math.min(1, Math.max(0, given[c] as number));
    keys = withTcKey(before, frame, mix);
    if (args.ease) keys = withKeyTween(keys, [frame], args.ease as KeyTween);
  }
  api.store.apply(new SetTcKeys(`AI: Transform "${k.name}" at ${frame + 1}`, api.store.currentSymbolId, anim.id, k.id, keys));
  api.store.emit("timeline");
  api.store.emit("stage");
  return { animation: anim.name, constraint: k.name, keys: keys.map((key) => ({ frame: key.frame, mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(key.mix[c], 3)])), ease: keyTweenOf(key) })) };
}

export function keyEvent(api: AgentApi, animName: string, frame: number, eventName: string, args: Args) {
  const anim = api.animation(animName);
  const def = (api.sym.events ?? []).find((d) => d.name === eventName);
  if (!def) throw new AgentError(`There is no event "${eventName}". define_event makes one; get_rig lists them.`);
  let keys = anim.events ?? [];
  if (args.delete === true) {
    const at = keys.filter((k) => k.frame === frame && k.name === eventName);
    if (!at.length) throw new AgentError(`"${eventName}" is not fired at frame ${frame}.`);
    keys = keys.filter((k) => !(k.frame === frame && k.name === eventName));
  } else {
    for (const f of ["int", "float", "volume", "balance"] as const) {
      if (args[f] !== undefined && (typeof args[f] !== "number" || !Number.isFinite(args[f]))) throw new AgentError(`${f} is a number.`);
    }
    keys = withEventKey(keys, frame, eventName);
    const nth = keys.filter((k) => k.frame === frame).length - 1;
    keys = withEventKeyValues(keys, frame, nth, {
      ...(typeof args.int === "number" ? { int: Math.trunc(args.int) } : {}),
      ...(typeof args.float === "number" ? { float: args.float } : {}),
      ...(typeof args.string === "string" ? { string: args.string } : {}),
      ...(typeof args.volume === "number" ? { volume: args.volume } : {}),
      ...(typeof args.balance === "number" ? { balance: args.balance } : {}),
    });
  }
  api.store.apply(new SetEventKeys(`AI: Event "${eventName}" at ${frame + 1}`, api.store.currentSymbolId, anim.id, keys));
  api.store.emit("timeline");
  return { animation: anim.name, events: keys.map((k) => ({ ...k })) };
}

export function defineEvent(api: AgentApi, name: string, args: Args) {
  const s = api.sym;
  const defs = s.events ?? [];
  const old = defs.find((d) => d.name === name);
  if (args.delete === true) {
    if (!old) throw new AgentError(`There is no event "${name}".`);
    const out = withoutEvent(defs, s.animations, name);
    const removed = s.animations.reduce((n, a) => n + (a.events?.length ?? 0) - (out.keys.get(a.id)?.length ?? a.events?.length ?? 0), 0);
    api.store.apply(new SetEvents(`AI: Delete Event "${name}"`, api.store.currentSymbolId, out.defs, out.keys));
    api.store.emit("timeline");
    return { deleted: name, keysRemoved: removed };
  }
  for (const f of ["int", "float", "volume", "balance"] as const) {
    if (args[f] !== undefined && (typeof args[f] !== "number" || !Number.isFinite(args[f]))) throw new AgentError(`${f} is a number.`);
  }
  if (args.string !== undefined && typeof args.string !== "string") throw new AgentError("string is text.");
  if (args.audio !== undefined && typeof args.audio !== "string") throw new AgentError("audio is a sound file's path, or \"\" for none.");
  let next = defs;
  let keys = new Map<AnimId, EventKey[]>();
  let current = name;
  if (typeof args.rename === "string") {
    if (!old) throw new AgentError(`There is no event "${name}" to rename.`);
    const out = renamedEvent(defs, s.animations, name, args.rename);
    if (!out) throw new AgentError(`"${args.rename}" is empty or already an event.`);
    next = out.defs;
    keys = out.keys;
    current = args.rename.trim();
  } else if (!old) {
    if (!name.trim()) throw new AgentError("An event needs a name.");
    next = [...defs, { name: name.trim() }];
    current = name.trim();
  }
  const patch: Partial<Omit<EventDef, "name">> = {};
  if (typeof args.int === "number") patch.int = Math.trunc(args.int);
  if (typeof args.float === "number") patch.float = args.float;
  if (typeof args.string === "string") patch.string = args.string;
  if (typeof args.audio === "string") patch.audio = args.audio;
  if (typeof args.volume === "number") patch.volume = Math.max(0, Math.min(1, args.volume));
  if (typeof args.balance === "number") patch.balance = Math.max(-1, Math.min(1, args.balance));
  next = next.map((d) => (d.name === current ? withEventDefValues(d, patch) : d));
  api.store.apply(new SetEvents(`AI: Event "${current}"`, api.store.currentSymbolId, next, keys));
  api.store.emit("timeline");
  return { event: next.find((d) => d.name === current), events: next.map((d) => d.name) };
}

export function keyProperties(api: AgentApi, animName: string, frame: number, layers: string[], which: unknown) {
  const anim = api.animation(animName);
  if (!layers.length) throw new AgentError("layers names at least one bone or slot.");
  const groups = Object.keys(KEY_GROUPS);
  let props: readonly TimelineProp[] | "changed";
  if (which === undefined || which === "changed") props = "changed";
  else if (which === "all") props = TIMELINE_PROPS;
  else if (Array.isArray(which) && which.length && which.every((g) => groups.includes(g as string))) props = which.flatMap((g) => KEY_GROUPS[g as KeyGroup]);
  else throw new AgentError(`properties is "changed", "all" or a list of ${groups.join(", ")}.`);
  if (frame < 0 || frame >= anim.duration) throw new AgentError(`frame is 0 to ${anim.duration - 1}.`);
  const tracks = new Map<NodeId, Track>();
  const keyed: Record<string, TimelineProp[]> = {};
  for (const node of layers.map((n) => api.node(n))) {
    const list = props === "changed" ? changedProps(anim.tracks[node.id], node, frame) : props;
    if (!list.length) continue;
    const base = anim.tracks[node.id] ?? { nodeId: node.id, keys: [createKeyframe(0, node)], endFrame: Math.max(0, anim.duration - 1) };
    const next = keyProps(base, node, list, frame);
    if (next === anim.tracks[node.id]) continue;
    tracks.set(node.id, next);
    keyed[node.name] = [...list];
  }
  if (tracks.size) {
    api.store.apply(new EditTracks(`AI: Key at ${frame + 1}`, api.store.currentSymbolId, anim.id, tracks));
    api.store.emit("timeline");
    api.store.emit("stage");
  }
  return { animation: anim.name, frame, keyed };
}

export function offsetKeys(api: AgentApi, animName: string, layers: string[], frames: number, stagger: boolean) {
  const anim = api.animation(animName);
  if (!layers.length) throw new AgentError("layers names at least one bone or slot.");
  const nodes = layers.map((n) => api.node(n));
  const seam = seamFrame(anim);
  const tracks = new Map<NodeId, Track>();
  for (const [id, delta] of offsetPlan(nodes.map((n) => n.id), frames, stagger)) {
    const track = anim.tracks[id];
    if (!track) continue;
    const next = offsetTrack(track, api.sym.nodes[id]!, delta, seam);
    if (next !== track) tracks.set(id, next);
  }
  if (tracks.size) {
    api.store.apply(new EditTracks(`AI: Offset Keys in "${anim.name}"`, api.store.currentSymbolId, anim.id, tracks));
    api.store.emit("timeline");
    api.store.emit("stage");
  }
  return {
    animation: anim.name, wrapped: seam !== null,
    moved: nodes.filter((n) => tracks.has(n.id)).map((n) => ({ layer: n.name, frames: offsetPlan(nodes.map((m) => m.id), frames, stagger).get(n.id) })),
    ...(nodes.some((n) => !anim.tracks[n.id]) ? { unkeyed: nodes.filter((n) => !anim.tracks[n.id]).map((n) => n.name) } : {}),
  };
}

export function setCycle(api: AgentApi, animName: string, on: unknown) {
  if (typeof on !== "boolean") throw new AgentError(`"on" is true or false.`);
  const anim = api.animation(animName);
  if (isCycle(anim) !== on) {
    const plan = on ? cyclePlan(anim, api.sym.nodes) : undefined;
    api.store.apply(new SetCycle(api.store.currentSymbolId, anim.id, on, plan, `AI: ${on ? "Cycle" : "Play Once"} "${anim.name}"`));
    api.store.emit("timeline");
    api.store.emit("stage");
  }
  const now = api.animation(animName);
  const seam = seamOf(api, now);
  return { animation: now.name, cycle: isCycle(now), frames: api.frames(now), ...(seam ? { seam } : {}) };
}

/* ── cycles and paths ── */

/** For a cycle: the bones whose pose on the last frame (frame 0 again)
 *  is not frame 0's, each where the difference starts (`seamGap`, in the
 *  parent's frame). Null for an animation that is not a cycle. */
export function seamOf(api: AgentApi, anim: Animation) {
  const join = seamFrame(anim);
  if (join === null) return null;
  const p = api.store.project;
  const names = new Map(api.bones().map((n) => [n.id, n.name]));
  const gaps = seamGap(posedSymbol(p, api.sym, anim, 0, "animate"), posedSymbol(p, api.sym, anim, join, "animate"), SEAM_TOLERANCE, true)
    .filter((g) => names.has(g.nodeId))
    .map((g) => ({
      bone: names.get(g.nodeId)!,
      ...(g.distance > SEAM_TOLERANCE.px ? { pixels: round(g.distance, 2) } : {}),
      ...(Math.abs(g.rotation) > SEAM_TOLERANCE.deg ? { degrees: round(-g.rotation, 2) } : {}),
      ...(g.scale > SEAM_TOLERANCE.scale ? { scale: round(g.scale, 4) } : {}),
      ...(g.color ? { color: true } : {}),
      ...(g.display ? { attachment: true } : {}),
    }));
  return { lastFrame: join, closes: gaps.length === 0, ...(gaps.length ? { gaps } : {}) };
}
