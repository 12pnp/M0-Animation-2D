/**
 * The weight brush (E6-PLAN step 4f): its settings, the person's (kept for the page, not in a
 * document), and one step of a stroke as new weights for the vertices under it. Pure apart from
 * the settings object: `tests/weightBrush.test.ts`.
 */

export interface BrushSettings {
  /** Painting instead of moving vertices, in mesh mode. */
  on: boolean;
  /** The circle's radius in screen pixels. */
  radius: number;
  /** How much of what is left each step adds (or takes away), at the centre. */
  strength: number;
}

export const BRUSH_RADIUS = [5, 300] as const;
export const BRUSH_STRENGTH = [0.01, 1] as const;

export const brush: BrushSettings = { on: false, radius: 40, strength: 0.1 };

/** Bigger or smaller by a step ([ and ]), within its range. */
export function resizeBrush(by: number): number {
  brush.radius = Math.min(BRUSH_RADIUS[1], Math.max(BRUSH_RADIUS[0], Math.round(brush.radius * (by > 0 ? 1.25 : 0.8))));
  return brush.radius;
}

/** The falloff at `d` pixels from the centre of a brush of `radius`: 1 at the centre, smoothly to 0 at the edge. */
export function falloff(d: number, radius: number): number {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  return t * t * (3 - 2 * t);
}

/**
 * One step of a stroke: for each vertex within the brush (`screen` gives its position on screen;
 * `weight` its weight for the painted bone now), the new weight. Adding moves it `strength ×
 * falloff` of the way to 1; taking away, as far towards 0.
 */
export function brushWeights(count: number, screen: (v: number) => readonly [number, number], weight: (v: number) => number,
  at: readonly [number, number], o: { radius: number; strength: number }, takeAway: boolean): Map<number, number> {
  const out = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    const [x, y] = screen(v), k = o.strength * falloff(Math.hypot(x - at[0], y - at[1]), o.radius);
    if (k <= 0) continue;
    const w = weight(v), next = takeAway ? w - k * w : w + k * (1 - w);
    if (Math.abs(next - w) > 1e-6) out.set(v, Math.round(next * 1e4) / 1e4);
  }
  return out;
}
