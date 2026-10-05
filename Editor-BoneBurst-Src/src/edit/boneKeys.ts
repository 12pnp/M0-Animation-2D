import { boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { keysAt, shortFloat, type TimelinePath } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { type KeyFields, setKey } from "./keys";

/**
 * Keying a bone's pose at a time: the stage's and the inspector's Animate mode. The pose is local
 * values (as the setup pose holds them); a key holds offsets from the setup pose for rotate,
 * translate and shear and a factor of it for scale (Format-Json-Atlas.md §11.4).
 */

export type BoneProperty = "translate" | "rotate" | "scale" | "shear";
export const BONE_PROPERTIES: readonly BoneProperty[] = ["rotate", "translate", "scale", "shear"];

export interface LocalPose {
  readonly x: number; readonly y: number; readonly rotation: number;
  readonly scaleX: number; readonly scaleY: number; readonly shearX: number; readonly shearY: number;
}

/** Key `properties` of `bone` in `animation` at `time` to the pose `local`, as one edit. */
export function keyBone(animation: string, bone: string, properties: readonly BoneProperty[], local: LocalPose, time: number): Edit<Skeleton> {
  return (s) => {
    const b = s.bones?.find((x) => x.name === bone);
    if (!b) throw new EditRefused(`There is no bone "${bone}".`);
    const anim = s.animations?.find((a) => a.name === animation);
    if (!anim) throw new EditRefused(`There is no animation "${animation}".`);
    const has = (timeline: string) => keysAt(anim, { section: "bones", owner: bone, timeline }) !== undefined;
    const keyed = (n: number) => shortFloat(Math.round(n * 1e4) / 1e4);
    const writes: Array<[string, KeyFields]> = [];
    const pair = (prop: "translate" | "scale" | "shear", vx: number, vy: number) => {
      // The split timelines when the bone already keys this property so, else the combined one.
      if (has(`${prop}x`) || has(`${prop}y`)) writes.push([`${prop}x`, { value: keyed(vx) }], [`${prop}y`, { value: keyed(vy) }]);
      else writes.push([prop, { x: keyed(vx), y: keyed(vy) }]);
    };
    for (const p of properties) {
      switch (p) {
        case "rotate": writes.push(["rotate", { value: keyed(local.rotation - boneNumber(b, "rotation")) }]); break;
        case "translate": pair("translate", local.x - boneNumber(b, "x"), local.y - boneNumber(b, "y")); break;
        case "shear": pair("shear", local.shearX - boneNumber(b, "shearX"), local.shearY - boneNumber(b, "shearY")); break;
        case "scale": {
          const sx = boneNumber(b, "scaleX"), sy = boneNumber(b, "scaleY");
          if (sx === 0 || sy === 0) throw new EditRefused(`"${bone}" has a setup scale of 0, so a scale key cannot reach this pose.`);
          pair("scale", local.scaleX / sx, local.scaleY / sy);
          break;
        }
      }
    }
    let out = s;
    for (const [timeline, fields] of writes) {
      const path: TimelinePath = { section: "bones", owner: bone, timeline };
      out = setKey(animation, path, time, fields)(out);
    }
    return out;
  };
}
