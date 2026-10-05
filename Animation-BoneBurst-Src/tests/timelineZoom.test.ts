import { describe, it, expect } from "vitest";
import {
  FRAME_WIDTH_MAX, FRAME_WIDTH_MIN, anchoredScroll, fitFrameWidth, playheadLabel, steppedFrameWidth,
} from "@/view/timeline/zoom";

describe("steppedFrameWidth", () => {
  const cases: Array<[number, boolean, number]> = [
    [12, true, 14],
    [12, false, 10],
    // Narrow frames still move by a pixel, or the wheel would do nothing.
    [4, true, 5],
    [5, false, 4],
    [FRAME_WIDTH_MAX, true, FRAME_WIDTH_MAX],
    [FRAME_WIDTH_MIN, false, FRAME_WIDTH_MIN],
  ];
  for (const [w, zoomIn, want] of cases) {
    it(`${w} ${zoomIn ? "in" : "out"} → ${want}`, () => expect(steppedFrameWidth(w, zoomIn)).toBe(want));
  }
});

describe("anchoredScroll", () => {
  it("keeps the frame under the pointer where it was", () => {
    // Frame 25 sits under x = 100 at 12px with 200 scrolled: (200 + 100) / 12.
    const scroll = anchoredScroll(200, 100, 12, 24);
    expect((scroll + 100) / 24).toBeCloseTo(25);
  });

  it("never scrolls before frame 1", () => {
    expect(anchoredScroll(0, 50, 20, 10)).toBe(0);
  });
});

describe("fitFrameWidth", () => {
  const cases: Array<[string, number, number, number]> = [
    ["a short animation fills the view, up to the widest frames", 10, 1000, FRAME_WIDTH_MAX],
    ["a 60-frame one in 1000px", 60, 1000, 16],
    ["a long one gets the narrowest frames", 500, 1000, FRAME_WIDTH_MIN],
    ["no view yet", 60, 0, FRAME_WIDTH_MIN],
  ];
  for (const [name, frames, view, want] of cases) {
    it(name, () => expect(fitFrameWidth(frames, view)).toBe(want));
  }
});

describe("playheadLabel", () => {
  it("is the number's width and the padding, centred on the line", () => {
    const b = playheadLabel(100.5, 18.4);
    expect(b.width).toBe(25);
    expect(b.left + b.width / 2).toBeCloseTo(100.5, 0);
  });
  it("a one-digit number takes less room", () => {
    expect(playheadLabel(50.5, 6).width).toBe(12);
  });
});
