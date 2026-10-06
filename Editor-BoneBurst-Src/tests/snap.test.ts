import { describe, expect, it } from "vitest";
import { snapPoint, type SnapOptions } from "@/ui/stage/snap";

/** Snapping (E6 step 4e): what a dragged point snaps to, within 8 screen pixels. */

const all: SnapOptions = { grid: true, guides: true, bones: true, pixels: false, gridSize: 50 };
const targets = { points: [[103, 47]] as [number, number][], guides: [{ axis: "x" as const, at: 210 }, { axis: "y" as const, at: -30 }] };

describe("snapping (E6 step 4e)", () => {
  it("a bone's joint or tip first, both axes; within 8 screen pixels at the zoom", () => {
    expect(snapPoint([100, 50], targets, all, 1)).toEqual({ point: [103, 47], to: [103, 47] });
    // At zoom 0.25 the reach is 32 units; at zoom 4, 2 units.
    expect(snapPoint([80, 60], targets, all, 0.25).point).toEqual([103, 47]);
    expect(snapPoint([100, 50], targets, all, 4).point).toEqual([100, 50]);
  });

  it("then a guide on its own axis, then a grid line, each axis apart", () => {
    // x near the vertical guide at 210, y near the grid line at 100.
    expect(snapPoint([205, 96], targets, all, 1)).toEqual({ point: [210, 100], x: 210, y: 100 });
    // A guide wins over a grid line within reach of both (the guide at y −30, the grid at −50 … 0).
    expect(snapPoint([3, -27], targets, all, 1)).toEqual({ point: [0, -30], x: 0, y: -30 });
    // Out of reach of everything: unchanged.
    expect(snapPoint([125.3, 75.6], targets, all, 1)).toEqual({ point: [125.3, 75.6] });
  });

  it("each switch: off, nothing of its kind; whole pixels round what did not snap", () => {
    expect(snapPoint([100, 50], targets, { ...all, bones: false }, 1)).toEqual({ point: [100, 50], x: 100, y: 50 });
    expect(snapPoint([205, 96], targets, { ...all, guides: false }, 1)).toEqual({ point: [200, 100], x: 200, y: 100 });
    expect(snapPoint([205, 96], targets, { ...all, guides: false, grid: false }, 1)).toEqual({ point: [205, 96] });
    expect(snapPoint([125.3, 75.6], targets, { ...all, pixels: true }, 1)).toEqual({ point: [125, 76] });
  });
});
