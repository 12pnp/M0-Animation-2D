import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atlasImages } from "@/engine/regions";
import { deleteTranslateKeys, translateKeyCount } from "@/edit/pathKeys";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { MotionPath } from "@/model/sidecar";
import { animationDuration } from "@/model/timelines";
import { bakeSummary, exportDoc } from "@/ui/exportPaths";
import { pathDrive, pathKeysOver } from "@/ui/motion";
import { Poser } from "@/ui/stage/posed";

const dir = join(__dirname, "fixtures", "stickman"), fps = 24;
const doc = readSkeleton(readFileSync(join(dir, "Stickman_IK.json"), "utf8")).skeleton;
const images = atlasImages(readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")));
const poser = new Poser(doc, images);
const keysFor = (d: typeof doc) => (m: MotionPath, length: number) => pathKeysOver(poser, d, null, m, length, fps);
const run = doc.animations!.find((a) => a.name === "run")!, length = animationDuration(run);
const ring = (extra: Partial<MotionPath> = {}): MotionPath => ({ animation: "run", bone: "hand_near_target", parent: "hips", nodes: [{ x: 0, y: 40 }, { x: 30, y: 60 }, { x: 0, y: 80 }, { x: -30, y: 60 }], closed: true, duration: length, loop: true, ...extra });

describe("the Spine keys export (docs/UNITY-EXPORT-PLAN.md, step 2)", () => {
  it("a document no bone of which uses a path exports as the same object, so the file is byte for byte what it was", () => {
    const out = exportDoc(doc, [], keysFor(doc));
    expect(out.doc).toBe(doc);
    expect(writeSkeleton(out.doc)).toBe(writeSkeleton(doc));
    expect(out.report.baked).toEqual([]);
    expect(bakeSummary(out.report)).toBe("");
    // A path set aside (the bone uses its keys), for another animation, or for a bone that is not there bakes nothing.
    for (const m of [ring({ active: false }), ring({ animation: "dance" }), ring({ bone: "nobody" })]) {
      const o = exportDoc(doc, m.animation === "dance" ? [{ ...m, animation: "nowhere" }] : [m], keysFor(doc));
      expect(o.doc).toBe(doc);
    }
  });
  it("a bone that uses its path has its translate keys replaced, to the animation's end; nothing else changes", () => {
    const m = ring(), out = exportDoc(doc, [m], keysFor(doc));
    expect(out.report.baked).toHaveLength(1);
    expect(out.report.baked[0]).toMatchObject({ animation: "run", bone: "hand_near_target", jumps: false });
    // Apart from that bone's translate keys, the document is as it was.
    const strip = (d: typeof doc) => writeSkeleton(deleteTranslateKeys("run", "hand_near_target")(d));
    expect(strip(out.doc)).toBe(strip(doc));
    expect(writeSkeleton(out.doc)).not.toBe(writeSkeleton(doc));
    const a = out.doc.animations!.find((x) => x.name === "run")!;
    expect(translateKeyCount(a, "hand_near_target")).toBeGreaterThan(2);
    expect(animationDuration(a)).toBeCloseTo(length, 6);
    expect(out.report.fromKeys).toContain("run/hips");
    expect(out.report.fromKeys).not.toContain("run/hand_near_target");
    expect(bakeSummary(out.report)).toMatch(/^1 bone from their TwinSpline \(\d+ keys\), \d+ from their key frames$/);
  });
  it("the exported file, posed by the rig, puts the bone where the editor's driven pose does", () => {
    const m = ring(), baked = exportDoc(doc, [m], keysFor(doc)).doc, p2 = new Poser(baked, images);
    let worst = 0;
    for (const t of [0, 0.06, 0.2, 0.37, 0.5, 0.61, length - 0.01]) {
      const want = pathDrive(doc, [m], "run", poser.pose(null, "run", Math.fround(t), "none"), t).get("hand_near_target")!;
      const got = p2.pose(null, "run", Math.fround(t), "none"), i = got.bones.get("hand_near_target")!;
      worst = Math.max(worst, Math.hypot(got.local[i * 7]! - want.x, got.local[i * 7 + 1]! - want.y));
    }
    expect(worst).toBeLessThan(1.5);
  });
  it("warns, naming the bone, when a looping path does not divide the animation", () => {
    const out = exportDoc(doc, [ring({ duration: length * 0.6 })], keysFor(doc));
    expect(out.report.baked[0]!.jumps).toBe(true);
    expect(bakeSummary(out.report)).toMatch(/run\/hand_near_target: its [\d.]+ s path does not divide run's [\d.]+ s, so the loop jumps/);
    expect(exportDoc(doc, [ring({ duration: length * 0.6, loop: false })], keysFor(doc)).report.baked[0]!.jumps).toBe(false);
  });
});
