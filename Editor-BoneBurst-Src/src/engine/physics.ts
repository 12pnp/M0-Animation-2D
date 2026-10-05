import { DEG_RAD, type PhysicsData } from "./rigTypes";
import type { Rig } from "./rig";

/**
 * Spine 4.3's physics constraint on the engine's pose. Its author knew 4.2's
 * solver; what 4.3 changed was measured against spine-core's public state
 * (offsets, velocities, lags, remaining time):
 *
 *   - each offset keeps its LAG, the change the steps of this update made,
 *     and the bone is drawn at offset − lag × (1 − remaining / step): between
 *     the last two steps, not at the last one;
 *   - inertia 0.5 and damping 0.85 by default;
 *   - wind and gravity act along the skeleton's `windX/Y` and `gravityX/Y`
 *     (1, 0 and 0, 1); position takes them times the reference scale, while
 *     rotation and x scale take them bare, rotation times bone length over
 *     the reference scale.
 *
 * `tests/engineOracle.test.ts` holds it to spine-core stepped frame by frame.
 */

const PI = 180 * DEG_RAD, PI2 = 2 * PI;

export type PhysicsMode = "none" | "reset" | "update" | "pose";

export interface PhysicsPose {
  inertia: number;
  strength: number;
  damping: number;
  massInverse: number;
  wind: number;
  gravity: number;
  mix: number;
}

/** One constraint's simulation, carried from pose to pose. */
export interface PhysicsState {
  reset: boolean;
  ux: number; uy: number;
  cx: number; cy: number;
  tx: number; ty: number;
  xOffset: number; xLag: number; xVelocity: number;
  yOffset: number; yLag: number; yVelocity: number;
  rotateOffset: number; rotateLag: number; rotateVelocity: number;
  scaleOffset: number; scaleLag: number; scaleVelocity: number;
  remaining: number;
  lastTime: number;
}

export function physicsState(): PhysicsState {
  return {
    reset: true, ux: 0, uy: 0, cx: 0, cy: 0, tx: 0, ty: 0,
    xOffset: 0, xLag: 0, xVelocity: 0, yOffset: 0, yLag: 0, yVelocity: 0,
    rotateOffset: 0, rotateLag: 0, rotateVelocity: 0, scaleOffset: 0, scaleLag: 0, scaleVelocity: 0,
    remaining: 0, lastTime: 0,
  };
}

/** Start the simulation over at the skeleton's `time`. */
export function resetPhysics(st: PhysicsState, time: number): void {
  Object.assign(st, physicsState(), { lastTime: time });
}

const clamp = (v: number, q: number) => (v > q ? q : v < -q ? -q : v);

export function solvePhysics(rig: Rig, k: PhysicsData, pose: PhysicsPose, st: PhysicsState, mode: PhysicsMode): void {
  const mix = pose.mix;
  if (mix === 0) return;
  const x = k.x > 0, y = k.y > 0, rotateOrShearX = k.rotate > 0 || k.shearX > 0, scaleX = k.scaleX > 0;
  const W = rig.world, w = k.bone * 6, l = rig.data.bones[k.bone]!.length, t = k.step;
  if (mode === "none") return;
  if (mode === "reset") resetPhysics(st, rig.time);
  switch (mode) {
    case "reset":
    case "update": {
      const delta = Math.max(rig.time - st.lastTime, 0);
      // The offsets as last drawn, between their last two steps.
      const drawn = 1 - st.remaining / t;
      st.remaining += delta;
      st.lastTime = rig.time;
      const bx = W[w + 4]!, by = W[w + 5]!;
      if (st.reset) {
        st.reset = false;
        st.ux = bx;
        st.uy = by;
      } else {
        let a = st.remaining, d = -1;
        const i = pose.inertia, f = rig.data.referenceScale;
        let qx = k.limit * delta;
        const qy = qx * Math.abs(rig.scaleY);
        qx *= Math.abs(rig.scaleX);
        // Wind and gravity along the skeleton's directions, y as the format has it.
        const fx = pose.wind * rig.windX + pose.gravity * rig.gravityX;
        const fy = -(pose.wind * rig.windY + pose.gravity * rig.gravityY) * Math.sign(rig.scaleY);
        if (x || y) {
          if (x) { st.xOffset += clamp((st.ux - bx) * i, qx); st.ux = bx; }
          if (y) { st.yOffset += clamp((st.uy - by) * i, qy); st.uy = by; }
          if (a >= t) {
            d = Math.pow(pose.damping, 60 * t);
            const m = pose.massInverse * t, e = pose.strength;
            if (x) st.xLag = 0;
            if (y) st.yLag = 0;
            do {
              if (x) {
                st.xVelocity += (fx * f * Math.abs(rig.scaleX) - st.xOffset * e) * m;
                const step = st.xVelocity * t;
                st.xOffset += step; st.xLag += step;
                st.xVelocity *= d;
              }
              if (y) {
                st.yVelocity += (fy * f * Math.abs(rig.scaleY) - st.yOffset * e) * m;
                const step = st.yVelocity * t;
                st.yOffset += step; st.yLag += step;
                st.yVelocity *= d;
              }
              a -= t;
            } while (a >= t);
          }
          const z = 1 - a / t;
          if (x) W[w + 4] = W[w + 4]! + (st.xOffset - st.xLag * z) * mix * k.x;
          if (y) W[w + 5] = W[w + 5]! + (st.yOffset - st.yLag * z) * mix * k.y;
        }
        if (rotateOrShearX || scaleX) {
          const ca = Math.atan2(W[w + 2]!, W[w]!);
          let c: number, s: number, mr = 0;
          const dx = clamp(st.cx - W[w + 4]!, qx), dy = clamp(st.cy - W[w + 5]!, qy);
          // The scale offset's inertia divides by the bone's world length; with
          // no rotation, less the scale lag as last drawn (measured: exact for
          // any length or scale; with rotation the plain length is exact).
          const length = l * Math.sqrt(W[w]! * W[w]! + W[w + 2]! * W[w + 2]!);
          if (rotateOrShearX) {
            mr = (k.rotate + k.shearX) * mix;
            let r = Math.atan2(dy + st.ty, dx + st.tx) - ca - (st.rotateOffset - st.rotateLag * drawn) * mr;
            st.rotateOffset += (r - Math.ceil(r / PI2 - 0.5) * PI2) * i;
            r = (st.rotateOffset - st.rotateLag * drawn) * mr + ca;
            c = Math.cos(r);
            s = Math.sin(r);
            if (scaleX && length > 0) st.scaleOffset += ((dx * c + dy * s) * i) / length;
          } else {
            c = Math.cos(ca);
            s = Math.sin(ca);
            const reach = length - st.scaleLag * drawn;
            if (length > 0) st.scaleOffset += ((dx * c + dy * s) * i) / reach;
          }
          a = st.remaining;
          if (a >= t) {
            if (d === -1) d = Math.pow(pose.damping, 60 * t);
            const m = pose.massInverse * t, e = pose.strength, h = l / f;
            if (scaleX) st.scaleLag = 0;
            if (rotateOrShearX) st.rotateLag = 0;
            for (;;) {
              a -= t;
              if (scaleX) {
                st.scaleVelocity += (fx * c + fy * s - st.scaleOffset * e) * m;
                const step = st.scaleVelocity * t;
                st.scaleOffset += step; st.scaleLag += step;
                st.scaleVelocity *= d;
              }
              if (rotateOrShearX) {
                st.rotateVelocity -= ((fx * s - fy * c) * h + st.rotateOffset * e) * m;
                const step = st.rotateVelocity * t;
                st.rotateOffset += step; st.rotateLag += step;
                st.rotateVelocity *= d;
                if (a < t) break;
                const r = st.rotateOffset * mr + ca;
                c = Math.cos(r);
                s = Math.sin(r);
              } else if (a < t) break;
            }
          }
        }
        st.remaining = a;
      }
      st.cx = W[w + 4]!;
      st.cy = W[w + 5]!;
      break;
    }
    case "pose": {
      const z = 1 - st.remaining / t;
      if (x) W[w + 4] = W[w + 4]! + (st.xOffset - st.xLag * z) * mix * k.x;
      if (y) W[w + 5] = W[w + 5]! + (st.yOffset - st.yLag * z) * mix * k.y;
    }
  }
  const z = 1 - st.remaining / t;
  if (rotateOrShearX) {
    let o = (st.rotateOffset - st.rotateLag * z) * mix, s: number, c: number, a: number;
    if (k.shearX > 0) {
      let r = 0;
      if (k.rotate > 0) {
        r = o * k.rotate;
        s = Math.sin(r); c = Math.cos(r);
        a = W[w + 1]!;
        W[w + 1] = c * a - s * W[w + 3]!;
        W[w + 3] = s * a + c * W[w + 3]!;
      }
      r += o * k.shearX;
      s = Math.sin(r); c = Math.cos(r);
      a = W[w]!;
      W[w] = c * a - s * W[w + 2]!;
      W[w + 2] = s * a + c * W[w + 2]!;
    } else {
      o *= k.rotate;
      s = Math.sin(o); c = Math.cos(o);
      a = W[w]!;
      W[w] = c * a - s * W[w + 2]!;
      W[w + 2] = s * a + c * W[w + 2]!;
      a = W[w + 1]!;
      W[w + 1] = c * a - s * W[w + 3]!;
      W[w + 3] = s * a + c * W[w + 3]!;
    }
  }
  if (scaleX) {
    const s = 1 + (st.scaleOffset - st.scaleLag * z) * mix * k.scaleX;
    W[w] = W[w]! * s;
    W[w + 2] = W[w + 2]! * s;
  }
  if (mode !== "pose") {
    st.tx = l * W[w]!;
    st.ty = l * W[w + 2]!;
  }
  rig.worldChanged(k.bone);
}
