import { describe, expect, it } from "vitest";
import { DEFAULTS } from "@/ui/preferences";
import { lookOf, rgbOf } from "@/ui/stage/look";

describe("the stage's look", () => {
  it("reads #rrggbb as channels, and anything else (auto) as none", () => {
    expect(rgbOf("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(rgbOf("auto")).toBeNull();
    expect(rgbOf("#fff")).toBeNull();
  });
  it("follows the preferences", () => {
    const look = lookOf({ ...DEFAULTS, checker: true, gridSize: 20, axes: false, axisThickness: 3, gridColour: "#00ff00" });
    expect(look).toMatchObject({ checker: 20, checkerColour: null, axes: false, axisPx: 3, gridColour: [0, 1, 0] });
    expect(lookOf({ ...DEFAULTS, checker: false }).checker).toBeNull();
  });
});
