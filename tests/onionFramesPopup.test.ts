import { describe, it, expect } from "vitest";
import { popupAt } from "@/view/panels/onionFramesPopup";

const btn = (left: number, top: number) => ({ left, top, right: left + 20, bottom: top + 20 });

describe("popupAt", () => {
  const cases: Array<[string, ReturnType<typeof btn>, { x: number; y: number }]> = [
    ["under the button, left edges matched", btn(100, 100), { x: 100, y: 122 }],
    ["above when there is no room below", btn(100, 650), { x: 100, y: 468 }],
    ["pushed left off the window's right edge", btn(900, 100), { x: 796, y: 122 }],
    ["kept off the left edge", btn(-30, 100), { x: 4, y: 122 }],
  ];
  for (const [name, anchor, want] of cases) {
    it(name, () => expect(popupAt(anchor, 200, 180, 1000, 700)).toEqual(want));
  }

  it("below and clamped when it fits neither way", () => {
    expect(popupAt(btn(100, 100), 200, 600, 1000, 300)).toEqual({ x: 100, y: 4 });
  });
});
