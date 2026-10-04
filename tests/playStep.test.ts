import { describe, expect, it } from "vitest";
import { playStep, type PlayClock } from "@/view/timeline/playStep";

const clock = (o: Partial<PlayClock> = {}): PlayClock => ({
  fps: 30, speed: 1, rate: 60, last: 29, period: 29, loops: () => true, ...o,
});
const at = (pos: number, sinceDraw = 0, loopsDone = 0) => ({ pos, sinceDraw, loopsDone });

describe("playStep", () => {
  it.each([
    { name: "60 Hz at 30 fps: half a frame a redraw", s: at(2), dt: 1 / 60, c: clock(), kind: "draw", pos: 2.5 },
    { name: "speed 2", s: at(2), dt: 1 / 60, c: clock({ speed: 2 }), kind: "draw", pos: 3 },
    { name: "30 Hz on a 60 Hz display waits a tick", s: at(2), dt: 1 / 60, c: clock({ rate: 30 }), kind: "wait", pos: 2.5 },
    { name: "30 Hz draws on the second tick", s: at(2.5, 1 / 60), dt: 1 / 60, c: clock({ rate: 30 }), kind: "draw", pos: 3 },
    { name: "120 Hz", s: at(0), dt: 1 / 120, c: clock({ rate: 120 }), kind: "draw", pos: 0.25 },
    { name: "a loop wraps at the period", s: at(28.8), dt: 1 / 60, c: clock(), kind: "draw", pos: 0.3 },
    { name: "a one-shot ends on the last frame", s: at(29.8), dt: 1 / 60, c: clock({ loops: () => false, period: 30 }), kind: "end", pos: 29 },
    { name: "a one-shot plays its last frame", s: at(28.8), dt: 1 / 60, c: clock({ loops: () => false, period: 30 }), kind: "draw", pos: 29.3 },
  ])("$name", ({ s, dt, c, kind, pos }) => {
    const r = playStep(s, dt, c);
    expect(r.kind).toBe(kind);
    expect(r.state.pos).toBeCloseTo(pos, 9);
  });

  it("counts a loop", () => {
    expect(playStep(at(28.8), 1 / 60, clock()).state.loopsDone).toBe(1);
  });
});
