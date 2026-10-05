import { describe, it, expect } from "vitest";
import { Camera } from "@/view/viewport/Camera";

/** Fit to Stage frames the space the stage toolbar leaves above it. */
describe("Camera.fit with a covered foot", () => {
  const view = (w: number, h: number) => { const c = new Camera(); c.width = w; c.height = h; return c; };
  const stage = { x: 0, y: 0, w: 800, h: 600 };

  it("with nothing covered, centres the stage in the whole view", () => {
    const c = view(1000, 800);
    c.fit(stage, 40);
    expect(c.zoom).toBeCloseTo(Math.min(920 / 800, 720 / 600));
    expect(c.panY + 300 * c.zoom).toBeCloseTo(400);
  });

  it("fits and centres above the covered band", () => {
    const c = view(1000, 800);
    c.fit(stage, 40, 100);
    expect(c.zoom).toBeCloseTo(620 / 600);
    // Its bottom edge clears the band.
    expect(c.panY + 600 * c.zoom).toBeLessThanOrEqual(700 - 40 + 1e-9);
    expect(c.panY + 300 * c.zoom).toBeCloseTo(350);
  });

  it("gives up at most 40% of the view to the band", () => {
    const c = view(1000, 300);
    c.fit(stage, 40, 290);
    expect(c.zoom).toBeCloseTo((180 - 80) / 600);
  });
});
