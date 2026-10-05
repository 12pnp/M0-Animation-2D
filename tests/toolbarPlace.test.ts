import { describe, it, expect } from "vitest";
import { clampToolbarOffset, toolbarInset } from "@/view/viewport/toolbarPlace";

const bar = { w: 400, h: 80 };
const host = { w: 1000, h: 600 };

describe("clampToolbarOffset", () => {
  const cases: Array<[string, { dx: number; dy: number }, { dx: number; dy: number }]> = [
    ["home stays home", { dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    ["inside the stage is kept", { dx: 200, dy: -300 }, { dx: 200, dy: -300 }],
    ["pushed back off the right edge", { dx: 900, dy: 0 }, { dx: 592, dy: 0 }],
    ["pushed back off the left edge", { dx: -50, dy: 0 }, { dx: -8, dy: 0 }],
    ["pushed back off the top", { dx: 0, dy: -900 }, { dx: 0, dy: -512 }],
    ["pushed back off the bottom", { dx: 0, dy: 40 }, { dx: 0, dy: 8 }],
  ];
  for (const [name, off, want] of cases) {
    it(name, () => expect(clampToolbarOffset(off, bar, host)).toEqual(want));
  }

  it("a bar wider than the stage keeps its left edge on it", () => {
    expect(clampToolbarOffset({ dx: 300, dy: 0 }, { w: 1200, h: 80 }, host)).toEqual({ dx: -8, dy: 0 });
  });
});

describe("toolbarInset", () => {
  it("covers the foot of the stage at home or below it", () => {
    expect(toolbarInset({ dx: 120, dy: 0 }, bar)).toBe(88);
    expect(toolbarInset({ dx: 0, dy: 8 }, bar)).toBe(88);
  });
  it("covers nothing once lifted", () => expect(toolbarInset({ dx: 0, dy: -40 }, bar)).toBe(0));
});
