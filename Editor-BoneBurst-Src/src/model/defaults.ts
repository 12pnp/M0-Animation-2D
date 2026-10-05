import type { Bone } from "./skeleton";

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
