import { plainJson } from "@/io/json";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Skeleton } from "@/model/skeleton";
import { drawList, drawnVertices, type DrawList } from "@/engine/draw";
import type { AtlasImages } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import type { Matrix } from "./gizmo";

/**
 * The document posed by the engine in its setup pose (SPEC §6: the one posing path). No DOM:
 * the stage draws what this returns, and the tests pose with it too.
 */
export interface Posed {
  readonly rig: Rig;
  readonly draw: DrawList;
  /** Bone name → index in the rig. */
  readonly bones: ReadonlyMap<string, number>;
}

export function poseSetup(doc: Skeleton, images: AtlasImages, skin: string | null): Posed {
  const rig = new Rig(readRig(plainJson(skeletonToJson(doc)), images));
  if (skin) rig.setSkins([skin]);
  rig.setupPose();
  rig.updateWorld("none");
  return { rig, draw: drawList(rig), bones: new Map(rig.data.bones.map((b) => [b.name, b.index])) };
}

export function boneMatrix(p: Posed, bone: number): Matrix {
  return p.rig.matrix(bone) as unknown as Matrix;
}

/** The matrix a bone's local values are in: its parent's world, or the skeleton's placement for a root. */
export function parentMatrix(p: Posed, bone: number): Matrix {
  const parent = p.rig.data.bones[bone]!.parent;
  return parent >= 0 ? boneMatrix(p, parent) : [p.rig.scaleX, 0, 0, p.rig.scaleY, p.rig.x, p.rig.y];
}

/** Where the bone's tip is: its length along its world x axis. */
export function boneTip(p: Posed, bone: number): [number, number] {
  const [a, , c, , x, y] = boneMatrix(p, bone), length = p.rig.data.bones[bone]!.length;
  return [x + a * length, y + c * length];
}

/** The box around every drawn vertex and every active bone, or null for an empty skeleton. */
export function bounds(p: Posed): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const d of p.draw.slots) {
    const v = new Float64Array(d.vertexCount * 2);
    drawnVertices(p.rig, d, v);
    for (let i = 0; i < v.length; i += 2) add(v[i]!, v[i + 1]!);
  }
  for (const b of p.rig.data.bones) {
    if (!p.rig.active[b.index]) continue;
    const m = boneMatrix(p, b.index);
    add(m[4], m[5]);
    const [tx, ty] = boneTip(p, b.index);
    add(tx, ty);
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}
