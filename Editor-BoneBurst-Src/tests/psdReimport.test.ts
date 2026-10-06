import { describe, expect, it } from "vitest";
import type { Layer } from "ag-psd";
import { addAnimation } from "@/edit/animations";
import { findAttachment, updateAttachment } from "@/edit/attachments";
import { keyBone } from "@/edit/boneKeys";
import { addBone, updateBone } from "@/edit/bones";
import { type BoneWorlds, toLocal } from "@/edit/meshLayout";
import { regionToMesh } from "@/edit/mesh";
import { updateSlot } from "@/edit/slots";
import { autoWeights, bindMesh } from "@/edit/weights";
import { atlasImages } from "@/engine/regions";
import { writeAtlas } from "@/io/atlas";
import type { PngImage } from "@/io/png";
import { readPsdLayers } from "@/io/psd";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Atlas } from "@/model/atlas";
import type { Skeleton } from "@/model/skeleton";
import { importPsd } from "@/ui/psdImport";
import { cutLayer, meshPicture, planReimport, rebuildAtlas, ReimportRefused } from "@/ui/psdReimport";
import { boneMatrix, Poser } from "@/ui/stage/posed";
import { figureLayers, part, writeFigure } from "./fixtures/psd";

/** The rig's setup-pose bone matrices, as the stage poses it. */
function worlds(doc: Skeleton, atlas: Atlas): BoneWorlds {
  const p = new Poser(doc, atlasImages(atlas)).pose(null, null, 0);
  return (doc.bones ?? []).map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
}

const pagesOf = (pages: readonly { name: string; width: number; height: number; pixels: Uint8ClampedArray }[]) => new Map<string, PngImage>(pages.map((p) => [p.name, p]));

/** Re-import `psd` into the rig: the plan, the skeleton after it, and the new atlas and pages. */
function reimport(doc: Skeleton, atlas: Atlas, pages: ReadonlyMap<string, PngImage>, psd: Uint8Array) {
  const plan = planReimport(doc, worlds(doc, atlas), atlasImages(atlas).regions, readPsdLayers(psd, "figure.psd"), "figure.psd");
  return { plan, doc: plan.edit(doc), ...rebuildAtlas(plan, atlas, pages, "figure") };
}

/** A region's pixels in an atlas and its pages. */
function regionPixels(atlas: Atlas, pages: ReadonlyMap<string, PngImage>, name: string): { w: number; h: number; px: Uint8ClampedArray } {
  const r = atlasImages(atlas).regions.find((x) => x.name === name)!, pg = pages.get(r.page.name)!;
  const px = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) px.set(pg.pixels.subarray(((r.y + y) * pg.width + r.x) * 4, ((r.y + y) * pg.width + r.x + r.width) * 4), y * r.width * 4);
  return { w: r.width, h: r.height, px };
}

const region = (doc: Skeleton, slot: string, key = slot) => findAttachment(doc, { skin: "default", slot, key })!;
const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!];
/** The figure's layers with `change` made to the named one (searched inside groups too). */
function changed(edits: Record<string, (l: Layer) => Layer | Layer[] | null>, add: Layer[] = []): Uint8Array {
  const walk = (ls: Layer[]): Layer[] => ls.flatMap((l) => {
    if (l.children) return [{ ...l, children: walk(l.children) }];
    const e = edits[l.name!];
    const out = e ? e(l) : l;
    return out ? (Array.isArray(out) ? out : [out]) : [];
  });
  return writeFigure([...walk(figureLayers()), ...add]);
}

describe("re-importing a PSD into its rig (E4 step 14)", () => {
  const first = importPsd(writeFigure(figureLayers()), "figure.psd", "h");
  const firstPages = pagesOf(first.pages);

  it("the same file changes nothing: every layer found, no move, pixels as they were", () => {
    const r = reimport(first.skeleton, first.atlas, firstPages, writeFigure(figureLayers()));
    expect([...r.plan.updated].sort()).toEqual(["arm L", "arm R", "body", "head", "leg L", "leg R", "shadow"]);
    expect(r.plan.moved).toEqual([]);
    expect(r.plan.added).toEqual([]);
    expect(r.plan.kept).toEqual([]);
    expect(writeSkeleton(r.doc)).toBe(writeSkeleton(first.skeleton));
    const pages = pagesOf(r.pages);
    for (const n of r.plan.updated) expect(Buffer.from(regionPixels(r.atlas, pages, n).px).equals(Buffer.from(regionPixels(first.atlas, firstPages, n).px)), n).toBe(true);
  });

  it("moves, resizes and repaints regions; adds new layers above their neighbour; keeps what the file no longer shows", () => {
    // The rig built on: the head on its own turned bone, an animation keying it.
    let doc = addBone("neck", "root", { x: 0, y: 280, rotation: 30 })(first.skeleton);
    const head0 = region(doc, "head"), w0 = worlds(doc, first.atlas);
    const [hx, hy] = apply(w0[0]!, head0.x ?? 0, head0.y ?? 0), neck = w0[(doc.bones ?? []).findIndex((b) => b.name === "neck")]!;
    const [lx, ly] = toLocal(neck, hx, hy);
    doc = updateSlot("head", { bone: "neck" })(doc);
    doc = addAnimation("nod")(updateAttachment({ skin: "default", slot: "head", key: "head" }, { x: lx, y: ly })(doc));
    doc = keyBone("nod", "neck", ["rotate"], { x: 0, y: 280, rotation: 45, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }, 0.5)(doc);
    const animations = JSON.stringify(writeSkeleton(doc).match(/"animations"[\s\S]*$/)?.[0]);

    const psd = changed({
      head: (l) => ({ ...l, left: l.left! + 10, top: l.top! - 6, right: l.right! + 10, bottom: l.bottom! - 6 }),
      // Repainted larger, and a new belt just above it (under the arms).
      body: () => [part("body", 95, 115, 110, 160, [180, 60, 60], {}, false), part("belt", 100, 230, 100, 14, [60, 40, 20], {}, false)],
      "arm R": (l) => ({ ...l, hidden: true }),
    }, [part("hat", 115, 5, 70, 30, [20, 20, 20])]);
    const r = reimport(doc, first.atlas, firstPages, psd);
    // The body grew about its centre: repainted and resized, not moved.
    expect(r.plan.moved).toEqual(["head"]);
    expect(r.plan.updated).toContain("body");
    expect(r.plan.added).toEqual(["belt", "hat"]);
    expect(r.plan.kept.map((k) => k.name)).toEqual(["arm R"]);
    expect(r.plan.issues.some((i) => i.message.includes('"arm R" is not a visible layer'))).toBe(true);

    // The head: where the layer is now, through its turned bone; its rotation and the animation kept.
    const w1 = worlds(r.doc, r.atlas), head1 = region(r.doc, "head");
    const at = apply(w1[(r.doc.bones ?? []).findIndex((b) => b.name === "neck")]!, head1.x!, head1.y!);
    expect(at[0]).toBeCloseTo(hx + 10, 1);
    expect(at[1]).toBeCloseTo(hy + 6, 1);
    expect(r.doc.slots!.find((s) => s.name === "head")!.bone).toBe("neck");
    expect(JSON.stringify(writeSkeleton(r.doc).match(/"animations"[\s\S]*$/)?.[0])).toBe(animations);
    // The body: its new size and pixels.
    expect([region(r.doc, "body").width, region(r.doc, "body").height]).toEqual([110, 160]);
    const pages = pagesOf(r.pages), body = regionPixels(r.atlas, pages, "body");
    expect([body.w, body.h]).toEqual([110, 160]);
    expect([...body.px.subarray((80 * 110 + 55) * 4, (80 * 110 + 55) * 4 + 4)]).toEqual([180, 60, 60, 255]);
    // The hat: drawn just above the head, at its layer's place.
    const order = r.doc.slots!.map((s) => s.name);
    expect(order.indexOf("hat")).toBe(order.indexOf("head") + 1);
    expect(order.indexOf("belt")).toBe(order.indexOf("body") + 1);
    const hat = region(r.doc, "hat");
    expect([hat.x ?? 0, hat.y, hat.width, hat.height]).toEqual([0, 380, 70, 30]);
    // The hidden arm: copied bit for bit.
    expect(Buffer.from(regionPixels(r.atlas, pages, "arm R").px).equals(Buffer.from(regionPixels(first.atlas, firstPages, "arm R").px))).toBe(true);
  });

  it("a meshed, weighted layer keeps its geometry and weights; its new pixels are cut to its picture", () => {
    let doc = addBone("hip", "root", { x: -15, y: 150, rotation: -90, length: 60 })(first.skeleton);
    doc = addBone("knee", "hip", { x: 60, length: 60 })(doc);
    const ref = { skin: "default", slot: "leg L", key: "leg L" };
    doc = regionToMesh(ref)(doc);
    const w = worlds(doc, first.atlas);
    doc = bindMesh(ref, ["hip", "knee"], w)(doc);
    doc = autoWeights(ref, w)(doc);
    const mesh = JSON.stringify(region(doc, "leg L"));
    // Repainted green, and painted 4 pixels past the bottom of its old rectangle.
    const r = reimport(doc, first.atlas, firstPages, changed({ "leg L": () => part("leg L", 115, 250, 30, 134, [40, 160, 60]) }));
    expect(JSON.stringify(region(r.doc, "leg L"))).toBe(mesh);
    expect(r.plan.updated).toContain("leg L");
    expect(r.plan.issues.some((i) => /painted pixels of "leg L" lie outside its mesh/.test(i.message))).toBe(true);
    const px = regionPixels(r.atlas, pagesOf(r.pages), "leg L");
    expect([px.w, px.h]).toEqual([30, 130]);
    expect([...px.px.subarray((65 * 30 + 15) * 4, (65 * 30 + 15) * 4 + 4)]).toEqual([40, 160, 60, 255]);
  });

  it("finds the canvas where the rig has moved it: a moved root moves nothing back", () => {
    const doc = updateBone("root", { x: 50, y: -20 })(first.skeleton);
    const r = reimport(doc, first.atlas, firstPages, changed({}, [part("hat", 115, 5, 70, 30, [20, 20, 20])]));
    expect(r.plan.moved).toEqual([]);
    expect(writeSkeleton(r.plan.edit(doc)).includes('"hat"')).toBe(true);
    const hat = region(r.doc, "hat");
    // Root-local: where the first import would have put it.
    expect([hat.x ?? 0, hat.y]).toEqual([0, 380]);
    expect(region(r.doc, "head").x).toBe(region(doc, "head").x);
  });

  it("refuses a premultiplied atlas or a turned region it would copy, saying why", () => {
    const pma: Atlas = { ...first.atlas, pages: first.atlas.pages.map((p) => ({ ...p, fields: [...p.fields, { key: "pma", values: ["true"] }] })) };
    expect(() => reimport(first.skeleton, pma, firstPages, writeFigure(figureLayers()))).toThrow(ReimportRefused);
    const turned: Atlas = { ...first.atlas, pages: first.atlas.pages.map((p) => ({ ...p, regions: p.regions.map((x) => (x.name === "arm R" ? { ...x, fields: [...x.fields, { key: "rotate", values: ["true"] }] } : x)) })) };
    // Turned but replaced: fine; turned and kept (hidden in the file): refused.
    expect(() => reimport(first.skeleton, turned, firstPages, writeFigure(figureLayers()))).not.toThrow();
    expect(() => reimport(first.skeleton, turned, firstPages, changed({ "arm R": (l) => ({ ...l, hidden: true }) }))).toThrow(/turned/);
    expect(writeAtlas(first.atlas)).toBe(first.atlasText);
  });

  it("finds a mesh's picture from its vertices and UVs, and cuts a layer to a rectangle", () => {
    const uvs = [0, 0, 1, 0, 1, 1, 0, 1], world = [10, 50, 40, 50, 40, 10, 10, 10];
    expect(meshPicture(uvs, world, 30, 40)).toEqual([10, 50]);
    // Scaled against its picture: not found.
    expect(meshPicture(uvs, [10, 50, 70, 50, 70, 10, 10, 10], 30, 40)).toBeNull();
    const l = { name: "x", groups: [], left: 5, top: 5, width: 2, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), opacity: 1, blend: "normal" };
    const cut = cutLayer(l, 6, 5, 3, 2);
    expect([...cut.pixels.subarray(0, 4)]).toEqual([4, 5, 6, 255]);
    expect(cut.outside).toBe(1);
  });
});

