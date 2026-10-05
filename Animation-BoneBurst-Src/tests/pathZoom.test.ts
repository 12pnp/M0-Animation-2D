import { describe, expect, it } from "vitest";
import { lockedZoom, PathZoomLink, type ZoomLinked } from "@/view/panels/pathZoom";
import { Camera } from "@/view/viewport/Camera";

describe("lockedZoom", () => {
  it.each([
    { fits: [2, 0.5], want: 0.5 },
    { fits: [1.5, null], want: 1.5 },
    { fits: [null, null], want: null },
    { fits: [0, 3, NaN], want: 3 },
    { fits: [], want: null },
  ])("$fits → $want", ({ fits, want }) => {
    expect(lockedZoom(fits)).toBe(want);
  });
});

describe("PathZoomLink", () => {
  const panel = (zoom: number, fitZoom: number | null = null): ZoomLinked & { draws: number } => {
    const camera = new Camera();
    camera.width = 200; camera.height = 100;
    camera.setZoom(zoom);
    const p = { camera, fitZoom, draws: 0, redraw: () => { p.draws++; } };
    return p;
  };

  it("a zoom in one panel sets the other's while locked, and not while unlocked", () => {
    let locked = true;
    const link = new PathZoomLink(() => locked);
    const local = panel(1), world = panel(1);
    link.add(local); link.add(world);
    local.camera.zoomAt(10, 10, 2.5);
    link.zoomed(local);
    expect(world.camera.zoom).toBeCloseTo(2.5);
    expect(world.draws).toBe(1);
    locked = false;
    local.camera.zoomAt(10, 10, 2);
    link.zoomed(local);
    expect(world.camera.zoom).toBeCloseTo(2.5);
  });

  it("a fit while locked leaves both at the smaller fit", () => {
    const link = new PathZoomLink(() => true);
    const local = panel(4, 4), world = panel(0.8, 0.8);
    link.add(local); link.add(world);
    link.fitted(local);
    expect(local.camera.zoom).toBeCloseTo(0.8);
    expect(world.camera.zoom).toBeCloseTo(0.8);
  });
});
