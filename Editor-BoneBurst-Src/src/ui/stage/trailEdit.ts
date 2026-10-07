import type { Skeleton } from "@/model/skeleton";
import { type Matrix, moveDelta, tidy } from "./gizmo";

/** The constraint that places a bone, so the bone's own keys do not (docs/LOCALPATH-EDIT-PLAN.md). */
export interface Driver {
  readonly name: string;
  readonly type: "ik" | "transform" | "path" | "physics" | "slider";
  /** The IK constraint's target: the bone to move instead. */
  readonly target?: string;
}

/**
 * The constraint driving `bone`, or null when the bone is free: the bones of an IK chain, a
 * transform or path constraint, and the bone a physics or slider constraint moves. An IK target is
 * not driven: it is what you move.
 */
export function constraintDriving(doc: Skeleton, bone: string): Driver | null {
  for (const c of doc.constraints ?? []) {
    if (c.type === "ik" && c.bones?.includes(bone)) return { name: c.name, type: "ik", ...(c.target !== undefined ? { target: c.target } : {}) };
    if ((c.type === "transform" || c.type === "path") && c.bones?.includes(bone)) return { name: c.name, type: c.type };
    if ((c.type === "physics" || c.type === "slider") && c.bone === bone) return { name: c.name, type: c.type };
  }
  return null;
}

/**
 * The bone's local x and y after its joint is moved by the world shift (`dx`, `dy`), under
 * `parent` (the parent's matrix at that frame). Rounded as the Stage's move rounds.
 */
export function shiftedLocal(parent: Matrix, from: { readonly x: number; readonly y: number }, dx: number, dy: number): { x: number; y: number } {
  const [lx, ly] = moveDelta(parent, dx, dy);
  return { x: tidy(from.x + lx, 2), y: tidy(from.y + ly, 2) };
}

/** A shift held to the horizontal or the vertical, whichever it has more of (Shift while dragging). */
export function axisLocked(dx: number, dy: number): [number, number] {
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
}
