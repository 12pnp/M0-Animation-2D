import { describe, expect, it } from "vitest";
import { AgentRefused, callTool } from "@/agent/host";
import { findAttachment } from "@/edit/attachments";
import { History } from "@/edit/history";
import { regionCorners } from "@/edit/mesh";
import { decodeBinds } from "@/edit/meshLayout";
import { meshPoints, OPAQUE, simplify, traceOutline } from "@/edit/trace";
import { type AtlasImages, atlasImages, regionAlpha } from "@/engine/regions";
import type { Attachment, Skeleton } from "@/model/skeleton";
import { poserCache } from "@/ui/agent/context";
import { importPsd } from "@/ui/psdImport";
import { testContext } from "./fixtures/agentContext";
import { figureLayers, writeFigure } from "./fixtures/psd";

/** Meshes (E5 step 8): the outline traced from alpha, and make_mesh, bind_mesh, link_mesh. */

type Ctx = ReturnType<typeof testContext>;
const call = (c: Ctx, name: string, args: unknown) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };

/** An alpha image from a predicate on pixel centres. */
function mask(w: number, h: number, on: (x: number, y: number) => boolean): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x + 0.5, y + 0.5)) a[y * w + x] = 255;
  return a;
}

function inside(xy: readonly number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, n = xy.length / 2, j = n - 1; i < n; j = i++) {
    const xi = xy[i * 2]!, yi = xy[i * 2 + 1]!, xj = xy[j * 2]!, yj = xy[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const area = (xy: readonly number[]) => { let s = 0; for (let i = 0, n = xy.length / 2; i < n; i++) { const j = (i + 1) % n; s += xy[i * 2]! * xy[j * 2 + 1]! - xy[j * 2]! * xy[i * 2 + 1]!; } return s / 2; };

/** Every opaque pixel's centre is inside the outline; `out` points (pixel centres) are not. */
function encloses(xy: readonly number[], alpha: Uint8Array, w: number, h: number) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x]! >= OPAQUE) expect(inside(xy, x + 0.5, y + 0.5), `pixel ${x},${y}`).toBe(true);
}

describe("tracing an outline (E5 step 8)", () => {
  it("a disc: every opaque pixel inside, a pixel out, its area near the disc's", () => {
    const a = mask(40, 40, (x, y) => Math.hypot(x - 20, y - 20) <= 15);
    const o = traceOutline(a, 40, 40)!;
    encloses(o, a, 40, 40);
    // Screen y runs down, so counter-clockwise on screen is a negative area in y-up terms.
    expect(area(o)).toBeLessThan(0);
    expect(Math.abs(area(o))).toBeGreaterThan(Math.PI * 15 * 15);
    expect(Math.abs(area(o))).toBeLessThan(Math.PI * 17 * 17);
    const s = simplify(o, 1);
    encloses(s, a, 40, 40);
    expect(s.length).toBeLessThan(o.length);
  });

  it("a ring: the outer edge, the hole inside the outline (a mesh has one outline)", () => {
    const ring = mask(40, 40, (x, y) => { const d = Math.hypot(x - 20, y - 20); return d <= 16 && d >= 8; });
    const o = traceOutline(ring, 40, 40)!;
    encloses(o, ring, 40, 40);
    expect(inside(o, 20, 20)).toBe(true);
  });

  it("an L: the notch stays outside; of two pieces, the larger; nothing opaque gives null", () => {
    const L = mask(30, 30, (x, y) => (x < 10 && y < 28) || (y >= 18 && y < 28 && x < 28));
    const o = traceOutline(L, 30, 30)!;
    encloses(o, L, 30, 30);
    expect(inside(o, 20, 8)).toBe(false);
    const two = mask(30, 30, (x, y) => (x < 6 && y < 6) || (x > 12 && y > 12));
    const t = traceOutline(two, 30, 30)!;
    expect(inside(t, 20, 20)).toBe(true);
    expect(inside(t, 3, 3)).toBe(false);
    expect(traceOutline(new Uint8Array(100), 10, 10)).toBeNull();
  });

  it("meshPoints: outline edges no longer than the spacing, inner points on a grid, the rectangle without pixels", () => {
    const a = mask(60, 60, (x, y) => Math.hypot(x - 30, y - 30) <= 25);
    const p = meshPoints(a, 60, 60, 10);
    expect(p.traced).toBe(true);
    for (let i = 0; i < p.hull; i++) {
      const j = (i + 1) % p.hull;
      expect(Math.hypot(p.xy[j * 2]! - p.xy[i * 2]!, p.xy[j * 2 + 1]! - p.xy[i * 2 + 1]!)).toBeLessThanOrEqual(10 + 1e-9);
    }
    expect(p.xy.length / 2 - p.hull).toBeGreaterThan(5);
    const r = meshPoints(null, 40, 20, 10);
    expect(r.traced).toBe(false);
    expect(r.xy.slice(0, 8)).toEqual([0, 0, 0, 10, 0, 20, 10, 20]);
  });
});

function open(): { c: Ctx; images: AtlasImages; pages: ReturnType<typeof importPsd>["pages"] } {
  const psd = importPsd(writeFigure(figureLayers()), "figure.psd", "h"), images = atlasImages(psd.atlas);
  return { c: testContext(new History(psd.skeleton), images, [], psd.pages), images, pages: psd.pages };
}
const JOINTS = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};

/** Where region `a` draws image point (u, v), v down: as its four corners place the image. */
function regionAt(a: Attachment, u: number, v: number): [number, number] {
  const { xy } = regionCorners(a); // bottom-left, bottom-right, top-right, top-left
  return [xy[0]! + u * (xy[2]! - xy[0]!) + (1 - v) * (xy[6]! - xy[0]!), xy[1]! + u * (xy[3]! - xy[1]!) + (1 - v) * (xy[7]! - xy[1]!)];
}

describe("make_mesh, bind_mesh and link_mesh (E5 step 8)", () => {
  it("make_mesh: the mesh puts each point where the region drew it, its outline around every opaque pixel, in one step", async () => {
    const { c, images, pages } = open();
    const region = findAttachment(c.history!.doc, { skin: "default", slot: "head", key: "head" })!;
    const out = await call(c, "make_mesh", { images: ["head", "body"], spacing: 12 });
    expect(c.history!.undoLabel).toBe("AI: make_mesh head, body");
    expect(out.made.map((m: { image: string; traced: boolean }) => [m.image, m.traced])).toEqual([["head", true], ["body", true]]);
    const mesh = findAttachment(c.history!.doc, { skin: "default", slot: "head", key: "head" })!;
    expect(mesh.type).toBe("mesh");
    for (let i = 0; i < mesh.uvs!.length; i += 2) {
      const [x, y] = regionAt(region, mesh.uvs![i]!, mesh.uvs![i + 1]!);
      expect(Math.hypot(mesh.vertices![i]! - x, mesh.vertices![i + 1]! - y)).toBeLessThan(0.01);
    }
    // The head is an ellipse: its outline leaves the image's corners out but every opaque pixel in.
    const r = images.regions.find((x) => x.name === "head")!, alpha = regionAlpha(r, pages.find((p) => p.name === r.page.name)!)!;
    const hullUv = mesh.uvs!.slice(0, mesh.hull! * 2).map((v, i) => v * (i % 2 ? alpha.height : alpha.width));
    encloses(hullUv, alpha.alpha, alpha.width, alpha.height);
    expect(inside(hullUv, 1, 1)).toBe(false);
    // The runtime draws it: every triangle's corners are vertices.
    const p = poserCache()(c.history!.doc, images).pose(null, null, 0), i = p.rig.data.slots.findIndex((s) => s.name === "head");
    expect(p.rig.attachmentOf(i)).toMatchObject({ kind: "mesh" });
    expect(Math.max(...mesh.triangles!)).toBe(mesh.uvs!.length / 2 - 1);
  });

  it("make_mesh without the page's pixels follows the rectangle and says so; refuses an image no slot shows", async () => {
    const psd = importPsd(writeFigure(figureLayers()), "figure.psd", "h");
    const c = testContext(new History(psd.skeleton), atlasImages(psd.atlas));
    const out = await call(c, "make_mesh", { images: ["body"] });
    expect(out.made[0]).toMatchObject({ image: "body", traced: false });
    expect(out.notes[0]).toMatch(/follows its rectangle/);
    expect(await refused(call(c, "make_mesh", { images: ["sketch"] }))).toMatch(/no atlas image "sketch"|No slot shows/);
  });

  it("bind_mesh: the mesh's points follow the bones, weighted by distance", async () => {
    const { c } = open();
    await call(c, "auto_rig", { joints: JOINTS, view: "front" });
    await call(c, "make_mesh", { images: ["arm L"] });
    const out = await call(c, "bind_mesh", { image: "arm L", bones: ["upper_arm_left", "forearm_left"] });
    expect(out.bones.sort()).toEqual(["forearm_left", "upper_arm_left"]);
    const doc = c.history!.doc, slot = doc.slots!.find((s) => s.attachment === "arm L")!.name;
    const mesh = findAttachment(doc, { skin: "default", slot, key: "arm L" })!;
    const binds = decodeBinds(mesh.vertices!);
    expect(binds.length).toBe(mesh.uvs!.length / 2);
    // Points near the hand lean on the forearm, near the shoulder on the upper arm.
    const fore = doc.bones!.findIndex((b) => b.name === "forearm_left");
    const weightOn = (i: number) => binds[i]!.find((b) => b.bone === fore)?.w ?? 0;
    const order = mesh.uvs!.map((_, i) => i).filter((i) => i % 2 === 0).sort((a, b) => mesh.uvs![a + 1]! - mesh.uvs![b + 1]!);
    expect(weightOn(order[0]! / 2)).toBeLessThan(0.5);
    expect(weightOn(order.at(-1)! / 2)).toBeGreaterThan(0.5);
    expect(await refused(call(c, "bind_mesh", { image: "head", bones: ["head_bone"] }))).toMatch(/make_mesh first/);
  });

  it("link_mesh: another image in the slot draws the mesh's shape; unlinked it is a region where the mesh was", async () => {
    const { c, images } = open();
    // The head slot gets a second image, then its own image becomes a mesh.
    await call(c, "add_skin", { name: "x" });
    c.show({ ...c.view(), skin: null });
    const doc0 = c.history!.doc;
    const own = findAttachment(doc0, { skin: "default", slot: "head", key: "head" })!;
    c.history!.apply("second image", (s: Skeleton) => {
      const entries = s.skins![0]!.attachments!.find((ss) => ss.slot === "head")!.entries;
      const more = { ...entries[0]!, key: "face", attachment: { ...own, name: "body", extra: new Map() } };
      return { ...s, skins: s.skins!.map((k, i) => (i ? k : { ...k, attachments: k.attachments!.map((ss) => (ss.slot === "head" ? { ...ss, entries: [...ss.entries, more] } : ss)) })) };
    });
    await call(c, "make_mesh", { images: ["head"] });
    const out = await call(c, "link_mesh", { layer: "head", image: "body", deform: false });
    expect(out).toEqual({ layer: "head", image: "body", linked: true, mesh: "head", deform: false });
    const linked = findAttachment(c.history!.doc, { skin: "default", slot: "head", key: "face" })!;
    expect(linked).toMatchObject({ type: "linkedmesh", source: "head", timelines: false, name: "body" });
    // The runtime builds it on the mesh's geometry: as many points, the body's picture.
    const p = poserCache()(c.history!.doc, images).pose(null, null, 0), i = p.rig.data.slots.findIndex((s) => s.name === "head");
    const face = p.rig.lookup(i, "face")!, head = p.rig.lookup(i, "head")!;
    expect(face).toMatchObject({ kind: "mesh" });
    expect((face as { vertexCount: number }).vertexCount).toBe((head as { vertexCount: number }).vertexCount);
    expect(p.rig.frameOf(i, face).region?.name).toBe("body");

    await call(c, "link_mesh", { layer: "head", image: "body", linked: false });
    const back = findAttachment(c.history!.doc, { skin: "default", slot: "head", key: "face" })!;
    expect(back.type).toBeUndefined();
    expect([back.x, back.y, back.width, back.height]).toEqual([own.x, own.y, 100, 150]);
    expect(back.scaleX).toBeCloseTo(90 / 100, 3);
    expect(back.scaleY).toBeCloseTo(100 / 150, 3);
    expect(await refused(call(c, "link_mesh", { layer: "body", image: "body" }))).toMatch(/no mesh for "body"/);
  });

  it("set_skin_image over a mesh: the skin's image is a linked mesh of it", async () => {
    const { c } = open();
    await call(c, "make_mesh", { images: ["head"] });
    await call(c, "add_skin", { name: "y" });
    await call(c, "set_skin_image", { skin: "y", layer: "head", image: "body" });
    expect(findAttachment(c.history!.doc, { skin: "y", slot: "head", key: "head" })).toMatchObject({ type: "linkedmesh", source: "head", name: "body" });
  });
});
