import { afterEach, describe, expect, it } from "vitest";
import { newSkeleton } from "@/edit/newSkeleton";
import { labelStep, ROW, setRowHeight, setTickSeries } from "@/ui/timeline/layout";

afterEach(() => { setRowHeight(22); setTickSeries(false); });

describe("the timeline's row height and ticks", () => {
  it("take the row height from the preference, where every user of ROW sees it", () => {
    expect(ROW).toBe(22);
    setRowHeight(30);
    expect(ROW).toBe(30);
    setRowHeight(2);
    expect(ROW).toBe(8);
  });
  it("label every 15 or 30 frames by default, and in a 1-2-5 series with fewer ticks", () => {
    expect(labelStep(4)).toBe(15);
    expect(labelStep(2)).toBe(30);
    setTickSeries(true);
    expect(labelStep(4)).toBe(20);
    expect(labelStep(2)).toBe(50);
    expect(labelStep(0.001)).toBe(2000);
  });
});

describe("a new project's frame rate", () => {
  it("is written to the header unless it is Spine's 30", () => {
    expect(newSkeleton("h", 24).header?.fps).toBe(24);
    expect(newSkeleton("h", 30).header?.fps).toBeUndefined();
    expect(newSkeleton("h").header?.fps).toBeUndefined();
  });
});
