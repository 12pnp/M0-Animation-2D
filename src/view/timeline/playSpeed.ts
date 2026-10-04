/**
 * The speed slider: logarithmic, so 0.5× and 2× sit the same distance either
 * side of 1×, and 0.01× (a frame in four seconds at 24 fps) is still a reach
 * away from 5×. Its value runs 0..SPEED_SLIDER_MAX and snaps to 1× near it,
 * where a drag back to normal speed would otherwise stop at 0.98×.
 */
export const SPEED_MIN = 0.01;
export const SPEED_MAX = 5;
export const SPEED_SLIDER_MAX = 1000;
const SNAP = 8;
const SPAN = Math.log(SPEED_MAX / SPEED_MIN);

export function sliderFromSpeed(speed: number): number {
  if (!(speed > 0)) return sliderFromSpeed(1);
  const v = Math.round((Math.log(speed / SPEED_MIN) / SPAN) * SPEED_SLIDER_MAX);
  return Math.max(0, Math.min(SPEED_SLIDER_MAX, v));
}

export function speedFromSlider(v: number): number {
  const t = Math.max(0, Math.min(SPEED_SLIDER_MAX, v));
  if (Math.abs(t - sliderFromSpeed(1)) <= SNAP) return 1;
  const speed = SPEED_MIN * Math.exp((t / SPEED_SLIDER_MAX) * SPAN);
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(speed * 100) / 100));
}

/** "1×", "0.5×", "1.25×". */
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}
