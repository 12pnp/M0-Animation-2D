import { describe, expect, it } from "vitest";
import { cellStep } from "@/ui/stage/canvasBackdrop";

describe("the backdrop's cells", () => {
  it("keep their size while they are big enough, and grow by fives when zoomed out", () => {
    expect(cellStep(50, 1, 8)).toBe(50);
    expect(cellStep(50, 0.1, 8)).toBe(250);
    expect(cellStep(50, 0.01, 8)).toBe(1250);
    expect(cellStep(1, 100, 6)).toBe(1);
  });
  it("does not loop when there is no scale or no cell size (a panel with no room)", () => {
    expect(cellStep(50, 0, 8)).toBe(50);
    expect(cellStep(50, -2, 8)).toBe(50);
    expect(cellStep(50, Number.NaN, 8)).toBe(50);
    expect(cellStep(0, 1, 8)).toBe(0);
  });
});
