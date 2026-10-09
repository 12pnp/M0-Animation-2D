import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertToFramePath, framePathReport } from "@/edit/toFramePath";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Key, Skeleton } from "@/model/skeleton";
import { keysAt } from "@/model/timelines";
import { NO_IMAGES } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";

/** docs/SPINE-IMPORT-FRAMEPATH-PLAN.md, step 1: a Spine export's translate keys made into what FramePath edits. 10 fps: frame n is n / 10 s. */

const doc = (hip: Record<string, unknown>) => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 10 },
  bones: [{ name: "root" }, { name: "hip", parent: "root", x: 3, y: 4 }],
  animations: { walk: { bones: { hip } } },
})).skeleton;
const list = (s: Skeleton, timeline: string, a = 0): readonly Key[] => keysAt(s.animations![a]!, { section: "bones", owner: "hip", timeline }) ?? [];
/** Every bone's local x, y at `time` of animation `name`, as the engine poses it. */
function poses(s: Skeleton, name: string, time: number): Float64Array {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), NO_IMAGES));
  rig.setupPose();
  rig.apply(rig.animation(name)!, time, false);
  return rig.local;
}
/** The largest distance between two skeletons' bone places over every frame `0 … frames` of `name`. */
function worstOver(a: Skeleton, b: Skeleton, name: string, frames: number, fps = 10): number {
  let worst = 0;
  for (let f = 0; f <= frames; f++) {
    const p = poses(a, name, f / fps), q = poses(b, name, f / fps);
    for (let i = 0; i < p.length; i += 7) worst = Math.max(worst, Math.hypot(p[i]! - q[i]!, p[i + 1]! - q[i + 1]!));
  }
  return worst;
}
const LEAVE = { timing: "leave", tolerance: 0.5 } as const;

describe("framePathReport", () => {
  it("names a bone with split lists (their key counts) and one whose curves time x and y apart", () => {
    expect(framePathReport(doc({ translatex: [{ value: 0 }, { time: 1, value: 5 }], translatey: [{ value: 1 }] }))).toEqual([{ animation: "walk", bone: "hip", split: { x: 2, y: 1 } }]);
    expect(framePathReport(doc({ translate: [{ x: 0, y: 0, curve: [0.2, 0, 0.8, 10, 0.5, 0, 0.6, 5] }, { time: 1, x: 10, y: 5 }] }))).toEqual([{ animation: "walk", bone: "hip", apart: 1 }]);
    expect(framePathReport(doc({ translate: [{ x: 0, y: 0, curve: [0.2, 0, 0.8, 10, 0.2, 0, 0.8, 5] }, { time: 1, x: 10, y: 5 }] }))).toEqual([]);
  });
});

describe("merging split lists (exact)", () => {
  it("one translate list keyed where either was; the bone where it was at every frame", () => {
    const before = doc({ translatex: [{ value: 0, curve: [0.3, 0, 0.6, 12] }, { time: 1, value: 10 }, { time: 2, value: 5 }], translatey: [{ value: 0 }, { time: 1.5, value: 20 }] });
    const after = convertToFramePath(before, LEAVE).doc;
    expect(list(after, "translatex")).toEqual([]);
    expect(list(after, "translatey")).toEqual([]);
    expect(list(after, "translate").map((k) => k.time ?? 0)).toEqual([0, 1, 1.5, 2]);
    expect(worstOver(before, after, "walk", 25)).toBeLessThan(0.3);
    // Left as it is (Leave), x's bezier and y's line time the merged spans apart: that is for the timing step.
    expect(framePathReport(after).every((f) => !f.split)).toBe(true);
  });

  it("an axis with no list stays at the setup pose (0)", () => {
    const after = convertToFramePath(doc({ translatey: [{ value: 0 }, { time: 1, value: 8 }] }), LEAVE).doc;
    expect(list(after, "translate").map((k) => [k.x, k.y])).toEqual([[0, 0], [0, 8]]);
  });

  it("an axis whose list starts late, or steps, while the other moves: a one-frame ramp, the same at every whole frame", () => {
    const late = doc({ translatex: [{ value: 0 }, { time: 1, value: 10 }], translatey: [{ time: 0.5, value: 7 }, { time: 1, value: 9 }] });
    expect(worstOver(late, convertToFramePath(late, LEAVE).doc, "walk", 12)).toBeLessThan(1e-3);
    const step = doc({ translatex: [{ value: 0, curve: "stepped" }, { time: 1, value: 10 }], translatey: [{ value: 0 }, { time: 1, value: 9 }] });
    const merged = convertToFramePath(step, LEAVE);
    expect(worstOver(step, merged.doc, "walk", 12)).toBeLessThan(1e-3);
    expect(merged.added).toBe(1);
  });
});

describe("x and y timed together", () => {
  const apart = () => doc({ translate: [{ x: 0, y: 0, curve: [0.1, 0, 0.2, 40, 0.8, 0, 0.9, 40] }, { time: 1, x: 40, y: 40 }] });

  it("leave keeps the timing; match gives one timing and says how far the bone moved", () => {
    expect(list(convertToFramePath(apart(), LEAVE).doc, "translate")).toEqual(list(apart(), "translate"));
    const m = convertToFramePath(apart(), { timing: "match", tolerance: 0.5 });
    expect(framePathReport(m.doc)).toEqual([]);
    expect(m.added).toBe(0);
    // One timing fitted to both channels (the value handles follow): near, and said how near.
    expect(m.worst).toBeGreaterThan(0);
  });

  it("split cuts the span at whole frames until matching moves the bone no more than the tolerance (or a span is one frame)", () => {
    const s = convertToFramePath(apart(), { timing: "split", tolerance: 0.5 });
    expect(framePathReport(s.doc)).toEqual([]);
    expect(s.added).toBeGreaterThan(0);
    expect(list(s.doc, "translate").every((k) => Math.abs((k.time ?? 0) * 10 - Math.round((k.time ?? 0) * 10)) < 1e-4)).toBe(true);
    expect(s.worst).toBeLessThanOrEqual(0.5);
    expect(worstOver(apart(), s.doc, "walk", 10)).toBeLessThan(0.5 + 0.3);
  });
});

describe("the owner's sample: mix-and-match-pro", () => {
  const sample = readSkeleton(readFileSync(join(__dirname, "..", "..", "Assets", "Samples Custom", "BoneBurstDemo", "mix-and-match-pro", "mix-and-match-pro.json"), "utf8")).skeleton;

  it("reports 22 split bones and the bones timing x and y apart", () => {
    const r = framePathReport(sample);
    expect(r.filter((f) => f.split).length).toBe(22);
    expect(r.filter((f) => f.apart).reduce((n, f) => n + f.apart!, 0)).toBe(21);
  });

  it("converted (split, 0.5): nothing left for FramePath to refuse, and every bone within the tolerance at every frame of every animation", { timeout: 120_000 }, () => {
    const out = convertToFramePath(sample, { timing: "split", tolerance: 0.5 });
    expect(framePathReport(out.doc)).toEqual([]);
    for (const a of sample.animations ?? []) {
      const frames = Math.ceil(Math.max(0, ...(a.bones ?? []).flatMap((g) => g.timelines.flatMap((t) => t.keys.map((k) => k.time ?? 0)))) * 30);
      // Matching moves within the tolerance; Spine's 10-step bezier sampling of cut curves adds a little.
      expect(worstOver(sample, out.doc, a.name, frames, 30), a.name).toBeLessThan(0.75);
    }
  });
});
