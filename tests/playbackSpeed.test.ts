import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { Store } from "@/app/Store";
import { Playback } from "@/view/timeline/Playback";

/** Playback driven by hand: `step(ms)` runs one animation frame `ms` later. */
function rig(speed: number, rate = 60) {
  const project = createProject("P");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  sym.animations[0]!.duration = 200;
  const store = new Store(project);
  store.prefs.set("timeline", { playSpeed: speed, playRate: rate });
  let pending: FrameRequestCallback | null = null;
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { pending = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { pending = null; });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const playback = new Playback(store, () => {});
  playback.play();
  const step = (ms: number) => { now += ms; const cb = pending; pending = null; cb?.(now); };
  return { store, step, playback };
}

beforeEach(() => reseed());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("playback speed", () => {
  it.each([
    { speed: 1, frames: 24 },
    { speed: 2, frames: 48 },
    { speed: 0.5, frames: 12 },
    { speed: 0.25, frames: 6 },
    { speed: 5, frames: 120 },
  ])("one second at $speed× plays $frames frames at 24 fps", ({ speed, frames }) => {
    const { store, step } = rig(speed);
    for (let i = 0; i < 60; i++) step(1000 / 60);
    // ±1: sixty steps of 1000/60 ms do not add up to exactly a second.
    expect(Math.abs(store.ui.frame - frames)).toBeLessThanOrEqual(1);
  });
});

describe("smooth playback", () => {
  it("poses between frames at 60 redraws a second, and rests on a whole frame", () => {
    const { store, step, playback } = rig(1, 60);
    step(1000 / 60);
    expect(store.ui.frame).toBe(0);
    expect(store.ui.subFrame).toBeCloseTo(0.4, 6);
    expect(store.stageFrame).toBeCloseTo(0.4, 6);
    playback.pause();
    expect(store.ui.subFrame).toBe(0);
    expect(store.stageFrame).toBe(0);
  });

  it("redraws only every other tick at 30 on a 60 Hz display", () => {
    const { store, step } = rig(1, 30);
    let events = 0;
    store.subscribe((t) => { if (t === "frame") events++; });
    for (let i = 0; i < 60; i++) step(1000 / 60);
    expect(events).toBe(30);
  });

  it("carries on from a scrub made while playing", () => {
    const { store, step } = rig(1, 60);
    step(1000 / 60);
    store.setFrame(100);
    step(1000 / 60);
    expect(store.ui.frame).toBe(100);
    expect(store.ui.subFrame).toBeCloseTo(0.4, 6);
  });
});
