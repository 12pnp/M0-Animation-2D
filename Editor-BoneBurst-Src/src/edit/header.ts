import type { Header, Skeleton } from "@/model/skeleton";
import { keyLists, keyTime } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";

/**
 * The skeleton's header (Format-Json-Atlas.md §4; E6-PLAN step 4i): its frame rate. Spine keeps key
 * times in seconds and the frame rate is nonessential (the editor's grid), so setting it moves no
 * key.
 */

export const FPS_RANGE = [1, 240] as const;

/** Set the frame rate; `undefined` leaves it to the default (30). */
export function setFps(fps: number | undefined): Edit<Skeleton> {
  return (s) => {
    if (fps !== undefined && !(Number.isInteger(fps) && fps >= FPS_RANGE[0] && fps <= FPS_RANGE[1])) {
      throw new EditRefused(`A frame rate is a whole number from ${FPS_RANGE[0]} to ${FPS_RANGE[1]}.`);
    }
    const h: Header = s.header ?? { extra: new Map() };
    if (h.fps === fps) return s;
    const { fps: _, ...rest } = h;
    return { ...s, header: (fps === undefined ? rest : { ...rest, fps }) as Header };
  };
}

/** How many keys fall between frames at `fps` (more than a thousandth of a frame off). */
export function keysOffFrame(s: Skeleton, fps: number): number {
  let n = 0;
  for (const a of s.animations ?? []) for (const { keys } of keyLists(a)) for (const k of keys) {
    const f = keyTime(k) * fps;
    if (Math.abs(f - Math.round(f)) > 1e-3) n++;
  }
  return n;
}
