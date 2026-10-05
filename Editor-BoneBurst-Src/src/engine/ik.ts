import { DEG_RAD, type IkData, type IkScaleY } from "./rigTypes";
import type { Bones } from "./bones";

/**
 * Spine 4.3's IK, solved on the engine's pose. Held to spine-core by
 * `tests/engineOracle.test.ts`. Its author knows spine-core's algorithm
 * (docs/SPEC.md §6 ▸ Provenance): this follows it.
 */

const RAD_DEG = 1 / DEG_RAD;
/** The runtime's π, as `DEG_RAD` takes it. */
const PI = 180 * DEG_RAD;

export interface IkPose {
  mix: number;
  softness: number;
  bendPositive: boolean;
  compress: boolean;
  stretch: boolean;
}

/** Apply one IK constraint: its bones already have their world transforms. */
export function solveIk(rig: Bones, k: IkData, pose: IkPose): void {
  if (pose.mix === 0) return;
  const t = k.target * 6, W = rig.world;
  const tx = W[t + 4]!, ty = W[t + 5]!;
  if (k.bones.length === 1) {
    oneBone(rig, k.bones[0]!, tx, ty, pose.compress, pose.stretch, k.scaleY, pose.mix);
  } else {
    twoBones(rig, k.bones[0]!, k.bones[1]!, tx, ty, pose.bendPositive ? 1 : -1, pose.stretch, k.scaleY, pose.softness, pose.mix);
  }
}

const wrap180 = (a: number) => (a > 180 ? a - 360 : a < -180 ? a + 360 : a);

/**
 * The y scale an IK stretch or squash of `s` leaves. "volume" keeps the
 * area (1 / s) down to a squash of 0.7, then eases along a line that reaches
 * 4× at s = 0: 28 / (7 + 18 s), which meets 1 / s at 0.7. Measured against
 * spine-core; independent of the bone's length and scale.
 */
function carryY(sy: number, s: number, mode: IkScaleY): number {
  if (mode === "uniform") return sy * s;
  if (mode === "volume") return sy * (s >= 0.7 ? 1 / s : 28 / (7 + 18 * s));
  return sy;
}

/** Point `bone` at the target, and stretch or squash it to reach it. */
export function oneBone(
  rig: Bones, bone: number, targetX: number, targetY: number,
  compress: boolean, stretch: boolean, scaleY: IkScaleY, mix: number,
): void {
  const L = rig.local, W = rig.world, l = bone * 7;
  const parent = rig.data.bones[bone]!.parent;
  const p = parent * 6;
  let pa = parent >= 0 ? W[p]! : rig.scaleX, pb = parent >= 0 ? W[p + 1]! : 0;
  const pc = parent >= 0 ? W[p + 2]! : 0;
  let pd = parent >= 0 ? W[p + 3]! : rig.scaleY;
  const pwx = parent >= 0 ? W[p + 4]! : rig.x, pwy = parent >= 0 ? W[p + 5]! : rig.y;
  const ax = L[l]!, ay = L[l + 1]!, arotation = L[l + 2]!, ashearX = L[l + 5]!;
  let rotationIK = -ashearX - arotation, tx: number, ty: number;
  const mode = rig.inherit[bone]!;
  const w = bone * 6;
  if (mode === "onlyTranslation") {
    tx = (targetX - W[w + 4]!) * Math.sign(rig.scaleX);
    ty = (targetY - W[w + 5]!) * Math.sign(rig.scaleY);
  } else {
    if (mode === "noRotationOrReflection") {
      const s = Math.abs(pa * pd - pb * pc) / Math.max(0.0001, pa * pa + pc * pc);
      const sa = pa / rig.scaleX, sc = pc / rig.scaleY;
      pb = -sc * s * rig.scaleX;
      pd = sa * s * rig.scaleY;
      rotationIK += Math.atan2(sc, sa) * RAD_DEG;
    }
    const x = targetX - pwx, y = targetY - pwy;
    const d = pa * pd - pb * pc;
    if (Math.abs(d) <= 0.0001) { tx = 0; ty = 0; } else {
      tx = (x * pd - y * pb) / d - ax;
      ty = (y * pa - x * pc) / d - ay;
    }
  }
  rotationIK += Math.atan2(ty, tx) * RAD_DEG;
  if (L[l + 3]! < 0) rotationIK += 180;
  rotationIK = wrap180(rotationIK);
  let sx = L[l + 3]!, sy = L[l + 4]!;
  if (compress || stretch) {
    if (mode === "noScale" || mode === "noScaleOrReflection") {
      tx = targetX - W[w + 4]!;
      ty = targetY - W[w + 5]!;
    }
    const b = rig.data.bones[bone]!.length * sx;
    if (b > 0.0001) {
      const dd = tx * tx + ty * ty;
      if ((compress && dd < b * b) || (stretch && dd > b * b)) {
        const s = (Math.sqrt(dd) / b - 1) * mix + 1;
        sx *= s;
        sy = carryY(sy, s, scaleY);
      }
    }
  }
  rig.setBone(bone, ax, ay, arotation + rotationIK * mix, sx, sy, ashearX, L[l + 6]!);
}

/** Bend a parent and child so the child's tip reaches the target. */
export function twoBones(
  rig: Bones, parent: number, child: number, targetX: number, targetY: number,
  bendDir: number, stretch: boolean, scaleY: IkScaleY, softness: number, mix: number,
): void {
  if (rig.inherit[parent] !== "normal" || rig.inherit[child] !== "normal") return;
  const L = rig.local, W = rig.world;
  const pl = parent * 7, cl = child * 7, pw = parent * 6;
  const px = L[pl]!, py = L[pl + 1]!;
  let psx = L[pl + 3]!, psy = L[pl + 4]!, csx = L[cl + 3]!;
  let sx = psx, sy = psy;
  let os1: number, os2: number, s2: number;
  if (psx < 0) { psx = -psx; os1 = 180; s2 = -1; } else { os1 = 0; s2 = 1; }
  if (psy < 0) { psy = -psy; s2 = -s2; }
  if (csx < 0) { csx = -csx; os2 = 180; } else os2 = 0;
  const cx = L[cl]!;
  let cy: number, cwx: number, cwy: number;
  let a = W[pw]!, b = W[pw + 1]!, c = W[pw + 2]!, d = W[pw + 3]!;
  const u = Math.abs(psx - psy) <= 0.0001;
  if (!u || stretch) {
    cy = 0;
    cwx = a * cx + W[pw + 4]!;
    cwy = c * cx + W[pw + 5]!;
  } else {
    cy = L[cl + 1]!;
    cwx = a * cx + b * cy + W[pw + 4]!;
    cwy = c * cx + d * cy + W[pw + 5]!;
  }
  // The parent's parent, or the skeleton for a root.
  const pp = rig.data.bones[parent]!.parent, q = pp * 6;
  a = pp >= 0 ? W[q]! : rig.scaleX; b = pp >= 0 ? W[q + 1]! : 0;
  c = pp >= 0 ? W[q + 2]! : 0; d = pp >= 0 ? W[q + 3]! : rig.scaleY;
  const ppx = pp >= 0 ? W[q + 4]! : rig.x, ppy = pp >= 0 ? W[q + 5]! : rig.y;
  let id = a * d - b * c;
  let x = cwx - ppx, y = cwy - ppy;
  id = Math.abs(id) <= 0.0001 ? 0 : 1 / id;
  const dx = (x * d - y * b) * id - px, dy = (y * a - x * c) * id - py;
  const l1 = Math.sqrt(dx * dx + dy * dy);
  let l2 = rig.data.bones[child]!.length * csx;
  let a1: number, a2: number;
  if (l1 < 0.0001) {
    oneBone(rig, parent, targetX, targetY, false, stretch, "none", mix);
    rig.setBone(child, cx, cy, 0, L[cl + 3]!, L[cl + 4]!, L[cl + 5]!, L[cl + 6]!);
    return;
  }
  x = targetX - ppx;
  y = targetY - ppy;
  let tx = (x * d - y * b) * id - px, ty = (y * a - x * c) * id - py;
  let dd = tx * tx + ty * ty;
  if (softness !== 0) {
    softness *= psx * (csx + 1) * 0.5;
    const td = Math.sqrt(dd), sd = td - l1 - l2 * psx + softness;
    if (sd > 0) {
      let p = Math.min(1, sd / (softness * 2)) - 1;
      p = (sd - softness * (1 - p * p)) / td;
      tx -= p * tx;
      ty -= p * ty;
      dd = tx * tx + ty * ty;
    }
  }
  solve: {
    if (u) {
      l2 *= psx;
      let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
      if (cos < -1) {
        cos = -1;
        a2 = PI * bendDir;
      } else if (cos > 1) {
        cos = 1;
        a2 = 0;
        if (stretch) {
          const s = (Math.sqrt(dd) / (l1 + l2) - 1) * mix + 1;
          sx *= s;
          sy = carryY(sy, s, scaleY);
        }
      } else a2 = Math.acos(cos) * bendDir;
      a = l1 + l2 * cos;
      b = l2 * Math.sin(a2);
      a1 = Math.atan2(ty * a - tx * b, tx * a + ty * b);
    } else {
      a = psx * l2;
      b = psy * l2;
      const aa = a * a, bb = b * b, ta = Math.atan2(ty, tx);
      c = bb * l1 * l1 + aa * dd - aa * bb;
      const c1 = -2 * bb * l1, c2 = bb - aa;
      d = c1 * c1 - 4 * c2 * c;
      if (d >= 0) {
        let q2 = Math.sqrt(d);
        if (c1 < 0) q2 = -q2;
        q2 = -(c1 + q2) * 0.5;
        const r0 = q2 / c2, r1 = c / q2;
        const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
        const rr = dd - r * r;
        if (rr >= 0) {
          y = Math.sqrt(rr) * bendDir;
          a1 = ta - Math.atan2(y, r);
          a2 = Math.atan2(y / psy, (r - l1) / psx);
          break solve;
        }
      }
      let minAngle = PI, minX = l1 - a, minDist = minX * minX, minY = 0;
      let maxAngle = 0, maxX = l1 + a, maxDist = maxX * maxX, maxY = 0;
      c = (-a * l1) / (aa - bb);
      if (c >= -1 && c <= 1) {
        c = Math.acos(c);
        x = a * Math.cos(c) + l1;
        y = b * Math.sin(c);
        d = x * x + y * y;
        if (d < minDist) { minAngle = c; minDist = d; minX = x; minY = y; }
        if (d > maxDist) { maxAngle = c; maxDist = d; maxX = x; maxY = y; }
      }
      if (dd <= (minDist + maxDist) * 0.5) {
        a1 = ta - Math.atan2(minY * bendDir, minX);
        a2 = minAngle * bendDir;
      } else {
        a1 = ta - Math.atan2(maxY * bendDir, maxX);
        a2 = maxAngle * bendDir;
      }
    }
  }
  const os = Math.atan2(cy, cx) * s2;
  let rotation = L[pl + 2]!;
  a1 = wrap180((a1 - os) * RAD_DEG + os1 - rotation);
  // 4.3 keeps the parent's shear (measured).
  rig.setBone(parent, px, py, rotation + a1 * mix, sx, sy, L[pl + 5]!, L[pl + 6]!);
  rotation = L[cl + 2]!;
  a2 = wrap180(((a2 + os) * RAD_DEG - L[cl + 5]!) * s2 + os2 - rotation);
  rig.setBone(child, cx, cy, rotation + a2 * mix, L[cl + 3]!, L[cl + 4]!, L[cl + 5]!, L[cl + 6]!);
}
