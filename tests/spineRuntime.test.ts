import { describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { readRig } from "@/core/spine/runtime/rigData";
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
 * The BoneBurst runtime (docs/PREVIEW-RUNTIME-PLAN.md, P0) against
 * spine-core 4.3.13, the oracle, at every frame of every animation: each
 * bone's world matrix, each slot's attachment and colour, the draw order,
 * and each region's world corners and UVs.
 *
 * P0 solves no constraints and only the normal inherit mode, so both
 * runtimes are given the file without constraints, constraint keys or
 * inherit modes; everything else in it is compared. The rigs are our own
 * exports (stickman, frog) and spine-unity's samples (skipped without the
 * samples folder).
 */

type Json = Record<string, unknown>;

/** The file both runtimes read: what P0 does not play taken out. */
function p0Only(file: Json): Json {
  const out = structuredClone(file);
  for (const k of ["constraints", "ik", "transform", "path", "physics", "slider"]) delete out[k];
  for (const b of (out.bones as Json[]) ?? []) { delete b.inherit; delete b.skin; }
  for (const s of (out.skins as Json[]) ?? []) for (const k of ["bones", "ik", "transform", "path", "physics", "slider"]) delete s[k];
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

function compare(name: string, file: Json, atlas: string): { frames: number; checks: number } {
  const json = p0Only(file);
  const oracleAtlas = new TextureAtlas(atlas);
  const data = new SkeletonJson(new AtlasAttachmentLoader(oracleAtlas)).readSkeletonData(json);
  const skeleton = new Skeleton(data);
  const ours = new Rig(readRig(json, readAtlas(atlas)));
  const fps = data.fps || 30;
  let frames = 0, checks = 0;
  const fail = (where: string, what: string) => { throw new Error(`${name} ${where}: ${what}`); };

  const anims = data.animations.length ? data.animations : [null];
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
      frames++;

      const size = extent(ours.world);
      skeleton.bones.forEach((b, i) => {
        const p = b.appliedPose;
        const want = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
        const got = Array.from(ours.world.subarray(i * 6, i * 6 + 6));
        if (!want.every((v, j) => close(got[j]!, v, j >= 4 ? size : 0))) fail(where, `bone "${b.data.name}" ${got} vs ${want}`);
        checks++;
      });

      const order = skeleton.drawOrder.appliedPose.map((s) => s.data.name).join(",");
      const myOrder = ours.drawOrder.map((i) => ours.data.slots[i]!.name).join(",");
      if (order !== myOrder) fail(where, `draw order ${myOrder} vs ${order}`);

      skeleton.slots.forEach((slot, i) => {
        const att = slot.appliedPose.getAttachment();
        const myKey = ours.attachment[i] ?? null;
        const mineAtt = ours.attachmentOf(i);
        const c = slot.appliedPose.color;
        const want = [c.r, c.g, c.b, c.a];
        const got = Array.from(ours.color.subarray(i * 4, i * 4 + 4));
        if (!want.every((v, j) => close(got[j]!, v))) fail(where, `slot "${slot.data.name}" colour ${got} vs ${want}`);
        checks++;
        if (!(att instanceof RegionAttachment) || att.sequence) return;
        if (!mineAtt || mineAtt.name !== att.name) fail(where, `slot "${slot.data.name}" shows ${mineAtt?.name ?? myKey} vs ${att.name}`);
        const verts = new Array<number>(8);
        att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), verts, 0, 2);
        const mineVerts = new Float64Array(8);
        ours.regionWorld(i, mineAtt!, mineVerts);
        // spine-core's corners run left-bottom, left-top, right-top,
        // right-bottom; ours bottom-left, bottom-right, top-right, top-left.
        const remap = [0, 3, 2, 1];
        for (let k = 0; k < 4; k++) {
          const m = remap[k]!;
          if (!close(mineVerts[m * 2]!, verts[k * 2]!, size) || !close(mineVerts[m * 2 + 1]!, verts[k * 2 + 1]!, size)) {
            fail(where, `slot "${slot.data.name}" corner ${k} ${mineVerts[m * 2]},${mineVerts[m * 2 + 1]} vs ${verts[k * 2]},${verts[k * 2 + 1]}`);
          }
          const uvs = (att as unknown as { uvs: ArrayLike<number> }).uvs;
          const u = uvs[k * 2]!, v = uvs[k * 2 + 1]!;
          if (!close(mineAtt!.uvs[m * 2]!, u) || !close(mineAtt!.uvs[m * 2 + 1]!, v)) {
            fail(where, `slot "${slot.data.name}" uv ${k} ${mineAtt!.uvs[m * 2]},${mineAtt!.uvs[m * 2 + 1]} vs ${u},${v}`);
          }
        }
        checks++;
      });
    }
  }
  return { frames, checks };
}

describe("BoneBurst runtime vs spine-core", () => {
  it("the stickman export", async () => {
    const { project } = await loadStickman();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = compare("stickman", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.checks).toBeGreaterThan(100);
  });

  it("the frog export", async () => {
    const { project } = await loadFixture();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = compare("frog", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.checks).toBeGreaterThan(10);
  });

  for (const rig of sampleRigs()) {
    it(`sample ${rig.name}`, () => {
      const r = compare(rig.name, JSON.parse(rig.json), rig.atlas);
      expect(r.frames).toBeGreaterThan(0);
    });
  }
});
