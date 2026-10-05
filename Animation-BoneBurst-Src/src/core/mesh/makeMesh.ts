import type { MeshData } from "@/core/doc/types";
import { triangulate } from "./triangulate";
import { inFlatPolygon, segmentDistance } from "@/core/math/geom";

/**
 * A mesh for an image from its outline (ARCHITECTURE ▸ Meshes): points along
 * the outline every `spacing` pixels or so, a grid of points inside it kept
 * half a spacing from the edge, all triangulated within the outline. Pure:
 * the outline comes from `traceContour` on the image's alpha.
 */
export function makeMesh(outline: readonly number[], spacing: number, width: number, height: number): MeshData {
  const n = outline.length / 2;
  const hullPts: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = outline[i * 2]!, ay = outline[i * 2 + 1]!;
    const bx = outline[((i + 1) % n) * 2]!, by = outline[((i + 1) % n) * 2 + 1]!;
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let s = 0; s < steps; s++) hullPts.push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
  }
  const hull = hullPts.length / 2;
  const inner: number[] = [];
  if (hull >= 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < hull; i++) {
      minX = Math.min(minX, hullPts[i * 2]!); maxX = Math.max(maxX, hullPts[i * 2]!);
      minY = Math.min(minY, hullPts[i * 2 + 1]!); maxY = Math.max(maxY, hullPts[i * 2 + 1]!);
    }
    for (let y = minY + spacing; y < maxY; y += spacing) {
      for (let x = minX + spacing; x < maxX; x += spacing) {
        if (inFlatPolygon(hullPts, x, y, hull) && distanceToOutline(hullPts, hull, x, y) > spacing * 0.5) inner.push(x, y);
      }
    }
  }
  const points = [...hullPts, ...inner].map((v) => Math.round(v * 100) / 100);
  return { width, height, points, triangles: triangulate(points, hull), hull };
}

/** The distance from (x, y) to the nearest outline edge. */
export function distanceToOutline(pts: readonly number[], hull: number, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < hull; i++) {
    const j = (i + 1) % hull;
    best = Math.min(best, segmentDistance(pts[i * 2]!, pts[i * 2 + 1]!, pts[j * 2]!, pts[j * 2 + 1]!, x, y));
  }
  return best;
}

/** A rectangle's outline: an image with no alpha to trace. */
export function boxOutline(width: number, height: number): number[] {
  return [0, 0, width, 0, width, height, 0, height];
}
