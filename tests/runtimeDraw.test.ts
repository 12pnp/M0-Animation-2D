import { describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, ClippingAttachment, MixFrom, Physics, Skeleton, SkeletonJson, SkeletonRendererCore, type Slot, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { atlasText } from "@/core/spine/atlas";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import { drawList, drawnVertices } from "@/core/spine/runtime/draw";
import { loadFixture } from "./fixtures/realProject";
import { loadStickman } from "./fixtures/stickman";
import { sampleRigs } from "./fixtures/spineSamples";
import { type Json, trimmedPage } from "./fixtures/runtimeOracle";

/**
 * The Preview's gate (docs/PREVIEW-RUNTIME-PLAN.md, P4): what the BoneBurst
 * runtime hands the renderer (`core/spine/runtime/draw.ts`) against what
 * spine-core's own renderer core draws, y down as the Preview poses, at every
 * frame: each triangle's positions, UVs, colour, dark colour, blend mode and
 * atlas page, in draw order.
 *
 * spine-core cuts clipped triangles on the CPU and the Preview masks them
 * with a stencil, so clipping is checked as which slots each clip covers:
 * with one clip moved out of sight, spine-core draws exactly the slots it
 * does not cover.
 */

interface Tri { blend: number; page: string; v: number[] }

/** A triangle's corners in one order (by UV, then position): a region's
 *  corners go round the other way in spine-core, over the same two triangles. */
function canonical(v: number[]): number[] {
  const corners = [v.slice(0, 11), v.slice(11, 22), v.slice(22, 33)];
  corners.sort((a, b) => a[2]! - b[2]! || a[3]! - b[3]! || a[0]! - b[0]! || a[1]! - b[1]!);
  return corners.flat();
}

const BLEND = { normal: 0, additive: 1, multiply: 2, screen: 3 } as const;

/** 0..1 to the renderer's 8 bits. */
const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

function oracleTris(skeleton: Skeleton): Tri[] {
  const out: Tri[] = [];
  for (let c = new SkeletonRendererCore().render(skeleton, false); c; c = c.next) {
    const page = (c.texture as { name: string } | null)?.name ?? "";
    for (let i = 0; i < c.numIndices; i += 3) {
      const v: number[] = [];
      for (let j = 0; j < 3; j++) {
        const k = c.indices[i + j]!;
        const rgba = c.colors[k]!, dark = c.darkColors[k]!;
        v.push(c.positions[k * 2]!, c.positions[k * 2 + 1]!, c.uvs[k * 2]!, c.uvs[k * 2 + 1]!,
          (rgba >>> 16) & 255, (rgba >>> 8) & 255, rgba & 255, rgba >>> 24,
          (dark >>> 16) & 255, (dark >>> 8) & 255, dark & 255);
      }
      out.push({ blend: c.blendMode, page, v: canonical(v) });
    }
  }
  return out;
}

function ourTris(rig: Rig, keep: (clip: number) => boolean): Tri[] {
  const out: Tri[] = [];
  for (const d of drawList(rig).slots) {
    if (!keep(d.clip) || d.color[3] === 0) continue;
    const pos = new Float64Array(d.vertexCount * 2);
    drawnVertices(rig, d, pos);
    const uvs = d.frame.uvs, [r, g, b, a] = d.color.map(byte) as [number, number, number, number];
    const dark = d.dark ? d.dark.map(byte) : [0, 0, 0];
    for (let i = 0; i < d.triangles.length; i += 3) {
      const v: number[] = [];
      for (let j = 0; j < 3; j++) {
        const k = d.triangles[i + j]!;
        v.push(pos[k * 2]!, pos[k * 2 + 1]!, uvs[k * 2]!, uvs[k * 2 + 1]!, r, g, b, a, ...dark);
      }
      out.push({ blend: BLEND[d.blend], page: d.frame.region.page.name, v: canonical(v) });
    }
  }
  return out;
}

function same(mine: Tri[], theirs: Tri[], size: number): string | null {
  if (mine.length !== theirs.length) return `${mine.length} triangles vs ${theirs.length}`;
  for (let t = 0; t < mine.length; t++) {
    const a = mine[t]!, b = theirs[t]!;
    if (a.blend !== b.blend || a.page !== b.page) return `triangle ${t}: blend ${a.blend} page ${a.page} vs ${b.blend} ${b.page}`;
    for (let i = 0; i < a.v.length; i++) {
      const j = i % 11, x = a.v[i]!, y = b.v[i]!;
      // Positions to a 32-bit float at the rig's size, UVs to a 32-bit float, colours to one step.
      const tol = j < 2 ? Math.max(1e-4, 1e-5 * Math.max(Math.abs(y), size)) : j < 4 ? 1e-6 : 1;
      if (Math.abs(x - y) > tol) return `triangle ${t} value ${i}: ${a.v.map((n) => +n.toFixed(4))} vs ${b.v.map((n) => +n.toFixed(4))}`;
    }
  }
  return null;
}

/** A clipping attachment that cuts away everything it covers. */
function outOfSight(from: ClippingAttachment): ClippingAttachment {
  const c = new ClippingAttachment(`${from.name} (out of sight)`);
  c.endSlot = from.endSlot;
  c.vertices = [1e7, 1e7, 1e7 + 1, 1e7, 1e7, 1e7 + 1];
  c.worldVerticesLength = 6;
  return c;
}

interface DrawCounts { frames: number; triangles: number; clipped: number }

function drawCompare(name: string, file: Json, atlas: string, skin?: string, stride = 1): DrawCounts {
  Skeleton.yDown = true;
  try {
    const oracleAtlas = new TextureAtlas(atlas);
    for (const p of oracleAtlas.pages) p.setTexture({ name: p.name, setFilters() {}, setWraps() {}, dispose() {}, getImage: () => null } as never);
    const data = new SkeletonJson(new AtlasAttachmentLoader(oracleAtlas)).readSkeletonData(file);
    const skeleton = new Skeleton(data);
    const rig = new Rig(readRig(file, readAtlas(atlas)));
    rig.scaleY = -1;
    if (skin) { skeleton.setSkin(skin); rig.setSkins([skin]); }
    const fps = data.fps || 30;
    const n: DrawCounts = { frames: 0, triangles: 0, clipped: 0 };
    const anims = data.animations.length ? data.animations : [null];
    for (const anim of anims) {
      const mine = anim ? rig.data.animations.find((a) => a.name === anim.name)! : undefined;
      const count = anim ? Math.max(1, Math.round(anim.duration * fps) + 1) : 1;
      for (let f = 0; f < count; f += stride) {
        const time = f / fps, where = `${name}${skin ? ` [${skin}]` : ""} ${anim?.name ?? "setup"} frame ${f}`;
        skeleton.setupPose();
        anim?.apply(skeleton, 0, time, false, null, 1, MixFrom.setup, false, false, false);
        skeleton.updateWorldTransform(Physics.none);
        rig.setupPose();
        if (mine) rig.apply(mine, time, false);
        rig.updateWorld();
        n.frames++;
        let size = 0;
        for (let i = 0; i < rig.world.length; i += 6) size = Math.max(size, Math.abs(rig.world[i + 4]!), Math.abs(rig.world[i + 5]!));

        // Every clip hidden: the whole stream.
        const clipSlots: Array<{ slot: Slot; clip: ClippingAttachment }> = [];
        for (const slot of skeleton.slots) {
          const a = slot.appliedPose.getAttachment();
          if (a instanceof ClippingAttachment && slot.bone.active) clipSlots.push({ slot, clip: a });
        }
        for (const { slot } of clipSlots) slot.appliedPose.setAttachment(null);
        const all = ourTris(rig, () => true);
        const fault = same(all, oracleTris(skeleton), size);
        if (fault) throw new Error(`${where}: ${fault}`);
        n.triangles += all.length;

        // Each clip in turn, out of sight: what it covers disappears.
        for (const { slot, clip } of clipSlots) {
          slot.appliedPose.setAttachment(outOfSight(clip));
          const kept = ourTris(rig, (c) => c !== slot.data.index);
          const faultClip = same(kept, oracleTris(skeleton), size);
          if (faultClip) throw new Error(`${where}, clip ${slot.data.name}: ${faultClip}`);
          n.clipped += all.length - kept.length;
          slot.appliedPose.setAttachment(null);
        }
      }
    }
    return n;
  } finally {
    Skeleton.yDown = false;
  }
}

describe("what the Preview draws against spine-core's renderer", () => {
  it("the stickman export", async () => {
    const { project } = await loadStickman();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = drawCompare("stickman", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.triangles).toBeGreaterThan(1000);
  });

  it("the frog export", async () => {
    const { project } = await loadFixture();
    const exported = exportSpine(project, project.rootSymbolId);
    const r = drawCompare("frog", JSON.parse(spineJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.triangles).toBeGreaterThan(50);
  });

  const samples = sampleRigs();
  for (const rig of samples) {
    it(`sample ${rig.name}`, () => {
      // Some samples draw nothing without a skin; their skins are counted below.
      expect(drawCompare(rig.name, JSON.parse(rig.json), rig.atlas).frames).toBeGreaterThan(0);
    });
    const skins = (((JSON.parse(rig.json) as Json).skins as Json[]) ?? []).map((s) => String(s.name)).filter((s) => s !== "default");
    if (skins.length) {
      it(`sample ${rig.name}, each skin`, () => {
        let triangles = 0;
        for (const skin of skins) triangles += drawCompare(rig.name, JSON.parse(rig.json), rig.atlas, skin, 4).triangles;
        expect(triangles).toBeGreaterThan(0);
      });
    }
  }

  it("the samples exercise clipping", () => {
    if (!samples.length) return;
    let clipped = 0;
    for (const rig of samples) clipped += drawCompare(rig.name, JSON.parse(rig.json), rig.atlas, undefined, 8).clipped;
    expect(clipped).toBeGreaterThan(0);
  });
});
