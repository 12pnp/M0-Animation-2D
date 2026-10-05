import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { evaluateSymbol } from "@/core/doc/pose";
import { atlasText } from "@/core/spine/atlas";
import { reseed, type AssetId } from "@/core/doc/ids";
import { importSpine } from "@/core/spine/importSpine";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { meshFromSpine } from "@/core/spine/importMesh";
import { displaysOf } from "@/core/doc/displays";
import { withPoint, withPointMoved, withPositions, withWeights } from "@/core/mesh/meshEdit";
import { meshPositions, spineVertices } from "@/core/mesh/meshPose";
import { mat } from "@/core/math/Matrix2D";
import type { MeshData, SymbolItem } from "@/core/doc/types";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";
import { stageAgainstRuntime } from "./fixtures/runtimeCheck";

beforeEach(() => reseed());

const images = new Map([["img", { name: "img", width: 100, height: 50, assetId: "s0" as AssetId }]]);

/** One rotated bone, a slot on it, and a four-point mesh whose vertices are
 *  its UVs scaled by half and moved: where they are is not where its UVs put them. */
function meshFile(extra: Record<string, unknown> = {}, deform?: unknown) {
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const vertices = [-25, 12.5, 25, 12.5, 25, -12.5, -25, -12.5].map((v, i) => v * 0.5 + (i % 2 ? 4 : 10));
  return {
    skeleton: { spine: "4.3.13", fps: 30 },
    bones: [{ name: "root" }, { name: "arm", parent: "root", rotation: 30, x: 20 }],
    slots: [{ name: "skin", bone: "arm", attachment: "body" }],
    skins: [{ name: "default", attachments: { skin: { body: { type: "mesh", path: "img", uvs, triangles: [0, 1, 2, 0, 2, 3], vertices, hull: 4, width: 100, height: 50, ...extra } } } }],
    animations: { wave: { ...(deform ? { attachments: { default: { skin: { body: { deform } } } } } : {}), bones: { arm: { rotate: [{ value: 0 }, { time: 1, value: 40 }] } } } },
  };
}

function opened(file: unknown) {
  const project = importSpine(file as never, "m", images).project;
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const slot = Object.values(sym.nodes).find((n) => n.name === "skin")!;
  return { project, sym, slot };
}

describe("an opened mesh becomes the document's", () => {
  it("its UVs are the points, its vertices the positions; written back the same, under its own key", () => {
    const file = meshFile();
    const { project, slot } = opened(file);
    expect(slot.attachment).toBeUndefined();
    expect(slot.key).toBe("body");
    expect(slot.mesh!.points).toEqual([0, 0, 100, 0, 100, 50, 0, 50]);
    expect(slot.mesh!.vertices).toBeDefined();
    const out = exportSpine(project).skeleton.skins![0]!.attachments!.skin!.body as unknown as Record<string, number[]>;
    out.vertices!.forEach((v, i) => expect(v).toBeCloseTo(file.skins[0]!.attachments.skin.body.vertices[i]!, 4));
    expect(out.uvs).toEqual(file.skins[0]!.attachments.skin.body.uvs);
  });

  it("its deform timeline becomes keys, and the stage plays it as spine-core plays the export", () => {
    const deform = [{ vertices: [0, 0, 5, 3] }, { time: 0.5, offset: 4, vertices: [2, -2], curve: "stepped" }, { time: 1 }];
    const { project, sym, slot } = opened(meshFile({}, deform));
    const keys = sym.animations[0]!.deforms?.[slot.id];
    expect(keys?.map((k) => k.frame)).toEqual([0, 15, 30]);
    expect(keys![0]!.offsets).toEqual([0, 0, 5, -3, 0, 0, 0, 0]);
    expect(keys![1]!.tween).toEqual({ kind: "none" });
    expect(sym.animations[0]!.spine?.attachments).toBeUndefined();
    stageAgainstRuntime(project, sym, "arm");
  });

  it("a field the model does not hold leaves it carried; its colour is held as the tint", () => {
    const { slot } = opened(meshFile({ blend: 3 }));
    expect(slot.attachment?.name).toBe("body");
    expect(slot.mesh).toBeUndefined();
    const tinted = opened(meshFile({ color: "ff0000ff" })).slot;
    expect(tinted.mesh).toBeDefined();
    expect(tinted.tint).toBe("ff0000ff");
  });

  it("a weighted point keeps each bone's offset as the file has it, though they disagree; written back the same", () => {
    const ctx = { width: 10, height: 10, pivot: { x: 5, y: 5 }, node: mat(), bone: (n: string) => ({ id: n as never, setup: mat() }), setupOf: () => mat() };
    const att = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [1, "a", 0, 0, 1, 1, "a", 10, 0, 1, 2, "a", 10, 10, 0.5, "b", 12, 10, 0.5] };
    const mesh = meshFromSpine(att, ctx)!;
    expect(mesh.boneOffsets).toEqual([[[0, 0]], [[10, 0]], [[10, -10], [12, -10]]]);
    // The position is where the setup pose shows the point: between the two.
    expect(meshPositions(mesh).slice(4)).toEqual([16, -5]);
    const back = spineVertices(mesh, ctx.pivot, { now: () => mat(), setup: () => mat(), node: mat() }, (id) => id as string);
    expect(back).toEqual(att.vertices);
  });

  it("a weighted mesh from a file: the stage plays it as spine-core plays the export", () => {
    const file = meshFile();
    const body = file.skins[0]!.attachments.skin.body as Record<string, unknown>;
    // Two bones, offsets that do not meet at one point.
    file.bones.push({ name: "tip", parent: "arm", x: 30 } as never);
    body.vertices = [2, 1, -10, 6, 0.6, 2, -12, 4, 0.4, 1, 1, 10, 6, 1, 1, 2, 10, -6, 1, 2, 1, -10, -6, 0.5, 2, -40, -5, 0.5];
    const { project, sym, slot } = opened(file);
    expect(slot.mesh?.boneOffsets).toBeDefined();
    stageAgainstRuntime(project, sym, "arm");
    const out = exportSpine(project).skeleton.skins![0]!.attachments!.skin!.body as unknown as Record<string, Array<number | string>>;
    expect(out.vertices).toEqual(body.vertices);
  });

  it("the editor's own pose of such a mesh (`meshWorld`) puts every vertex where spine-core does", () => {
    const file = meshFile();
    const body = file.skins[0]!.attachments.skin.body as Record<string, unknown>;
    file.bones.push({ name: "tip", parent: "arm", x: 30, rotation: 20 } as never);
    body.vertices = [2, 1, -10, 6, 0.6, 2, -12, 4, 0.4, 1, 1, 10, 6, 1, 1, 2, 10, -6, 1, 2, 1, -10, -6, 0.5, 2, -40, -5, 0.5];
    (file.animations.wave as Record<string, unknown>).bones = { arm: { rotate: [{ value: 0 }, { time: 1, value: 40 }] }, tip: { rotate: [{ value: 0 }, { time: 1, value: -60 }] } };
    const { project, sym, slot } = opened(file);
    const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText([{ name: "p", imagePath: "p.png", width: 128, height: 64, scale: 1, regions: [{ name: "img", x: 0, y: 0, width: 100, height: 50, offsetX: 0, offsetY: 0, originalWidth: 100, originalHeight: 50, rotated: false }] }])))).readSkeletonData(JSON.parse(spineJson(exportSpine(project).skeleton))));
    const anim = sym.animations[0]!;
    // The editor's own path: the symbol without its carry is not posed by the runtime.
    const own = { ...sym, spine: undefined };
    for (const f of [0, 10, 25]) {
      sk.setupPose();
      sk.data.findAnimation("wave")!.apply(sk, 0, f / project.frameRate, false, null, 1, MixFrom.setup, false, false, false);
      sk.updateWorldTransform(Physics.reset);
      const slotRt = sk.findSlot("skin")!;
      const att = slotRt.appliedPose.getAttachment() as MeshAttachment;
      const want = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(sk, slotRt, 0, att.worldVerticesLength, want, 0, 2);
      const got = evaluateSymbol(own, anim, f, "animate").byNode.get(slot.id)!.spine!.vertices;
      got.forEach((v, i) => expect(Math.abs(v - (i % 2 ? -want[i]! : want[i]!)), `frame ${f} value ${i}`).toBeLessThan(1e-3));
    }
  });
});

describe("editing a mesh whose positions are not its texture coordinates", () => {
  const m: MeshData = {
    width: 10, height: 10, points: [0, 0, 10, 0, 10, 10, 0, 10], triangles: [0, 1, 2, 0, 2, 3], hull: 4,
    vertices: [0, 0, 20, 0, 20, 20, 0, 20],
  };
  it("a point moved moves its position, not its texture coordinate", () => {
    const out = withPointMoved(m, 2, 25, 25);
    expect(out.points).toEqual(m.points);
    expect(meshPositions(out).slice(4, 6)).toEqual([25, 25]);
  });
  it("a moved point drops its own bone offsets; the others keep theirs; new weights drop them all", () => {
    const w: MeshData = { ...m, weights: [[["a" as never, 1]], [["a" as never, 1]], [["a" as never, 1]], [["a" as never, 1]]], boneOffsets: [[[1, 1]], [[2, 2]], [[3, 3]], [[4, 4]]] };
    const moved = withPositions(w, [0, 0, 20, 0, 25, 25, 0, 20], [2]);
    expect(moved.boneOffsets).toEqual([[[1, 1]], [[2, 2]], [], [[4, 4]]]);
    expect(moved.points).toEqual(m.points);
    expect(withWeights(w, [[["b" as never, 1]], [], [], []]).boneOffsets).toBeUndefined();
  });

  it("a point added takes the texture coordinate its triangle gives it", () => {
    const out = withPoint(m, 10, 10)!;
    expect(out.vertices!.slice(-2)).toEqual([10, 10]);
    expect(out.points.slice(-2).map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 5]);
  });
});

describe("spine-unity's samples", () => {
  it.skipIf(!sampleRigs().length)("some of their meshes become editable, the rest stay carried", () => {
    let editable = 0, carried = 0;
    for (const rig of sampleRigs()) {
      const project = importSpine(JSON.parse(rig.json), rig.name, imagesOf(rig.atlas)).project;
      for (const node of Object.values((project.items[project.rootSymbolId] as SymbolItem).nodes)) {
        for (const d of displaysOf(node)) {
          if (d.mesh) editable++;
          else if ((d.attachment?.data as { type?: string } | undefined)?.type === "mesh") carried++;
        }
      }
    }
    console.log("sample meshes editable", editable, "carried", carried);
    expect(editable).toBeGreaterThan(0);
  });
});
