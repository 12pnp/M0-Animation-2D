import { INHERIT_MODES, isInherit, withInheritKey } from "@/core/doc/inherit";
import type { BoneBurstInherit } from "@/core/boneburst/types";
import { constraintEntries, orderFrom } from "@/core/doc/constraintOrder";
import { newTcId } from "@/core/doc/ids";
import { displayAt, displaysOf, linkableDisplays, withDisplayTint, withLink } from "@/core/doc/displays";
import { skinnedOutline, withPointOffset } from "@/core/doc/boxes";
import type { InheritKey, TransformConstraint, Node } from "@/core/doc/types";
import { transformPlan, withMapping, withoutMapping, withSourceOffset } from "@/core/doc/transformKeys";
import { SetTransforms } from "@/core/history/transformCommands";
import { doBindMesh, doMakeMesh } from "@/app/MeshOps";
import { TC_CHANNELS, type TcChannel } from "@/core/doc/types";
import { RenameNode } from "@/core/history/commands";
import { doAddAttachment, doAddPhysics, doAddSlider, doMakePath, doMakeSequence, doSetConstraints, editShownOutline } from "@/app/AttachmentOps";
import { PHYSICS_DEFAULTS, PHYSICS_SETTINGS, SLIDER_PROPERTIES } from "@/core/doc/constraints";
import { EditNode, SetConstraintOrder, SetInheritKeys } from "@/core/history/attachmentCommands";
import { stageSkinOf } from "@/core/boneburst/boneburstPose";
import { AgentError, int, list, str, type Args } from "./agentArgs";
import type { AgentApi } from "./AgentApi";

/**
 * The AI's attachment and constraint tools: meshes, boxes, points, paths,
 * sequences, tints, physics, sliders, transform constraints, inherit modes.
 */

export function makeMeshes(api: AgentApi, names: string[], spacing: unknown) {
  if (spacing !== undefined && (typeof spacing !== "number" || !(spacing >= 2))) throw new AgentError("spacing is a number of pixels, 2 or more.");
  const ids = names.map((n) => api.node(n).id);
  const made = doMakeMesh(api.store, api.assets ?? null, ids, "AI: Make Mesh", spacing as number | undefined);
  if (!made) throw new AgentError("None of those is an image of its own without a mesh.");
  return {
    meshes: ids.filter((id) => api.sym.nodes[id]?.mesh).map((id) => {
      const m = api.sym.nodes[id]!.mesh!;
      return { image: api.sym.nodes[id]!.name, points: m.points.length / 2, outline: m.hull, triangles: m.triangles.length / 3 };
    }),
  };
}

export function bindMesh(api: AgentApi, image: string, bones: string[]) {
  const ids = [api.node(image).id, ...bones.map((n) => api.bone(n).id)];
  const refused = doBindMesh(api.store, ids, "AI: Bind Mesh");
  if (refused) throw new AgentError(refused);
  const m = api.sym.nodes[ids[0]!]!.mesh!;
  return { image, bones, points: m.points.length / 2 };
}

export function addAttachment(api: AgentApi, args: Args) {
  const kind = args.kind;
  if (kind !== "box" && kind !== "point") throw new AgentError(`kind is "box" or "point".`);
  const on = args.on === undefined ? null : api.node(str(args, "on"));
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name && api.nameTaken(name)) throw new AgentError(`The name "${name}" is taken.`);
  const before = new Set(Object.keys(api.sym.nodes));
  api.store.selectNodes(on ? [on.id] : []);
  api.store.transaction(kind === "box" ? "AI: Add Bounding Box" : "AI: Add Point", () => {
    doAddAttachment(api.store, api.assets ?? null, kind);
    const added = Object.values(api.sym.nodes).find((n) => !before.has(n.id))!;
    if (name) api.store.apply(new RenameNode(api.store.currentSymbolId, added.id, name));
  });
  const made = Object.values(api.sym.nodes).find((n) => !before.has(n.id))!;
  const node = api.sym.nodes[made.id]!;
  return { [kind === "box" ? "box" : "point"]: node.name, parent: node.parentId ? api.sym.nodes[node.parentId]!.name : null, ...(node.box ? { points: node.box.points.length / 2 } : {}) };
}

export function addPhysics(api: AgentApi, boneName: string, args: Args) {
  const bone = api.bone(boneName);
  const before = new Set((api.sym.physics ?? []).map((k) => k.id));
  const settings = args.settings && typeof args.settings === "object" ? args.settings as Record<string, unknown> : {};
  for (const [k, v] of Object.entries(settings)) {
    if (!PHYSICS_SETTINGS.includes(k as never)) throw new AgentError(`"${k}" is not a physics setting; they are ${PHYSICS_SETTINGS.join(", ")}.`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`${k} is a number.`);
  }
  api.store.transaction("AI: Add Physics", () => {
    doAddPhysics(api.store, bone.id);
    const list = (api.sym.physics ?? []).map((k) => (before.has(k.id) ? k : { ...k, ...settings }));
    if (Object.keys(settings).length) doSetConstraints(api.store, "physics", list, "AI: Add Physics");
  });
  const made = api.sym.physics!.find((k) => !before.has(k.id))!;
  return { constraint: made.name, bone: bone.name, settings: Object.fromEntries(PHYSICS_SETTINGS.map((s) => [s, made[s] ?? PHYSICS_DEFAULTS[s]])) };
}

export function linkMesh(api: AgentApi, layerName: string, image: string, args: Args) {
  const node = api.node(layerName);
  if (!node.mesh) throw new AgentError(`"${node.name}" is not a mesh: make_mesh first.`);
  const index = displaysOf(node).findIndex((d, i) => i > 0 && api.store.project.items[d.itemId]?.name === image);
  if (index < 0) throw new AgentError(`"${node.name}" has no other image "${image}"; its images are ${displaysOf(node).map((d) => `"${api.store.project.items[d.itemId]?.name}"`).join(", ")}.`);
  if (!linkableDisplays(node, 0).includes(index)) throw new AgentError(`"${image}" on "${node.name}" has a mesh or sequence of its own.`);
  const link = args.linked === false ? undefined : args.deform === false ? { to: 0, deform: false as const } : { to: 0 };
  api.store.apply(new EditNode(link ? `AI: Link "${image}" to "${node.name}"'s Mesh` : `AI: Unlink "${image}"`, api.store.currentSymbolId, node.id, (n) => withLink(n, index, link)));
  api.store.emit("stage");
  return { layer: node.name, image, linked: !!link, ...(link ? { deform: link.deform !== false } : {}) };
}

/** A point's offset and turn (Spine's point `x`, `y`, `rotation`), y down and clockwise as the stage. */
export function setPoint(api: AgentApi, name: string, args: Args) {
  const node = Object.values(api.sym.nodes).find((n) => n.name === name && n.kind === "point") ?? api.node(name);
  if (node.kind !== "point") throw new AgentError(`"${node.name}" is not a point (add_attachment makes one).`);
  const patch: Partial<NonNullable<Node["point"]>> = {};
  for (const k of ["x", "y", "rotation"] as const) {
    if (args[k] === undefined) continue;
    if (typeof args[k] !== "number" || !Number.isFinite(args[k])) throw new AgentError(`${k} is a number.`);
    patch[k] = args[k] as number;
  }
  if (!Object.keys(patch).length) throw new AgentError("Give x, y or rotation.");
  editShownOutline(api.store, node.id, (n) => withPointOffset(n, patch), `AI: Move Point "${node.name}"`);
  api.store.emit("stage");
  const p = skinnedOutline(api.sym, api.sym.nodes[node.id]!, stageSkinOf(api.sym)).point;
  return { point: node.name, x: p?.x ?? 0, y: p?.y ?? 0, rotation: p?.rotation ?? 0 };
}

/** A display's own colour (Spine's attachment `color`): "rrggbb" or "rrggbbaa", null for none. */
export function setTint(api: AgentApi, name: string, args: Args) {
  // An opened file's slot shares its name with its bone: the one with images.
  const node = Object.values(api.sym.nodes).find((n) => n.name === name && n.itemId) ?? api.node(name);
  const index = args.display === undefined ? 0 : int(args, "display", 0);
  if (!displayAt(node, index)) throw new AgentError(`"${node.name}" has no display ${index}.`);
  const c = args.color;
  if (c !== null && (typeof c !== "string" || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c))) throw new AgentError(`color is "rrggbb" or "rrggbbaa", or null for none.`);
  const hex = typeof c === "string" ? c.replace("#", "") : null;
  const tint = hex ? (hex.length === 6 ? `${hex}ff` : hex) : undefined;
  api.store.apply(new EditNode(`AI: Tint "${node.name}"`, api.store.currentSymbolId, node.id, (n) => withDisplayTint(n, index, tint)));
  api.store.emit("stage");
  return { layer: node.name, display: index, tint: displayAt(api.sym.nodes[node.id]!, index)?.tint ?? null };
}

/** One mapping of a transform constraint's property map, in Spine's units. */
export function mapTransform(api: AgentApi, name: string, args: Args) {
  const k = (api.sym.transforms ?? []).find((c) => c.name === name);
  if (!k) throw new AgentError(`There is no transform constraint "${name}"; get_rig lists them.`);
  const from = args.from, to = args.to;
  if (!TC_CHANNELS.includes(from as TcChannel) || !TC_CHANNELS.includes(to as TcChannel)) throw new AgentError(`from and to are each one of ${TC_CHANNELS.join(", ")}.`);
  const patch: { scale?: number; offset?: number; max?: number } = {};
  for (const f of ["scale", "offset", "max"] as const) {
    if (args[f] === undefined) continue;
    if (typeof args[f] !== "number" || !Number.isFinite(args[f])) throw new AgentError(`${f} is a number.`);
    patch[f] = args[f] as number;
  }
  let properties = args.remove === true ? withoutMapping(k.properties, from as TcChannel, to as TcChannel) : withMapping(k.properties, from as TcChannel, to as TcChannel, patch);
  if (args.sourceOffset !== undefined) {
    if (typeof args.sourceOffset !== "number" || !Number.isFinite(args.sourceOffset)) throw new AgentError("sourceOffset is a number.");
    properties = withSourceOffset(properties, from as TcChannel, args.sourceOffset);
  }
  if (!properties.length) throw new AgentError(`That would leave "${k.name}" driving nothing; remove the constraint instead.`);
  const next = (api.sym.transforms ?? []).map((c) => (c.id === k.id ? { ...c, properties } : c));
  api.store.apply(new SetTransforms(`AI: Transform Map "${k.name}"`, api.store.currentSymbolId, next));
  api.store.emit("stage");
  return { constraint: k.name, properties };
}

export function setInherit(api: AgentApi, boneName: string, args: Args) {
  const bone = api.bone(boneName);
  const mode = args.inherit;
  if (args.delete !== true && !isInherit(mode)) throw new AgentError(`inherit is one of ${INHERIT_MODES.join(", ")}.`);
  if (args.animation === undefined) {
    if (args.delete === true) throw new AgentError("delete removes a key: give the animation and frame.");
    api.store.apply(new EditNode(`AI: Inherit "${bone.name}"`, api.store.currentSymbolId, bone.id, (n) => {
      const out = { ...n };
      if (mode !== "normal") out.inherit = mode as BoneBurstInherit; else delete out.inherit;
      return out;
    }));
    api.store.emit("stage");
    return { bone: bone.name, inherit: mode };
  }
  const anim = api.animation(str(args, "animation"));
  const frame = int(args, "frame", 0);
  const before = anim.inherits?.[bone.id] ?? [];
  let keys: InheritKey[];
  if (args.delete === true) {
    if (!before.some((k) => k.frame === frame)) throw new AgentError(`"${bone.name}" has no inherit key at frame ${frame}.`);
    keys = before.filter((k) => k.frame !== frame);
  } else keys = withInheritKey(before, frame, mode as BoneBurstInherit);
  api.store.apply(new SetInheritKeys(`AI: Inherit "${bone.name}" at ${frame + 1}`, api.store.currentSymbolId, anim.id, bone.id, keys));
  api.store.emit("timeline");
  api.store.emit("stage");
  return { bone: bone.name, animation: anim.name, keys };
}

export function setConstraintOrder(api: AgentApi, names: string[]) {
  const order = orderFrom(api.sym, names);
  if (typeof order === "string") throw new AgentError(`${order} get_rig lists the constraints in constraintOrder.`);
  api.store.apply(new SetConstraintOrder("AI: Constraint Order", api.store.currentSymbolId, order));
  api.store.emit("stage");
  api.store.emit("doc");
  return { constraintOrder: constraintEntries(api.sym).map((e) => e.name) };
}

export function addSlider(api: AgentApi, animName: string, args: Args) {
  const anim = api.animation(animName);
  const bone = args.bone === undefined ? null : api.bone(str(args, "bone"));
  if (args.property !== undefined && !SLIDER_PROPERTIES.includes(args.property as never)) throw new AgentError(`property is one of ${SLIDER_PROPERTIES.join(", ")}.`);
  const before = new Set((api.sym.sliders ?? []).map((k) => k.id));
  api.store.transaction("AI: Add Slider", () => {
    doAddSlider(api.store, anim.id, bone?.id ?? null);
    const patch: Record<string, unknown> = {};
    for (const f of ["from", "to", "scale", "time", "mix"]) if (typeof args[f] === "number") patch[f] = args[f];
    for (const f of ["loop", "additive", "local"]) if (args[f] === true) patch[f] = true;
    if (bone && args.property) patch.property = args.property;
    if (Object.keys(patch).length) doSetConstraints(api.store, "sliders", (api.sym.sliders ?? []).map((k) => (before.has(k.id) ? k : { ...k, ...patch })), "AI: Add Slider");
  });
  const made = api.sym.sliders!.find((k) => !before.has(k.id))!;
  const { id: _id, animId: _a, boneId: _b, ...rest } = made;
  return { ...rest, animation: anim.name, ...(bone ? { bone: bone.name } : {}) };
}

export function makePath(api: AgentApi, bones: string[]) {
  const ids = bones.map((n) => api.bone(n).id);
  const refused = doMakePath(api.store, ids);
  if (refused) throw new AgentError(refused);
  const k = api.sym.paths![api.sym.paths!.length - 1]!;
  return { constraint: k.name, path: api.sym.nodes[k.pathId]!.name, bones: k.boneIds.map((id) => api.sym.nodes[id]!.name), knots: api.sym.nodes[k.pathId]!.path!.points.length / 6 };
}

export function makeSequence(api: AgentApi, layer: string) {
  const node = api.node(layer);
  const problem = doMakeSequence(api.store, node.id);
  if (problem) throw new AgentError(problem);
  const seq = api.sym.nodes[node.id]!.sequence!;
  return { layer, frames: seq.items.map((id) => api.store.project.items[id]!.name) };
}

export function addTransform(api: AgentApi, args: Args) {
  const s = api.sym;
  const bones = list<string>(args, "bones").map((n) => api.bone(n).id);
  const source = api.bone(str(args, "source"));
  const plan = transformPlan(s, bones, source.id, newTcId());
  if ("refused" in plan) throw new AgentError(plan.refused);
  const k: TransformConstraint = { ...plan };
  if (typeof args.name === "string" && args.name.trim()) {
    if ((s.transforms ?? []).some((c) => c.name === args.name)) throw new AgentError(`There is already a transform constraint "${args.name}".`);
    k.name = (args.name as string).trim();
  }
  for (const f of ["localSource", "localTarget", "clamp"] as const) if (args[f] === true) k[f] = true;
  if (args.relative === true) k.additive = true;
  const mix = args.mix && typeof args.mix === "object" ? (args.mix as Record<string, unknown>) : {};
  for (const c of TC_CHANNELS) if (typeof mix[c] === "number") k.mix = { ...k.mix, [c]: Math.min(1, Math.max(0, mix[c] as number)) };
  const off = args.offsets && typeof args.offsets === "object" ? (args.offsets as Record<string, unknown>) : {};
  const offsets: Partial<Record<TcChannel, number>> = {};
  for (const c of TC_CHANNELS) if (typeof off[c] === "number" && off[c]) offsets[c] = off[c] as number;
  if (Object.keys(offsets).length) k.offsets = offsets;
  api.store.apply(new SetTransforms(`AI: Transform Constraint "${k.name}"`, api.store.currentSymbolId, [...(s.transforms ?? []), k]));
  api.store.emit("stage");
  return { name: k.name, source: source.name, bones: k.boneIds.map((id) => s.nodes[id]!.name) };
}
