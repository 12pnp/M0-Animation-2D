import type { Bone } from "@/model/skeleton";
import type { IconName } from "./icons";

/** The icons a bone can be given (its `icon` in the file is one of these names). */
export const BONE_ICONS: readonly IconName[] = ["bone", "point", "key", "ik", "transform", "physics", "slider", "path", "mesh", "boundingbox", "slot", "skin", "region", "clipping", "move", "rotate", "scale"];

/** A bone's colour as `#rrggbb` (its `color` is `rrggbb` or `rrggbbaa`), or null when it has none that reads. */
export function boneColourOf(bone: Pick<Bone, "color">): string | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(bone.color ?? "");
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/** `#rrggbb` as the file writes a bone colour: `rrggbbff`. */
export function boneColourToFile(hex: string): string {
  return `${hex.replace("#", "").toLowerCase()}ff`;
}

/** A bone's icon: the one it names when that is one of ours, else the bone's own. */
export function boneIconOf(bone: Pick<Bone, "icon">): IconName {
  return BONE_ICONS.find((n) => n === bone.icon) ?? "bone";
}
