import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { pathDrive, pathKeysOver } from "@/ui/motion";
import { Poser } from "@/ui/stage/posed";
import { pathPose, pathTime } from "@/motion";
import { translateKeysAt } from "@/edit/pathKeys";
import type { MotionPath } from "@/model/sidecar";
import { keysOver, SEAM_GAP } from "@/ui/pathKeysOver";

const FPS = 24, identity = (_t: number, x: number, y: number): readonly [number, number] => [x, y];
const ring: MotionPath = { animation: "a", bone: "b", nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], closed: true, duration: 1, loop: true };
const line: MotionPath = { animation: "a", bone: "b", nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false, duration: 1, loop: true };
const near = (a: number, b: number, d = 1e-6): boolean => Math.abs(a - b) < d;

/** The motion the keys give at `t`: the Bézier of the segment (control times a third and two thirds along), by bisection on time. */
function sample(keys: ReturnType<typeof keysOver>["keys"], t: number): [number, number] {
  let i = keys.findIndex((_k, j) => j + 1 < keys.length && t < keys[j + 1]!.time);
  if (i < 0) i = keys.length - 2;
  const a = keys[i]!, b = keys[i + 1]!, u = (t - a.time) / (b.time - a.time);
  if (!a.control) return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
  const bez = (p0: number, c1: number, c2: number, p3: number, w: number): number => { const v = 1 - w; return v * v * v * p0 + 3 * v * v * w * c1 + 3 * v * w * w * c2 + w * w * w * p3; };
  // The control times sit at thirds, so time is linear in the Bézier's parameter.
  return [bez(a.x, a.control[0], a.control[1], b.x, u), bez(a.y, a.control[2], a.control[3], b.y, u)];
}

describe("a path as keys over an animation's length (docs/UNITY-EXPORT-PLAN.md, step 1)", () => {
  it("a ring over twice its duration repeats its first run, starts at time 0 and ends at the length", () => {
    const one = keysOver(ring, 1, FPS, identity), two = keysOver(ring, 2, FPS, identity);
    expect(two.keys[0]!.time).toBe(0);
    expect(two.keys.at(-1)!.time).toBe(2);
    expect(two.wholeRuns).toBe(true);
    // The second run is the first, a run later: each key of the first run has its twin.
    for (const k of one.keys.slice(0, -1)) {
      const twin = two.keys.find((x) => near(x.time, k.time + 1));
      expect(twin, `key at ${k.time}`).toBeDefined();
      expect(near(twin!.x, k.x, 1e-4) && near(twin!.y, k.y, 1e-4)).toBe(true);
    }
    // A ring ends where it began: the last key is the first.
    expect(near(two.keys.at(-1)!.x, two.keys[0]!.x, 1e-4)).toBe(true);
    expect(near(two.keys.at(-1)!.y, two.keys[0]!.y, 1e-4)).toBe(true);
  });
  it("the keys' motion is the path's, at every time of the animation, within the fit", () => {
    for (const [m, len] of [[ring, 2.5], [line, 1.7]] as [MotionPath, number][]) {
      const out = keysOver(m, len, FPS, identity);
      let worst = 0;
      for (let t = 0; t <= len; t += 0.01) {
        const [x, y] = sample(out.keys, t), q = pathPose(m, pathTime(m, t));
        // Within a repeat's gap the open path is mid-jump.
        if (!m.closed && Math.abs(t - Math.round(t)) < 0.02) continue;
        worst = Math.max(worst, Math.hypot(x - q.x, y - q.y));
      }
      expect(worst).toBeLessThan(1.5);
    }
  });
  it("a path that does not loop holds its last place for the rest of the animation", () => {
    const out = keysOver({ ...ring, closed: false, loop: false }, 3, FPS, identity);
    const end = pathPose({ ...ring, closed: false }, 1);
    for (const t of [1, 2, 3]) { const [x, y] = sample(out.keys, t); expect(near(x, end.x, 1e-3) && near(y, end.y, 1e-3)).toBe(true); }
    expect(out.keys.at(-1)!.time).toBe(3);
  });
  it("an animation that is not a whole number of runs long is flagged; a whole number is not", () => {
    expect(keysOver(ring, 1.37, FPS, identity).wholeRuns).toBe(false);
    expect(keysOver(ring, 1, FPS, identity).wholeRuns).toBe(true);
    expect(keysOver(ring, 3, FPS, identity).wholeRuns).toBe(true);
  });
  it("a path longer than the animation is cut at its length", () => {
    const out = keysOver(ring, 0.4, FPS, identity);
    expect(out.keys.at(-1)!.time).toBe(0.4);
    const [x, y] = [out.keys.at(-1)!.x, out.keys.at(-1)!.y], q = pathPose(ring, 0.4);
    expect(near(x, q.x, 1e-3) && near(y, q.y, 1e-3)).toBe(true);
  });
  it("an even straight path gives straight keys: the first, a key at the end, and the motion linear in time", () => {
    const out = keysOver({ ...line, loop: false }, 1, FPS, identity);
    expect(out.keys[0]).toMatchObject({ time: 0, x: 0, y: 0 });
    expect(out.keys.at(-1)).toMatchObject({ time: 1, x: 100, y: 0 });
    expect(out.stray).toBeLessThan(0.1);
    for (const t of [0.25, 0.5, 0.75]) { const [x, y] = sample(out.keys, t); expect(near(x, 100 * t, 0.2)).toBe(true); expect(near(y, 0, 1e-6)).toBe(true); }
  });
  it("an open looping path jumps from its end to its start within the gap at each repeat; a ring has no such pair", () => {
    const out = keysOver(line, 2, FPS, identity);
    const before = out.keys.find((k) => near(k.time, 1 - SEAM_GAP, 1e-9)), at = out.keys.find((k) => k.time === 1);
    expect(before).toBeDefined();
    expect(near(before!.x, 100, 0.2)).toBe(true);
    expect(at!.x).toBeCloseTo(0, 4);
    expect(before!.control).toBeUndefined();
    expect(keysOver(ring, 2, FPS, identity).keys.some((k) => near(k.time, 1 - SEAM_GAP, 1e-9))).toBe(false);
  });
  it("the place of each point is the caller's: a shift of the reference bone over time moves the keys with it", () => {
    const out = keysOver({ ...line, loop: false }, 1, FPS, (t, x, y) => [x, y + 10 * t]);
    expect(out.keys.at(-1)!.y).toBeCloseTo(10, 4);
    expect(out.keys[0]!.y).toBeCloseTo(0, 4);
  });
  it("written as Spine keys: times in seconds, offsets from the setup pose, a curve on every key but the last and the jump", () => {
    const out = keysOver(line, 2, FPS, identity), keys = translateKeysAt({ x: 5, y: 0 }, out.keys);
    expect(keys[0]).toMatchObject({ x: -5, y: 0 });
    expect(keys[0]!.time).toBeUndefined();
    expect(keys.at(-1)!.curve).toBeUndefined();
    expect(keys.filter((k) => k.curve).length).toBe(out.keys.filter((k) => k.control).length);
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.time!).toBeGreaterThan(keys[i - 1]!.time ?? -1);
  });
  it("nothing for a zero length or a path with no duration", () => {
    expect(keysOver(ring, 0, FPS, identity).keys).toEqual([]);
    expect(keysOver({ ...ring, duration: 0 }, 1, FPS, identity).keys).toEqual([]);
  });
});

describe("on the stickman: the keys give the bone what pathDrive gives it", () => {
  const dir = join(__dirname, "fixtures", "stickman"), fps = 24;
  const doc = readSkeleton(readFileSync(join(dir, "Stickman_IK.json"), "utf8")).skeleton;
  const images = atlasImages(readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")));
  // An IK target follows a ring in the space of the hips, which the run animation moves relative to it (the hips bob, its parent does not).
  const m: MotionPath = { animation: "run", bone: "hand_near_target", parent: "hips", nodes: [{ x: 0, y: 40 }, { x: 30, y: 60 }, { x: 0, y: 80 }, { x: -30, y: 60 }], closed: true, duration: 0.5, loop: true };
  it("at times between the keys, in a reference bone that moves", () => {
    const poser = new Poser(doc, images), out = pathKeysOver(poser, doc, null, m, 1, fps);
    expect(out.keys.at(-1)!.time).toBe(1);
    let worst = 0;
    for (const t of [0, 0.07, 0.19, 0.31, 0.5, 0.58, 0.77, 0.93]) {
      const pose = poser.pose(null, "run", Math.fround(t), "none"), want = pathDrive(doc, [m], "run", pose, t).get("hand_near_target")!;
      const [x, y] = sample(out.keys, t);
      worst = Math.max(worst, Math.hypot(x - want.x, y - want.y));
    }
    expect(worst).toBeLessThan(1.5);
  });
});
