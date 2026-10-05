import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateBone } from "@/edit/bones";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { boneInherit, boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { atlasImages } from "@/engine/regions";
import { fit, pan, toScreen, toWorld, zoomAt } from "@/ui/stage/camera";
import { baseName, pickFiles } from "@/ui/files";
import { asWritten, localRotation, moveDelta, pickBone, scaleFactors, tidy, turn, turnSign } from "@/ui/stage/gizmo";
import { boneMatrix, bounds, parentMatrix, poseSetup } from "@/ui/stage/posed";
import { STICKMAN } from "./fixtures/rigs";

const stickman = () => ({
  doc: readSkeleton(readFileSync(join(STICKMAN, "Stickman_IK.json"), "utf8")).skeleton,
  images: atlasImages(readAtlas(readFileSync(join(STICKMAN, "Stickman_IK.atlas.txt"), "utf8"))),
});

/** A chain whose parent is turned, scaled unevenly and mirrored: the hard case for a drag. */
const twisted = () => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [
    { name: "root" },
    { name: "arm", parent: "root", x: 10, rotation: 37, scaleX: 2, scaleY: -0.5, length: 50 },
    { name: "hand", parent: "arm", x: 50, y: 4, rotation: -20, length: 20 },
  ],
})).skeleton;

describe("camera", () => {
  const size = { width: 800, height: 600 };
  it("maps world to screen and back, y up in the world", () => {
    const c = { x: 10, y: 20, zoom: 2 };
    expect(toScreen(c, size, 10, 20)).toEqual([400, 300]);
    expect(toScreen(c, size, 11, 21)).toEqual([402, 298]);
    expect(toWorld(c, size, ...toScreen(c, size, -3.5, 7))).toEqual([-3.5, 7]);
  });
  it("zooms about the pointer, which stays on the same world point", () => {
    const c = { x: 0, y: 0, zoom: 1 }, at = [620, 140] as const;
    const before = toWorld(c, size, ...at), z = zoomAt(c, size, ...at, 3);
    expect(z.zoom).toBe(3);
    const after = toWorld(z, size, ...at);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });
  it("pans with the pointer", () => {
    const c = pan({ x: 0, y: 0, zoom: 2 }, 20, 10);
    expect(toScreen(c, size, 0, 0)).toEqual([420, 310]);
  });
  it("fits a box inside the margins", () => {
    const c = fit(size, { minX: -50, minY: 0, maxX: 50, maxY: 200 }, 50);
    expect(c).toEqual({ x: 0, y: 100, zoom: 2.5 });
    expect(fit(size, null)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("dragging a bone puts it where the pointer went", () => {
  const cases: Array<[string, () => { doc: Skeleton; images: ReturnType<typeof stickman>["images"] }, string]> = [
    ["the stickman's forearm (under IK)", stickman, "arm_near_2"],
    ["the stickman's head", stickman, "head"],
    ["a hand under a turned, mirrored parent", () => ({ doc: twisted(), images: stickman().images }), "hand"],
  ];
  it.each(cases)("move: %s", (_, make, name) => {
    const { doc, images } = make();
    const p = poseSetup(doc, images, null), i = p.bones.get(name)!;
    const b = doc.bones!.find((x) => x.name === name)!;
    const [dx, dy] = moveDelta(parentMatrix(p, i), 13.5, -7.25);
    const moved = updateBone(name, { x: boneNumber(b, "x") + dx, y: boneNumber(b, "y") + dy })(doc);
    const before = boneMatrix(p, i), after = boneMatrix(poseSetup(moved, images, null), i);
    // An IK-driven bone's origin is its parent's business; its unconstrained origin moves exactly.
    if (name !== "arm_near_2") {
      expect(after[4] - before[4]).toBeCloseTo(13.5, 6);
      expect(after[5] - before[5]).toBeCloseTo(-7.25, 6);
    }
  });
  it.each([[90], [-35], [170]])("rotate %d°: a hand under a turned, unevenly scaled, mirrored parent points where the pointer went", (by) => {
    const doc = twisted(), images = stickman().images, p = poseSetup(doc, images, null), i = p.bones.get("hand")!;
    const b = doc.bones!.find((x) => x.name === "hand")!;
    const m = boneMatrix(p, i), a0 = (Math.atan2(m[2], m[0]) * 180) / Math.PI;
    const r = localRotation(parentMatrix(p, i), a0 + by, 0, 1, boneNumber(b, "rotation"));
    const m1 = boneMatrix(poseSetup(updateBone("hand", { rotation: r })(doc), images, null), i);
    let got = (Math.atan2(m1[2], m1[0]) * 180) / Math.PI - a0;
    got -= Math.round(got / 360) * 360;
    // To 1e-5°: the engine turns with Spine's eight-digit π (engine/rigTypes DEG_RAD).
    expect(got).toBeCloseTo(by, 4);
    // The plain sign rule (for the other inherit modes) is not exact here: the parent is uneven.
    expect(turnSign(parentMatrix(p, i), boneInherit(b), false)).toBe(-1);
  });
  it("rotate keeps whole turns: the result is the turn nearest the expected one", () => {
    expect(localRotation([1, 0, 0, 1, 0, 0], 10, 0, 1, 725)).toBeCloseTo(730, 9);
  });
  it("scale: dragging out along the bone's x axis doubles its x scale only", () => {
    const { doc, images } = stickman(), p = poseSetup(doc, images, null), i = p.bones.get("head")!;
    const m = boneMatrix(p, i);
    const along = (k: number) => [m[4] + m[0] * k, m[5] + m[2] * k] as const;
    expect(scaleFactors(m, along(10), along(20), false).map((f) => tidy(f, 9))).toEqual([2, 1]);
    const [u] = scaleFactors(m, along(10), along(25), true);
    expect(u).toBeCloseTo(2.5, 9);
  });
});

describe("gizmo helpers", () => {
  it("turns the short way", () => {
    expect(turn([0, 0], [1, 0], [-1, -0.0001])).toBeCloseTo(-179.99, 1);
    expect(turn([0, 0], [-1, 0.0001], [-1, -0.0001])).toBeCloseTo(0.0115, 3);
  });
  it("tidies to the given places, never -0", () => {
    expect(tidy(1.23456, 2)).toBe(1.23);
    expect(Object.is(tidy(-0.001, 2), 0)).toBe(true);
  });
  it("picks the nearest bone in reach, the later on a tie", () => {
    const bones = [
      { name: "a", x0: 0, y0: 0, x1: 100, y1: 0 },
      { name: "b", x0: 0, y0: 4, x1: 100, y1: 4 },
      { name: "c", x0: 0, y0: 4, x1: 100, y1: 4 },
    ];
    expect(pickBone(bones, 50, 1)).toBe("a");
    expect(pickBone(bones, 50, 3)).toBe("c");
    expect(pickBone(bones, 50, 30)).toBeNull();
    expect(pickBone(bones, 108, 0, 6)).toBeNull();
  });
  it("prefers a bone's origin to another bone's segment: an IK target on a shin's tip", () => {
    const bones = [
      { name: "target", x0: 100, y0: 100, x1: 100, y1: 100 },
      { name: "shin", x0: 40, y0: 60, x1: 101, y1: 101 },
    ];
    expect(pickBone(bones, 103, 102)).toBe("target");
    expect(pickBone(bones, 70, 80)).toBe("shin");
  });
  it("keeps the selected bone when another shares its origin (hips and pelvis)", () => {
    const bones = [{ name: "hips", x0: 0, y0: 0, x1: 0, y1: -30 }, { name: "pelvis", x0: 0, y0: 0, x1: 0, y1: 0 }];
    expect(pickBone(bones, 1, 1)).toBe("pelvis");
    expect(pickBone(bones, 1, 1, 6, "hips")).toBe("hips");
    expect(pickBone(bones, 50, 50, 6, "hips")).toBeNull();
  });
  it.each([
    ["an untouched axis stays absent", { scaleX: 2.2, scaleY: 1 }, { scaleX: 2.2, scaleY: undefined }],
    ["an untouched axis keeps the value written", { x: 5, y: 3 }, { x: 5, y: 3 }],
    ["out and back restores absence", { scaleX: 1, scaleY: 1 }, { scaleX: undefined, scaleY: undefined }],
  ])("as written: %s", (_, patch, want) => {
    const began = { x: 0, y: 3, scaleX: 1, scaleY: 1 }, written = { x: undefined, y: 3, scaleX: undefined, scaleY: undefined };
    expect(asWritten(patch, began, written)).toEqual(want);
  });
  it("a degenerate parent moves nothing", () => {
    expect(moveDelta([0, 0, 0, 0, 0, 0], 5, 5)).toEqual([0, 0]);
  });
});

describe("posing the document", () => {
  it("frames the stickman, and a skeleton with no bones has no box", () => {
    const { doc, images } = stickman();
    const box = bounds(poseSetup(doc, images, null))!;
    expect(box.maxX - box.minX).toBeGreaterThan(50);
    expect(box.maxY - box.minY).toBeGreaterThan(200);
    expect(bounds(poseSetup(readSkeleton("{}").skeleton, images, null))).toBeNull();
  });
});

describe("picking files", () => {
  it("finds the skeleton, its atlas and the images, and ignores the rest", () => {
    const f = (name: string) => ({ name });
    const p = pickFiles([f("a.png"), f("raptor.bb.json"), f("hero.json"), f("hero.atlas.txt"), f("Hero.bb.json"), f("notes.md"), f("other.json")]);
    expect(p.skeleton?.name).toBe("hero.json");
    expect(p.atlas?.name).toBe("hero.atlas.txt");
    // Its own sidecar (named after it, any case); another skeleton's is ignored.
    expect(p.sidecar?.name).toBe("Hero.bb.json");
    expect([...p.images.keys()]).toEqual(["a.png"]);
    expect(p.ignored.map((x) => x.name)).toEqual(["notes.md", "other.json", "raptor.bb.json"]);
    expect(pickFiles([f("hero.bb.json")]).sidecar).toBeNull();
  });
  it("names the document after its file", () => {
    expect(baseName("/x/y/Stickman_IK.json")).toBe("Stickman_IK");
  });
});
