/**
 * Where the stage toolbar sits once dragged by its grip: an offset from its
 * home, the stage's bottom-left corner, kept so the whole bar stays on the
 * stage. Pure, so the clamping is tested without a stage.
 */

export interface Size { w: number; h: number }
export interface Offset { dx: number; dy: number }

/** The gap between the bar and the stage's edges at home. */
export const TOOLBAR_MARGIN = 8;

/** `off` moved as little as needed for a `bar` to fit inside `host`. A bar
 *  bigger than the stage keeps its left / top edge on it. */
export function clampToolbarOffset(off: Offset, bar: Size, host: Size): Offset {
  const homeX = TOOLBAR_MARGIN, homeY = host.h - TOOLBAR_MARGIN - bar.h;
  const x = Math.max(0, Math.min(homeX + off.dx, host.w - bar.w));
  const y = Math.max(0, Math.min(homeY + off.dy, host.h - bar.h));
  return { dx: Math.round(x - homeX), dy: Math.round(y - homeY) };
}

/** Pixels the bar covers at the foot of the stage, which Fit to Stage leaves
 *  free: none once it has been lifted off the bottom. */
export function toolbarInset(off: Offset, bar: Size): number {
  return off.dy < 0 ? 0 : bar.h + TOOLBAR_MARGIN;
}
