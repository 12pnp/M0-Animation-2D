import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type AssetId, type ItemId } from "@/core/doc/ids";
import { fileLengthsOf, outlineOf, sequenceDisplayOf } from "@/core/boneburst/importAttachments";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { withKnotMoved } from "@/core/doc/constraints";
import type { SymbolItem } from "@/core/doc/types";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";

beforeEach(() => reseed());

const pathAtt = { type: "path", vertexCount: 6, vertices: [0, 0, 10, 0, 20, 5, 30, 5, 40, 0, 50, 0], lengths: [41.3, 41.3], color: "ff8800ff" };

describe("which boxes, points and paths the model holds", () => {
  it.each([
    { name: "a box, y flipped, its colour kept", att: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 10, 0, 0, 10], color: "00ff00ff" }, want: { kind: "box", box: { points: [0, 0, 10, 0, 0, -10] }, color: "00ff00ff" } },
    { name: "a point at its bone's origin", att: { type: "point", rotation: 0 }, want: { kind: "point" } },
    { name: "a point with an offset, y and the turn flipped into the node's space", att: { type: "point", x: 4, y: 2, rotation: 30 }, want: { kind: "point", point: { x: 4, y: -2, rotation: -30 } } },
    { name: "a point with a rotation that is not a number", att: { type: "point", rotation: "up" }, want: null },
    { name: "a weighted box, without the bones to read it against", att: { type: "boundingbox", vertexCount: 3, vertices: [1, 0, 0, 0, 1, 1, 0, 10, 0, 1, 1, 0, 0, 10, 1] }, want: null },
    { name: "a field it does not hold", att: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 1, 0, 0, 1], sequence: {} }, want: null },
  ])("$name", ({ att, want }) => {
    expect(outlineOf(att)).toEqual(want);
  });

  it("a weighted box or path: positions where the setup pose shows them, weights and the file's offsets kept", () => {
    // Bone "b" at (100, 0), turned 90° (y down: its x axis along +y).
    const b = { id: "nb" as never, setup: { a: 0, b: 1, c: -1, d: 0, tx: 100, ty: 0 } };
    const bones = { node: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, bone: (n: string) => (n === "b" ? b : undefined) };
    const box = outlineOf({ type: "boundingbox", vertexCount: 3, vertices: [1, "b", 0, 0, 1, 1, "b", 10, 0, 1, 2, "b", 0, 10, 0.5, "b", 0, 10, 0.5] }, bones);
    expect(box).toMatchObject({ kind: "box", box: { weights: [[["nb", 1]], [["nb", 1]], [["nb", 0.5], ["nb", 0.5]]], boneOffsets: [[[0, 0]], [[10, 0]], [[0, -10], [0, -10]]] } });
    const pts = (box as { box: { points: number[] } }).box.points;
    [100, 0, 100, 10, 110, 0].forEach((v, i) => expect(pts[i]).toBeCloseTo(v, 9));
    expect(outlineOf({ type: "boundingbox", vertexCount: 3, vertices: [1, "nope", 0, 0, 1, 1, "b", 10, 0, 1, 1, "b", 0, 10, 1] }, bones)).toBeNull();
    const path = outlineOf({ type: "path", vertexCount: 6, vertices: [1, "b", 0, 0, 1, 1, "b", 1, 0, 1, 1, "b", 2, 0, 1, 1, "b", 3, 0, 1, 1, "b", 4, 0, 1, 1, "b", 5, 0, 1], lengths: [5] }, bones);
    expect(path).toMatchObject({ kind: "path", path: { weights: Array(6).fill([["nb", 1]]) } });
  });

  it("a path keeps the file's lengths while its shape is the one they were measured on", () => {
    const out = outlineOf(pathAtt)!;
    expect(out.kind).toBe("path");
    const shape = (out as { path: Parameters<typeof fileLengthsOf>[0] }).path;
    expect(fileLengthsOf(shape)).toEqual([41.3, 41.3]);
    expect(fileLengthsOf(withKnotMoved(shape, 1, 2, 0))).toBeNull();
    expect(fileLengthsOf({ ...shape, closed: true })).toBeNull();
  });
});

describe("which sequences the model holds", () => {
  const items = new Map([1, 2, 3].map((n) => [`fx_0${n}`, { id: `i${n}` as ItemId, width: 20, height: 10 }]));
  const named = (n: string) => items.get(n);
  it("its images by name, its offset the transform point", () => {
    expect(sequenceDisplayOf({ path: "fx_", x: 3, y: -2, sequence: { count: 3, start: 1, digits: 2, setup: 1 } }, "fx", named)).toEqual({
      itemId: "i2", pivot: { x: 7, y: 3 }, sequence: { items: ["i1", "i2", "i3"], setup: 1 }, key: "fx",
    });
  });
  it("turned or scaled, Spine's turn kept and the pivot the unturned centre's", () => {
    expect(sequenceDisplayOf({ path: "fx_", x: 3, y: -2, rotation: 10, scaleX: 1, scaleY: -1, sequence: { count: 3, start: 1, digits: 2 } }, "fx", named)).toMatchObject({
      pivot: { x: 7, y: 3 }, region: { rotation: 10, scaleY: -1 },
    });
  });
  it.each([
    { name: "a rotation that is not a number", att: { path: "fx_", rotation: "10", sequence: { count: 3, start: 1, digits: 2 } } },
    { name: "an image the library lacks", att: { path: "fx_", sequence: { count: 4, start: 1, digits: 2 } } },
    { name: "a size not the image's", att: { path: "fx_", width: 40, sequence: { count: 3, start: 1, digits: 2 } } },
  ])("carried: $name", ({ att }) => {
    expect(sequenceDisplayOf(att, "fx", named)).toBeNull();
  });
});

describe("an opened file's", () => {
  const images = new Map([
    ["img", { name: "img", width: 30, height: 30, assetId: "s0" as AssetId }],
    ...[1, 2, 3].map((n) => [`fx_0${n}`, { name: `fx_0${n}`, width: 20, height: 10, assetId: `s${n}` as AssetId }] as const),
  ]);
  const file = {
    skeleton: { spine: "4.3.13", fps: 30 },
    bones: [{ name: "root" }, { name: "arm", parent: "root", rotation: 30 }],
    slots: [{ name: "hit", bone: "arm", attachment: "hitbox" }, { name: "rail", bone: "root", attachment: "rail" }, { name: "tip", bone: "arm" }, { name: "fire", bone: "arm", attachment: "fx" }],
    skins: [{ name: "default", attachments: {
      hit: { hitbox: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 10, 0, 0, 10], color: "00ff00ff" } },
      rail: { rail: pathAtt },
      tip: { tip: { type: "point" } },
      fire: { fx: { path: "fx_", x: 3, y: -2, sequence: { count: 3, start: 1, digits: 2 } } },
    } }],
    animations: { go: {
      slots: { tip: { attachment: [{ time: 0.1, name: "tip" }] } },
      attachments: { default: { fire: { fx: { sequence: [{ mode: "loop", delay: 0.1 }, { time: 0.5, mode: "once", index: 1, delay: 0.2 }] } } } },
      bones: { arm: { rotate: [{ value: 0 }, { time: 1, value: 40 }] } },
    } },
  };

  it("boxes, points, paths and sequences become the document's, and are written back the same", () => {
    const project = importBoneBurst(file as never, "a", images).project;
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const byName = (n: string) => Object.values(sym.nodes).find((x) => x.name === n && x.kind !== "bone")!;
    expect(byName("hit")).toMatchObject({ kind: "box", key: "hitbox", attachmentColor: "00ff00ff" });
    expect(byName("rail")).toMatchObject({ kind: "path", key: "rail" });
    expect(byName("tip")).toMatchObject({ kind: "point", key: "tip", setupDisplay: -1 });
    expect(byName("fire").sequence?.items).toHaveLength(3);
    const anim = sym.animations[0]!;
    expect(anim.sequences?.[byName("fire").id]).toEqual([{ frame: 0, mode: "loop", index: 0, delay: 3 }, { frame: 15, mode: "once", index: 1, delay: 6 }]);
    expect(anim.spine?.attachments).toBeUndefined();
    const out = exportBoneBurst(project);
    expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const atts = out.skeleton.skins![0]!.attachments!;
    expect(atts.hit).toEqual(file.skins[0]!.attachments.hit);
    expect(atts.rail).toEqual(file.skins[0]!.attachments.rail);
    expect(atts.tip).toEqual(file.skins[0]!.attachments.tip);
    expect(atts.fire!.fx).toMatchObject({ path: "fx_", x: 3, y: -2, sequence: { count: 3, start: 1, digits: 2 } });
    const tip = out.skeleton.slots!.find((sl) => sl.name === "tip")!;
    expect(tip.attachment).toBeUndefined();
  });
});

describe("spine-unity's samples", () => {
  it.skipIf(!sampleRigs().length)("their default-skin boxes and paths become the document's", () => {
    let held = 0;
    for (const rig of sampleRigs()) {
      const project = importBoneBurst(JSON.parse(rig.json), rig.name, imagesOf(rig.atlas)).project;
      for (const n of Object.values((project.items[project.rootSymbolId] as SymbolItem).nodes)) if (n.kind === "box" || n.kind === "path" || n.kind === "point") held++;
    }
    console.log("sample boxes, points and paths held", held);
    expect(held).toBeGreaterThan(0);
  });
});
