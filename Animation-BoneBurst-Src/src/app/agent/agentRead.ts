import { constraintEntries } from "@/core/doc/constraintOrder";
import { orderAt } from "@/core/doc/drawOrder";
import type { NodeId } from "@/core/doc/ids";
import { isImage, type Node } from "@/core/doc/types";
import { referenceEnd, referenceFrameOf } from "@/core/doc/reference";
import { usedMixes } from "@/core/doc/transformKeys";
import { isCycle } from "@/core/doc/cycle";
import { posedSymbol, skinsOf, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { toBoneBurstLocal } from "@/core/boneburst/transform";
import { keyTweenOf } from "@/core/doc/keyList";
import { AgentError, axisEases, easeName, ikKeyOut, round, spine, type Args } from "./agentArgs";
import type { AgentApi } from "./AgentApi";
import { seamOf } from "./agentKeys";

/**
 * The AI's reading tools: the rig, an animation, a pose.
 */

export function getRig(api: AgentApi) {
  const s = api.sym;
  const nameOf = (id: NodeId | null | undefined) => (id ? s.nodes[id]?.name ?? null : null);
  const anim = api.store.currentAnimation;
  const setup = posedSymbol(api.store.project, s, null, 0, "setup");
  // Where a picture is: its pivot pixel in skeleton space, which with the
  // size and the bone's turn is enough to read any of its pixels.
  const picture = (n: Node) => {
    const item = n.kind === "image" && !n.slotBone && n.itemId ? api.store.project.items[n.itemId] : undefined;
    const m = setup.byNode.get(n.id)?.world;
    if (!item || !isImage(item) || !m) return {};
    return {
      image: item.name, size: [item.width, item.height], pivot: [round(n.pivot.x, 2), round(n.pivot.y, 2)],
      at: [round(m.tx, 2), round(-m.ty, 2)], rotation: round((Math.atan2(-m.b, m.a) * 180) / Math.PI, 2),
    };
  };
  return {
    name: s.name,
    fps: api.store.project.frameRate,
    bones: api.bones().map((n) => ({
      name: n.name,
      parent: nameOf(n.parentId),
      ...(n.boneLength ? { length: round(n.boneLength) } : {}),
      setup: spine(toBoneBurstLocal(n.bind)),
      ...(n.inherit ? { inherit: n.inherit } : {}),
    })),
    slots: s.layers.map((l) => s.nodes[l.nodeId]).filter((n): n is Node => !!n && (n.kind === "image" || n.kind === "symbol"))
      .reverse().map((n) => ({ name: n.name, bone: nameOf(n.slotBone) ?? n.name, ...picture(n) })),
    ik: s.ik.map((k) => {
      const effector = s.nodes[k.boneId];
      const bones = k.chain > 0 && effector?.parentId ? [nameOf(effector.parentId), effector.name] : [effector?.name];
      return { name: k.name, bones, target: nameOf(k.targetId), mix: k.weight, ...(k.softness ? { softness: round(k.softness, 3) } : {}) };
    }),
    ...(s.events?.length ? { events: s.events.map((d) => ({ ...d })) } : {}),
    ...(s.transforms?.length ? {
      transforms: s.transforms.map((k) => ({
        name: k.name, source: nameOf(k.sourceId), bones: k.boneIds.map((id) => nameOf(id)),
        mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(k.mix[c], 3)])),
        ...(k.offsets && Object.keys(k.offsets).length ? { offsets: k.offsets } : {}),
        ...(k.localSource ? { localSource: true } : {}), ...(k.localTarget ? { localTarget: true } : {}),
        ...(k.additive ? { relative: true } : {}), ...(k.clamp ? { clamp: true } : {}),
      })),
    } : {}),
    ...(constraintEntries(s).length > 1 ? { constraintOrder: constraintEntries(s).map((e) => e.name) } : {}),
    animations: s.animations.map((a) => ({
      name: a.name, frames: api.frames(a), loops: a.playTimes === 0,
      ...(a.reference ? { reference: { images: a.reference.frames.length, frames: [referenceFrameOf(a.reference, 0), referenceEnd(a.reference)] } } : {}),
    })),
    ...(skinsOf(s).some((n) => n !== "default") ? { skins: skinsOf(s).filter((n) => n !== "default") } : {}),
    images: api.libraryImages().map((i) => ({ name: i.name, width: i.width, height: i.height })),
    showing: { animation: anim?.name ?? null, frame: api.store.ui.frame, ...(skinsOf(s).some((n) => n !== "default") ? { skins: stageSkinOf(s) } : {}) },
  };
}

export function getAnimation(api: AgentApi, name: string) {
  const anim = api.animation(name);
  const bones: Record<string, unknown[]> = {};
  for (const n of api.bones()) {
    const track = anim.tracks[n.id];
    if (!track) continue;
    bones[n.name] = track.keys.map((k) => {
      const own = axisEases(k);
      return { frame: k.frame, ...spine(toBoneBurstLocal(k.transform)), ease: easeName(k.tween), ...(own ? { eases: own } : {}) };
    });
  }
  const seam = seamOf(api, anim);
  return { name: anim.name, frames: api.frames(anim), loops: anim.playTimes === 0, cycle: isCycle(anim), ...(seam ? { seam } : {}), fps: api.store.project.frameRate, bones,
    ...(anim.poses?.length ? { poses: [...anim.poses], note: "poses: the user's key-pose frames, already keyed — keep them as they are" } : {}),
    ...(anim.drawOrder?.length ? {
      drawOrder: anim.drawOrder.map((k) => ({
        frame: k.frame,
        frontToBack: k.order ? [...orderAt(api.sym, anim, k.frame)].reverse().map((id) => api.sym.nodes[id]!.name) : "setup",
      })),
    } : {}),
    ...(anim.events?.length ? { events: anim.events.map((k) => ({ ...k })) } : {}),
    ...(anim.transforms && Object.keys(anim.transforms).length ? {
      transforms: Object.fromEntries((api.sym.transforms ?? []).filter((k) => anim.transforms?.[k.id]?.length).map((k) => [k.name, anim.transforms![k.id]!.map((key) => ({
        frame: key.frame, mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(key.mix[c], 3)])), ease: keyTweenOf(key),
      }))])),
    } : {}),
    ...(anim.ik && Object.keys(anim.ik).length ? {
      ik: Object.fromEntries(api.sym.ik.filter((k) => anim.ik?.[k.id]?.length).map((k) => [k.name, anim.ik![k.id]!.map((key) => ({
        frame: key.frame, ...ikKeyOut(k, key),
      }))])),
    } : {}) };
}

export function getPose(api: AgentApi, args: Args) {
  const animName = typeof args.animation === "string" ? args.animation : null;
  const anim = animName ? api.animation(animName) : null;
  const frame = typeof args.frame === "number" ? args.frame : 0;
  const wanted = Array.isArray(args.bones) ? new Set(args.bones.map(String)) : null;
  const pose = posedSymbol(api.store.project, api.sym, anim, frame, anim ? "animate" : "setup");
  const out: Record<string, unknown> = {};
  for (const n of api.bones()) {
    if (wanted && !wanted.has(n.name)) continue;
    const m = pose.byNode.get(n.id)?.world;
    if (!m) continue;
    // The editor's world is y down; back to Spine's y up.
    out[n.name] = {
      x: round(m.tx, 2), y: round(-m.ty, 2),
      rotation: round((Math.atan2(-m.b, m.a) * 180) / Math.PI, 2),
      scaleX: round(Math.hypot(m.a, m.b)), scaleY: round(Math.hypot(m.c, m.d)),
    };
  }
  if (wanted) for (const b of wanted) if (!out[b]) throw new AgentError(`There is no bone "${b}".`);
  return { animation: anim?.name ?? null, frame, bones: out };
}
