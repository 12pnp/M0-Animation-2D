import type { AnimationReference } from "./types";
import type { Rect } from "@/core/math/geom";

/**
 * Reference art's timing and placement (`Animation.reference`), and the
 * cells of a sprite sheet. Pure: cutting pixels is `io/import/spriteSheet.ts`.
 */

/** Which image a frame shows, or null before the first key or after the last.
 * A picture shows from its own `at` until one keyed later takes over; the
 * last holds `hold` frames. `at` need not ascend with the strip — the strip
 * is storage order, the keys decide. */
export function referenceIndexAt(ref: AnimationReference, frame: number): number | null {
  let best = -1;
  for (let k = 0; k < ref.frames.length; k++) {
    const at = referenceFrameOf(ref, k);
    // `>=` so a tie goes to the later picture in the strip.
    if (at <= frame && (best < 0 || at >= referenceFrameOf(ref, best))) best = k;
  }
  return best >= 0 && frame <= referenceEnd(ref) ? best : null;
}

/** The first frame image `index` shows. */
export function referenceFrameOf(ref: AnimationReference, index: number): number {
  return ref.at?.[index] ?? ref.start + index * ref.hold;
}

/** The last frame the reference reaches: the latest any picture plays. */
export function referenceEnd(ref: AnimationReference): number {
  if (ref.frames.length === 0) return ref.start - 1;
  const last = ref.at?.length === ref.frames.length
    ? Math.max(...ref.at)
    : ref.start + (ref.frames.length - 1) * ref.hold;
  return last + ref.hold - 1;
}

/** `at` re-spaced by the bulk fields: every image `hold` frames apart from
 * `start` — what "Starts at" and "Each image" in the panel apply. */
export function referenceSpacing(count: number, start: number, hold: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * hold);
}

/** Where an image sits in the symbol's space. */
export function referenceRect(ref: AnimationReference): Rect {
  return { x: ref.x, y: ref.y, w: ref.width * ref.scale, h: ref.height * ref.scale };
}

/**
 * A placement that stands the image over `box` (what the rig draws): as tall
 * as it, centred on it. A reference is usually the character with room
 * round it, so this is a start to adjust, not a match.
 */
export function fitReference(width: number, height: number, box: Rect | null): Pick<AnimationReference, "x" | "y" | "scale"> {
  if (!box || box.w <= 0 || box.h <= 0 || width <= 0 || height <= 0) return { x: -width / 2, y: -height, scale: 1 };
  const scale = box.h / height;
  return { x: box.x + box.w / 2 - (width * scale) / 2, y: box.y, scale };
}

/**
 * A sheet's cells, left to right, then top to bottom: `columns` × `rows`
 * equal cells, the first `count` of them (a sheet's last row is often
 * short). Whole pixels; a sheet that does not divide evenly loses the
 * remainder at its right and bottom edges.
 */
export function sheetCells(sheetWidth: number, sheetHeight: number, columns: number, rows: number, count = columns * rows): Rect[] {
  const cols = Math.max(1, Math.floor(columns)), rws = Math.max(1, Math.floor(rows));
  const w = Math.floor(sheetWidth / cols), h = Math.floor(sheetHeight / rws);
  if (w < 1 || h < 1) return [];
  const out: Rect[] = [];
  const n = Math.max(0, Math.min(cols * rws, Math.floor(count)));
  for (let i = 0; i < n; i++) out.push({ x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
  return out;
}

/** Every asset any animation's reference shows: kept by the project file. */
export function referenceAssets(animations: Iterable<{ reference?: AnimationReference }>): Set<string> {
  const out = new Set<string>();
  for (const a of animations) for (const id of a.reference?.frames ?? []) out.add(id);
  return out;
}

/**
 * How a picture for the AI frames the symbol's space: every rect in `boxes`
 * (what the rig draws, the reference) inside `maxSide` pixels, with `pad`
 * round it. `toPixel` and `fromPixel` convert between the symbol's space
 * (editor, y down) and the picture's pixels.
 */
export interface ImageFrame {
  width: number;
  height: number;
  /** Pixels per symbol unit. */
  scale: number;
  toPixel(x: number, y: number): [number, number];
  fromPixel(px: number, py: number): [number, number];
}

export function imageFrame(boxes: Rect[], maxSide: number, pad = 16): ImageFrame {
  const live = boxes.filter((b) => b.w > 0 && b.h > 0 && [b.x, b.y, b.w, b.h].every(Number.isFinite));
  const x0 = live.length ? Math.min(...live.map((b) => b.x)) : -100, y0 = live.length ? Math.min(...live.map((b) => b.y)) : -100;
  const x1 = live.length ? Math.max(...live.map((b) => b.x + b.w)) : 100, y1 = live.length ? Math.max(...live.map((b) => b.y + b.h)) : 100;
  const scale = (maxSide - 2 * pad) / Math.max(x1 - x0, y1 - y0, 1e-6);
  return {
    width: Math.max(1, Math.ceil((x1 - x0) * scale + 2 * pad)),
    height: Math.max(1, Math.ceil((y1 - y0) * scale + 2 * pad)),
    scale,
    toPixel: (x, y) => [(x - x0) * scale + pad, (y - y0) * scale + pad],
    fromPixel: (px, py) => [x0 + (px - pad) / scale, y0 + (py - pad) / scale],
  };
}
