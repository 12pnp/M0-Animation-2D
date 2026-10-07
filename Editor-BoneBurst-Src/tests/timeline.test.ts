import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import type { Animation } from "@/model/skeleton";
import { atlasImages } from "@/engine/regions";
import { animatedLocal, Poser } from "@/ui/stage/posed";
import { secondsSinceLastKey, frameX, labelStep, refId, xFrame } from "@/ui/timeline/layout";
import { STICKMAN } from "./fixtures/rigs";

const stickman = () => readSkeleton(readFileSync(join(STICKMAN, "Stickman_IK.json"), "utf8")).skeleton;
const images = () => atlasImages(readAtlas(readFileSync(join(STICKMAN, "Stickman_IK.atlas.txt"), "utf8")));

describe("timeline geometry", () => {
  const v = { frameWidth: 10, first: 2 };
  it("maps frames to x and back", () => {
    expect(frameX(v, 2)).toBe(0);
    expect(frameX(v, 7)).toBe(50);
    expect(xFrame(v, 50)).toBe(7);
  });
  it("labels the ruler at least 48 px apart", () => {
    expect(labelStep(60)).toBe(1);
    expect(labelStep(12)).toBe(5);
    expect(labelStep(1)).toBe(60);
  });
  it("names a key by its list and frame, so float32 noise does not split it", () => {
    const path = { section: "bones" as const, owner: "a", timeline: "rotate" };
    expect(refId({ path, time: 0.0833333283662796 }, 24)).toBe(refId({ path, time: 0.083333336 }, 24));
  });
});

describe("posing an animation", () => {
  it("keeps the pose before constraints for keying: an IK-driven bone's own values", () => {
    const doc = stickman(), poser = new Poser(doc, images());
    const p = poser.pose(null, "run", Math.fround(0.25));
    const i = p.bones.get("leg_near_thigh")!;
    const before = animatedLocal(p, i).rotation, after = p.rig.local[i * 7 + 2]!;
    // The thigh is in a two-bone IK chain: the solver turns it away from its keyed value.
    expect(Math.abs(after - before)).toBeGreaterThan(0.01);
  });
  it("poses the same frame the same way however it is reached", () => {
    const poser = new Poser(stickman(), images());
    const at = (t: number) => Array.from(poser.pose(null, "run", Math.fround(t)).rig.world);
    const once = at(0.5);
    at(0.1);
    expect(at(0.5)).toEqual(once);
  });
});

describe("the time since the last key", () => {
  const key = (t: number) => ({ ...(t ? { time: t } : {}), extra: new Map() });
  const a = { name: "x", bones: [{ name: "b", timelines: [{ name: "rotate", keys: [key(0), key(0.5)] }] }], extra: new Map() } as unknown as Animation;
  it("is measured from the nearest key before the frame, on any timeline", () => {
    expect(secondsSinceLastKey(a, 18, 24)).toBeCloseTo(0.25, 6);
    expect(secondsSinceLastKey(a, 5, 24)).toBeCloseTo(5 / 24, 6);
  });
  it("on a key it counts from the one before, and there is nothing before the first", () => {
    expect(secondsSinceLastKey(a, 12, 24)).toBeCloseTo(0.5, 6);
    expect(secondsSinceLastKey(a, 0, 24)).toBeNull();
  });
});
