import { describe, expect, it } from "vitest";
import { speedColour } from "@/ui/graphLook";
import { SPEED_MIN } from "@/edit/keySpeed";

/** docs/CURVES-PANEL-PLAN.md, step 7: the speed curve coloured by its value. */
describe("speedColour", () => {
  it("is the path colour at the even pace, bright green at 2 and beyond, red at the slowest", () => {
    expect(speedColour("#ff9f1c", 0)).toBe("#ff9f1c");
    expect(speedColour("#ff9f1c", 2)).toBe("#3dff7a");
    expect(speedColour("#ff9f1c", 5)).toBe("#3dff7a");
    expect(speedColour("#ff9f1c", SPEED_MIN)).toBe("#ff3b30");
  });

  it("goes partway in between: more green the faster, more red the slower", () => {
    const g = (hex: string) => parseInt(hex.slice(3, 5), 16), b = (hex: string) => parseInt(hex.slice(5, 7), 16);
    expect(g(speedColour("#ff9f1c", 1.5))).toBeGreaterThan(g(speedColour("#ff9f1c", 0.5)));
    expect(b(speedColour("#ff9f1c", -0.8))).toBeGreaterThan(b(speedColour("#ff9f1c", -0.2)));
    expect(g(speedColour("#ff9f1c", -0.8))).toBeLessThan(g(speedColour("#ff9f1c", -0.2)));
  });
});
