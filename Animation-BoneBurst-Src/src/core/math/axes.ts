/**
 * The stage toolbar's axes (Spine's Local / Parent / World): which frame the
 * Rotate and Translate values are read and written in, and which directions
 * Shift locks a Translate drag to.
 *
 * - Parent: the node's own stored values — x/y in its parent's space, the
 *   rotation it carries. What the Properties panel shows.
 * - Local: x/y measured along the node's own rotated axes; rotation as Parent.
 * - World: the edited symbol's root space — where the node's origin sits on
 *   the stage, and its rotation there, parents included.
 *
 * Scale and Shear are always the node's own: no frame changes what they mean.
 */

import { type Matrix2D, applyInverse } from "./Matrix2D";
import { type Transform, rotateBy, shearOf } from "./Transform";
import type { Point } from "./geom";

export type Axes = "local" | "parent" | "world";

const RAD = Math.PI / 180;

const det = (m: Matrix2D) => m.a * m.d - m.b * m.c;

/** The rotation the toolbar shows, in degrees. */
export function shownRotation(axes: Axes, local: Transform, world: Matrix2D): number {
  return axes === "world" ? Math.atan2(world.b, world.a) / RAD : local.skewY;
}

/** The local transform that shows `value` as its rotation. Shear is kept. */
export function rotationFromShown(
  axes: Axes, value: number, local: Transform, world: Matrix2D, parentWorld: Matrix2D,
): Transform {
  if (axes !== "world") return { ...local, skewY: value, skewX: value + shearOf(local) };
  let delta = value - shownRotation(axes, local, world);
  delta = ((delta + 540) % 360) - 180;
  // Under a mirrored parent a positive local turn reads as a negative world one.
  if (det(parentWorld) < 0) delta = -delta;
  return rotateBy({ ...local }, local, delta);
}

/** The position the toolbar shows. */
export function shownTranslation(axes: Axes, local: Transform, world: Matrix2D): Point {
  if (axes === "world") return { x: world.tx, y: world.ty };
  if (axes === "parent") return { x: local.x, y: local.y };
  const c = Math.cos(local.skewY * RAD), s = Math.sin(local.skewY * RAD);
  return { x: local.x * c + local.y * s, y: -local.x * s + local.y * c };
}

/** The local transform that shows `value` as its position. */
export function translationFromShown(
  axes: Axes, value: Point, local: Transform, parentWorld: Matrix2D,
): Transform {
  if (axes === "parent") return { ...local, x: value.x, y: value.y };
  if (axes === "local") {
    const c = Math.cos(local.skewY * RAD), s = Math.sin(local.skewY * RAD);
    return { ...local, x: value.x * c - value.y * s, y: value.x * s + value.y * c };
  }
  const p = { x: 0, y: 0 };
  if (!applyInverse(p, parentWorld, value.x, value.y)) return { ...local };
  return { ...local, x: p.x, y: p.y };
}

/** The two directions, in world space, that Shift locks a Translate drag to. */
export function axisDirections(axes: Axes, world: Matrix2D, parentWorld: Matrix2D): [Point, Point] {
  if (axes === "world") return [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  const m = axes === "local" ? world : parentWorld;
  const unit = (x: number, y: number): Point => {
    const l = Math.hypot(x, y);
    return l > 1e-9 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  };
  return [unit(m.a, m.b), unit(m.c, m.d)];
}

/** `d` projected on whichever of the directions it runs closer to. */
export function constrainToAxis(d: Point, dirs: [Point, Point]): Point {
  const dots = dirs.map((u) => d.x * u.x + d.y * u.y);
  const i = Math.abs(dots[0]!) >= Math.abs(dots[1]!) ? 0 : 1;
  return { x: dirs[i]!.x * dots[i]!, y: dirs[i]!.y * dots[i]! };
}

/** The signed angle, in degrees, the pointer has swept about `origin`. */
export function sweptAngle(origin: Point, from: Point, to: Point): number {
  const a = Math.atan2(from.y - origin.y, from.x - origin.x);
  const b = Math.atan2(to.y - origin.y, to.x - origin.x);
  let d = (b - a) / RAD;
  d = ((d + 540) % 360) - 180;
  return d;
}

/**
 * Scale factors along a node's own axes for a pointer dragged from `from` to
 * `to` about `origin`: the ratio of the pointer's projections on each axis.
 * An axis the drag started too close to stays at 1. `uniform` (Shift) uses
 * the ratio of distances for both.
 */
export function scaleFactors(
  origin: Point, world: Matrix2D, from: Point, to: Point, uniform: boolean,
): { sx: number; sy: number } {
  const v0 = { x: from.x - origin.x, y: from.y - origin.y };
  const v1 = { x: to.x - origin.x, y: to.y - origin.y };
  if (uniform) {
    const l0 = Math.hypot(v0.x, v0.y);
    const k = l0 > 1e-6 ? Math.hypot(v1.x, v1.y) / l0 : 1;
    return { sx: k, sy: k };
  }
  const factor = (ux: number, uy: number): number => {
    const l = Math.hypot(ux, uy);
    if (l < 1e-9) return 1;
    const p0 = (v0.x * ux + v0.y * uy) / l;
    const p1 = (v1.x * ux + v1.y * uy) / l;
    return Math.abs(p0) > 4 ? p1 / p0 : 1;
  };
  return { sx: factor(world.a, world.b), sy: factor(world.c, world.d) };
}
