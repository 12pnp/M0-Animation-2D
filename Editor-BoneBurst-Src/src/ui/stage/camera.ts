/**
 * The stage's view of the world: the world point at the canvas centre and how many CSS pixels a
 * world unit spans. World is y up (Spine); the canvas is y down. No DOM: tested in vitest.
 */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Size { readonly width: number; readonly height: number }

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 64;

export function toScreen(c: Camera, s: Size, x: number, y: number): [number, number] {
  return [s.width / 2 + (x - c.x) * c.zoom, s.height / 2 - (y - c.y) * c.zoom];
}

export function toWorld(c: Camera, s: Size, sx: number, sy: number): [number, number] {
  return [c.x + (sx - s.width / 2) / c.zoom, c.y - (sy - s.height / 2) / c.zoom];
}

/** Zoom by `factor`, keeping the world point under the screen point (`sx`, `sy`) where it is. */
export function zoomAt(c: Camera, s: Size, sx: number, sy: number, factor: number): Camera {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom * factor));
  const [wx, wy] = toWorld(c, s, sx, sy);
  return { x: wx - (sx - s.width / 2) / zoom, y: wy + (sy - s.height / 2) / zoom, zoom };
}

/** Move the view by a screen drag of (`dx`, `dy`) pixels: the world follows the pointer. */
export function pan(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x - dx / c.zoom, y: c.y + dy / c.zoom, zoom: c.zoom };
}

/** The camera that shows the box with `margin` pixels to spare on every side. */
export function fit(s: Size, box: { minX: number; minY: number; maxX: number; maxY: number } | null, margin = 40): Camera {
  if (!box || !(box.maxX >= box.minX) || !(box.maxY >= box.minY)) return { x: 0, y: 0, zoom: 1 };
  const w = Math.max(box.maxX - box.minX, 1), h = Math.max(box.maxY - box.minY, 1);
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((s.width - 2 * margin) / w, (s.height - 2 * margin) / h)));
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, zoom };
}
