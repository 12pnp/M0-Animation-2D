import type { BoneBurstInherit } from "../types";
import { DEG_RAD } from "./rigData";

/**
 * What the IK and transform solvers (`ik.ts`, `transform.ts`) read and write:
 * a `Rig`, or `LooseBones` for the few bones the editor's own pose hands them
 * (`core/doc/pose.ts`). Local poses 7 per bone (x, y, rotation, scale x and y,
 * shear x and y), world matrices 6 per bone (a, b, c, d, x, y), y up.
 */
export interface Bones {
  readonly local: Float64Array;
  readonly world: Float64Array;
  readonly inherit: ArrayLike<BoneBurstInherit>;
  readonly data: { readonly bones: ReadonlyArray<{ readonly parent: number; readonly length: number }> };
  /** The skeleton's placement, which a root bone takes. */
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** A solver's local pose for the bone; its world follows. */
  setBone(bone: number, x: number, y: number, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number): void;
  /** A solver changed the bone's local pose: its world follows. */
  localChanged(bone: number): void;
  /** A solver set the bone's world: its local pose is derived from it. */
  worldChanged(bone: number): void;
}

/** World matrix `w` of local pose `l` under the parent matrix `p` (normal inheritance). */
export function normalWorld(
  L: ArrayLike<number>, l: number, pa: number, pb: number, pc: number, pd: number, px: number, py: number, W: Float64Array, w: number,
): void {
  const x = L[l]!, y = L[l + 1]!, rotation = L[l + 2]!, scaleX = L[l + 3]!, scaleY = L[l + 4]!, shearX = L[l + 5]!, shearY = L[l + 6]!;
  const rx = (rotation + shearX) * DEG_RAD, ry = (rotation + 90 + shearY) * DEG_RAD;
  const la = Math.cos(rx) * scaleX, lb = Math.cos(ry) * scaleY, lc = Math.sin(rx) * scaleX, ld = Math.sin(ry) * scaleY;
  W[w] = pa * la + pb * lc; W[w + 1] = pa * lb + pb * ld;
  W[w + 2] = pc * la + pd * lc; W[w + 3] = pc * lb + pd * ld;
  W[w + 4] = pa * x + pb * y + px;
  W[w + 5] = pc * x + pd * y + py;
}

/** The local pose (no x shear) that gives world matrix `w` under the parent
 *  matrix `p` with normal inheritance, into `L` at `l`. */
export function localFromWorld(
  W: ArrayLike<number>, w: number, pa: number, pb: number, pc: number, pd: number, px: number, py: number, L: Float64Array, l: number,
): void {
  const pid = 1 / (pa * pd - pb * pc);
  const dx = W[w + 4]! - px, dy = W[w + 5]! - py;
  const ia = pid * pd, id = pid * pa, ib = pid * pb, ic = pid * pc;
  const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!;
  const ra = ia * a - ib * c, rb = ia * b - ib * d, rc = id * c - ic * a, rd = id * d - ic * b;
  L[l] = dx * pd * pid - dy * pb * pid;
  L[l + 1] = dy * pa * pid - dx * pc * pid;
  L[l + 5] = 0;
  let scaleX = Math.sqrt(ra * ra + rc * rc);
  if (scaleX > 0.0001) {
    const det = ra * rd - rb * rc;
    // The y axis's length, signed by the mirror: shear turns it, it does not
    // shorten it. Mirrored, the shear is measured to the negated axis, so the
    // pose builds the same matrix again (measured: 180° out otherwise).
    L[l + 4] = Math.sign(det) * Math.sqrt(rb * rb + rd * rd);
    L[l + 6] = -Math.atan2(Math.sign(det) * (ra * rb + rc * rd), Math.abs(det)) / DEG_RAD;
    L[l + 2] = Math.atan2(rc, ra) / DEG_RAD;
  } else {
    scaleX = 0;
    L[l + 4] = Math.sqrt(rb * rb + rd * rd);
    L[l + 6] = 0;
    L[l + 2] = 90 - Math.atan2(rd, rb) / DEG_RAD;
  }
  L[l + 3] = scaleX;
}

/**
 * A handful of bones outside any `Rig`, for the editor's own pose: each with
 * its parent among them (or -1), normal inheritance, the skeleton at the
 * origin unscaled. A bone the caller fills in and no solver writes (the
 * chain's parent, a constraint's source) keeps the world it was given.
 */
export class LooseBones implements Bones {
  readonly local: Float64Array;
  readonly world: Float64Array;
  readonly inherit: BoneBurstInherit[];
  readonly data: { bones: Array<{ parent: number; length: number }> };
  readonly x = 0;
  readonly y = 0;
  readonly scaleX = 1;
  readonly scaleY = 1;

  constructor(bones: Array<{ parent: number; length: number }>) {
    this.data = { bones };
    this.local = new Float64Array(bones.length * 7);
    this.world = new Float64Array(bones.length * 6);
    this.inherit = bones.map(() => "normal");
  }

  setBone(bone: number, x: number, y: number, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number): void {
    this.local.set([x, y, rotation, scaleX, scaleY, shearX, shearY], bone * 7);
    this.localChanged(bone);
  }

  localChanged(bone: number): void {
    const [pa, pb, pc, pd, px, py] = this.parentMatrix(bone);
    normalWorld(this.local, bone * 7, pa, pb, pc, pd, px, py, this.world, bone * 6);
  }

  worldChanged(bone: number): void {
    const [pa, pb, pc, pd, px, py] = this.parentMatrix(bone);
    localFromWorld(this.world, bone * 6, pa, pb, pc, pd, px, py, this.local, bone * 7);
  }

  private parentMatrix(bone: number): [number, number, number, number, number, number] {
    const parent = this.data.bones[bone]!.parent;
    if (parent < 0) return [1, 0, 0, 1, 0, 0];
    const W = this.world, p = parent * 6;
    return [W[p]!, W[p + 1]!, W[p + 2]!, W[p + 3]!, W[p + 4]!, W[p + 5]!];
  }
}
