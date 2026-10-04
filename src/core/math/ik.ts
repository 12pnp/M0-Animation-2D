/**
 * Inverse kinematics, transcribed from the Spine runtime the preview runs:
 * `IkConstraint.apply1` / `apply2` in @esotericsoftware/spine-core 4.3.13.
 *
 * Kept as the runtime has it, because it is what the exported file gets:
 * it works in Spine's space (y UP, `a b c d` row-major with `(a, c)` the x
 * axis), on the bones' LOCAL values against their parents' world matrices,
 * and writes back local rotations only; `mix` blends those rotations; a
 * non-uniform parent scale takes a different, numeric solve and zeroes the
 * child's local y; angles go through the runtime's own pi (3.1415927) and
 * wrap into (−180, 180] before mixing.
 *
 * Left out, because the editor cannot author them: stretch, compress, and
 * every inheritance mode but normal (the export always writes normal).
 * Softness is in: near full reach it pulls the target in, so the chain
 * eases into straight instead of snapping. `core/doc/pose.ts` (`applyIk`) maps the stage's bones into this
 * space and back; `tests/spineParity.test.ts` checks the result against
 * spine-core itself.
 */

const PI = 3.1415927;
const RAD_DEG = 180 / PI;
const EPSILON = 0.00001;

/** A bone's world matrix, Spine's layout. */
export interface IkWorld {
  a: number; b: number; c: number; d: number;
  worldX: number; worldY: number;
}

/** A constrained bone: its local transform (mutable) and its world matrix. */
export interface IkBone extends IkWorld {
  x: number; y: number;
  rotation: number;
  scaleX: number; scaleY: number;
  shearX: number; shearY: number;
}

/** `IkConstraint.apply1`: point one bone at the target. `parent` is the
 *  bone's parent's world matrix. Mutates `bone.rotation`. */
export function ikApply1(bone: IkBone, parent: IkWorld, targetX: number, targetY: number, mix: number): void {
  const pa = parent.a, pb = parent.b, pc = parent.c, pd = parent.d;
  let rotationIK = -bone.shearX - bone.rotation, tx = 0, ty = 0;
  const x = targetX - parent.worldX, y = targetY - parent.worldY;
  const d = pa * pd - pb * pc;
  if (Math.abs(d) > EPSILON) {
    tx = (x * pd - y * pb) / d - bone.x;
    ty = (y * pa - x * pc) / d - bone.y;
  }
  rotationIK += Math.atan2(ty, tx) * RAD_DEG;
  if (bone.scaleX < 0) rotationIK += 180;
  if (rotationIK > 180) rotationIK -= 360;
  else if (rotationIK <= -180) rotationIK += 360;
  bone.rotation += rotationIK * mix;
}

/**
 * `IkConstraint.apply2`: two bones, `child` a direct child of `parent`.
 * `grand` is `parent`'s parent's world matrix; `childLength` the child's
 * bone length; `softness` in pixels. Mutates both rotations, and `child.y`
 * for a non-uniform parent scale.
 */
export function ikApply2(
  parent: IkBone, child: IkBone, grand: IkWorld, childLength: number,
  targetX: number, targetY: number, bendDir: number, mix: number, softness = 0,
): void {
  const px = parent.x, py = parent.y;
  let psx = parent.scaleX, psy = parent.scaleY, csx = child.scaleX;
  let os1: number, os2: number, s2: number;
  if (psx < 0) { psx = -psx; os1 = 180; s2 = -1; } else { os1 = 0; s2 = 1; }
  if (psy < 0) { psy = -psy; s2 = -s2; }
  if (csx < 0) { csx = -csx; os2 = 180; } else os2 = 0;

  let cwx: number, cwy: number, a = parent.a, b = parent.b, c = parent.c, d = parent.d;
  const u = Math.abs(psx - psy) <= EPSILON;
  if (!u) {
    child.y = 0;
    cwx = a * child.x + parent.worldX;
    cwy = c * child.x + parent.worldY;
  } else {
    cwx = a * child.x + b * child.y + parent.worldX;
    cwy = c * child.x + d * child.y + parent.worldY;
  }
  a = grand.a; b = grand.b; c = grand.c; d = grand.d;
  let id = a * d - b * c, x = cwx - grand.worldX, y = cwy - grand.worldY;
  id = Math.abs(id) <= EPSILON ? 0 : 1 / id;
  const dx = (x * d - y * b) * id - px, dy = (y * a - x * c) * id - py;
  const l1 = Math.sqrt(dx * dx + dy * dy);
  let l2 = childLength * csx, a1: number, a2: number;
  if (l1 < EPSILON) {
    ikApply1(parent, grand, targetX, targetY, mix);
    child.rotation = 0;
    return;
  }
  x = targetX - grand.worldX;
  y = targetY - grand.worldY;
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

  outer: if (u) {
    l2 *= psx;
    let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    if (cos < -1) { cos = -1; a2 = PI * bendDir; }
    else if (cos > 1) { cos = 1; a2 = 0; }
    else a2 = Math.acos(cos) * bendDir;
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
      let q = Math.sqrt(d);
      if (c1 < 0) q = -q;
      q = -(c1 + q) * 0.5;
      let r0 = q / c2;
      const r1 = c / q;
      const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
      r0 = dd - r * r;
      if (r0 >= 0) {
        y = Math.sqrt(r0) * bendDir;
        a1 = ta - Math.atan2(y, r);
        a2 = Math.atan2(y / psy, (r - l1) / psx);
        break outer;
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
  const os = Math.atan2(child.y, child.x) * s2;
  a1 = (a1 - os) * RAD_DEG + os1 - parent.rotation;
  if (a1 > 180) a1 -= 360;
  else if (a1 <= -180) a1 += 360;
  parent.rotation += a1 * mix;
  a2 = ((a2 + os) * RAD_DEG - child.shearX) * s2 + os2 - child.rotation;
  if (a2 > 180) a2 -= 360;
  else if (a2 <= -180) a2 += 360;
  child.rotation += a2 * mix;
}
