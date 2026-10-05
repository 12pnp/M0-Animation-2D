/**
 * The Path panels' grid step, in stage pixels: the smallest of 1, 2 or 5 × 10ⁿ
 * that is at least `minPx` on screen at `zoom`, so the lines stay readable
 * from a hand's twitch to a whole walk. Every fifth line is a major one.
 */
export function pathGridStep(zoom: number, minPx = 16): number {
  if (!(zoom > 0)) return 1;
  const raw = minPx / zoom;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw - 1e-9) return m * pow;
  }
  return 10 * pow;
}

export const PATH_GRID_MAJOR = 5;
