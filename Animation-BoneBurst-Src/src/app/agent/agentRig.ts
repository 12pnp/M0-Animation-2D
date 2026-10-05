import { newIkId } from "@/core/doc/ids";
import { isImage, type Node } from "@/core/doc/types";
import { apply } from "@/core/math/Matrix2D";
import { pt } from "@/core/math/geom";
import { createLayer, createNode } from "@/core/doc/defaults";
import { ikRoles } from "@/core/doc/ikGraph";
import { AddNode } from "@/core/history/commands";
import { createsCycle, SetParent, SetPivot } from "@/core/history/hierarchyCommands";
import { SetLayerOrder } from "@/core/history/layerCommands";
import { AddIkConstraint, SetIkOptions } from "@/core/history/ikCommands";
import { autoRigPlan, jointNames, type RigLayer } from "@/core/rig/autoRig";
import { bendFlipNeeded, type BoneBurstPoint, boneFromWorld, placeOnBone, siblingOrder } from "@/core/rig/rigPlan";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { fromBoneBurstLocal } from "@/core/boneburst/transform";
import { AgentError, point, round, type Args, type AttachIn, type BoneIn } from "./agentArgs";
import type { AgentApi } from "./AgentApi";

/**
 * The AI's rigging tools: bones, attaching pictures, IK, stacking, auto rig.
 */

export function addBones(api: AgentApi, specs: BoneIn[]) {
  // Everything is checked before the first command: a transaction keeps
  // what it applied before a throw.
  const coming = new Set<string>();
  for (const b of specs) {
    if (typeof b.name !== "string" || !b.name.trim()) throw new AgentError("Each bone needs a name.");
    if (api.nameTaken(b.name) || coming.has(b.name)) throw new AgentError(`The name "${b.name}" is taken.`);
    if (b.parent !== undefined && !coming.has(b.parent)) api.bone(b.parent);
    if (b.from !== undefined || b.to !== undefined) {
      const from = point(b.from, `Bone "${b.name}": from`), to = point(b.to, `Bone "${b.name}": to`);
      if (from[0] === to[0] && from[1] === to[1]) throw new AgentError(`Bone "${b.name}": from and to are the same point.`);
      if (b.x !== undefined || b.y !== undefined || b.rotation !== undefined || b.length !== undefined) {
        throw new AgentError(`Bone "${b.name}": give from and to, or x, y, rotation and length, not both.`);
      }
    } else {
      for (const k of ["x", "y", "rotation", "length"] as const) {
        if (b[k] !== undefined && (typeof b[k] !== "number" || !Number.isFinite(b[k]))) throw new AgentError(`Bone "${b.name}": ${k} must be a number.`);
      }
      if (!(typeof b.length === "number" && b.length > 0)) throw new AgentError(`Bone "${b.name}": give from and to, or a length above 0.`);
    }
    coming.add(b.name);
  }
  const label = `AI: Add ${specs.length} bone${specs.length === 1 ? "" : "s"}`;
  api.store.transaction(label, () => {
    for (const b of specs) {
      const parent = b.parent !== undefined ? api.bone(b.parent) : null;
      const node = createNode("bone", b.name, { parentId: parent?.id ?? null });
      if (b.from) {
        const placed = boneFromWorld(parent ? api.setupWorld(parent.id) : undefined, b.from as unknown as BoneBurstPoint, b.to as unknown as BoneBurstPoint);
        if (!placed) throw new AgentError(`Bone "${b.name}": its parent "${b.parent}" is scaled to nothing.`);
        node.bind = placed.bind;
        node.boneLength = Math.max(1, round(placed.length, 2));
      } else {
        node.bind = fromBoneBurstLocal({ x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, shearX: 0, shearY: 0, scaleX: 1, scaleY: 1 });
        node.boneLength = Math.max(1, round(b.length!, 2));
      }
      api.store.apply(new AddNode(label, api.store.currentSymbolId, node, createLayer(node.id, node.name, api.sym.layers.length), 0));
    }
  });
  return { added: specs.map((b) => b.name), note: "render_frame with no animation shows the setup pose" };
}

export function attach(api: AgentApi, items: AttachIn[]) {
  const images = api.libraryImages();
  const coming = new Set<string>();
  const plans: Array<() => void> = [];
  const label = `AI: Attach ${items.length} picture${items.length === 1 ? "" : "s"}`;
  for (const it of items) {
    if (typeof it.bone !== "string") throw new AgentError("Each item needs a bone.");
    const bone = api.bone(it.bone);
    if (bone.kind !== "bone" && bone.kind !== "group") throw new AgentError(`"${it.bone}" is a slot, not a bone.`);
    if ((it.image === undefined) === (it.layer === undefined)) throw new AgentError(`On "${it.bone}": give either image (from the library) or layer (already in the skeleton).`);
    if (it.layer !== undefined) {
      for (const k of ["at", "rotation", "scale", "name"] as const) {
        if (it[k] !== undefined) throw new AgentError(`Layer "${it.layer}": ${k} is for a new image; a layer keeps where it is.`);
      }
      const node = api.node(it.layer);
      if (node.kind !== "image" && node.kind !== "symbol") throw new AgentError(`"${it.layer}" is a bone, not artwork.`);
      if (node.slotBone) throw new AgentError(`"${it.layer}" is a slot of an opened Spine rig; it already rides "${api.sym.nodes[node.slotBone]?.name}".`);
      if (createsCycle(api.sym, node.id, bone.id)) throw new AgentError(`"${it.bone}" hangs below "${it.layer}".`);
      if (ikRoles(api.sym).driven.has(node.id)) throw new AgentError(`"${it.layer}" is turned by IK; it cannot change parent.`);
      if (it.pivot !== undefined) {
        const [u, v] = point(it.pivot, `Layer "${it.layer}": pivot`);
        // The artwork stays where it is; only the point it turns about moves.
        plans.push(() => api.store.apply(new SetPivot(api.store.currentSymbolId, new Map([[node.id, { x: u, y: v }]]))));
      }
      plans.push(() => api.store.apply(new SetParent(api.store.currentSymbolId, [node.id], bone.id, true, label)));
      continue;
    }
    const image = images.find((i) => i.name === it.image);
    if (!image) throw new AgentError(`There is no picture "${it.image}" in the library. get_rig lists them under images.`);
    const name = it.name ?? image.name;
    if (api.nameTaken(name) || coming.has(name)) throw new AgentError(`The name "${name}" is taken: give this one a name.`);
    coming.add(name);
    const pivot = it.pivot === undefined ? [image.width / 2, image.height / 2] as const : point(it.pivot, `"${name}": pivot`);
    const scale = it.scale ?? 1;
    if (typeof scale !== "number" || !(scale > 0)) throw new AgentError(`"${name}": scale must be above 0.`);
    if (it.rotation !== undefined && (typeof it.rotation !== "number" || !Number.isFinite(it.rotation))) throw new AgentError(`"${name}": rotation must be a number.`);
    const boneWorld = api.setupWorld(bone.id);
    const at: BoneBurstPoint = it.at === undefined ? [boneWorld?.tx ?? 0, -(boneWorld?.ty ?? 0)] : point(it.at, `"${name}": at`);
    const bind = placeOnBone(boneWorld, at, it.rotation ?? 0, scale);
    if (!bind) throw new AgentError(`"${it.bone}" is scaled to nothing.`);
    const node = createNode("image", name, { parentId: bone.id, itemId: image.id });
    node.pivot = { x: pivot[0], y: pivot[1] };
    node.bind = bind;
    plans.push(() => api.store.apply(new AddNode(label, api.store.currentSymbolId, node, createLayer(node.id, node.name, api.sym.layers.length), 0)));
  }
  api.store.transaction(label, () => { for (const run of plans) run(); });
  return { attached: items.map((it) => ({ bone: it.bone, slot: it.layer ?? it.name ?? it.image })) };
}

export function addIk(api: AgentApi, boneName: string, args: Args) {
  const s = api.sym;
  const effector = api.bone(boneName);
  if (effector.kind !== "bone") throw new AgentError(`"${boneName}" is a slot; IK turns bones.`);
  const parent = effector.parentId ? s.nodes[effector.parentId] : undefined;
  // The runtime's rule (ARCHITECTURE ▸ Bones and IK): a bone parent roots the two-bone solve.
  const chain: 0 | 1 = parent?.kind === "bone" ? 1 : 0;
  const chainIds = chain ? [parent!.id, effector.id] : [effector.id];
  const root = s.nodes[chainIds[0]!]!;
  const driven = ikRoles(s).driven;
  for (const id of chainIds) if (driven.has(id)) throw new AgentError(`"${s.nodes[id]!.name}" is already turned by IK.`);
  for (const anim of s.animations) for (const id of chainIds) {
    if (anim.tracks[id]?.keys.length) throw new AgentError(`"${s.nodes[id]!.name}" has keys in "${anim.name}"; IK would fight them. Delete them first (delete_keys), then key the target instead.`);
  }
  const name = typeof args.name === "string" ? args.name : `${boneName}_ik`;
  if (s.ik.some((k) => k.name === name)) throw new AgentError(`There is already an IK constraint "${name}".`);
  if (args.bendPositive !== undefined && typeof args.bendPositive !== "boolean") throw new AgentError("bendPositive is true or false.");
  const mix = args.mix === undefined ? 1 : args.mix;
  if (typeof mix !== "number" || mix < 0 || mix > 1) throw new AgentError("mix is a number from 0 to 1.");
  for (const f of ["stretch", "compress"]) if (args[f] !== undefined && typeof args[f] !== "boolean") throw new AgentError(`${f} is true or false.`);
  if (args.scale_y !== undefined && !["none", "uniform", "volume"].includes(args.scale_y as string)) throw new AgentError(`scale_y is "none", "uniform" or "volume".`);

  let target: Node;
  let make: (() => void) | null = null;
  if (typeof args.target === "string") {
    target = api.bone(args.target);
    if (target.kind !== "bone") throw new AgentError(`The target "${args.target}" must be a bone.`);
    // A target inside the chain chases its own tail; the solve skips it.
    if (createsCycle(s, root.id, target.id)) throw new AgentError(`The target "${args.target}" is in the chain it would move: parent it outside "${root.name}".`);
  } else {
    const targetName = `${boneName}_target`;
    if (api.nameTaken(targetName)) throw new AgentError(`The name "${targetName}" is taken: give a target.`);
    const world = api.setupWorld(effector.id);
    const tip = world ? apply(pt(), world, effector.boneLength ?? 0, 0) : pt();
    const holderWorld = root.parentId ? api.setupWorld(root.parentId) : undefined;
    const bind = placeOnBone(holderWorld, [tip.x, -tip.y]);
    if (!bind) throw new AgentError(`"${root.name}"'s parent is scaled to nothing.`);
    target = createNode("bone", targetName, { parentId: root.parentId });
    target.bind = bind;
    target.boneLength = 20;
    const made = target;
    make = () => api.store.apply(new AddNode(`AI: Add ${targetName}`, api.store.currentSymbolId, made, createLayer(made.id, made.name, s.layers.length), 0));
  }
  const label = `AI: IK on ${boneName}`;
  api.store.transaction(label, () => {
    make?.();
    api.store.apply(new AddIkConstraint(api.store.currentSymbolId, {
      id: newIkId(), name, boneId: effector.id, targetId: target.id, chain,
      bendPositive: args.bendPositive !== false, weight: mix,
      ...(args.stretch === true ? { stretch: true } : {}), ...(args.compress === true ? { compress: true } : {}),
      ...(args.scale_y === "uniform" || args.scale_y === "volume" ? { scaleY: args.scale_y } : {}),
    }, label));
  });
  return { constraint: name, bones: chainIds.map((id) => s.nodes[id]!.name), target: target.name, ...(make ? { created: target.name } : {}) };
}

export function drawOrder(api: AgentApi, parentName: string | null, front: string[]) {
  if (!front.every((n) => typeof n === "string")) throw new AgentError("front is a list of names.");
  const parentId = parentName === null ? null : api.node(parentName).id;
  const plan = siblingOrder(api.sym, parentId, front.map((n) => api.node(n).id));
  if (typeof plan === "string") throw new AgentError(plan);
  api.store.apply(new SetLayerOrder("AI: Draw Order", api.store.currentSymbolId, plan.map((l) => l.id)));
  const children = api.sym.layers.map((l) => api.sym.nodes[l.nodeId]!).filter((n) => (n.parentId ?? null) === parentId);
  return { parent: parentName, frontToBack: children.map((n) => n.name) };
}

/* ── auto rig ── */

export function autoRig(api: AgentApi, args: Args) {
  const view = args.view ?? "side";
  if (view !== "side" && view !== "front") throw new AgentError(`view is "side" or "front".`);
  const facing = args.facing ?? "right";
  if (facing !== "right" && facing !== "left") throw new AgentError(`facing is "right" or "left".`);
  if (!args.joints || typeof args.joints !== "object" || Array.isArray(args.joints)) throw new AgentError(`joints is an object of name → [x, y] in skeleton space. Joints: ${jointNames(view).join(", ")}.`);
  const s = api.sym;
  const setup = posedSymbol(api.store.project, s, null, 0, "setup");
  const wanted = Array.isArray(args.layers) ? new Set(args.layers.map(String)) : null;
  // Pictures not on a bone yet, front first.
  const layers: RigLayer[] = [];
  s.layers.forEach((l, z) => {
    const n = s.nodes[l.nodeId];
    if (!n || n.kind !== "image" || n.slotBone || n.parentId || !n.itemId) return;
    if (wanted && !wanted.has(n.name)) return;
    const item = api.store.project.items[n.itemId], m = setup.byNode.get(n.id)?.world;
    if (!item || !isImage(item) || !m) return;
    layers.push({ name: n.name, size: [item.width, item.height], pivot: [n.pivot.x, n.pivot.y], at: [m.tx, -m.ty], rotation: (Math.atan2(-m.b, m.a) * 180) / Math.PI, z });
  });
  if (wanted) for (const name of wanted) if (!layers.some((l) => l.name === name)) throw new AgentError(`"${name}" is not a picture layer off any bone.`);
  const plan = autoRigPlan(args.joints as Record<string, [number, number]>, layers, view, { armIk: args.armIk === true, taken: (n) => api.nameTaken(n) });
  if (typeof plan === "string") throw new AgentError(plan);
  const existing = Object.values(s.nodes).find((n) => n.kind === "bone" && ["hips", "torso"].includes(n.name.replace(/_bone\d*$/, "")));
  if (existing) throw new AgentError(`The rig already has "${existing.name}": auto_rig builds a skeleton from nothing. Undo the old one first.`);

  const before = api.store.history.position;
  try {
    api.store.transaction("AI: Auto Rig", () => {
      addBones(api, plan.bones.map((b) => ({ name: b.name, ...(b.parent ? { parent: b.parent } : {}), from: [...b.from], to: [...b.to] })));
      if (plan.attach.length) attach(api, plan.attach.map((a) => ({ bone: a.bone, layer: a.layer, pivot: a.pivot })));
      for (const o of plan.order) drawOrder(api, o.parent, o.front);
      for (const bone of plan.ik) {
        addIk(api, bone, {});
        const chain = plan.bones.filter((b) => b.name === bone || plan.bones.find((x) => x.name === bone)?.parent === b.name);
        settleBend(api, bone, chain, view === "side" ? facing : null);
      }
    });
  } catch (err) {
    // A step that failed half way is not left behind.
    if (api.store.history.position > before) api.store.undo();
    throw err;
  }

  // The setup pose now, against the joints it was built from.
  const posed = posedSymbol(api.store.project, api.sym, null, 0, "setup");
  let worst = 0, at = "";
  for (const b of plan.bones) {
    const m = posed.byNode.get(api.bone(b.name).id)?.world;
    const d = m ? Math.hypot(m.tx - b.from[0], -m.ty - b.from[1]) : Infinity;
    if (d > worst) { worst = d; at = b.name; }
  }
  return {
    bones: plan.bones.map((b) => b.name),
    attached: plan.attach.map((a) => ({ layer: a.layer, bone: a.bone })),
    ik: plan.ik.map((b) => `${b}_ik`),
    check: { matches: worst < 0.5, worstPixels: round(worst, 3), ...(worst < 0.5 ? {} : { at }) },
    notes: plan.notes,
    next: "Look with render_frame (no animation). Move a layer to another bone with attach; for a wrong joint, undo and run auto_rig again.",
  };
}

/** Which way an IK chain bends (`bendFlipNeeded`), set on the constraint. */
export function settleBend(api: AgentApi, effectorName: string, chain: ReadonlyArray<{ name: string; from: BoneBurstPoint; to: BoneBurstPoint }>, facing: "right" | "left" | null): void {
  const k = bendFlipNeeded(api.sym, effectorName, chain, facing);
  if (k) api.store.apply(new SetIkOptions(api.store.currentSymbolId, k.id, { bendPositive: !k.bendPositive }));
}
