import { describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { type MeshData, type RegionData, readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import { atlasText } from "@/core/spine/atlas";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import type { PackedPage } from "@/core/atlas/packed";
import { isImage, type Project } from "@/core/doc/types";
import type { ItemId } from "@/core/doc/ids";
import { loadFixture } from "./fixtures/realProject";
import { loadStickman } from "./fixtures/stickman";
import { sampleRigs } from "./fixtures/spineSamples";

/**
 * The BoneBurst runtime (docs/PREVIEW-RUNTIME-PLAN.md, P0 and P1) against
 * spine-core 4.3.13, the oracle, at every frame of every animation: each
 * bone's world matrix and whether it is active, each slot's attachment and
 * colour, the draw order, each region's world corners and UVs, each mesh's
 * world vertices, UVs and triangles, and each sequence's frame.
 *
 * The runtime solves no constraints yet and only the normal inherit mode, so
 * both are given the file without constraints, constraint keys or inherit
 * modes; everything else in it is compared. The rigs are our own
 * exports (stickman, frog) and spine-unity's samples (skipped without the
 * samples folder).
 */

type Json = Record<string, unknown>;

/** The file both runtimes read: what P1 does not play taken out. */
function p1Only(file: Json): Json {
  const out = structuredClone(file);
  for (const k of ["constraints", "ik", "transform", "path", "physics", "slider"]) delete out[k];
  for (const b of (out.bones as Json[]) ?? []) delete b.inherit;
  for (const s of (out.skins as Json[]) ?? []) for (const k of ["ik", "transform", "path", "physics", "slider"]) delete s[k];
  for (const a of Object.values((out.animations as Record<string, Json>) ?? {})) {
    for (const k of ["ik", "transform", "path", "physics", "slider"]) delete a[k];
    for (const groups of Object.values((a.bones as Record<string, Json>) ?? {})) delete groups.inherit;
  }
  return out;
}

/** Every image on one page, each trimmed a pixel on the left and bottom, so
 *  the offsets are exercised. */
function trimmedPage(project: Project, ids: ItemId[]): PackedPage {
  let y = 0, width = 1;
  const regions = ids.map((id) => {
    const item = project.items[id];
    if (!isImage(item)) throw new Error("not an image");
    const w = Math.max(1, item.width - 1), h = Math.max(1, item.height - 1);
    const r = { name: item.name, x: 0, y, width: w, height: h, offsetX: item.width > 1 ? 1 : 0, offsetY: 0,
      originalWidth: item.width, originalHeight: item.height, rotated: false };
    y += h;
    width = Math.max(width, w);
    return r;
  });
  return { name: "p", imagePath: "p.png", width, height: Math.max(1, y), scale: 1, regions };
}

const close = (a: number, b: number, scale = 0) => Math.abs(a - b) <= Math.max(1e-5, 1e-5 * Math.max(Math.abs(b), scale));

/**
 * The size positions are compared at: the rig's largest world coordinate in
 * the frame. spine-core samples a bezier by forward differencing and we
 * evaluate it, so a curve point can differ by one 32-bit rounding step; a
 * bone near the origin under a far-off parent inherits an error sized to the
 * parent, not to itself.
 */
function extent(world: ArrayLike<number>): number {
  let r = 0;
  for (let i = 0; i < world.length; i += 6) r = Math.max(r, Math.abs(world[i + 4]!), Math.abs(world[i + 5]!));
  return r;
}

interface Counts { frames: number; bones: number; regions: number; meshes: number; deformed: number; sequences: number }

/**
 * Both runtimes through every frame of `animations` (all of them when
 * absent), with `skin` shown over the default one. Counts what was compared,
 * so a check that silently compares nothing shows up as a zero.
 */
function compare(name: string, file: Json, atlas: string, skin?: string, animations?: number): Counts {
  const json = p1Only(file);
  const oracleAtlas = new TextureAtlas(atlas);
  const data = new SkeletonJson(new AtlasAttachmentLoader(oracleAtlas)).readSkeletonData(json);
  const skeleton = new Skeleton(data);
  const ours = new Rig(readRig(json, readAtlas(atlas)));
  if (skin) { skeleton.setSkin(skin); ours.setSkins([skin]); }
  if (ours.data.fps !== (data.fps || 0)) throw new Error(`${name}: fps ${ours.data.fps} vs ${data.fps}`);
  const fps = data.fps || 30;
  const n: Counts = { frames: 0, bones: 0, regions: 0, meshes: 0, deformed: 0, sequences: 0 };
  const fail = (where: string, what: string) => { throw new Error(`${name}${skin ? ` [${skin}]` : ""} ${where}: ${what}`); };

  const anims = data.animations.length ? data.animations.slice(0, animations) : [null];
  for (const anim of anims) {
    const mine = anim ? ours.data.animations.find((a) => a.name === anim.name) : undefined;
    if (anim && !mine) fail(anim.name, "animation missing");
    if (anim && !close(mine!.duration, anim.duration)) fail(anim.name, `duration ${mine!.duration} vs ${anim.duration}`);
    const count = anim ? Math.max(1, Math.round(anim.duration * fps) + 1) : 1;
    for (let f = 0; f < count; f++) {
      const time = f / fps;
      const where = `${anim?.name ?? "setup"} frame ${f}`;
      skeleton.setupPose();
      anim?.apply(skeleton, 0, time, false, null, 1, MixFrom.setup, false, false, false);
      skeleton.updateWorldTransform(Physics.none);
      ours.setupPose();
      if (mine) ours.apply(mine, time, false);
      ours.updateWorld();
      n.frames++;

      const size = extent(ours.world);
      skeleton.bones.forEach((b, i) => {
        if (!!ours.active[i] !== b.active) fail(where, `bone "${b.data.name}" active ${!!ours.active[i]} vs ${b.active}`);
        if (!b.active) return;
        const p = b.appliedPose;
        const want = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
        const got = Array.from(ours.world.subarray(i * 6, i * 6 + 6));
        if (!want.every((v, j) => close(got[j]!, v, j >= 4 ? size : 0))) fail(where, `bone "${b.data.name}" ${got} vs ${want}`);
        n.bones++;
      });

      const order = skeleton.drawOrder.appliedPose.map((s) => s.data.name).join(",");
      const myOrder = ours.drawOrder.map((i) => ours.data.slots[i]!.name).join(",");
      if (order !== myOrder) fail(where, `draw order ${myOrder} vs ${order}`);

      skeleton.slots.forEach((slot, i) => {
        const c = slot.appliedPose.color;
        const want = [c.r, c.g, c.b, c.a];
        const got = Array.from(ours.color.subarray(i * 4, i * 4 + 4));
        if (!want.every((v, j) => close(got[j]!, v))) fail(where, `slot "${slot.data.name}" colour ${got} vs ${want}`);

        const att = slot.bone.active ? slot.appliedPose.getAttachment() : null;
        if (!(att instanceof RegionAttachment) && !(att instanceof MeshAttachment)) return;
        const mineAtt = ours.attachmentOf(i);
        const what = `slot "${slot.data.name}"`;
        if (!mineAtt || mineAtt.name !== att.name) fail(where, `${what} shows ${mineAtt?.name ?? ours.attachment[i]} vs ${att.name}`);
        const seq = att.sequence;
        const index = seq.resolveIndex(slot.appliedPose);
        const frame = ours.frameOf(i, mineAtt!);
        if (seq.hasPathSuffix()) {
          const region = seq.regions[index] as unknown as { name: string } | null;
          if ((region?.name ?? null) !== (frame.region?.name ?? null)) fail(where, `${what} frame ${frame.region?.name} vs ${region?.name}`);
          n.sequences++;
        }
        const uvs = seq.getUVs(index);
        if (att instanceof RegionAttachment) {
          if (mineAtt!.kind !== "region") fail(where, `${what} is a ${mineAtt!.kind}`);
          const verts = new Array<number>(8);
          att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), verts, 0, 2);
          const mineVerts = new Float64Array(8);
          ours.regionWorld(i, mineAtt as RegionData, mineVerts);
          // spine-core's corners run left-bottom, left-top, right-top,
          // right-bottom; ours bottom-left, bottom-right, top-right, top-left.
          const remap = [0, 3, 2, 1];
          for (let k = 0; k < 4; k++) {
            const m = remap[k]!;
            if (!close(mineVerts[m * 2]!, verts[k * 2]!, size) || !close(mineVerts[m * 2 + 1]!, verts[k * 2 + 1]!, size)) {
              fail(where, `${what} corner ${k} ${mineVerts[m * 2]},${mineVerts[m * 2 + 1]} vs ${verts[k * 2]},${verts[k * 2 + 1]}`);
            }
            if (!close(frame.uvs[m * 2]!, uvs[k * 2]!) || !close(frame.uvs[m * 2 + 1]!, uvs[k * 2 + 1]!)) {
              fail(where, `${what} uv ${k} ${frame.uvs[m * 2]},${frame.uvs[m * 2 + 1]} vs ${uvs[k * 2]},${uvs[k * 2 + 1]}`);
            }
          }
          n.regions++;
        } else {
          if (mineAtt!.kind !== "mesh") fail(where, `${what} is a ${mineAtt!.kind}`);
          const verts = new Array<number>(att.worldVerticesLength);
          att.computeWorldVertices(skeleton, slot, 0, att.worldVerticesLength, verts, 0, 2);
          const mineVerts = new Float64Array(att.worldVerticesLength);
          ours.meshWorld(i, mineAtt as MeshData, mineVerts);
          for (let k = 0; k < verts.length; k++) {
            if (!close(mineVerts[k]!, verts[k]!, size)) fail(where, `${what} vertex ${k >> 1} ${mineVerts[k]} vs ${verts[k]}`);
            if (!close(frame.uvs[k]!, uvs[k]!)) fail(where, `${what} uv ${k >> 1} ${frame.uvs[k]} vs ${uvs[k]}`);
          }
          if ((mineAtt as MeshData).triangles.join() !== att.triangles.join()) fail(where, `${what} triangles`);
          n.meshes++;
          if (ours.deform[i]) n.deformed++;
        }
      });
    }
  }
  return n;
}

describe("BoneBurst runtime vs spine-core", () => {
  it("the stickman export", async () => {
    const { project } = await loadStickman();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = compare("stickman", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.bones).toBeGreaterThan(100);
    expect(r.regions).toBeGreaterThan(100);
  });

  it("the frog export", async () => {
    const { project } = await loadFixture();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = compare("frog", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.regions).toBeGreaterThan(10);
  });

  const samples = sampleRigs();
  for (const rig of samples) {
    it(`sample ${rig.name}`, () => {
      const r = compare(rig.name, JSON.parse(rig.json), rig.atlas);
      expect(r.frames).toBeGreaterThan(0);
    });
    // Each other skin over the default one, through the first animation:
    // skin attachments, linked meshes and the bones a skin enables.
    const skins = ((JSON.parse(rig.json) as Json).skins as Json[] ?? []).map((s) => String(s.name)).filter((s) => s !== "default");
    if (skins.length) {
      it(`sample ${rig.name}, each skin`, () => {
        for (const skin of skins) compare(rig.name, JSON.parse(rig.json), rig.atlas, skin, 1);
      });
    }
  }

  it("the samples exercise meshes, linked meshes, deform keys and sequences", () => {
    if (!samples.length) return;
    const total: Counts = { frames: 0, bones: 0, regions: 0, meshes: 0, deformed: 0, sequences: 0 };
    for (const rig of samples) {
      const r = compare(rig.name, JSON.parse(rig.json), rig.atlas);
      for (const k of Object.keys(total) as Array<keyof Counts>) total[k] += r[k];
    }
    expect(total.regions).toBeGreaterThan(1000);
    expect(total.meshes).toBeGreaterThan(1000);
    expect(total.deformed).toBeGreaterThan(100);
    expect(total.sequences).toBeGreaterThan(10);
  });
});
