import { displaysOf } from "@/core/doc/displays";
import type { NodeId } from "@/core/doc/ids";
import { evaluateSymbol } from "@/core/doc/pose";
import { type Project, type SymbolItem, type Node, type MeshData, type Animation, type DeformKey, isImage, type SkinDef, type DisplayRef, type BoneBurstAttachmentRef } from "@/core/doc/types";
import { type DeformTarget, assignDeforms, withDeformKeysOf } from "@/core/mesh/deform";
import { type MeshContext, deformKeysFromBoneBurst, meshFromBoneBurst } from "./importMesh";
import { str } from "./importRead";
import type { BoneBurstRaw } from "./types";

/**
 * The default skin's meshes the model can hold become the document's
 * (ARCHITECTURE ▸ Meshes ▸ Opened meshes): `meshFromBoneBurst`, and each
 * animation's deform timeline as keys. A mesh another display's deform keys,
 * or a timeline that does not convert, stays carried, the whole mesh at once.
 */
export function editableMeshes(project: Project, sym: SymbolItem, slotNode: Map<string, Node>, boneNode: Map<string, Node>, rate: number): void {
  const setup = evaluateSymbol(sym, null, 0, "setup", null).byNode;
  const bone = (name: string) => {
    const n = boneNode.get(name);
    const w = n ? setup.get(n.id)?.world : undefined;
    return n && w ? { id: n.id, setup: w } : undefined;
  };
  const setupOf = (id: NodeId) => setup.get(id)?.world;
  /** Each animation's deform timeline of `skin`'s `key` in `slot` as `target`'s
   *  keys, the carried timelines dropped; false (nothing changed) when one
   *  does not convert, and the mesh stays carried. */
  const takeDeforms = (target: DeformTarget, skin: string, slot: string, key: string, mesh: MeshData, ctx: MeshContext): boolean => {
    const deforms = new Map<Animation, DeformKey[]>();
    for (const anim of sym.animations) {
      const raw = deformOf(anim, skin, slot, key);
      if (raw === undefined) continue;
      const keys = deformKeysFromBoneBurst(raw, mesh, ctx, rate);
      if (!keys) return false;
      deforms.set(anim, keys);
    }
    for (const [anim, keys] of deforms) {
      assignDeforms(anim, withDeformKeysOf(anim, target, keys));
      dropCarriedDeform(anim, skin, slot, key);
    }
    return true;
  };
  for (const [slotName, slot] of slotNode) {
    const nodeWorld = setup.get(slot.id)?.world;
    if (!nodeWorld) continue;
    displaysOf(sym.nodes[slot.id]!).forEach((d, index) => {
      const att = d.attachment;
      const item = project.items[d.itemId];
      if (!att || d.skinOnly || att.data.type !== "mesh" || !isImage(item)) return;
      const ctx = { width: item.width, height: item.height, pivot: d.pivot, node: nodeWorld, bone, setupOf };
      const mesh = meshFromBoneBurst(att.data, ctx);
      if (!mesh) return;
      if (!takeDeforms({ nodeId: slot.id, skin: null, index }, "default", slotName, att.name, mesh, ctx)) return;
      replaceDisplay(sym, slot.id, index, { mesh, key: att.name, ...nameOf(att) });
    });
    // Linked meshes whose parent is now the document's mesh, in this slot.
    displaysOf(sym.nodes[slot.id]!).forEach((d, index) => {
      const att = d.attachment;
      if (!att || d.skinOnly || att.data.type !== "linkedmesh") return;
      const data = att.data;
      if (Object.keys(data).some((k) => !LINKED_FIELDS.has(k)) || (data.skin !== undefined && data.skin !== "default")) return;
      if (data.slot !== undefined && data.slot !== slotName) return;
      if (sym.animations.some((anim) => deformOf(anim, "default", slotName, att.name) !== undefined)) return;
      const to = displaysOf(sym.nodes[slot.id]!).findIndex((p) => p.mesh && p.key === data.source);
      if (to < 0) return;
      replaceDisplay(sym, slot.id, index, { linked: data.timelines === false ? { to, deform: false } : { to }, key: att.name, ...nameOf(att) });
    });
  }
  // Other skins' meshes likewise, their deform timelines as the skin's keys.
  const slotName = new Map([...slotNode].map(([name, n]) => [n.id, name]));
  const skinned = (fn: (def: SkinDef, nodeId: NodeId, index: number, ref: DisplayRef, slot: string) => DisplayRef | null) => {
    for (const def of sym.skins ?? []) {
      for (const [nodeId, byIndex] of Object.entries(def.displays ?? {}) as Array<[NodeId, Record<string, DisplayRef>]>) {
        const slot = slotName.get(nodeId);
        if (!slot) continue;
        for (const [index, ref] of Object.entries(byIndex)) {
          const held = ref.attachment ? fn(def, nodeId, Number(index), ref, slot) : null;
          // The tint the carried display had read from its colour stays.
          if (held) byIndex[index] = ref.tint ? { ...held, tint: ref.tint } : held;
        }
      }
    }
  };
  const deformed = (skin: string, slot: string, key: string) => sym.animations.some((anim) => deformOf(anim, skin, slot, key) !== undefined);
  skinned((def, nodeId, index, ref, slot) => {
    const att = ref.attachment!;
    const item = project.items[ref.itemId];
    const nodeWorld = setup.get(nodeId)?.world;
    if (att.data.type !== "mesh" || !isImage(item) || !nodeWorld) return null;
    const ctx = { width: item.width, height: item.height, pivot: ref.pivot, node: nodeWorld, bone, setupOf };
    const mesh = meshFromBoneBurst(att.data, ctx);
    if (!mesh || !takeDeforms({ nodeId, skin: def.name, index }, def.name, slot, att.name, mesh, ctx)) return null;
    return { itemId: ref.itemId, pivot: ref.pivot, mesh, key: att.name, ...nameOf(att) };
  });
  // A skin's linked mesh whose source is a mesh the document now holds: in the
  // skin it names (Spine's `skin`), else in the default skin.
  skinned((def, nodeId, index, ref, slot) => {
    const data = ref.attachment!.data;
    if (data.type !== "linkedmesh" || Object.keys(data).some((k) => !LINKED_FIELDS.has(k))) return null;
    if ((data.slot !== undefined && data.slot !== slot) || deformed(def.name, slot, ref.attachment!.name)) return null;
    const from = str(data.skin) && data.skin !== "default" ? data.skin : null;
    const node = sym.nodes[nodeId]!;
    const count = displaysOf(node).length;
    let to = -1;
    for (let i = 0; i < count && to < 0; i++) {
      const d = from ? sym.skins?.find((x) => x.name === from)?.displays?.[nodeId]?.[i] : displaysOf(node)[i];
      if (d?.mesh && d.key === data.source) to = i;
    }
    if (to < 0 || (to === index && !from)) return null;
    const linked: DisplayRef["linked"] = { to, ...(data.timelines === false ? { deform: false as const } : {}), ...(from ? { skin: from } : {}) };
    return { itemId: ref.itemId, pivot: ref.pivot, linked, key: ref.attachment!.name, ...nameOf(ref.attachment!) };
  });
}
/** An attachment's own colour (Spine's `color`) as a display's tint; white is none. */
export function tintOf(data: BoneBurstRaw): { tint?: string; } {
  if (!str(data.color) || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(data.color)) return {};
  const t = (data.color.length === 6 ? data.color + "ff" : data.color).toLowerCase();
  return t === "ffffffff" ? {} : { tint: t };
}
/** An attachment's own name, kept where it is not its key. */
const nameOf = (att: BoneBurstAttachmentRef): { name?: string; } => (str(att.data.name) && att.data.name !== att.name ? { name: att.data.name } : {});
const LINKED_FIELDS = new Set(["type", "name", "path", "source", "slot", "skin", "timelines", "width", "height", "color"]);
/** Display `index` of the node with its carried attachment replaced by `held`. */
function replaceDisplay(sym: SymbolItem, nodeId: NodeId, index: number, held: Pick<DisplayRef, "mesh" | "key" | "linked" | "name">): void {
  const node = sym.nodes[nodeId]!;
  if (index === 0) {
    const { attachment: _a, ...rest } = node;
    const { name, ...own } = held;
    sym.nodes[nodeId] = { ...rest, ...own, ...(name ? { attachmentName: name } : {}) };
    return;
  }
  const extras = [...node.extraDisplays!];
  const { attachment: _a, ...ref } = extras[index - 1]!;
  extras[index - 1] = { ...ref, ...held };
  sym.nodes[nodeId] = { ...node, extraDisplays: extras };
}
export function deformOf(anim: Animation, skin: string, slot: string, key: string): unknown {
  const atts = anim.spine?.attachments as Record<string, Record<string, Record<string, BoneBurstRaw>>> | undefined;
  return atts?.[skin]?.[slot]?.[key]?.deform;
}

export function dropCarriedDeform(anim: Animation, skin: string, slot: string, key: string): void {
  const atts = structuredClone(anim.spine!.attachments) as Record<string, Record<string, Record<string, BoneBurstRaw>>>;
  const att = atts[skin]![slot]![key]!;
  delete att.deform;
  if (!Object.keys(att).length) delete atts[skin]![slot]![key];
  if (!Object.keys(atts[skin]![slot]!).length) delete atts[skin]![slot];
  if (!Object.keys(atts[skin]!).length) delete atts[skin];
  const boneburst = { ...anim.spine };
  if (Object.keys(atts).length) boneburst.attachments = atts; else delete boneburst.attachments;
  if (Object.keys(boneburst).length) anim.spine = boneburst; else delete anim.spine;
}
