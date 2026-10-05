import type { Skeleton } from "@/model/skeleton";
import { addRegion } from "./attachments";
import { newSkeleton } from "./newSkeleton";
import { addSlot, updateSlot } from "./slots";

/**
 * A new skeleton from image layers (E4-PLAN step 7): a root bone, and per layer a slot on it
 * showing one region. Layers come bottom first, which is Spine's draw order.
 */

export interface RigLayer {
  /** The slot's name and the region's key (the atlas region of the same name is its image). */
  readonly name: string;
  /** The image's centre, in skeleton units (y up). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 0..1; 1 leaves the slot's colour at its default. */
  readonly opacity: number;
  /** A Spine blend mode; "normal" is the default. */
  readonly blend: string;
}

export function rigFromLayers(hash: string, layers: readonly RigLayer[]): Skeleton {
  let s = newSkeleton(hash);
  for (const l of layers) {
    s = addSlot(l.name, "root")(s);
    s = addRegion({ skin: "default", slot: l.name, key: l.name }, {
      width: l.width, height: l.height, ...(l.x ? { x: l.x } : {}), ...(l.y ? { y: l.y } : {}),
    })(s);
    const alpha = Math.round(Math.max(0, Math.min(1, l.opacity)) * 255);
    s = updateSlot(l.name, {
      attachment: l.name,
      ...(alpha < 255 ? { color: `ffffff${alpha.toString(16).padStart(2, "0")}` } : {}),
      ...(l.blend !== "normal" ? { blend: l.blend } : {}),
    })(s);
  }
  return s;
}
