import type { BlendMode, ClippingData, Frame, MeshData, RegionData } from "./rigData";
import type { Rig, Writable } from "./rig";

/**
 * What a renderer draws of the posed rig, in order: each slot showing an
 * image, with the clipping slot whose polygon cuts it (or -1). The Preview's
 * Pixi adapter (`src/preview/runtime/boneburstRig.ts`) applies it;
 * `tests/runtimeDraw.test.ts` holds it to spine-core's renderer.
 */

/** Two triangles over a region's corners, as `Rig.regionWorld` orders them. */
export const QUAD = new Uint32Array([2, 3, 0, 0, 1, 2]);

export interface DrawnSlot {
  slot: number;
  att: RegionData | MeshData;
  frame: Frame & { region: NonNullable<Frame["region"]> };
  /** The clipping slot open over this one, or -1. */
  clip: number;
  triangles: Uint32Array;
  vertexCount: number;
  /** Slot colour times attachment colour. */
  color: [number, number, number, number];
  /** The slot's dark colour, for a slot set up with two-colour tint. */
  dark: [number, number, number] | null;
  blend: BlendMode;
}

export interface DrawList {
  slots: DrawnSlot[];
  /** Each clip opened this pose, by its slot. */
  clips: Map<number, ClippingData>;
}

/**
 * A clip opens at its slot and closes after its end slot; a clipping
 * attachment met while one is open is ignored. A slot whose attachment has
 * no image in the atlas draws nothing.
 */
export function drawList(rig: Rig): DrawList {
  const slots: DrawnSlot[] = [], clips = new Map<number, ClippingData>();
  let open = -1, end = -1;
  for (const slot of rig.drawOrder) {
    const att = rig.attachmentOf(slot);
    if (att?.kind === "clipping") {
      if (open < 0) { open = slot; end = att.end; clips.set(slot, att); }
    } else if (att && (att.kind === "region" || att.kind === "mesh")) {
      const frame = rig.frameOf(slot, att);
      if (frame.region) {
        const data = rig.data.slots[slot]!, c = rig.color, k = slot * 7, a = att.color;
        slots.push({
          slot, att, frame: frame as DrawnSlot["frame"], clip: open,
          triangles: att.kind === "mesh" ? att.triangles : QUAD,
          vertexCount: att.kind === "mesh" ? att.vertexCount : 4,
          color: [c[k]! * a[0], c[k + 1]! * a[1], c[k + 2]! * a[2], c[k + 3]! * a[3]],
          dark: data.dark ? [c[k + 4]!, c[k + 5]!, c[k + 6]!] : null,
          blend: data.blend,
        });
      }
    }
    if (open >= 0 && slot === end) open = -1;
  }
  return { slots, clips };
}

/** A drawn slot's world vertices (2 per vertex) into `out`. */
export function drawnVertices(rig: Rig, d: DrawnSlot, out: Writable): void {
  if (d.att.kind === "mesh") rig.meshWorld(d.slot, d.att, out);
  else rig.regionWorld(d.slot, d.att, out);
}
