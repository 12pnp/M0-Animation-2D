/**
 * Snapping (E6-PLAN step 4e): a dragged point in skeleton units moved onto what is near it on
 * screen: another bone's joint or tip (both axes), else a guide, else a grid line (each axis on
 * its own), else, with whole pixels on, a whole unit. Pure: the stage gives the targets.
 */

export type Point = readonly [number, number];

export interface SnapOptions {
  readonly grid: boolean;
  readonly guides: boolean;
  readonly bones: boolean;
  readonly pixels: boolean;
  /** The grid's spacing in skeleton units. */
  readonly gridSize: number;
}

export interface SnapTargets {
  /** Joints and tips of the bones that do not move with the dragged point. */
  readonly points: readonly Point[];
  readonly guides: readonly { readonly axis: "x" | "y"; readonly at: number }[];
}

/** What the point snapped to, per axis, for the stage to draw: a line at x or y, or a point. */
export interface Snapped {
  readonly point: Point;
  readonly x?: number;
  readonly y?: number;
  readonly to?: Point;
}

/** How near on screen a target has to be, in CSS pixels. */
export const SNAP_RADIUS = 8;

/** `p` snapped at `zoom` (screen pixels per unit). */
export function snapPoint(p: Point, targets: SnapTargets, o: SnapOptions, zoom: number): Snapped {
  const r = SNAP_RADIUS / zoom;
  if (o.bones) {
    let best: Point | null = null, bestD = r;
    for (const q of targets.points) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= bestD) { best = q; bestD = d; }
    }
    if (best) return { point: best, to: best };
  }
  const axis = (v: number, a: "x" | "y"): { v: number; line?: number } => {
    if (o.guides) {
      let best: number | null = null, bestD = r;
      for (const g of targets.guides) if (g.axis === a && Math.abs(g.at - v) <= bestD) { best = g.at; bestD = Math.abs(g.at - v); }
      if (best !== null) return { v: best, line: best };
    }
    if (o.grid && o.gridSize > 0) {
      const g = Math.round(v / o.gridSize) * o.gridSize;
      if (Math.abs(g - v) <= r) return { v: g, line: g };
    }
    return { v: o.pixels ? Math.round(v) : v };
  };
  // A vertical guide sits at an x; a horizontal one at a y.
  const x = axis(p[0], "x"), y = axis(p[1], "y");
  return { point: [x.v, y.v], ...(x.line !== undefined ? { x: x.line } : {}), ...(y.line !== undefined ? { y: y.line } : {}) };
}
