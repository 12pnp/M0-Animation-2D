import type { IkId, NodeId, TcId } from "./ids";
import type { DisplayRef, Node, Project, SkinDef, SymbolItem } from "./types";
import { isImage } from "./types";
import { displayAt, displaysOf } from "./displays";

/**
 * Skins (ARCHITECTURE ▸ Skins), pure: which skins a symbol has and shows,
 * what a node shows under them, which bones and constraints they switch off,
 * and the edits the Skins panel, the Properties panel and the AI make.
 * The rules are spine-core 4.3's (`Skeleton.updateCache`, `Skin.addSkin`),
 * checked against it in `spineParity` ▸ "skins".
 */

export const DEFAULT_SKIN = "default";

type CarriedSkin = { name?: unknown; attachments?: Record<string, Record<string, { type?: string }>> };

function carriedSkins(sym: SymbolItem): CarriedSkin[] {
  return (sym.spine?.skins ?? []) as CarriedSkin[];
}

/** Whether the default skin draws anything: a display not left to skins,
 *  or a carried default-skin attachment that draws. */
function defaultDraws(sym: SymbolItem): boolean {
  const draws = (a: { type?: string }) => a.type === undefined || a.type === "region" || a.type === "mesh" || a.type === "linkedmesh";
  return Object.values(sym.nodes).some((n) => displaysOf(n).some((d) => !d.skinOnly))
    || carriedSkins(sym).some((s) => s.name === DEFAULT_SKIN && Object.values(s.attachments ?? {}).some((byKey) => Object.values(byKey).some(draws)));
}

/** The symbol's skins: "default" first when it has one, then its own skins,
 *  then any skin carried from a file that the model does not name. */
export function skinsOf(sym: SymbolItem): string[] {
  const own = (sym.skins ?? []).map((s) => s.name);
  const carried = carriedSkins(sym).map((s) => String(s.name)).filter((n) => n !== DEFAULT_SKIN && !own.includes(n));
  const hasDefault = carriedSkins(sym).some((s) => s.name === DEFAULT_SKIN) || defaultDraws(sym);
  return [...(hasDefault ? [DEFAULT_SKIN] : []), ...own, ...carried];
}

/**
 * The skins the stage shows over the default skin, combined: the symbol's
 * choice (`stageSkins`, less any it no longer has), else none when the
 * default skin draws anything, else the first other skin. Without one the
 * runtime draws only what the default skin holds, and a game picks the rest.
 */
export function stageSkinOf(sym: SymbolItem): string[] {
  const named = skinsOf(sym).filter((n) => n !== DEFAULT_SKIN);
  if (sym.stageSkins) return sym.stageSkins.filter((n) => named.includes(n));
  return defaultDraws(sym) || named.length === 0 ? [] : [named[0]!];
}

/**
 * The stage skins after turning `name` on or off: the named skins kept in
 * the rig's own order, as the stage bar's picker and the Skins panel both
 * set them.
 */
export function toggledSkins(named: readonly string[], shown: readonly string[], name: string): string[] {
  const next = shown.includes(name) ? shown.filter((n) => n !== name) : [...shown, name];
  return named.filter((n) => next.includes(n));
}

/** What each shown skin puts in place of a display, a later skin winning a
 *  display two of them hold (`Skin.addSkin`). Keyed `nodeId#index`. */
export function skinLookup(sym: SymbolItem, skins: readonly string[]): Map<string, DisplayRef> {
  const out = new Map<string, DisplayRef>();
  for (const name of skins) {
    const def = sym.skins?.find((s) => s.name === name);
    for (const [nodeId, byIndex] of Object.entries(def?.displays ?? {})) {
      for (const [index, ref] of Object.entries(byIndex)) out.set(`${nodeId}#${index}`, ref);
    }
  }
  return out;
}

/**
 * What `node` shows at display `index` with the skins `lookup` was built for:
 * the skin's display, else the node's own, else nothing for a display only
 * skins fill. `lookup` null ignores skins (a bind pose).
 */
export function skinnedDisplay(node: Node, index: number, lookup: Map<string, DisplayRef> | null): DisplayRef | null {
  const own = displayAt(node, index);
  if (!own || !lookup) return own;
  return lookup.get(`${node.id}#${index}`) ?? (own.skinOnly ? null : own);
}

/**
 * The nodes a skin's bones are in the export: those it lists, and every
 * descendant that is not a bone (an image's or a group's own bone), so a
 * picture goes with the bone it hangs from. Descendant bones are listed
 * explicitly (`withSkinBones` adds them).
 */
export function skinBoneSet(sym: SymbolItem, def: SkinDef): Set<NodeId> {
  const out = new Set<NodeId>((def.bones ?? []).filter((id) => sym.nodes[id]));
  const children = childrenOf(sym);
  const walk = (id: NodeId) => {
    for (const c of children.get(id) ?? []) {
      if (c.kind === "bone" || out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id);
    }
  };
  for (const id of [...out]) walk(id);
  return out;
}

function childrenOf(sym: SymbolItem): Map<NodeId, Node[]> {
  const children = new Map<NodeId, Node[]>();
  for (const n of Object.values(sym.nodes)) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n);
    else children.set(n.parentId, [n]);
  }
  return children;
}

export interface SkinActivity {
  /** Nodes whose bone is off: neither drawn nor solved. */
  inactive: Set<NodeId>;
  ikOff: Set<IkId>;
  tcOff: Set<TcId>;
}

/**
 * What the shown skins switch off, as `Skeleton.updateCache` does: a bone some
 * skin lists is off unless a shown skin lists it or one of its descendants;
 * a constraint is off when its source is (an IK's target, a transform
 * constraint's source) or some skin lists it and no shown skin does. A slot
 * riding a bone (`slotBone`) goes with it. `skins` null: nothing is off.
 */
export function skinActivity(sym: SymbolItem, skins: readonly string[] | null): SkinActivity {
  const out: SkinActivity = { inactive: new Set(), ikOff: new Set(), tcOff: new Set() };
  const defs = sym.skins ?? [];
  if (!skins || !defs.length) return out;
  const required = new Set<NodeId>();
  const active = new Set<NodeId>();
  const shown = defs.filter((d) => skins.includes(d.name));
  for (const def of defs) {
    const set = skinBoneSet(sym, def);
    for (const id of set) required.add(id);
    if (!shown.includes(def)) continue;
    for (const id of set) {
      for (let at: NodeId | null | undefined = id; at && !active.has(at); at = sym.nodes[at]?.parentId) active.add(at);
    }
  }
  const off = (id: NodeId): boolean => required.has(id) && !active.has(id);
  for (const n of Object.values(sym.nodes)) {
    // A slot that rides a bone has no bone of its own: it is off with that bone.
    if (n.slotBone ? off(n.slotBone) : off(n.id)) out.inactive.add(n.id);
  }
  const inShown = (pick: (d: SkinDef) => readonly string[] | undefined, id: string) => shown.some((d) => pick(d)?.includes(id));
  const listed = (pick: (d: SkinDef) => readonly string[] | undefined, id: string) => defs.some((d) => pick(d)?.includes(id));
  for (const k of sym.ik) {
    if (out.inactive.has(k.targetId) || (listed((d) => d.ik, k.id) && !inShown((d) => d.ik, k.id))) out.ikOff.add(k.id);
  }
  for (const k of sym.transforms ?? []) {
    if (out.inactive.has(k.sourceId) || (listed((d) => d.transforms, k.id) && !inShown((d) => d.transforms, k.id))) out.tcOff.add(k.id);
  }
  return out;
}

/** Why `name` cannot be a new skin's name (or `from`'s new name); null when it can. */
export function skinNameProblem(sym: SymbolItem, name: string, from?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A skin needs a name.";
  if (trimmed === DEFAULT_SKIN) return `"${DEFAULT_SKIN}" is the skin every rig has; choose another name.`;
  if (trimmed !== from && skinsOf(sym).includes(trimmed)) return `There is already a skin called "${trimmed}".`;
  return null;
}

/** The skin the panels edit: `chosen` while the symbol has it, else the
 *  first one shown, else the first; null without skins. */
export function editedSkin(sym: SymbolItem, chosen: string | null): string | null {
  const named = skinsOf(sym).filter((n) => n !== DEFAULT_SKIN);
  if (chosen && named.includes(chosen)) return chosen;
  return stageSkinOf(sym)[0] ?? named[0] ?? null;
}

/** "skin", "skin 2", …: the first name no skin has. */
export function uniqueSkinName(sym: SymbolItem, base = "skin"): string {
  const taken = new Set(skinsOf(sym));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/**
 * What a skin shows at `node`'s display `index` when given image `itemId`:
 * the image about the same relative point as the node's own display, so a
 * picture drawn on the same canvas lands where the default one does.
 */
export function skinDisplayFor(project: Project, node: Node, index: number, itemId: DisplayRef["itemId"]): DisplayRef | null {
  const own = displayAt(node, index);
  const item = project.items[itemId], was = own ? project.items[own.itemId] : undefined;
  if (!own || !isImage(item)) return null;
  const sx = isImage(was) && was.width ? item.width / was.width : 1, sy = isImage(was) && was.height ? item.height / was.height : 1;
  return { itemId, pivot: { x: Math.round(own.pivot.x * sx * 100) / 100, y: Math.round(own.pivot.y * sy * 100) / 100 } };
}

/** The fields a skin edit replaces: the skins, the stage's choice and what
 *  of the file's skins is carried. */
export interface SkinState {
  skins: SkinDef[] | undefined;
  stageSkins: string[] | undefined;
  carried: Array<Record<string, unknown>> | undefined;
}

export function skinStateOf(sym: SymbolItem): SkinState {
  return { skins: sym.skins, stageSkins: sym.stageSkins, carried: sym.spine?.skins };
}

/** A new, empty skin at the end, shown on the stage alone. */
export function withNewSkin(sym: SymbolItem, name: string): SkinState | string {
  const problem = skinNameProblem(sym, name);
  if (problem) return problem;
  const skin: SkinDef = { name: name.trim() };
  return { ...skinStateOf(sym), skins: [...(sym.skins ?? []), skin], stageSkins: [skin.name] };
}

/** `from` renamed, its carried part and the stage's choice with it. A skin
 *  only carried from a file becomes one of the model's. */
export function withRenamedSkin(sym: SymbolItem, from: string, to: string): SkinState | string {
  const problem = skinNameProblem(sym, to, from);
  if (problem) return problem;
  const name = to.trim();
  const own = sym.skins ?? [];
  const skins = own.some((s) => s.name === from) ? own.map((s) => (s.name === from ? { ...s, name } : s)) : [...own, { name }];
  const carried = sym.spine?.skins.map((s) => (s.name === from ? { ...s, name } : s));
  const stageSkins = sym.stageSkins?.map((n) => (n === from ? name : n));
  return { skins, stageSkins, carried };
}

/** `name` gone, with its carried part; the stage stops showing it. */
export function withoutSkin(sym: SymbolItem, name: string): SkinState {
  const skins = (sym.skins ?? []).filter((s) => s.name !== name);
  return {
    skins: skins.length ? skins : undefined,
    stageSkins: sym.stageSkins?.filter((n) => n !== name),
    carried: sym.spine?.skins.filter((s) => s.name !== name),
  };
}

/** The skin `name`, made a model skin if it was only carried. */
function ensured(skins: readonly SkinDef[], name: string): SkinDef[] {
  return skins.some((s) => s.name === name) ? [...skins] : [...skins, { name }];
}

/** Skin `name` showing `ref` at `nodeId`'s display `index`; null takes the
 *  skin's display away there. */
export function withSkinDisplay(sym: SymbolItem, name: string, nodeId: NodeId, index: number, ref: DisplayRef | null): SkinState {
  const skins = ensured(sym.skins ?? [], name).map((s) => {
    if (s.name !== name) return s;
    const displays = { ...s.displays };
    const byIndex = { ...displays[nodeId] };
    if (ref) byIndex[String(index)] = ref;
    else delete byIndex[String(index)];
    if (Object.keys(byIndex).length) displays[nodeId] = byIndex;
    else delete displays[nodeId];
    const out: SkinDef = { ...s, displays };
    if (!Object.keys(displays).length) delete out.displays;
    return out;
  });
  return { ...skinStateOf(sym), skins };
}

/** `ids` and every bone below them, in the symbol's node order. */
export function withDescendantBones(sym: SymbolItem, ids: readonly NodeId[]): NodeId[] {
  const children = childrenOf(sym);
  const out = new Set<NodeId>();
  const walk = (id: NodeId) => {
    if (out.has(id)) return;
    out.add(id);
    for (const c of children.get(id) ?? []) if (c.kind === "bone") walk(c.id);
  };
  for (const id of ids) if (sym.nodes[id]) walk(id);
  return Object.keys(sym.nodes).filter((id) => out.has(id as NodeId)) as NodeId[];
}

/**
 * Skin `name` with `bones` (and the bones below them), IK constraints `ik`
 * and transform constraints `transforms` added (`on`) or taken out.
 */
export function withSkinMembers(
  sym: SymbolItem, name: string, members: { bones?: readonly NodeId[]; ik?: readonly IkId[]; transforms?: readonly TcId[] }, on: boolean,
): SkinState {
  const bones = withDescendantBones(sym, members.bones ?? []);
  const edit = <T extends string>(list: readonly T[] | undefined, ids: readonly T[]): T[] | undefined => {
    const set = new Set(list ?? []);
    for (const id of ids) if (on) set.add(id); else set.delete(id);
    return set.size ? [...set] : undefined;
  };
  const skins = ensured(sym.skins ?? [], name).map((s) => {
    if (s.name !== name) return s;
    const out: SkinDef = { ...s, bones: edit(s.bones, bones), ik: edit(s.ik, members.ik ?? []), transforms: edit(s.transforms, members.transforms ?? []) };
    for (const k of ["bones", "ik", "transforms"] as const) if (!out[k]) delete out[k];
    return out;
  });
  return { ...skinStateOf(sym), skins };
}
