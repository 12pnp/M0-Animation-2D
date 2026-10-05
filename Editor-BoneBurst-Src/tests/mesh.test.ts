import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { addHullVertex, addVertex, deleteVertex, moveVertex, regionToMesh, retriangulate, triangleAt } from "@/edit/mesh";
import { signedArea, triangulate } from "@/edit/triangulate";
import { readAtlas } from "@/io/atlas";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson, writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import { attachmentType, type Skeleton } from "@/model/skeleton";
import { keyTime } from "@/model/timelines";
import { drawList, drawnVertices } from "@/engine/draw";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import { hitMesh } from "@/ui/stage/meshMode";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => {
  const atlas = readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton, atlas, images: atlasImages(readAtlas(atlas)) };
};

/** The profile holds, the file round-trips, and both runtimes pose it alike. */
function sound(s: Skeleton, atlas: string, times = [0, 0.5]): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("edited", text, atlas, times);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** Each drawn slot's world vertices and page UVs, by slot name, posed at `time` of `animation` (null: setup). */
function drawn(s: Skeleton, images: AtlasImages, skin: string | null = null, animation: string | null = null, time = 0): Map<string, { xy: number[]; uv: number[]; kind: string }> {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), images));
  rig.setSkins(skin ? [skin] : []);
  rig.setupPose();
  if (animation) { rig.apply(rig.animation(animation)!, time, false); rig.settleAttachments(); }
  rig.updateWorld("none");
  const out = new Map<string, { xy: number[]; uv: number[]; kind: string }>();
  for (const d of drawList(rig).slots) {
    const v = new Float64Array(d.vertexCount * 2);
    drawnVertices(rig, d, v);
    out.set(rig.data.slots[d.slot]!.name, { xy: [...v], uv: [...d.frame.uvs], kind: d.att.kind });
  }
  return out;
}

/** World position of page UV (u, v) through the affine map the first three non-collinear vertices give. */
function worldAt(m: { xy: number[]; uv: number[] }, u: number, v: number): [number, number] {
  const n = m.uv.length / 2;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) {
    const [u0, v0, u1, v1, u2, v2] = [m.uv[a * 2]!, m.uv[a * 2 + 1]!, m.uv[b * 2]!, m.uv[b * 2 + 1]!, m.uv[c * 2]!, m.uv[c * 2 + 1]!];
    const d = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(d) < 1e-9) continue;
    const l0 = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / d, l1 = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / d, l2 = 1 - l0 - l1;
    return [l0 * m.xy[a * 2]! + l1 * m.xy[b * 2]! + l2 * m.xy[c * 2]!, l0 * m.xy[a * 2 + 1]! + l1 * m.xy[b * 2 + 1]! + l2 * m.xy[c * 2 + 1]!];
  }
  throw new Error("flat");
}

/** Every (skin, slot, key) of an attachment of `type`. */
const refsOf = (s: Skeleton, type: string): AttachmentRef[] =>
  (s.skins ?? []).flatMap((k) => (k.attachments ?? []).flatMap((ss) => ss.entries.filter((e) => attachmentType(e.attachment) === type && e.attachment.source === undefined).map((e) => ({ skin: k.name, slot: ss.slot, key: e.key }))));

describe("triangulate", () => {
  it("ear clips concave outlines either way round, every triangle inside, the area kept", () => {
    // An L and a star, clockwise and counter-clockwise.
    const L = [0, 0, 4, 0, 4, 1, 1, 1, 1, 4, 0, 4];
    const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 2 : 5, t = (i * Math.PI) / 5; return [r * Math.cos(t), r * Math.sin(t)]; }).flat();
    for (const poly of [L, star]) for (const xy of [poly, reverse(poly)]) {
      const n = xy.length / 2, { triangles, outside } = triangulate(xy, n);
      expect(outside).toEqual([]);
      expect(triangles.length).toBe((n - 2) * 3);
      let area = 0;
      for (let k = 0; k < triangles.length; k += 3) {
        const t = signedArea(xy, triangles.slice(k, k + 3));
        expect(t).toBeGreaterThan(0);
        area += t;
      }
      expect(area).toBeCloseTo(Math.abs(signedArea(xy, Array.from({ length: n }, (_, i) => i))), 9);
    }
  });
  it("inserts inner points, flips to Delaunay, leaves out points outside, and is deterministic", () => {
    let seed = 3;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const xy = [0, 0, 10, 0, 10, 10, 0, 10];
    for (let i = 0; i < 40; i++) xy.push(0.5 + rand() * 9, 0.5 + rand() * 9);
    xy.push(20, 20);
    const a = triangulate(xy, 4), b = triangulate(xy, 4);
    expect(a).toEqual(b);
    expect(a.outside).toEqual([44]);
    expect(a.triangles.length / 3).toBe(2 * 44 - 4 - 2);
    // Delaunay: no vertex inside any triangle's circumcircle.
    for (let k = 0; k < a.triangles.length; k += 3) {
      const [p, q, r] = a.triangles.slice(k, k + 3) as [number, number, number];
      const [cx, cy, rr] = circle(xy, p, q, r);
      for (let v = 0; v < 44; v++) if (v !== p && v !== q && v !== r) expect(Math.hypot(xy[v * 2]! - cx, xy[v * 2 + 1]! - cy)).toBeGreaterThan(rr - 1e-6);
    }
  });
});

describe("mesh edits", () => {
  it("turn every region of a sample into a mesh that draws the same image in the same place", () => {
    for (const [dir, file] of [["spineboy-pro", "spineboy-pro.json"], ["raptor-pro-and-mask", "raptor-pro.json"]] as const) {
      const { doc, atlas, images } = sample(dir, file);
      let s = doc;
      const refs = refsOf(doc, "region");
      expect(refs.length).toBeGreaterThan(10);
      for (const r of refs) s = regionToMesh(r)(s);
      expect(refsOf(s, "region")).toEqual([]);
      const before = drawn(doc, images), after = drawn(s, images);
      expect([...after.keys()]).toEqual([...before.keys()]);
      for (const [slot, region] of before) {
        if (region.kind !== "region") continue;
        const mesh = after.get(slot)!;
        // Where each of the region's corners shows its page pixel, the mesh shows the same one.
        for (let i = 0; i < region.uv.length / 2; i++) {
          const [x, y] = worldAt(mesh, region.uv[i * 2]!, region.uv[i * 2 + 1]!);
          expect(Math.hypot(x - region.xy[i * 2]!, y - region.xy[i * 2 + 1]!), `${dir} ${slot}`).toBeLessThan(0.05);
        }
      }
      sound(s, atlas);
    }
  });
  it("move a vertex with its image staying put, or stretching it", () => {
    const { doc, atlas } = sample("spineboy-pro", "spineboy-pro.json");
    const r = refsOf(doc, "region").find((x) => x.slot === "torso") ?? refsOf(doc, "region")[0]!;
    const s = regionToMesh(r)(doc);
    const m = findAttachment(s, r)!;
    // Halfway along the first triangle's edge 0 → 1: the image there is the UVs halfway too.
    const x = (m.vertices![0]! + m.vertices![2]!) / 2, y = (m.vertices![1]! + m.vertices![3]!) / 2;
    const kept = findAttachment(moveVertex(r, 0, x, y)(s), r)!;
    expect(kept.uvs![0]).toBeCloseTo((m.uvs![0]! + m.uvs![2]!) / 2, 9);
    expect(kept.uvs![1]).toBeCloseTo((m.uvs![1]! + m.uvs![3]!) / 2, 9);
    const stretched = findAttachment(moveVertex(r, 0, x, y, false)(s), r)!;
    expect(stretched.uvs).toEqual(m.uvs);
    expect(moveVertex(r, 0, m.vertices![0]!, m.vertices![1]!)(s)).toBe(s);
    sound(moveVertex(r, 0, x, y)(s), atlas);
  });
  it("add inner and outline vertices and delete them; the image does not move", () => {
    const { doc, atlas, images } = sample("spineboy-pro", "spineboy-pro.json");
    // A region its slot shows in the setup pose.
    const r = refsOf(doc, "region").find((x) => x.skin === "default" && doc.slots!.find((sl) => sl.name === x.slot)?.attachment === x.key)!;
    let s = regionToMesh(r)(doc);
    const base = findAttachment(s, r)!, before = drawn(s, images).get(r.slot)!;
    const cx = base.vertices!.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b) / 4, cy = base.vertices!.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b) / 4;
    s = addVertex(r, cx, cy)(s);
    s = addHullVertex(r, 1, 0.5)(s);
    const m = findAttachment(s, r)!;
    expect(m.hull).toBe(5);
    expect(m.uvs!.length).toBe(12);
    expect(m.triangles!.length).toBe(3 * (2 * 6 - 5 - 2));
    const after = drawn(s, images).get(r.slot)!;
    for (let i = 0; i < after.uv.length / 2; i++) {
      const [x, y] = worldAt(before, after.uv[i * 2]!, after.uv[i * 2 + 1]!);
      expect(Math.hypot(x - after.xy[i * 2]!, y - after.xy[i * 2 + 1]!)).toBeLessThan(0.05);
    }
    sound(s, atlas);
    expect(() => addVertex(r, cx + 1e5, cy)(s)).toThrow(/inside the mesh/);
    s = deleteVertex(r, 2)(s);
    s = deleteVertex(r, 4)(s);
    expect(findAttachment(s, r)!.hull).toBe(4);
    s = deleteVertex(r, 0)(s);
    expect(() => deleteVertex(r, 0)(s)).toThrow(/at least three/);
    sound(s, atlas);
  });
  it("keep deform keys moving the old vertices as they did, the new ones between them", () => {
    for (const [dir, file] of [["Goblins", "goblins.json"], ["Hero", "hero-pro.json"], ["spineboy-pro", "spineboy-pro.json"]] as const) {
      const { doc, atlas, images } = sample(dir, file);
      // An unweighted mesh with deform keys.
      const found = doc.animations!.flatMap((a) => (a.attachments ?? []).flatMap((st) => st.slots.flatMap((sl) => sl.attachments.filter((g) => g.timelines.some((t) => t.name === "deform"))
        .map((g) => ({ anim: a.name, r: { skin: st.skin, slot: sl.slot, key: g.name }, keys: g.timelines.find((t) => t.name === "deform")!.keys })))))
        .find((x) => { const m = findAttachment(doc, x.r); return m && m.source === undefined && m.vertices!.length === m.uvs!.length; })!;
      expect(found, dir).toBeDefined();
      const { anim, r, keys } = found;
      const m = findAttachment(doc, r)!, n = m.uvs!.length / 2;
      const tri = m.triangles!.slice(0, 3) as [number, number, number];
      const px = (m.vertices![tri[0] * 2]! + m.vertices![tri[1] * 2]! + m.vertices![tri[2] * 2]!) / 3, py = (m.vertices![tri[0] * 2 + 1]! + m.vertices![tri[1] * 2 + 1]! + m.vertices![tri[2] * 2 + 1]!) / 3;
      expect(triangleAt(m, px, py)).not.toBeNull();
      const del = n - 1 >= (m.hull ?? 0) ? n - 1 : -1;
      let s = addVertex(r, px, py)(doc);
      s = addHullVertex(r, 0, 0.5)(s);
      if (del >= 0) s = deleteVertex(r, del + 1)(s);
      // Old vertex i is at new index i (before the outline split) or i + 1 (after it); the deleted one is gone.
      const newIndex = (i: number) => (i === del ? -1 : i >= 1 ? i + 1 : i);
      const skin = r.skin === "default" ? null : r.skin;
      let checked = 0;
      for (const k of keys) {
        const t = Math.fround(keyTime(k));
        const a = drawn(doc, images, skin, anim, t).get(r.slot), b = drawn(s, images, skin, anim, t).get(r.slot);
        if (!a || !b || a.xy.length !== n * 2) continue;
        checked++;
        for (let i = 0; i < n; i++) {
          const j = newIndex(i);
          if (j < 0) continue;
          expect(Math.hypot(a.xy[i * 2]! - b.xy[j * 2]!, a.xy[i * 2 + 1]! - b.xy[j * 2 + 1]!), `${dir} ${r.key} key ${t} vertex ${i}`).toBeLessThan(1e-3);
        }
      }
      expect(checked, `${dir} ${r.key}`).toBeGreaterThan(0);
      sound(s, atlas);
    }
  });
  it("refuse what is not an unweighted mesh, and triangulate again on demand", () => {
    const { doc } = sample("spineboy-pro", "spineboy-pro.json");
    const region = refsOf(doc, "region")[0]!;
    expect(() => addVertex(region, 0, 0)(doc)).toThrow(/only meshes/);
    const weighted = refsOf(doc, "mesh").find((x) => { const a = findAttachment(doc, x)!; return a.vertices!.length !== a.uvs!.length; })!;
    expect(() => moveVertex(weighted, 0, 0, 0)(doc)).toThrow(/bound to bones/);
    const s = regionToMesh(region)(doc);
    expect(retriangulate(region)(s)).toBe(s);
    expect(() => regionToMesh(region)(s)).toThrow(/not a region/);
  });
});

describe("mesh mode picking", () => {
  it("a vertex before the outline, the outline before the inside, nothing outside", () => {
    // A 100-pixel square on screen with one inner vertex.
    const screen = [0, 0, 100, 0, 100, 100, 0, 100, 50, 50], tris = triangulate(screen, 4).triangles;
    expect(hitMesh(screen, tris, 4, 3, 2)).toEqual({ kind: "vertex", index: 0 });
    expect(hitMesh(screen, tris, 4, 52, 49)).toEqual({ kind: "vertex", index: 4 });
    expect(hitMesh(screen, tris, 4, 50, 3)).toEqual({ kind: "edge", after: 0, t: 0.5 });
    expect(hitMesh(screen, tris, 4, 3, 50)).toEqual({ kind: "edge", after: 3, t: 0.5 });
    expect(hitMesh(screen, tris, 4, 30, 70)).toEqual({ kind: "inside" });
    expect(hitMesh(screen, tris, 4, 150, 50)).toBeNull();
  });
});

function reverse(xy: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = xy.length - 2; i >= 0; i -= 2) out.push(xy[i]!, xy[i + 1]!);
  return out;
}

function circle(xy: readonly number[], a: number, b: number, c: number): [number, number, number] {
  const ax = xy[a * 2]!, ay = xy[a * 2 + 1]!, bx = xy[b * 2]!, by = xy[b * 2 + 1]!, cx = xy[c * 2]!, cy = xy[c * 2 + 1]!;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return [ux, uy, Math.hypot(ax - ux, ay - uy)];
}
