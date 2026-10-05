import type { Bone, Constraint, Skeleton } from "@/model/skeleton";
import { EditRefused, type Edit } from "./history";

/** The fields of a bone an edit may set; `undefined` removes the key (the default then applies). */
export type BonePatch = { -readonly [K in Exclude<keyof Bone, "name" | "extra">]?: Bone[K] | undefined };

/** Set fields of the bone `name`. Refused when there is no such bone, or the parent would not be an earlier bone. */
export function updateBone(name: string, patch: BonePatch): Edit<Skeleton> {
  return (s) => {
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
