/**
 * Timeline zoom: how wide one frame is drawn. DOM-free, so vitest checks it;
 * the frame grid applies it.
 */

/** The narrowest and widest a frame is drawn (Preferences ▸ Timeline's limits). */
export const FRAME_WIDTH_MIN = 4;
export const FRAME_WIDTH_MAX = 40;

const clamp = (w: number) => Math.max(FRAME_WIDTH_MIN, Math.min(FRAME_WIDTH_MAX, w));

/**
 * One wheel step in (`zoomIn`) or out. About 15% a step, and always at least
 * a whole pixel, or rounding would leave a narrow frame where it was.
 */
export function steppedFrameWidth(width: number, zoomIn: boolean): number {
  const next = Math.round(zoomIn ? width * 1.15 : width / 1.15);
  return clamp(next === width ? width + (zoomIn ? 1 : -1) : next);
}

/**
 * The scroll that keeps the frame under `pointerX` (pixels from the grid's
 * left edge) under it after the frame width changes from `from` to `to`.
 */
export function anchoredScroll(scrollX: number, pointerX: number, from: number, to: number): number {
  const frame = (scrollX + pointerX) / from;
  return Math.max(0, frame * to - pointerX);
}

/**
 * The widest frames at which `frames` frames, and half a frame to spare, fit
 * in `viewWidth` pixels; at least the narrowest, when even that cannot.
 */
export function fitFrameWidth(frames: number, viewWidth: number): number {
  if (frames <= 0 || viewWidth <= 0) return FRAME_WIDTH_MIN;
  return clamp(Math.floor(viewWidth / (frames + 0.5)));
}

/**
 * The room the playhead's frame number takes in the ruler: centred on the
 * playhead line at `x`, the number's width (`textWidth`) with `pad` either
 * side. The ruler's own labels keep out of it. Left edge and width, in whole
 * pixels.
 */
export function playheadLabel(x: number, textWidth: number, pad = 3): { left: number; width: number } {
  const width = Math.ceil(textWidth) + 2 * pad;
  return { left: Math.round(x - width / 2), width };
}
