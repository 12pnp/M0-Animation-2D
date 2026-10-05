import { plainJson } from "@/io/json";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Skeleton } from "@/model/skeleton";
import { drawList, drawnVertices, type DrawList } from "@/engine/draw";
import type { PhysicsMode } from "@/engine/physics";
import type { AtlasImages } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import type { AnimationData, RigData } from "@/engine/rigTypes";
import type { Matrix } from "./gizmo";

/**
 * The document posed by the engine (SPEC §6: the one posing path): the setup pose, or an
 * animation at a time. No DOM: the stage and the timeline draw what this returns, and the tests
 * pose with it too.
 */
export interface Posed {
  readonly rig: Rig;
  readonly draw: DrawList;
  /** Bone name → index in the rig. */
  readonly bones: ReadonlyMap<string, number>;
  /** The animation posed, or null for the setup pose. */
  readonly animation: AnimationData | null;
  /** The local pose (7 per bone) the animation gave, before constraints moved it: what keying
   *  starts from. */
  readonly local: Float64Array;
}

/** One document's rig, built once and posed as often as asked (each frame of playback). */
export class Poser {
  readonly data: RigData;
  readonly rig: Rig;
  private readonly bones: ReadonlyMap<string, number>;

  constructor(doc: Skeleton, images: AtlasImages) {
    this.data = readRig(plainJson(skeletonToJson(doc)), images);
    this.rig = new Rig(this.data);
    this.bones = new Map(this.data.bones.map((b) => [b.name, b.index]));
  }

  /**
   * Pose `animation` (null: the setup pose) at `time` seconds with `skin` shown. Physics steps
   * only with "update" (playback, after `rig.update(dt)`) or starts over with "reset"; "none"
   * poses without it, so a frame looks the same however it was reached.
   */
  pose(skin: string | null, animation: string | null, time: number, physics: PhysicsMode = "none"): Posed {
    const rig = this.rig;
    rig.setSkins(skin ? [skin] : []);
    rig.setupPose();
    const anim = animation !== null ? rig.animation(animation) ?? null : null;
    if (anim) {
      rig.apply(anim, time, false);
      rig.settleAttachments();
    }
    const local = rig.local.slice();
    rig.updateWorld(physics);
    return { rig, draw: drawList(rig), bones: this.bones, animation: anim, local };
  }
}

/** The setup pose of a document. */
export function poseSetup(doc: Skeleton, images: AtlasImages, skin: string | null): Posed {
  return new Poser(doc, images).pose(skin, null, 0);
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

/** A bone's local pose before constraints, as `edit/boneKeys` takes it. */
export function animatedLocal(p: Posed, bone: number) {
  const L = p.local, l = bone * 7;
  return { x: L[l]!, y: L[l + 1]!, rotation: L[l + 2]!, scaleX: L[l + 3]!, scaleY: L[l + 4]!, shearX: L[l + 5]!, shearY: L[l + 6]! };
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
