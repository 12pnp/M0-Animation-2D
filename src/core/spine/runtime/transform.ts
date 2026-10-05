import { DEG_RAD, type TransformData, type TransformMix, type TransformProp } from "./rigData";
import type { Rig } from "./rig";

/**
 * Spine 4.3's transform constraint on the BoneBurst runtime's pose (the
 * plan's P2): each source property, read locally or in the world, less its
 * offset, drives target properties through its map, each by its own mix,
 * absolutely or added. Held to spine-core by `tests/runtimeConstraints.test.ts`
 * and the samples. Its author knows spine-core (docs/PREVIEW-RUNTIME-PLAN.md
 * ▸ Risks).
 */

const RAD_DEG = 1 / DEG_RAD;
const PI = 180 * DEG_RAD;
const wrapPi = (v: number) => (v > PI ? v - 2 * PI : v < -PI ? v + 2 * PI : v);

/** The source's value of `prop`, offset by the constraint's own offsets. */
function read(rig: Rig, k: TransformData, prop: TransformProp): number {
  return boneProperty(rig, k.source, prop, k.localSource, k.offsets);
}

const NO_OFFSETS: Record<TransformProp, number> = { rotate: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 };

/**
 * A bone's `prop`, as a transform constraint or slider reads it: its local
 * value, or in the world, in the skeleton's unscaled space — plus `o`.
 */
export function boneProperty(rig: Rig, s: number, prop: TransformProp, local: boolean, o: Record<TransformProp, number> = NO_OFFSETS): number {
  if (local) {
    const L = rig.local, l = s * 7;
    switch (prop) {
      case "rotate": return L[l + 2]! + o.rotate;
      case "x": return L[l]! + o.x;
      case "y": return L[l + 1]! + o.y;
      case "scaleX": return L[l + 3]! + o.scaleX;
      case "scaleY": return L[l + 4]! + o.scaleY;
      case "shearY": return L[l + 6]! + o.shearY;
    }
  }
  const W = rig.world, w = s * 6, sx = rig.scaleX, sy = rig.scaleY;
  const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!;
  switch (prop) {
    // Mirrored in the skeleton's unscaled space, the offset turns the other
    // way; a value below 0 after it reads 360 up (measured).
    case "rotate": {
      const r = Math.atan2(c / sy, a / sx) * RAD_DEG + ((a * d - b * c) / (sx * sy) > 0 ? o.rotate : -o.rotate);
      return r < 0 ? r + 360 : r;
    }
    case "x": return (o.x * a + o.y * b + W[w + 4]!) / sx;
    case "y": return (o.x * c + o.y * d + W[w + 5]!) / sy;
    case "scaleX": return Math.sqrt(a * a + c * c) / Math.abs(sx) + o.scaleX;
    case "scaleY": return Math.sqrt(b * b + d * d) / Math.abs(sy) + o.scaleY;
    case "shearY": return (Math.atan2(d / sy, b / sx) - Math.atan2(c / sy, a / sx)) * RAD_DEG - 90 + o.shearY;
  }
}

/** Drive `prop` of `bone` toward `value` by `mix`, in its local pose. */
function writeLocal(rig: Rig, bone: number, prop: TransformProp, value: number, mix: number, additive: boolean): void {
  const L = rig.local, l = bone * 7;
  switch (prop) {
    case "rotate": L[l + 2] = L[l + 2]! + (additive ? value : value - L[l + 2]!) * mix; break;
    case "x": L[l] = L[l]! + (additive ? value : value - L[l]!) * mix; break;
    case "y": L[l + 1] = L[l + 1]! + (additive ? value : value - L[l + 1]!) * mix; break;
    case "scaleX":
    case "scaleY": {
      const i = l + (prop === "scaleX" ? 3 : 4);
      if (additive) L[i] = L[i]! * (1 + (value - 1) * mix);
      else if (L[i] !== 0) L[i] = L[i]! + (value - L[i]!) * mix;
      break;
    }
    case "shearY": L[l + 6] = L[l + 6]! + (additive ? value : value - L[l + 6]!) * mix; break;
  }
}

/** Drive `prop` of `bone` toward `value` by `mix`, on its world transform. */
function writeWorld(rig: Rig, bone: number, prop: TransformProp, value: number, mix: number, additive: boolean): void {
  const W = rig.world, w = bone * 6, sx = rig.scaleX, sy = rig.scaleY;
  switch (prop) {
    case "rotate": {
      // Turned in the skeleton's unscaled space, then scaled back.
      const a = W[w]! / sx, b = W[w + 1]! / sx, c = W[w + 2]! / sy, d = W[w + 3]! / sy;
      let r = value * DEG_RAD;
      if (!additive) r -= Math.atan2(c, a);
      r = wrapPi(r) * mix;
      const cos = Math.cos(r), sin = Math.sin(r);
      W[w] = (cos * a - sin * c) * sx; W[w + 1] = (cos * b - sin * d) * sx;
      W[w + 2] = (sin * a + cos * c) * sy; W[w + 3] = (sin * b + cos * d) * sy;
      break;
    }
    case "x": W[w + 4] = W[w + 4]! + (additive ? value : value - W[w + 4]! / sx) * mix * sx; break;
    case "y": W[w + 5] = W[w + 5]! + (additive ? value : value - W[w + 5]! / sy) * mix * sy; break;
    case "scaleX":
    case "scaleY": {
      const i = prop === "scaleX" ? w : w + 1, j = i + 2;
      let s: number;
      if (additive) s = 1 + (value - 1) * mix;
      else {
        const len = Math.sqrt((W[i]! / sx) ** 2 + (W[j]! / sy) ** 2);
        if (len === 0) break;
        s = 1 + ((value - len) * mix) / len;
      }
      W[i] = W[i]! * s;
      W[j] = W[j]! * s;
      break;
    }
    case "shearY": {
      const b = W[w + 1]! / sx, d = W[w + 3]! / sy;
      const by = Math.atan2(d, b);
      let r = (value + 90) * DEG_RAD;
      if (additive) r -= PI / 2;
      else r -= by - Math.atan2(W[w + 2]! / sy, W[w]! / sx);
      r = by + wrapPi(r) * mix;
      const len = Math.sqrt(b * b + d * d);
      W[w + 1] = Math.cos(r) * len * sx;
      W[w + 3] = Math.sin(r) * len * sy;
      break;
    }
  }
}

/** Apply one transform constraint: its source and bones are up to date. */
export function solveTransform(rig: Rig, k: TransformData, mix: TransformMix): void {
  if (!mix.rotate && !mix.x && !mix.y && !mix.scaleX && !mix.scaleY && !mix.shearY) return;
  for (const bone of k.bones) {
    for (const from of k.properties) {
      const value = read(rig, k, from.from) - from.offset;
      for (const to of from.to) {
        const m = mix[to.prop];
        if (m === 0) continue;
        let v = to.offset + value * to.scale;
        if (k.clamp) v = to.offset < to.max ? Math.min(Math.max(v, to.offset), to.max) : Math.min(Math.max(v, to.max), to.offset);
        if (k.localTarget) writeLocal(rig, bone, to.prop, v, m, k.additive);
        else writeWorld(rig, bone, to.prop, v, m, k.additive);
      }
    }
    if (k.localTarget) rig.localChanged(bone);
    else rig.worldChanged(bone);
  }
}
