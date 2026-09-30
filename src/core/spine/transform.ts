import type { Transform } from "@/core/math/Transform";
import { nz } from "@/core/math/angle";

/**
 * The editor's transform expressed as a Spine bone's, and back.
 *
 * The editor is Flash: y points DOWN, the x axis points at `skewY` and the y
 * axis at `skewX + 90`. Spine data is y UP, the x axis points at
 * `rotation + shearX` and the y axis at `rotation + 90 + shearY` (see
 * `SpineBoneTransform`). Flipping y conjugates a local matrix by
 * diag(1, −1), which negates both axis angles, so
 *
 *   rotation = −skewY    shearX = 0    shearY = skewY − skewX
 *
 * with scales unchanged and y negated. Exact, with no decomposition: the
 * world matrices the runtime composes are the editor's, flipped. Angles are
 * never wrapped (a multi-turn key must stay multi-turn), and the relative
 * timelines interpolate them as raw numbers, so a tween turns the way the
 * editor's does.
 */
export interface SpineLocal {
  x: number;
  y: number;
  rotation: number;
  shearX: number;
  shearY: number;
  scaleX: number;
  scaleY: number;
}

export function toSpineLocal(t: Transform): SpineLocal {
  return {
    x: nz(t.x),
    y: nz(-t.y),
    rotation: nz(-t.skewY),
    shearX: 0,
    shearY: nz(t.skewY - t.skewX),
    scaleX: t.scaleX,
    scaleY: t.scaleY,
  };
}

/** The inverse, for any Spine bone, shearX included. */
export function fromSpineLocal(s: SpineLocal): Transform {
  return {
    x: nz(s.x),
    y: nz(-s.y),
    skewX: nz(-(s.rotation + s.shearY)),
    skewY: nz(-(s.rotation + s.shearX)),
    scaleX: s.scaleX,
    scaleY: s.scaleY,
  };
}

/**
 * A pose as the bone timelines store it. Translate, rotate and shear keys
 * are ADDED to the setup value; scale keys MULTIPLY it. A scale channel is
 * null when the setup scale is 0 and the pose is not: no key can reach it.
 */
export interface SpineKeyValues {
  x: number;
  y: number;
  rotate: number;
  shearX: number;
  shearY: number;
  scaleX: number | null;
  scaleY: number | null;
}

export function keyValues(pose: SpineLocal, setup: SpineLocal): SpineKeyValues {
  return {
    x: nz(pose.x - setup.x),
    y: nz(pose.y - setup.y),
    rotate: nz(pose.rotation - setup.rotation),
    shearX: nz(pose.shearX - setup.shearX),
    shearY: nz(pose.shearY - setup.shearY),
    scaleX: scaleRatio(pose.scaleX, setup.scaleX),
    scaleY: scaleRatio(pose.scaleY, setup.scaleY),
  };
}

function scaleRatio(pose: number, setup: number): number | null {
  if (setup === 0) return pose === 0 ? 1 : null;
  return pose / setup;
}

/**
 * Where a region attachment goes for an image drawn with its top-left
 * corner at −pivot (the editor's convention, y down): Spine places the
 * image's CENTRE, in the bone's y-up space.
 */
export function regionCentre(
  width: number, height: number, pivot: { x: number; y: number },
): { x: number; y: number } {
  return { x: nz(width / 2 - pivot.x), y: nz(pivot.y - height / 2) };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * The time a key at `frame` is written with: the largest float32 not after
 * `frame / fps`. The runtime stores key times in a Float32Array and a key
 * applies once `time >= key`; float32(1/60) is 0.0166666675, just AFTER
 * 1/60, so seeking to frame 1 would still show frame 0's interval. Written
 * this way, the stored time is exactly the written one and never late.
 * JSON must carry it unrounded.
 */
export function keyTime(frame: number, fps: number): number {
  const t = frame / fps;
  if (t <= 0) return 0;
  f32[0] = t;
  if (f32[0] > t) u32[0] -= 1;          // positive float: one ulp down
  return f32[0]!;
}
