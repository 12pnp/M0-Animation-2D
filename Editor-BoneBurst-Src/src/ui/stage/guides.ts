import type { Guide } from "@/model/sidecar";
import { type Camera, type Size, toScreen } from "./camera";

/**
 * The stage's rulers and guides (E4-PLAN step 8). A guide on axis "x" is the vertical line at that
 * x; on axis "y", the horizontal line at that y (skeleton units). The top ruler makes horizontal
 * guides, the left ruler vertical ones. No DOM: tested in vitest.
 */

/** The rulers' thickness, in CSS pixels. */
export const RULER = 16;

/** Which ruler a screen point is on, if any (the corner counts as neither). */
export function rulerAt(sx: number, sy: number): "top" | "left" | null {
  if (sx < RULER && sy < RULER) return null;
  if (sy < RULER) return "top";
  if (sx < RULER) return "left";
  return null;
}

/** The axis of the guides a ruler makes, and the ruler a guide goes back to. */
export const axisOf = (r: "top" | "left"): Guide["axis"] => (r === "top" ? "y" : "x");
export const rulerOf = (axis: Guide["axis"]): "top" | "left" => (axis === "y" ? "top" : "left");

/** A guide's line on screen: its x (vertical) or y (horizontal), in CSS pixels. */
export function guideScreen(g: Guide, c: Camera, s: Size): number {
  return g.axis === "x" ? toScreen(c, s, g.at, 0)[0] : toScreen(c, s, 0, g.at)[1];
}

/** The guide within `radius` pixels of the screen point (the nearest; the later on a tie), or -1. */
export function hitGuide(guides: readonly Guide[], c: Camera, s: Size, sx: number, sy: number, radius = 4): number {
  let best = -1, bestD = radius;
  guides.forEach((g, i) => {
    const d = Math.abs((g.axis === "x" ? sx : sy) - guideScreen(g, c, s));
    if (d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

/** A ruler's tick spacing in skeleton units: 1, 2 or 5 × 10ⁿ, at least `minPx` pixels apart. */
export function tickStep(zoom: number, minPx = 50): number {
  const raw = minPx / zoom, p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
