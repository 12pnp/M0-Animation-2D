import { displaysOf } from "@/core/doc/displays";
import type { IkId, TcId, CnId, NodeId, ItemId } from "@/core/doc/ids";
import { descendantsOf } from "@/core/doc/layerTree";
import { skinBoneSet } from "@/core/doc/skins";
import { type SymbolItem, type Node, type DisplayRef, type Project, producesSlot } from "@/core/doc/types";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { isAtlasName } from "./atlas";
import { type Scope, ROOT_BONE } from "./exportTypes";
import type { BoneBurstLocal } from "./transform";
import type { BoneBurstBone, BoneBurstIkConstraint, BoneBurstTransformConstraint, BoneBurstAttachment, BoneBurstSkin } from "./types";

/* ── structure ───────────────────────────────────────────────────────────── */
/**
 * The exported symbol's own skins (ARCHITECTURE ▸ Skins): each one's
 * attachments, its bones (`skinBoneSet`, in bone order) and constraints by
 * name, one list per kind, all marked `skin` as Spine requires.
 */
export function skinsOfModel(
  sym: SymbolItem, bones: BoneBurstBone[], boneNodes: Array<{ scope: Scope; node: Node; name: string; }>,
  rootIk: Map<IkId, BoneBurstIkConstraint>, rootTc: Map<TcId, BoneBurstTransformConstraint>, rootCn: Map<CnId, Record<string, unknown>>,
  attachments: Map<string, Record<string, Record<string, BoneBurstAttachment>>>): BoneBurstSkin[] {
  const nameOf = new Map(boneNodes.filter((b) => b.scope.depth === 0).map((b) => [b.node.id, b.name]));
  return (sym.skins ?? []).map((def) => {
    const set = skinBoneSet(sym, def);
    const names = new Set([...set].map((id) => nameOf.get(id)).filter((n): n is string => !!n));
    const own = bones.filter((b) => names.has(b.name));
    for (const b of own) b.skin = true;
    const ik = (def.ik ?? []).map((id) => rootIk.get(id)).filter((c): c is BoneBurstIkConstraint => !!c);
    const tc = (def.transforms ?? []).map((id) => rootTc.get(id)).filter((c): c is BoneBurstTransformConstraint => !!c);
    for (const c of [...ik, ...tc]) c.skin = true;
    const skin: BoneBurstSkin = { name: def.name };
    if (def.color) (skin as unknown as Record<string, unknown>).color = def.color;
    const atts = attachments.get(def.name);
    if (atts) skin.attachments = atts;
    if (own.length) skin.bones = own.map((b) => b.name);
    if (ik.length) skin.ik = ik.map((c) => c.name);
    if (tc.length) skin.transform = tc.map((c) => c.name);
    // Physics, sliders and paths, each kind in its own list as Spine writes them.
    const lists = skin as unknown as Record<string, string[] | undefined>;
    for (const id of def.constraints ?? []) {
      const c = rootCn.get(id);
      if (!c) continue;
      c.skin = true;
      (lists[c.type as string] ??= []).push(String(c.name));
    }
    return skin;
  });
}
/**
 * Display 0 always (the setup pose shows it), the extra displays some key
 * still uses, and with `skinned` those a skin fills, by their index in the
 * node's display list.
 */
export function exportedDisplays(sym: SymbolItem, node: Node, skinned = false): Array<[number, DisplayRef]> {
  const all = displaysOf(node);
  // An opened slot's skin keeps every attachment, keyed or not.
  if (all.some((d) => d.attachment || d.key)) return all.map((d, i) => [i, d]);
  const used = new Set<number>([0]);
  for (const anim of sym.animations) {
    for (const k of anim.tracks[node.id]?.keys ?? []) {
      if (k.displayIndex > 0 && k.displayIndex < all.length) used.add(k.displayIndex);
    }
  }
  if (skinned) {
    all.forEach((d, i) => { if (d.skinOnly) used.add(i); });
    for (const def of sym.skins ?? []) for (const i of Object.keys(def.displays?.[node.id] ?? {})) used.add(Number(i));
  }
  // A linked mesh needs its parent in the file.
  for (const i of [...used]) { const to = all[i]?.linked?.to; if (to !== undefined) used.add(to); }
  return [...used].sort((a, b) => a - b).filter((i) => all[i]).map((i) => [i, all[i]!]);
}
/**
 * Nodes that never reach the file: excluded layers with their whole
 * subtree (a child left behind would reparent to the root and move), and
 * the "empty" placeholders that hold empty layers open.
 */
export function excludedNodes(sym: SymbolItem): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const layer of sym.layers) {
    if (!layer.excludeFromExport) continue;
    out.add(layer.nodeId);
    for (const id of descendantsOf(sym, layer.nodeId)) out.add(id);
  }
  for (const node of Object.values(sym.nodes)) if (node.kind === "empty") out.add(node.id);
  return out;
}
export function reportExcluded(sym: SymbolItem, skipped: Set<NodeId>, diags: ExportDiagnostic[]): void {
  const named = sym.layers.filter((l) => l.excludeFromExport && skipped.has(l.nodeId));
  if (named.length === 0) return;
  diags.push({
    severity: "warning",
    message: `Excluded from "${sym.name}": ${named.map((l) => `"${l.name}"`).join(", ")}. Marked "Exclude from Export", ` +
      `so ${named.length === 1 ? "it is" : "they are"} left out of the exported files and the Preview.`,
  });
}
/**
 * The runtime finds atlas regions by name, so two images with one name
 * would both draw the first's pixels; and the atlas is line based.
 */
export function reportImageNames(project: Project, ids: ItemId[], diags: ExportDiagnostic[]): void {
  const count = new Map<string, number>();
  for (const id of ids) {
    const name = project.items[id]!.name;
    count.set(name, (count.get(name) ?? 0) + 1);
    if (!isAtlasName(name)) {
      diags.push({
        severity: "error",
        message: `The image name ${JSON.stringify(name)} cannot go in a Spine atlas: remove leading or trailing spaces and line breaks.`,
      });
    }
  }
  for (const [name, n] of count) {
    if (n < 2) continue;
    diags.push({
      severity: "error",
      message: `${n} images in the library are called "${name}". Spine finds each texture by name, so all but one would show the wrong one. Give them different names.`,
    });
  }
}
/** Parents before children: the parser silently roots a bone whose parent
 *  comes later. Layer order first, so siblings keep a stable order. */
export function nodesInHierarchyOrder(sym: SymbolItem): Node[] {
  const out: Node[] = [];
  const emitted = new Set<NodeId>();
  const emit = (node: Node, depth: number): void => {
    if (emitted.has(node.id) || depth > 64) return;
    if (node.parentId) {
      const parent = sym.nodes[node.parentId];
      if (parent && !emitted.has(parent.id)) emit(parent, depth + 1);
    }
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    out.push(node);
  };
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node) emit(node, 0);
  }
  for (const node of Object.values(sym.nodes)) emit(node, 0);
  return out;
}
/**
 * Bones and slots are found by name, so names are unique within a symbol;
 * "root" is taken at the top, where the root bone lives, unless `ownRoot`
 * is that bone. A layer is a bone and a slot of one name; a slot on a bone
 * (`slotBone`) is only a slot, and slots and bones are named apart in
 * Spine, so it only has to differ from the other slots.
 */
export function uniqueNames(sym: SymbolItem, diags: ExportDiagnostic[], top: boolean, ownRoot?: Node): Map<NodeId, string> {
  const map = new Map<NodeId, string>();
  const bonesTaken = new Set<string>(top && !ownRoot ? [ROOT_BONE] : []);
  const slotsTaken = new Set<string>();
  const assign = (node: Node): void => {
    const riding = rides(sym, node);
    const bone = !riding, slot = riding || producesSlot(node);
    const free = (n: string) => !(bone && bonesTaken.has(n)) && !(slot && slotsTaken.has(n));
    let name = node.name.trim() || node.kind;
    if (!free(name)) {
      const original = name;
      for (let i = 2; !free(name); i++) name = `${original}_${i}`;
      diags.push({
        severity: "warning",
        message: original === ROOT_BONE && bone
          ? `"${ROOT_BONE}" is the name of the skeleton's root bone in Spine; exported "${node.name}" in "${sym.name}" as "${name}".`
          : `Two objects in "${sym.name}" are called "${original}"; exported the second as "${name}".`,
      });
    }
    if (bone) bonesTaken.add(name);
    if (slot) slotsTaken.add(name);
    map.set(node.id, name);
  };
  if (ownRoot) assign(ownRoot);
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node && !map.has(node.id)) assign(node);
  }
  for (const node of Object.values(sym.nodes)) if (!map.has(node.id)) assign(node);
  return map;
}
export function withoutDefaults(s: BoneBurstLocal): Partial<BoneBurstLocal> {
  const out: Partial<BoneBurstLocal> = {};
  if (s.x !== 0) out.x = s.x;
  if (s.y !== 0) out.y = s.y;
  if (s.rotation !== 0) out.rotation = s.rotation;
  if (s.shearX !== 0) out.shearX = s.shearX;
  if (s.shearY !== 0) out.shearY = s.shearY;
  if (s.scaleX !== 1) out.scaleX = s.scaleX;
  if (s.scaleY !== 1) out.scaleY = s.scaleY;
  return out;
}

export function nonZero<T extends Record<string, number>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== 0) out[k] = o[k];
  return out;
}
/** A slot on a bone of its own symbol: exported with no bone of its own. */

export function rides(sym: SymbolItem, node: Node): boolean {
  return !!node.slotBone && sym.nodes[node.slotBone]?.kind === "bone";
}
