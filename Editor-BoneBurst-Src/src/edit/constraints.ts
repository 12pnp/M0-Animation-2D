import type { Animation, Constraint, ConstraintType, Skeleton, Skin } from "@/model/skeleton";
import { subtree } from "./bones";
import { EditRefused, type Edit } from "./history";

/**
 * Constraint edits (Format-Json-Atlas.md §7). The constraints are one list whose order is the
 * order the runtimes apply them in. A constraint is found by kind and name (§7.1: names are unique
 * within a kind); skins' lists and animations' timelines name it, so renaming and deleting follow
 * the name there.
 */

export interface ConstraintRef { readonly type: ConstraintType; readonly name: string }

/** The fields of a constraint of kind `T` an edit may set; `undefined` removes the key (the default then applies). */
export type ConstraintPatch<T extends ConstraintType = ConstraintType> = {
  -readonly [K in Exclude<keyof Extract<Constraint, { type: T }>, "type" | "name" | "extra">]?: Extract<Constraint, { type: T }>[K] | undefined
};

export const IK_SCALE_Y = ["none", "uniform", "volume"] as const;
export const PHYSICS_SCALE_Y = IK_SCALE_Y;
export const POSITION_MODES = ["fixed", "percent"] as const;
export const SPACING_MODES = ["length", "fixed", "percent", "proportional"] as const;
export const ROTATE_MODES = ["tangent", "chain", "chainScale"] as const;
export const TRANSFORM_PROPERTIES = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const;

export function findConstraint(s: Skeleton, r: ConstraintRef): Constraint | undefined {
  return s.constraints?.find((c) => c.type === r.type && c.name === r.name);
}

/** "an IK constraint", "a transform constraint", … */
export function kindName(type: ConstraintType): string {
  return type === "ik" ? "an IK constraint" : `a ${type} constraint`;
}

function indexOf(s: Skeleton, r: ConstraintRef): number {
  const i = (s.constraints ?? []).findIndex((c) => c.type === r.type && c.name === r.name);
  if (i < 0) throw new EditRefused(`There is no such constraint: ${kindName(r.type)} "${r.name}".`);
  return i;
}

/** Refuse a constraint whose references would break the file or the solve. */
function check(s: Skeleton, c: Constraint): void {
  const bones = new Set((s.bones ?? []).map((b) => b.name));
  const bone = (n: string | undefined, what: string) => {
    if (n === undefined) throw new EditRefused(`"${c.name}" needs a ${what}.`);
    if (!bones.has(n)) throw new EditRefused(`There is no bone "${n}".`);
  };
  const list = (l: readonly string[] | undefined) => {
    for (const n of l ?? []) bone(n, "bone");
    if (new Set(l).size !== (l ?? []).length) throw new EditRefused(`"${c.name}" lists a bone twice.`);
  };
  switch (c.type) {
    case "ik": {
      const l = c.bones ?? [];
      if (l.length < 1 || l.length > 2) throw new EditRefused("An IK constraint bends one bone or two.");
      list(l);
      if (l.length === 2 && s.bones!.find((b) => b.name === l[1])!.parent !== l[0]) throw new EditRefused(`"${l[1]}" is not a child of "${l[0]}"; two IK bones are a parent and its child.`);
      bone(c.target, "target");
      if (l.includes(c.target!)) throw new EditRefused(`"${c.target}" cannot be its own target.`);
      if (subtree(s, l[0]!).includes(c.target!)) throw new EditRefused(`"${c.target}" is under "${l[0]}"; the target cannot move with the bones it moves.`);
      break;
    }
    case "transform":
      list(c.bones);
      bone(c.source, "source");
      if (c.bones?.includes(c.source!)) throw new EditRefused(`"${c.source}" cannot be its own source.`);
      for (const p of c.properties ?? []) {
        if (!(TRANSFORM_PROPERTIES as readonly string[]).includes(p.from)) throw new EditRefused(`"${p.from}" is not a property.`);
        for (const t of p.to ?? []) if (!(TRANSFORM_PROPERTIES as readonly string[]).includes(t.to)) throw new EditRefused(`"${t.to}" is not a property.`);
      }
      break;
    case "path":
      list(c.bones);
      if (c.slot === undefined) throw new EditRefused(`"${c.name}" needs a slot.`);
      if (!s.slots?.some((x) => x.name === c.slot)) throw new EditRefused(`There is no slot "${c.slot}".`);
      break;
    case "physics":
      bone(c.bone, "bone");
      if (c.fps !== undefined && !(c.fps > 0)) throw new EditRefused("Physics steps need a rate above 0.");
      if (c.mass !== undefined && c.mass === 0) throw new EditRefused("Mass cannot be 0.");
      break;
    case "slider":
      if (c.animation === undefined) throw new EditRefused(`"${c.name}" needs an animation.`);
      if (!s.animations?.some((a) => a.name === c.animation)) throw new EditRefused(`There is no animation "${c.animation}".`);
      if (c.bone !== undefined) {
        bone(c.bone, "bone");
        if (c.property === undefined) throw new EditRefused("A slider driven by a bone needs the property it reads.");
      }
      if (c.property !== undefined && !(TRANSFORM_PROPERTIES as readonly string[]).includes(c.property)) throw new EditRefused(`"${c.property}" is not a property.`);
      break;
  }
}

/** IK, transform and path constraints keep `bones`, even empty: spine-core's reader needs the key. */
function withBones(c: Constraint): Constraint {
  return (c.type === "transform" || c.type === "path") && c.bones === undefined ? { ...c, bones: [] } : c;
}

function checkName(s: Skeleton, type: ConstraintType, name: string): void {
  if (!name.trim()) throw new EditRefused("A constraint needs a name.");
  if (s.constraints?.some((c) => c.type === type && c.name === name)) throw new EditRefused(`There is already ${kindName(type)} "${name}".`);
}

/** Add a constraint, last in the update order unless `at` says where. */
export function addConstraint(c: Constraint, at?: number): Edit<Skeleton> {
  return (s) => {
    checkName(s, c.type, c.name);
    check(s, c);
    const list = s.constraints ?? [];
    const i = at === undefined ? list.length : Math.max(0, Math.min(list.length, at));
    return { ...s, constraints: [...list.slice(0, i), withBones(c), ...list.slice(i)] };
  };
}

/** Set fields of a constraint; refused when the result would not hold (see `check`). */
export function updateConstraint<T extends ConstraintType>(r: ConstraintRef & { readonly type: T }, patch: ConstraintPatch<T>): Edit<Skeleton> {
  return (s) => {
    const i = indexOf(s, r);
    const next: Record<string, unknown> = { ...s.constraints![i]! };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (next[k] === v) continue;
      changed = true;
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    if (!changed) return s;
    const c = withBones(next as unknown as Constraint);
    check(s, c);
    return { ...s, constraints: s.constraints!.map((x, n) => (n === i ? c : x)) };
  };
}

/** `s` with the skins' lists and the animations' timelines of kind `type` changed by `f` (null drops the name). */
function onNames(s: Skeleton, type: ConstraintType, f: (name: string) => string | null): Skeleton {
  const list = (l: readonly string[] | undefined) => l?.flatMap((n) => { const m = f(n); return m === null ? [] : [m]; });
  const skins = s.skins?.map((k): Skin => {
    if (!k[type]?.length) return k;
    const next = list(k[type])!;
    if (next.length) return { ...k, [type]: next };
    const { [type]: _, ...rest } = k;
    return rest as Skin;
  });
  const animations = s.animations?.map((a): Animation => {
    const groups = a[type] as readonly { readonly name: string }[] | undefined;
    if (!groups) return a;
    // The global physics timelines (named "") belong to no constraint.
    const next = groups.flatMap((g) => { if (type === "physics" && g.name === "") return [g]; const m = f(g.name); return m === null ? [] : [m === g.name ? g : { ...g, name: m }]; });
    if (next.length) return { ...a, [type]: next };
    const { [type]: _, ...rest } = a;
    return rest as Animation;
  });
  return { ...s, ...(skins ? { skins } : {}), ...(animations ? { animations } : {}) };
}

/** Rename a constraint, in the skins that turn it on and the animations that key it. */
export function renameConstraint(r: ConstraintRef, to: string): Edit<Skeleton> {
  return (s) => {
    if (r.name === to) return s;
    const i = indexOf(s, r);
    checkName(s, r.type, to);
    const out = onNames(s, r.type, (n) => (n === r.name ? to : n));
    return { ...out, constraints: s.constraints!.map((c, n) => (n === i ? { ...c, name: to } : c)) };
  };
}

/** Delete a constraint, its timelines and its place in every skin. */
export function deleteConstraint(r: ConstraintRef): Edit<Skeleton> {
  return (s) => {
    const i = indexOf(s, r);
    const out = onNames(s, r.type, (n) => (n === r.name ? null : n));
    const rest = s.constraints!.filter((_, n) => n !== i);
    if (rest.length) return { ...out, constraints: rest };
    const { constraints: _, ...bare } = out;
    return bare as Skeleton;
  };
}

/** Move a constraint to index `to` of the list: the order the runtimes apply them in. */
export function moveConstraint(r: ConstraintRef, to: number): Edit<Skeleton> {
  return (s) => {
    const i = indexOf(s, r), list = s.constraints!;
    const j = Math.max(0, Math.min(list.length - 1, to));
    if (i === j) return s;
    const rest = list.filter((_, n) => n !== i);
    return { ...s, constraints: [...rest.slice(0, j), list[i]!, ...rest.slice(j)] };
  };
}
