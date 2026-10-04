import { describe, it, expect } from "vitest";
import { pathOnionSpan } from "@/view/panels/pathOnion";
import { DEFAULT_PREFS, mergePrefs } from "@/core/prefs/prefs";
import type { Animation } from "@/core/doc/types";

const anim = (duration: number, cycle = false) =>
  ({ duration, playTimes: cycle ? 0 : 1, endsAtLastFrame: cycle }) as unknown as Animation;

describe("pathOnionSpan", () => {
  const cases: Array<[string, number, Animation, number, number, { start: number; end: number }]> = [
    ["the counts either side of the playhead", 10, anim(30), 2, 3, { start: 8, end: 13 }],
    ["clamped to the animation", 1, anim(30), 5, 5, { start: 0, end: 6 }],
    ["clamped at the last frame", 28, anim(30), 1, 5, { start: 27, end: 29 }],
    ["unwrapped round a cycle's join", 1, anim(30, true), 3, 2, { start: -2, end: 3 }],
    ["none either side", 4, anim(30), 0, 0, { start: 4, end: 4 }],
  ];
  for (const [name, frame, a, before, after, want] of cases) {
    it(name, () => expect(pathOnionSpan(frame, a, before, after)).toEqual(want));
  }
});

describe("the Path panels' onion prefs", () => {
  it("each panel keeps its own, apart from the timeline's", () => {
    const p = mergePrefs({
      timeline: { onionBefore: 7 },
      gizmos: { localPathOnion: true, localPathOnionBefore: 4, worldPathOnionAfter: 9 },
    });
    expect([p.timeline.onionBefore, p.gizmos.localPathOnion, p.gizmos.worldPathOnion]).toEqual([7, true, false]);
    expect([p.gizmos.localPathOnionBefore, p.gizmos.localPathOnionAfter]).toEqual([4, DEFAULT_PREFS.gizmos.localPathOnionAfter]);
    expect([p.gizmos.worldPathOnionBefore, p.gizmos.worldPathOnionAfter]).toEqual([DEFAULT_PREFS.gizmos.worldPathOnionBefore, 9]);
  });

  it("opacity and colours are each panel's own", () => {
    const g = mergePrefs({ gizmos: { localPathOnionOpacity: 0.6, worldPathOnionPast: "#ff0000" } }).gizmos;
    expect([g.localPathOnionOpacity, g.worldPathOnionOpacity]).toEqual([0.6, DEFAULT_PREFS.gizmos.worldPathOnionOpacity]);
    expect([g.worldPathOnionPast, g.localPathOnionPast]).toEqual(["#ff0000", DEFAULT_PREFS.gizmos.localPathOnionPast]);
  });

  it("falloff and outline are each panel's own", () => {
    const g = mergePrefs({ gizmos: { worldPathOnionFalloff: 0.5, localPathOnionOutline: true } }).gizmos;
    expect([g.worldPathOnionFalloff, g.localPathOnionFalloff]).toEqual([0.5, DEFAULT_PREFS.gizmos.localPathOnionFalloff]);
    expect([g.localPathOnionOutline, g.worldPathOnionOutline]).toEqual([true, false]);
    expect(mergePrefs({ gizmos: { localPathOnionFalloff: 2 } }).gizmos.localPathOnionFalloff).toBe(0.9);
  });

  it("counts are clamped", () => {
    expect(mergePrefs({ gizmos: { worldPathOnionBefore: 500, localPathOnionAfter: -3 } }).gizmos)
      .toMatchObject({ worldPathOnionBefore: 100, localPathOnionAfter: 0 });
    expect(mergePrefs({ gizmos: { localPathOnionOpacity: 0 } }).gizmos.localPathOnionOpacity).toBe(0.05);
  });
});
