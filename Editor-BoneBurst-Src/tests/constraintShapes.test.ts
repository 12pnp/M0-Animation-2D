import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateConstraint } from "@/edit/constraints";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import type { IkConstraint, Skeleton } from "@/model/skeleton";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { constraintShapes, hitConstraint } from "@/ui/stage/constraintShapes";
import { boneMatrix, boneTip, Poser } from "@/ui/stage/posed";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => {
  const atlas = readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton, images: atlasImages(readAtlas(atlas)) };
};
const pose = (s: Skeleton, images: AtlasImages, skin: string | null = null) => new Poser(s, images).pose(skin, null, 0);

describe("constraint shapes", () => {
  it("IK reaches from its chain's end to its target; a transform links its source to each bone it moves", () => {
    const { doc, images } = sample("spineboy-pro", "spineboy-pro.json");
    const p = pose(doc, images), shapes = constraintShapes(p);
    // An IK whose last bone has length, so its tip is not its origin.
    const ik = doc.constraints!.find((c): c is IkConstraint => c.type === "ik" && (doc.bones!.find((b) => b.name === c.bones!.at(-1))!.length ?? 0) > 10)!;
    const s = shapes.find((x) => x.type === "ik" && x.name === ik.name)!;
    const last = p.bones.get(ik.bones!.at(-1)!)!, target = boneMatrix(p, p.bones.get(ik.target!)!);
    const tip = boneTip(p, last);
    expect(s.links[0]![0]).toBeCloseTo(tip[0], 6);
    expect(s.links[0]![1]).toBeCloseTo(tip[1], 6);
    expect(s.links[0]![3]).toBeCloseTo(target[5], 6);
    expect(s.marks).toEqual([{ x: target[4], y: target[5], mark: "ring" }]);
    const t = doc.constraints!.find((c) => c.type === "transform")!;
    const ts = shapes.find((x) => x.type === "transform" && x.name === t.name)!;
    expect(ts.links.length).toBe(t.bones!.length);
    expect(ts.links[0]![0]).toBeCloseTo(boneMatrix(p, p.bones.get(t.source!)!)[4], 6);
  });
  it("a path draws its attachment's curve, and at position 0 its first bone sits on the curve's start", () => {
    // Stretchyman's paths apply on the setup pose (hero-pro's is skin-required).
    const { doc, images } = sample("Stretchyman", "stretchyman.json");
    const path = doc.constraints!.find((c) => c.type === "path")!;
    const s = updateConstraint({ type: "path", name: path.name }, { positionMode: "percent", position: 0, mixX: 1, mixY: 1 })(doc);
    const p = pose(s, images), shape = constraintShapes(p).find((x) => x.type === "path" && x.name === path.name)!;
    expect(shape.curves.length).toBeGreaterThan(0);
    expect(shape.marks.length).toBe(path.bones!.length);
    const first = boneMatrix(p, p.bones.get(path.bones![0]!)!);
    expect(first[4]).toBeCloseTo(shape.curves[0]![0], 2);
    expect(first[5]).toBeCloseTo(shape.curves[0]![1], 2);
    // Each segment starts where the one before it ends.
    for (let i = 1; i < shape.curves.length; i++) {
      expect(shape.curves[i]![0]).toBeCloseTo(shape.curves[i - 1]![6], 6);
      expect(shape.curves[i]![1]).toBeCloseTo(shape.curves[i - 1]![7], 6);
    }
  });
  it("physics rings its bone; a bone-driven slider squares its bone, a time-driven one draws nothing", () => {
    const circus = sample("celestial-circus", "celestial-circus-pro.json");
    const p = pose(circus.doc, circus.images), shapes = constraintShapes(p);
    const ph = circus.doc.constraints!.find((c) => c.type === "physics")!;
    const s = shapes.find((x) => x.type === "physics" && x.name === ph.name)!;
    expect(s.marks[0]!.mark).toBe("ring");
    expect(s.marks[0]!.x).toBeCloseTo(boneMatrix(p, p.bones.get(ph.bone!)!)[4], 6);
    const sb = sample("spineboy-pro", "spineboy-pro.json");
    const withSliders = { ...sb.doc, constraints: [...sb.doc.constraints!,
      { type: "slider" as const, name: "byBone", animation: "aim", bone: "root", property: "x", extra: new Map() },
      { type: "slider" as const, name: "byTime", animation: "aim", mix: 0, extra: new Map() }] } as Skeleton;
    const ss = constraintShapes(pose(withSliders, sb.images));
    expect(ss.find((x) => x.name === "byBone")!.marks[0]!.mark).toBe("square");
    expect(ss.find((x) => x.name === "byTime")).toBeUndefined();
  });
  it("leaves out a constraint that is not active (skin-required, its skin not shown)", () => {
    const { doc, images } = sample("spineboy-pro", "spineboy-pro.json");
    const ik = doc.constraints!.find((c) => c.type === "ik")!;
    const s = updateConstraint({ type: "ik", name: ik.name }, { skin: true })(doc);
    expect(constraintShapes(pose(s, images)).some((x) => x.type === "ik" && x.name === ik.name)).toBe(false);
  });
  it("picks a constraint by its link, its curve or its mark, within 6 pixels", () => {
    const shapes = [
      { index: 0, type: "ik" as const, name: "a", links: [[0, 0, 100, 0] as const], curves: [], marks: [{ x: 100, y: 0, mark: "ring" as const }] },
      { index: 1, type: "path" as const, name: "b", links: [], curves: [[0, 50, 30, 50, 70, 50, 100, 50] as const], marks: [] },
    ];
    const id = (x: number, y: number): [number, number] => [x, y];
    expect(hitConstraint(shapes, id, 50, 4, 6)?.name).toBe("a");
    expect(hitConstraint(shapes, id, 50, 53, 6)?.name).toBe("b");
    expect(hitConstraint(shapes, id, 108, 0, 6)?.name).toBe("a");
    expect(hitConstraint(shapes, id, 50, 25, 6)).toBeNull();
  });
});
