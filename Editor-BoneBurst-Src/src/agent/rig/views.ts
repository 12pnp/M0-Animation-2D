/**
 * The views a character is drawn in, and the names of its sides in each (E5 step 5): a side view
 * has a near and a far side, a front view a left and a right, as on screen. Bones and joints are
 * named after them (`thigh_near`, `knee.left`).
 */
export type MotionView = "side" | "front";

export const SIDES: Readonly<Record<MotionView, readonly string[]>> = { side: ["near", "far"], front: ["left", "right"] };

/** A point in skeleton space, y up. */
export type Point = readonly [number, number];
