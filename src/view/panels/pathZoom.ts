import type { Camera } from "@/view/viewport/Camera";

/**
 * The zoom both locked panels share after a fit: the smallest of their own
 * fits, so each path is whole in its panel. Panels that have not fitted yet
 * (null) do not count.
 */
export function lockedZoom(fits: readonly (number | null)[]): number | null {
  const ok = fits.filter((z): z is number => z !== null && Number.isFinite(z) && z > 0);
  return ok.length ? Math.min(...ok) : null;
}

export interface ZoomLinked {
  readonly camera: Camera;
  /** The zoom this panel's last fit chose on its own. */
  fitZoom: number | null;
  redraw(): void;
}

/** Holds the Path panels whose zoom is locked together (`gizmos.pathZoomLock`). */
export class PathZoomLink {
  private readonly panels: ZoomLinked[] = [];

  constructor(private readonly locked: () => boolean) {}

  add(p: ZoomLinked): void { this.panels.push(p); }

  /** `from` was zoomed: the others take its zoom, about their centres. */
  zoomed(from: ZoomLinked): void {
    if (!this.locked()) return;
    for (const p of this.panels) {
      if (p === from || p.camera.zoom === from.camera.zoom) continue;
      p.camera.setZoom(from.camera.zoom);
      p.redraw();
    }
  }

  /** `from` fitted itself: every panel takes the smallest fit. */
  fitted(from: ZoomLinked): void {
    if (!this.locked()) return;
    const z = lockedZoom(this.panels.map((p) => p.fitZoom));
    if (z === null) return;
    for (const p of this.panels) {
      if (p.camera.zoom === z) continue;
      p.camera.setZoom(z);
      if (p !== from) p.redraw();
    }
  }
}
