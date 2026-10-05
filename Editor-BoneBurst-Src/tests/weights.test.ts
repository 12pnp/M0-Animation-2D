import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { addHullVertex, addVertex, deleteVertex, moveVertex, normaliseWeights, regionToMesh } from "@/edit/mesh";
import { type BoneWorlds, decodeBinds, frameFor, isWeighted, positions } from "@/edit/meshLayout";
import { autoWeights, bindMesh, distanceWeights, meshBones, setMeshBone, setWeight, unbindMesh } from "@/edit/weights";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import { attachmentType, type Key, type Skeleton } from "@/model/skeleton";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { boneMatrix, Poser } from "@/ui/stage/posed";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => {
  const atlas = readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton, atlas, images: atlasImages(readAtlas(atlas)) };
};

function sound(s: Skeleton, atlas: string): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("edited", text, atlas, [0, 0.5]);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** The setup pose's bone world matrices by bone index, as the stage gives them. */
function setupBones(s: Skeleton, images: AtlasImages): BoneWorlds {
  const p = new Poser(s, images).pose(null, null, 0);
  return s.bones!.map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
}

/** Each vertex in the world on the setup pose, with a deform key's offsets (flat) when given. */
function world(s: Skeleton, r: AttachmentRef, bones: BoneWorlds, offsets?: readonly number[]): number[] {
  const a = findAttachment(s, r)!, slotBone = s.slots!.find((x) => x.name === r.slot)!.bone;
  const m = bones[s.bones!.findIndex((b) => b.name === slotBone)]!;
  const out: number[] = [];
  if (!isWeighted(a)) {
    for (let i = 0; i < a.vertices!.length; i += 2) {
      const x = a.vertices![i]! + (offsets?.[i] ?? 0), y = a.vertices![i + 1]! + (offsets?.[i + 1] ?? 0);
      out.push(m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!);
    }
    return out;
  }
  let k = 0;
  for (const binds of decodeBinds(a.vertices!)) {
    let x = 0, y = 0;
    for (const b of binds) {
      const B = bones[b.bone]!, bx = b.x + (offsets?.[k++] ?? 0), by = b.y + (offsets?.[k++] ?? 0);
      x += (B[0]! * bx + B[1]! * by + B[4]!) * b.w;
      y += (B[2]! * bx + B[3]! * by + B[5]!) * b.w;
    }
    out.push(x, y);
  }
  return out;
}

/** A deform key's offsets expanded to the full array. */
function full(k: Key, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  (k.vertices ?? []).forEach((v, n) => { out[(k.offset ?? 0) + n] = v; });
  return out;
}

/** Every deform key of `r` (its own timelines), as [animation, key index]. */
function deformKeys(s: Skeleton, r: AttachmentRef): Key[] {
  return (s.animations ?? []).flatMap((a) => (a.attachments ?? []).filter((st) => st.skin === r.skin).flatMap((st) => st.slots.filter((sl) => sl.slot === r.slot)
    .flatMap((sl) => sl.attachments.filter((g) => g.name === r.key).flatMap((g) => g.timelines.filter((t) => t.name === "deform").flatMap((t) => t.keys)))));
}

const deformLength = (s: Skeleton, r: AttachmentRef) => {
  const a = findAttachment(s, r)!;
  return isWeighted(a) ? decodeBinds(a.vertices!).reduce((n, b) => n + b.length, 0) * 2 : a.vertices!.length;
};

/** Each deform key's vertices in the world on the setup pose, kept vertices only (`map`: old index → new). */
function deformedWorlds(s: Skeleton, r: AttachmentRef, bones: BoneWorlds): number[][] {
  const n = deformLength(s, r);
  return deformKeys(s, r).map((k) => world(s, r, bones, full(k, n)));
}

function expectClose(a: readonly number[], b: readonly number[], tol: number, what: string): void {
  expect(a.length, what).toBe(b.length);
  let worst = 0;
  a.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - b[i]!)); });
  expect(worst, what).toBeLessThan(tol);
}

/** A weighted mesh (not linked) that has deform keys. */
function weightedWithDeform(s: Skeleton): AttachmentRef {
  for (const k of s.skins!) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    const r = { skin: k.name, slot: ss.slot, key: e.key };
    if (attachmentType(e.attachment) === "mesh" && e.attachment.source === undefined && isWeighted(e.attachment) && deformKeys(s, r).some((x) => x.vertices)) return r;
  }
  throw new Error("none");
}

describe("weight rules", () => {
  it("normalise: shares kept, the four heaviest, under 0.01 dropped, summing to 1", () => {
    expect(normaliseWeights([{ bone: 0, w: 3 }, { bone: 1, w: 1 }])).toEqual([{ bone: 0, w: 0.75 }, { bone: 1, w: 0.25 }]);
    expect(normaliseWeights([1, 2, 3, 4, 5].map((w, bone) => ({ bone, w }))).map((x) => x.bone)).toEqual([4, 3, 2, 1]);
    expect(normaliseWeights([{ bone: 0, w: 1 }, { bone: 1, w: 0.005 }])).toEqual([{ bone: 0, w: 1 }]);
    expect(() => normaliseWeights([{ bone: 0, w: 0 }])).toThrow(/needs a bone/);
  });
  it("by distance: on a bone it weighs most, each other by 1 / (d + 1)⁴", () => {
    // Two bones along x: A from (0, 0) to (10, 0), B from (0, 30) to (10, 30).
    const s = { bones: [{ name: "a", length: 10, extra: new Map() }, { name: "b", length: 10, extra: new Map() }], extra: new Map() } as unknown as Skeleton;
    const bones = [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 30]];
    // On A, B's share (1 / 31⁴ against 1) is under 0.01: A alone.
    const w = distanceWeights(s, bones, [0, 1], 5, 0);
    expect(w).toEqual([{ bone: 0, w: 1 }]);
    const mid = distanceWeights(s, bones, [0, 1], 5, 10);
    expect(mid[0]!.bone).toBe(0);
    expect(mid[1]!.w).toBeCloseTo((1 / 21 ** 4) / (1 / 11 ** 4 + 1 / 21 ** 4), 4);
  });
});

describe("weights", () => {
  it("bind a mesh to bones: every vertex stays put, weights sum to 1 on at most four bones, nearer bones weigh more", () => {
    const { doc, atlas, images } = sample("spineboy-pro", "spineboy-pro.json");
    const r = { skin: "default", slot: "torso", key: doc.slots!.find((x) => x.name === "torso")!.attachment! };
    let s = doc;
    if (attachmentType(findAttachment(s, r)!) === "region") s = regionToMesh(r)(s);
    if (isWeighted(findAttachment(s, r)!)) s = unbindMesh(r, setupBones(s, images))(s);
    const bones = setupBones(s, images), before = world(s, r, bones);
    const chosen = ["torso", "torso2", "torso3", "neck"].filter((n) => s.bones!.some((b) => b.name === n));
    const bound = bindMesh(r, chosen, bones)(s);
    const a = findAttachment(bound, r)!;
    expect(isWeighted(a)).toBe(true);
    for (const binds of decodeBinds(a.vertices!)) {
      expect(binds.length).toBeLessThanOrEqual(4);
      expect(binds.reduce((n, b) => n + b.w, 0)).toBeCloseTo(1, 6);
    }
    expectClose(world(bound, r, bones), before, 1e-3, "setup pose after binding");
    sound(bound, atlas);
    // Back again: the same vertices.
    const back = unbindMesh(r, bones)(bound);
    expectClose(findAttachment(back, r)!.vertices!, findAttachment(s, r)!.vertices!, 1e-3, "unbound");
    expect(() => bindMesh(r, [], bones)(s)).toThrow(/at least one bone/);
  });
  it("unbind a weighted mesh: the setup pose and every deform key's setup offsets stay", () => {
    for (const [dir, file] of [["spineboy-pro", "spineboy-pro.json"], ["Hero", "hero-pro.json"]] as const) {
      const { doc, atlas, images } = sample(dir, file);
      const r = weightedWithDeform(doc), bones = setupBones(doc, images);
      const s = unbindMesh(r, bones)(doc);
      expect(isWeighted(findAttachment(s, r)!)).toBe(false);
      expectClose(world(s, r, bones), world(doc, r, bones), 1e-3, `${dir} setup`);
      const was = deformedWorlds(doc, r, bones), now = deformedWorlds(s, r, bones);
      expect(was.length).toBeGreaterThan(0);
      was.forEach((w, k) => expectClose(now[k]!, w, 1e-3, `${dir} ${r.key} deform key ${k}`));
      sound(s, atlas);
    }
  });
  it("set a vertex's weight: the others share the rest, the vertex and its deform offsets stay; other vertices untouched", () => {
    const { doc, atlas, images } = sample("spineboy-pro", "spineboy-pro.json");
    const r = weightedWithDeform(doc), bones = setupBones(doc, images), a = findAttachment(doc, r)!;
    const binds = decodeBinds(a.vertices!), v = binds.findIndex((b) => b.length >= 2), bone = binds[v]![0]!;
    const name = doc.bones![bone.bone]!.name;
    const s = setWeight(r, v, name, 0.25, bones)(doc);
    const after = decodeBinds(findAttachment(s, r)!.vertices!);
    expect(after[v]!.find((b) => b.bone === bone.bone)!.w).toBe(0.25);
    expect(after[v]!.reduce((n, b) => n + b.w, 0)).toBeCloseTo(1, 6);
    after.forEach((b, i) => { if (i !== v) expect(b).toEqual(binds[i]); });
    expectClose(world(s, r, bones), world(doc, r, bones), 1e-3, "setup");
    const was = deformedWorlds(doc, r, bones), now = deformedWorlds(s, r, bones);
    was.forEach((w, k) => expectClose(now[k]!, w, 1e-3, `deform key ${k}`));
    // The other vertices' deform offsets are kept exactly as written.
    const slices = (d: Skeleton) => {
      const bs = decodeBinds(findAttachment(d, r)!.vertices!), len = deformLength(d, r);
      return deformKeys(d, r).map((k) => { const fl = full(k, len); let at = 0; return bs.map((b) => { const out = fl.slice(at, at + b.length * 2); at += b.length * 2; return out; }); });
    };
    const rawBefore = slices(doc), rawAfter = slices(s);
    rawBefore.forEach((key, k) => key.forEach((o, i) => { if (i !== v) expect(rawAfter[k]![i], `key ${k} vertex ${i}`).toEqual(o); }));
    sound(s, atlas);
    // Off the vertex; a new bone on it; refusals.
    expect(decodeBinds(findAttachment(setWeight(r, v, name, 0, bones)(doc), r)!.vertices!)[v]!.some((b) => b.bone === bone.bone)).toBe(false);
    const stranger = doc.bones!.find((_, i) => !binds[v]!.some((x) => x.bone === i))!.name;
    expect(decodeBinds(findAttachment(setWeight(r, v, stranger, 0.3, bones)(doc), r)!.vertices!)[v]!.length).toBe(Math.min(4, binds[v]!.length + 1));
    expect(() => setWeight(r, v, name, 1.5, bones)(doc)).toThrow(/between 0 and 1/);
    const single = binds.findIndex((b) => b.length === 1);
    if (single >= 0) expect(() => setWeight(r, single, doc.bones![binds[single]![0]!.bone]!.name, 0, bones)(doc)).toThrow(/only bone/);
  });
  it("weight again by distance, add and remove a bone the mesh follows", () => {
    const { doc, atlas, images } = sample("spineboy-pro", "spineboy-pro.json");
    const r = weightedWithDeform(doc), bones = setupBones(doc, images);
    const s = autoWeights(r, bones)(doc);
    expect(autoWeights(r, bones)(s)).toBe(s);
    expectClose(world(s, r, bones), world(doc, r, bones), 1e-3, "setup");
    deformedWorlds(doc, r, bones).forEach((w, k) => expectClose(deformedWorlds(s, r, bones)[k]!, w, 1e-3, `deform key ${k}`));
    sound(s, atlas);
    const follows = meshBones(findAttachment(doc, r)!);
    const extra = doc.bones!.find((_, i) => !follows.includes(i))!.name;
    const more = setMeshBone(r, extra, true, bones)(doc);
    expect(meshBones(findAttachment(more, r)!).length).toBeGreaterThanOrEqual(follows.length);
    expectClose(world(more, r, bones), world(doc, r, bones), 1e-3, "setup with a bone added");
    const fewer = setMeshBone(r, doc.bones![follows[0]!]!.name, false, bones)(doc);
    expect(meshBones(findAttachment(fewer, r)!)).not.toContain(follows[0]);
    sound(fewer, atlas);
  });
  it("shape a weighted mesh: moved, added and deleted vertices; the others and their deform offsets stay", () => {
    for (const [dir, file] of [["spineboy-pro", "spineboy-pro.json"], ["Hero", "hero-pro.json"]] as const) {
      const { doc, atlas, images } = sample(dir, file);
      const r = weightedWithDeform(doc), bones = setupBones(doc, images), a = findAttachment(doc, r)!;
      const f = frameFor(doc, r, a, bones), pos = positions(a, f), n = pos.length / 2;
      expect(() => moveVertex(r, 0, 0, 0)(doc)).toThrow(/bound to bones/);
      // Move vertex 0 by (3, -2) in the slot's space.
      let s = moveVertex(r, 0, pos[0]! + 3, pos[1]! - 2, true, bones)(doc);
      const moved = positions(findAttachment(s, r)!, frameFor(s, r, findAttachment(s, r)!, bones));
      expect(moved[0]).toBeCloseTo(pos[0]! + 3, 3);
      expect(moved[1]).toBeCloseTo(pos[1]! - 2, 3);
      expectClose(moved.slice(2), pos.slice(2), 1e-9, `${dir} others unmoved`);
      // An inner vertex at a triangle's centre, an outline split, a delete.
      const t = a.triangles!.slice(0, 3);
      const cx = (pos[t[0]! * 2]! + pos[t[1]! * 2]! + pos[t[2]! * 2]!) / 3, cy = (pos[t[0]! * 2 + 1]! + pos[t[1]! * 2 + 1]! + pos[t[2]! * 2 + 1]!) / 3;
      const before = deformedWorlds(doc, r, bones);
      s = addVertex(r, cx, cy, bones)(doc);
      s = addHullVertex(r, 0, 0.5, bones)(s);
      const del = n - 1 >= (a.hull ?? 0) ? n - 1 : -1;
      if (del >= 0) s = deleteVertex(r, del + 1, bones)(s);
      const b = findAttachment(s, r)!;
      for (const binds of decodeBinds(b.vertices!)) expect(binds.reduce((m, x) => m + x.w, 0)).toBeCloseTo(1, 3);
      // Old vertex i is at new index i (i = 0) or i + 1; the deleted one is gone.
      const at = (i: number) => (i === del ? -1 : i >= 1 ? i + 1 : i);
      const after = deformedWorlds(s, r, bones);
      before.forEach((w, k) => {
        for (let i = 0; i < n; i++) {
          const j = at(i);
          if (j < 0) continue;
          expect(Math.hypot(w[i * 2]! - after[k]![j * 2]!, w[i * 2 + 1]! - after[k]![j * 2 + 1]!), `${dir} key ${k} vertex ${i}`).toBeLessThan(1e-3);
        }
      });
      sound(s, atlas);
    }
  });
});
