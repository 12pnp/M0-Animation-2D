import type { Bone, Constraint, ConstraintType, TransformConstraint } from "./skeleton";

/**
 * What an absent key means (Format-Json-Atlas.md §5, bones). The model keeps keys as the file had
 * them; these answer for the ones it did not.
 */
export const BONE_DEFAULTS = {
  length: 0, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0,
} as const;

export type BoneNumber = keyof typeof BONE_DEFAULTS;
export const BONE_NUMBERS = Object.keys(BONE_DEFAULTS) as BoneNumber[];

/** The bone's value of `key`: as written, or the default. */
export function boneNumber(b: Bone, key: BoneNumber): number {
  return b[key] ?? BONE_DEFAULTS[key];
}

/** The bone's inherit mode: as written, or "normal". */
export function boneInherit(b: Bone): string {
  return b.inherit ?? "normal";
}

/**
 * What an absent constraint key means (Format-Json-Atlas.md §7.2–7.6), kind by kind. Mixes whose
 * default depends on other keys are not here: `constraintMix` answers them.
 */
export const CONSTRAINT_DEFAULTS: { readonly [K in ConstraintType]: Readonly<Record<string, number | boolean | string>> } = {
  ik: { mix: 1, softness: 0, bendPositive: true, compress: false, stretch: false, scaleY: "none" },
  transform: {
    localSource: false, localTarget: false, additive: false, clamp: false,
    rotation: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0,
  },
  path: { positionMode: "percent", spacingMode: "length", rotateMode: "tangent", rotation: 0, position: 0, spacing: 0, mixRotate: 1, mixX: 1 },
  physics: {
    x: 0, y: 0, rotate: 0, scaleX: 0, scaleY: "none", shearX: 0, limit: 5000, fps: 60, inertia: 0.5, strength: 100,
    damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1,
    inertiaGlobal: false, strengthGlobal: false, dampingGlobal: false, massGlobal: false, windGlobal: false, gravityGlobal: false, mixGlobal: false,
  },
  slider: { additive: false, loop: false, mix: 1, from: 0, to: 0, scale: 1, local: false, time: 0 },
};

/** A constraint's value of `key`: as written, or the default (undefined: no default, e.g. a reference). */
export function constraintValue(c: Constraint, key: string): number | boolean | string | undefined {
  const v = (c as unknown as Record<string, unknown>)[key];
  if (v !== undefined) return v as number | boolean | string;
  if (c.type === "transform" && key.startsWith("mix")) return constraintMix(c, key);
  if (c.type === "path" && key === "mixY") return (c.mixX ?? 1);
  return CONSTRAINT_DEFAULTS[c.type][key];
}

/** The transform properties a constraint drives (its `to` kinds, §7.3). */
export function transformTargets(c: TransformConstraint): Set<string> {
  return new Set((c.properties ?? []).flatMap((p) => (p.to ?? []).map((t) => t.to)));
}

/** The mix keys of a transform constraint, with the `to` kind each one needs (§7.3). */
export const TRANSFORM_MIXES = [
  ["mixRotate", "rotate"], ["mixX", "x"], ["mixY", "y"], ["mixScaleX", "scaleX"], ["mixScaleY", "scaleY"], ["mixShearY", "shearY"],
] as const;

/**
 * A transform constraint's mix as the runtimes read it (§7.3): 0 unless a `to` of its kind
 * exists; then as written, else 1, except `mixY` (`mixX`'s value) and `mixScaleY` (`mixScaleX`'s).
 */
export function constraintMix(c: TransformConstraint, key: string): number {
  const to = transformTargets(c);
  const read = (k: string): number => {
    const kind = TRANSFORM_MIXES.find(([m]) => m === k)?.[1];
    if (!kind || !to.has(kind)) return 0;
    const v = (c as unknown as Record<string, number | undefined>)[k];
    if (v !== undefined) return v;
    return k === "mixY" ? read("mixX") : k === "mixScaleY" ? read("mixScaleX") : 1;
  };
  return read(key);
}

/** Keys whose default depends on another key: written as shown, never dropped. */
export const DEPENDENT_DEFAULTS: { readonly [K in ConstraintType]?: readonly string[] } = {
  transform: ["mixY", "mixScaleY"], path: ["mixY"],
};
