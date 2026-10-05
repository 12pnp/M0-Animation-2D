import { describe, expect, it } from "vitest";
import type { NodeId } from "@/core/doc/ids";
import { frameCell, frameCellBounds, parseFrameCell } from "@/core/doc/frameCells";

describe("frame cells", () => {
  it.each([
    ["n1:4", { id: "n1", frame: 4 }],
    ["a:b:12", { id: "a:b", frame: 12 }],
    ["n1:x", null],
    ["n1", null],
  ])("reads %s", (cell, want) => expect(parseFrameCell(cell)).toEqual(want));
  it("round-trips", () => expect(parseFrameCell(frameCell("n:9" as NodeId, 3))).toEqual({ id: "n:9", frame: 3 }));
  it("bounds a rectangle, ids in first-seen order, skipping what does not read", () => {
    expect(frameCellBounds(["b:4", "a:2", "b:6", "bad"])).toEqual({ ids: ["b", "a"], from: 2, to: 6 });
    expect(frameCellBounds(["bad"])).toBeNull();
    expect(frameCellBounds([])).toBeNull();
  });
});
