import { describe, expect, it } from "vitest";
import { pathGridStep } from "@/view/panels/pathGrid";

describe("pathGridStep", () => {
  it.each([
    { zoom: 1, step: 20 },
    { zoom: 16, step: 1 },
    { zoom: 8, step: 2 },
    { zoom: 0.5, step: 50 },
    { zoom: 0.1, step: 200 },
    { zoom: 3.2, step: 5 },
    { zoom: 0, step: 1 },
  ])("zoom $zoom → $step px", ({ zoom, step }) => {
    expect(pathGridStep(zoom)).toBeCloseTo(step, 9);
  });
});
