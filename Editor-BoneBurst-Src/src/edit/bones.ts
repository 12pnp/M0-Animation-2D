import type { Attachment, Bone, Constraint, Skeleton, Skin } from "@/model/skeleton";
import { EditRefused, type Edit } from "./history";
import { removeSlots, slotUsers } from "./slots";
import { refuseNonFinite } from "./finite";

/** The fields of a bone an edit may set; `undefined` removes the key (the default then applies). */
export type BonePatch = { -readonly [K in Exclude<keyof Bone, "name" | "extra">]?: Bone[K] | undefined };

/** Set fields of the bone `name`. Refused when there is no such bone, or the parent would not be an earlier bone. */
export function updateBone(name: string, patch: BonePatch): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite(`Bone "${name}"`, patch);
    const bones = s.bones ?? [];
    const i = bones.findIndex((b) => b.name === name);
    if (i < 0) throw new EditRefused(`There is no bone "${name}".`);
    if (patch.parent !== undefined && !bones.slice(0, i).some((b) => b.name === patch.parent)) {
      throw new EditRefused(`"${patch.parent}" is not a bone before "${name}"; a parent must come first.`);
    }
    const next: Record<string, unknown> = { ...bones[i]! };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (next[k] === v) continue;
      changed = true;
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    if (!changed) return s;
    return { ...s, bones: bones.map((b, n) => (n === i ? (next as unknown as Bone) : b)) };
  };
}

/**
 * Rename a bone, and every reference to it: children's parents, slots, constraints, skins' bone
 * lists, animations' bone timelines. Refused for an empty name or one another bone has.
 */
export function renameBone(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    if (from === to) return s;
    const bones = s.bones ?? [];
    if (!bones.some((b) => b.name === from)) throw new EditRefused(`There is no bone "${from}".`);
    if (!to) throw new EditRefused("A bone needs a name.");
    if (bones.some((b) => b.name === to)) throw new EditRefused(`There is already a bone "${to}".`);
    const r = (n: string) => (n === from ? to : n);
    const ro = (n: string | undefined) => (n === from ? to : n);
    const list = (l: readonly string[] | undefined) => (l?.includes(from) ? l.map(r) : l);
    return {
      ...s,
      bones: bones.map((b) => ({ ...b, name: r(b.name), ...(b.parent !== undefined ? { parent: r(b.parent) } : {}) })),
      ...(s.slots ? { slots: s.slots.map((sl) => (sl.bone === from ? { ...sl, bone: to } : sl)) } : {}),
      ...(s.constraints ? { constraints: s.constraints.map((c) => renameInConstraint(c, from, to, list, ro)) } : {}),
      ...(s.skins ? { skins: s.skins.map((k) => (k.bones?.includes(from) ? { ...k, bones: list(k.bones)! } : k)) } : {}),
      ...(s.animations ? {
        animations: s.animations.map((a) => (a.bones?.some((g) => g.name === from)
          ? { ...a, bones: a.bones.map((g) => (g.name === from ? { ...g, name: to } : g)) }
          : a)),
      } : {}),
    };
  };
}

function renameInConstraint(
  c: Constraint, from: string, to: string,
  list: (l: readonly string[] | undefined) => readonly string[] | undefined,
  ro: (n: string | undefined) => string | undefined,
): Constraint {
  const bones = "bones" in c && c.bones?.includes(from) ? { bones: list(c.bones)! } : {};
  switch (c.type) {
    case "ik": return c.target === from || "bones" in bones ? { ...c, ...bones, ...(c.target !== undefined ? { target: ro(c.target)! } : {}) } : c;
    case "transform": return c.source === from || "bones" in bones ? { ...c, ...bones, ...(c.source !== undefined ? { source: ro(c.source)! } : {}) } : c;
    case "path": return "bones" in bones ? { ...c, ...bones } : c;
    case "physics": case "slider": return c.bone === from ? { ...c, bone: to } : c;
  }
}

/** The bone and every bone under it, in skeleton order. */
export function subtree(s: Skeleton, name: string): string[] {
  const out = new Set([name]);
  for (const b of s.bones ?? []) if (b.parent !== undefined && out.has(b.parent)) out.add(b.name);
  return (s.bones ?? []).filter((b) => out.has(b.name)).map((b) => b.name);
}

/** Index just past `name`'s subtree in `bones`. */
function afterSubtree(bones: readonly Bone[], name: string): number {
  const under = new Set([name]);
  let last = bones.findIndex((b) => b.name === name);
  bones.forEach((b, i) => { if (b.parent !== undefined && under.has(b.parent)) { under.add(b.name); last = i; } });
  return last + 1;
}

/** Add a bone under `parent`, after the parent's other descendants (the first bone of an empty skeleton has none). */
export function addBone(name: string, parent: string | null, patch: BonePatch = {}): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite(`Bone "${name}"`, patch);
    const bones = s.bones ?? [];
    if (!name.trim()) throw new EditRefused("A bone needs a name.");
    if (bones.some((b) => b.name === name)) throw new EditRefused(`There is already a bone "${name}".`);
    if (parent === null && bones.length) throw new EditRefused("A bone needs a parent; the skeleton has its root.");
    if (parent !== null && !bones.some((b) => b.name === parent)) throw new EditRefused(`There is no bone "${parent}".`);
    const fields = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "parent"));
    const bone = { name, ...(parent !== null ? { parent } : {}), ...fields, extra: new Map() } as Bone;
    const at = parent === null ? 0 : afterSubtree(bones, parent);
    return withBoneOrder(s, [...bones.slice(0, at), bone, ...bones.slice(at)]);
  };
}

/**
 * Delete a bone with every bone under it, the slots on them (with their skin entries and
 * timelines) and their bone timelines. Refused for the root, and while a constraint, or something
 * outside those slots, names one of them.
 */
export function deleteBone(name: string): Edit<Skeleton> {
  return (s) => {
    const b = s.bones?.find((x) => x.name === name);
    if (!b) throw new EditRefused(`There is no bone "${name}".`);
    if (b.parent === undefined) throw new EditRefused("The root bone cannot be deleted.");
    const gone = new Set(subtree(s, name));
    for (const c of s.constraints ?? []) {
      const names = constraintBones(c);
      const hit = names.find((n) => gone.has(n));
      if (hit) throw new EditRefused(`"${name}" cannot be deleted: the ${c.type} constraint "${c.name}" uses "${hit}". Delete the constraint first.`);
    }
    const slots = new Set((s.slots ?? []).filter((x) => gone.has(x.bone)).map((x) => x.name));
    for (const slot of slots) {
      const why = slotUsers(s, slot);
      // Users inside the deleted slots go with them; only outside ones block.
      if (why && !insideOnly(s, slot, slots)) throw new EditRefused(`"${name}" cannot be deleted: the slot "${slot}" is in use (${why}).`);
    }
    const out = withBoneOrder(removeSlots(s, slots), (s.bones ?? []).filter((x) => !gone.has(x.name)), name);
    return {
      ...out,
      ...(out.skins ? { skins: out.skins.map((k) => (k.bones?.some((n) => gone.has(n)) ? { ...k, bones: k.bones.filter((n) => !gone.has(n)) } : k)) } : {}),
      ...(out.animations ? { animations: out.animations.map((a) => (a.bones?.some((g) => gone.has(g.name)) ? { ...a, bones: a.bones.filter((g) => !gone.has(g.name)) } : a)) } : {}),
    };
  };
}

/** The bones a constraint names. */
function constraintBones(c: Constraint): string[] {
  switch (c.type) {
    case "ik": return [...(c.bones ?? []), ...(c.target !== undefined ? [c.target] : [])];
    case "transform": return [...(c.bones ?? []), ...(c.source !== undefined ? [c.source] : [])];
    case "path": return [...(c.bones ?? [])];
    case "physics": case "slider": return c.bone !== undefined ? [c.bone] : [];
  }
}

/** Whether every user of `slot` is itself among the slots going. */
function insideOnly(s: Skeleton, slot: string, going: ReadonlySet<string>): boolean {
  if (s.constraints?.some((c) => c.type === "path" && c.slot === slot)) return false;
  for (const sk of s.skins ?? []) for (const ss of sk.attachments ?? []) for (const e of ss.entries) {
    const a = e.attachment;
    const uses = a.end === slot || (a.source !== undefined && a.slot === slot && ss.slot !== slot);
    if (uses && !going.has(ss.slot)) return false;
  }
  return true;
}

/**
 * Move a bone (and everything under it) under `parent`, with the local values `local` that keep
 * it where it was (the stage works them out from the pose). Bones stay ordered parent first.
 */
export function reparentBone(name: string, parent: string, local: BonePatch = {}): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite(`Bone "${name}"`, local);
    const bones = s.bones ?? [];
    const b = bones.find((x) => x.name === name);
    if (!b) throw new EditRefused(`There is no bone "${name}".`);
    if (!bones.some((x) => x.name === parent)) throw new EditRefused(`There is no bone "${parent}".`);
    if (b.parent === undefined) throw new EditRefused("The root bone has no parent.");
    const moving = new Set(subtree(s, name));
    if (moving.has(parent)) throw new EditRefused(`"${parent}" is under "${name}"; a bone cannot hang from its own descendant.`);
    if (b.parent === parent) return s;
    const rest = bones.filter((x) => !moving.has(x.name));
    const block = bones.filter((x) => moving.has(x.name)).map((x) => {
      if (x.name !== name) return x;
      const next: Record<string, unknown> = { ...x, parent };
      for (const [k, v] of Object.entries(local)) { if (k === "parent") continue; if (v === undefined) delete next[k]; else next[k] = v; }
      return next as unknown as Bone;
    });
    const at = afterSubtree(rest, parent);
    return withBoneOrder(s, [...rest.slice(0, at), ...block, ...rest.slice(at)]);
  };
}

/** Whether an attachment's vertices are weighted: per vertex its bones, not one x,y pair. */
function weighted(a: Attachment): boolean {
  const count = a.uvs ? a.uvs.length / 2 : a.vertexCount;
  return !!a.vertices && count !== undefined && a.vertices.length !== count * 2;
}

/**
 * The skeleton with its bones in the order `next` (E7-PLAN step 4). Weighted vertices name their
 * bones by index, so each weighted attachment's indices follow their bones by name; one that names
 * a bone `next` lacks refuses the edit (`deleting`: the bone the user asked to delete). Before,
 * adding, moving or deleting a bone left the indices as they were: the meshes bound to later
 * bones followed the wrong ones, and an index past the end broke the mesh edits.
 */
function withBoneOrder(s: Skeleton, next: readonly Bone[], deleting?: string): Skeleton {
  const before = s.bones ?? [], at = new Map(next.map((b, i) => [b.name, i]));
  const map = before.map((b) => at.get(b.name));
  const same = map.every((m, i) => m === i);
  const remap = (a: Attachment, where: string): Attachment => {
    if (same || !weighted(a)) return a;
    const v = a.vertices!, out = [...v];
    let changed = false;
    for (let i = 0; i < v.length;) {
      const n = v[i++]!;
      for (let k = 0; k < n; k++, i += 4) {
        const to = map[v[i]!];
        if (to === undefined) {
          throw new EditRefused(`"${deleting ?? before[v[i]!]?.name}" cannot be deleted: ${where} is bound to "${before[v[i]!]?.name}". Unbind it first.`);
        }
        if (to !== v[i]) { out[i] = to; changed = true; }
      }
    }
    return changed ? { ...a, vertices: out } : a;
  };
  let skinsChanged = false;
  const skins = s.skins?.map((k) => {
    let kc = false;
    const attachments = k.attachments?.map((ss) => {
      let sc = false;
      const entries = ss.entries.map((e) => {
        const a = remap(e.attachment, `"${e.key}" in the slot "${ss.slot}" of the skin "${k.name}"`);
        if (a === e.attachment) return e;
        sc = true;
        return { ...e, attachment: a };
      });
      if (!sc) return ss;
      kc = true;
      return { ...ss, entries };
    });
    if (!kc) return k;
    skinsChanged = true;
    return { ...k, attachments: attachments! } as Skin;
  });
  return { ...s, bones: [...next], ...(skinsChanged && skins ? { skins } : {}) };
}
