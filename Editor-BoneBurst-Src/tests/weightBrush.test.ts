import { describe, expect, it } from "vitest";
import { brush, brushWeights, falloff, resizeBrush } from "@/ui/stage/weightBrush";

/** The weight brush (E6 step 4f): one step of a stroke as new weights. */

const pts: [number, number][] = [[100, 100], [110, 100], [130, 100], [150, 100]];
const step = (w: number[], takeAway = false, strength = 0.5) => brushWeights(pts.length, (v) => pts[v]!, (v) => w[v]!, [100, 100], { radius: 40, strength }, takeAway);

describe("the weight brush (E6 step 4f)", () => {
  it("falls off smoothly from 1 at the centre to 0 at the edge", () => {
    expect(falloff(0, 40)).toBe(1);
    expect(falloff(20, 40)).toBe(0.5);
    expect(falloff(40, 40)).toBe(0);
    expect(falloff(10, 40)).toBeGreaterThan(falloff(30, 40));
  });

  it("adds towards 1 under the brush, more at the centre; outside it nothing changes", () => {
    const out = step([0, 0, 0.5, 0.2]);
    expect(out.get(0)).toBe(0.5);
    expect(out.get(1)! > 0 && out.get(1)! < 0.5).toBe(true);
    expect(out.get(2)! > 0.5 && out.get(2)! < 0.75).toBe(true);
    expect(out.has(3)).toBe(false);
  });

  it("takes away towards 0 with Alt; a weight already there is not listed", () => {
    const out = step([1, 0, 0.5, 1], true);
    expect(out.get(0)).toBe(0.5);
    expect(out.has(1)).toBe(false);
    expect(out.get(2)! < 0.5).toBe(true);
    expect(step([1, 1, 1, 1]).size).toBe(0);
  });

  it("[ and ] size it within 5 to 300 pixels", () => {
    brush.radius = 40;
    expect(resizeBrush(1)).toBe(50);
    expect(resizeBrush(-1)).toBe(40);
    for (let i = 0; i < 40; i++) resizeBrush(1);
    expect(brush.radius).toBe(300);
    for (let i = 0; i < 40; i++) resizeBrush(-1);
    expect(brush.radius).toBe(5);
    brush.radius = 40;
  });
});
