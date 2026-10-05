import { describe, expect, it } from "vitest";
import { propertyKeys, type TimelineProp } from "@/core/doc/propertyKeys";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import type { Track } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

/** Keys at frames 0, 10, 20, 30 with these transforms. */
const track = (...ts: ReturnType<typeof tf>[]): Track => ({
  nodeId: "n" as NodeId, endFrame: 40,
  keys: ts.map((transform, i) => ({ frame: i * 10, transform, displayIndex: 0, tween: TWEEN_LINEAR })),
});

// tf(x, y, skewX, skewY, scaleX, scaleY): rotation is skewY, shear skewY − skewX.
const rest = tf();
const turned = tf(0, 0, 30, 30);
const moved = tf(5, 0);
const sheared = tf(0, 0, 10, 0);

describe("propertyKeys", () => {
  it.each<{ name: string; t: Track; prop: TimelineProp; want: number[] }>([
    { name: "a property that never changes has no keys", t: track(rest, moved, rest), prop: "rotate", want: [] },
    { name: "x moving: every key it differs at", t: track(rest, moved, rest), prop: "x", want: [0, 10, 20] },
    { name: "a hold before a change keeps its start", t: track(rest, rest, turned), prop: "rotate", want: [10, 20] },
    { name: "a key equal to both neighbours is not one", t: track(turned, rest, rest, rest), prop: "rotate", want: [0, 10] },
    { name: "y does not move with x", t: track(rest, moved), prop: "y", want: [] },
    { name: "shear apart from rotation", t: track(rest, sheared), prop: "shear", want: [0, 10] },
    { name: "rotation without shear", t: track(rest, turned), prop: "shear", want: [] },
    { name: "scale", t: track(rest, tf(0, 0, 0, 0, 2, 1)), prop: "scale", want: [0, 10] },
    { name: "one key: nothing to show", t: track(turned), prop: "rotate", want: [] },
  ])("$name", ({ t, prop, want }) => {
    expect(propertyKeys(t, prop)).toEqual(want);
  });
});
