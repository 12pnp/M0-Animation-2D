import type { KeyRef } from "@/edit/keys";
import type { Animation } from "@/model/skeleton";
import { keyLists, keyTime, pathId, timeFrame } from "@/model/timelines";

/** The timeline's geometry, without the DOM (`tests/timeline.test.ts`): where a frame is, the ruler's labels. */

/** How the track area is scrolled and zoomed. */
export interface View {
  /** CSS pixels per frame. */
  readonly frameWidth: number;
  /** The frame at the track's left edge (may be fractional). */
  readonly first: number;
}

export const RULER = 24;

export function frameX(v: View, frame: number): number { return (frame - v.first) * v.frameWidth; }
export function xFrame(v: View, x: number): number { return x / v.frameWidth + v.first; }

/** How often the ruler labels frames: every 1, 2, 5, 10 … frames, at least 48 px apart. */
/** The steps between labelled ticks: the frame-rate divisors, or (fewer ticks) a 1-2-5 series. */
const TICKS_FPS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const TICKS_125: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
let ticks = TICKS_FPS;
export function setTickSeries(fewer: boolean): void { ticks = fewer ? TICKS_125 : TICKS_FPS; }

export function labelStep(frameWidth: number): number {
  for (const s of ticks) if (s * frameWidth >= 48) return s;
  return ticks.at(-1)! * 2;
}

/** Seconds from the nearest key (of any timeline) before `frame` to that frame, or null when no key is before it. */
export function secondsSinceLastKey(anim: Animation, frame: number, fps: number): number | null {
  const now = frame / fps;
  let last = -Infinity;
  for (const l of keyLists(anim)) for (const k of l.keys) { const t = keyTime(k); if (t < now - 1e-6 && t > last) last = t; }
  return Number.isFinite(last) ? now - last : null;
}

/** A key's identity in the selection. */
export function refId(r: KeyRef, fps: number): string {
  return `${pathId(r.path)}${r.name !== undefined ? `/${r.name}` : ""}@${timeFrame(r.time, fps)}`;
}
