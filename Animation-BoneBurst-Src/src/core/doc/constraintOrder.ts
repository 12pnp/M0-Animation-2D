import type { SymbolItem } from "./types";

/**
 * Constraint order (ARCHITECTURE ▸ Constraint order), pure. Spine applies a
 * skeleton's constraints in the order of its one list, so the order decides
 * what a constraint reads when another moves the same bones.
 * `SymbolItem.constraintOrder` holds names, Spine's identity for a
 * constraint. A constraint it does not name comes after the named ones, in
 * the default order: IK, transform, physics, path, slider, then the carried
 * ones as the file had them.
 */

export type ConstraintKind = "ik" | "transform" | "physics" | "path" | "slider" | "carried";

export interface ConstraintEntry {
  name: string;
  kind: ConstraintKind;
}

/** Every constraint of the symbol in the default order. */
function defaultEntries(sym: SymbolItem): ConstraintEntry[] {
  return [
    ...sym.ik.map((k) => ({ name: k.name, kind: "ik" as const })),
    ...(sym.transforms ?? []).map((k) => ({ name: k.name, kind: "transform" as const })),
    ...(sym.physics ?? []).map((k) => ({ name: k.name, kind: "physics" as const })),
    ...(sym.paths ?? []).map((k) => ({ name: k.name, kind: "path" as const })),
    ...(sym.sliders ?? []).map((k) => ({ name: k.name, kind: "slider" as const })),
    ...(sym.spine?.constraints ?? []).map((c) => ({ name: String(c.name), kind: "carried" as const })),
  ];
}

/** `items` sorted by `order` (names), stable; names it lacks keep their place after it. */
export function byOrder<T>(items: readonly T[], order: readonly string[] | undefined, nameOf: (t: T) => string): T[] {
  if (!order?.length) return [...items];
  const rank = new Map(order.map((n, i) => [n, i]));
  return items
    .map((t, i) => ({ t, i, r: rank.get(nameOf(t)) ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.t);
}

/** The symbol's constraints in the order they are applied. */
export function constraintEntries(sym: SymbolItem): ConstraintEntry[] {
  return byOrder(defaultEntries(sym), sym.constraintOrder, (e) => e.name);
}

/**
 * The order with the constraint `name` moved to `index` of the applied
 * order, every constraint named so that the list says the whole order. Null
 * when nothing moves.
 */
export function withConstraintMoved(sym: SymbolItem, name: string, index: number): string[] | null {
  const names = constraintEntries(sym).map((e) => e.name);
  const from = names.indexOf(name);
  const to = Math.max(0, Math.min(names.length - 1, index));
  if (from < 0 || from === to) return null;
  names.splice(from, 1);
  names.splice(to, 0, name);
  return names;
}

/**
 * The order an edit asks for (`set_constraint_order`): the names given, in
 * that order, then the others where they were. A reason when a name is not a
 * constraint of the symbol or is given twice.
 */
export function orderFrom(sym: SymbolItem, names: readonly string[]): string[] | string {
  const all = constraintEntries(sym).map((e) => e.name);
  const known = new Set(all);
  const seen = new Set<string>();
  for (const n of names) {
    if (!known.has(n)) return `"${sym.name}" has no constraint called "${n}".`;
    if (seen.has(n)) return `"${n}" is named twice.`;
    seen.add(n);
  }
  return [...names, ...all.filter((n) => !seen.has(n))];
}

/**
 * The order after a list of constraints was replaced: an entry whose name a
 * constraint (same id) gave up follows it to its new name. The same array
 * when no name it holds changed.
 */
export function orderAfterEdit(
  order: readonly string[] | undefined,
  before: ReadonlyArray<{ id: string; name: string }> | undefined,
  after: ReadonlyArray<{ id: string; name: string }> | undefined,
): readonly string[] | undefined {
  if (!order?.length || !before?.length || !after) return order;
  const now = new Map(after.map((k) => [k.id, k.name]));
  const renamed = new Map<string, string>();
  for (const k of before) {
    const name = now.get(k.id);
    if (name !== undefined && name !== k.name) renamed.set(k.name, name);
  }
  if (!order.some((n) => renamed.has(n))) return order;
  return order.map((n) => renamed.get(n) ?? n);
}
