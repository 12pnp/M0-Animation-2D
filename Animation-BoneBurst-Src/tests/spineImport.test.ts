import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { imagesOf, type SampleRig, sampleRigs } from "./fixtures/spineSamples";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { DEFAULT_EXPORT_SETTINGS } from "@/core/export/settings";

/**
 * Opening a Spine file and exporting it again must play as the original
 * does: spine-core runs both, from the same atlas, and every bone's world
 * matrix, every slot's attachment, colour and dark colour, the draw order
 * and every region's and mesh's world vertices must agree at every whole
 * frame of every animation. The rigs are spine-unity's own samples, from
 * the M0-Animation-2D Unity project around this one (`fixtures/spineSamples.ts`);
 * without them the test is skipped, not passed.
 */

interface Worst { matrix: number; position: number; vertex: number; color: number; frames: number }

/** `skin` shown on both (none: the default skin alone); every `step`th frame. */
function compare(rig: SampleRig, skin?: string, step = 1, nonessential = true): { worst: Worst; baked: number; warnings: string[] } {
  const atlasText = rig.atlas;
  const original = JSON.parse(rig.json);
  const imported = importBoneBurst(original, rig.name, imagesOf(atlasText));
  if (!nonessential) imported.project.exportSettings = { ...DEFAULT_EXPORT_SETTINGS, nonessential: false };
  const exported = exportBoneBurst(imported.project);
  const errors = exported.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`${rig.name}: export refused: ${errors.map((e) => e.message).join("; ")}`);

  const read = (json: unknown) => new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText))).readSkeletonData(json));
  const a = read(original);
  const b = read(JSON.parse(boneburstJson(exported.skeleton)));
  if (skin) { a.setSkin(skin); b.setSkin(skin); }
  const rate = imported.project.frameRate;
  const worst: Worst = { matrix: 0, position: 0, vertex: 0, color: 0, frames: 0 };
  const fail = (where: string, what: string) => { throw new Error(`${rig.name} ${where}: ${what}`); };

  const verts = (sk: Skeleton, slotIndex: number): number[] | null => {
    const slot = sk.slots[slotIndex]!;
    const att = slot.appliedPose.getAttachment();
    if (att instanceof RegionAttachment) {
      const out = new Array<number>(8);
      att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), out, 0, 2);
      return out;
    }
    if (att instanceof MeshAttachment) {
      const out = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, out, 0, 2);
      return out;
    }
    return null;
  };

  const pose = (sk: Skeleton, name: string, t: number) => {
    sk.setupPose();
    sk.data.findAnimation(name)!.apply(sk, 0, t, false, null, 1, MixFrom.setup, false, false, false);
    sk.updateWorldTransform(Physics.reset);
  };

  for (const animA of a.data.animations) {
    const animB = b.data.findAnimation(animA.name);
    if (!animB) fail(animA.name, "animation missing from the export");
    if (Math.abs(animB!.duration - animA.duration) > 1.5 / rate) fail(animA.name, `lasts ${animB!.duration}s, the original ${animA.duration}s`);
    const frames = Math.round(animA.duration * rate);
    for (let f = 0; f <= frames; f += step) {
      const where = `${skin ? `skin "${skin}" ` : ""}"${animA.name}" frame ${f}`;
      // Just after the frame: a file's key at float32(f / rate) may be a
      // hair later than f / rate itself, and it belongs to frame f.
      const t = f / rate + 2e-6;
      pose(a, animA.name, t);
      pose(b, animA.name, t);
      worst.frames++;
      for (const boneA of a.bones) {
        const boneB = b.findBone(boneA.data.name);
        if (!boneB) fail(where, `no bone "${boneA.data.name}"`);
        if (boneA.active !== boneB!.active) fail(where, `bone "${boneA.data.name}" is ${boneB!.active ? "on" : "off"}, the original ${boneA.active ? "on" : "off"}`);
        const p = boneA.appliedPose, q = boneB!.appliedPose;
        const m = Math.max(Math.abs(p.a - q.a), Math.abs(p.b - q.b), Math.abs(p.c - q.c), Math.abs(p.d - q.d));
        const d = Math.max(Math.abs(p.worldX - q.worldX), Math.abs(p.worldY - q.worldY));
        worst.matrix = Math.max(worst.matrix, m);
        worst.position = Math.max(worst.position, d);
        if (m > 2e-3 || d > 0.05) fail(where, `bone "${boneA.data.name}" matrix off by ${m}, position by ${d}`);
      }
      const orderA = a.drawOrder.appliedPose.map((sl) => sl.data.name).join("|");
      const orderB = b.drawOrder.appliedPose.map((sl) => sl.data.name).join("|");
      if (orderA !== orderB) fail(where, `draw order ${orderB} vs ${orderA}`);
      a.slots.forEach((slotA, i) => {
        const slotB = b.findSlot(slotA.data.name);
        if (!slotB) fail(where, `no slot "${slotA.data.name}"`);
        const attA = slotA.appliedPose.getAttachment()?.name ?? null;
        const attB = slotB!.appliedPose.getAttachment()?.name ?? null;
        if (attA !== attB) fail(where, `slot "${slotA.data.name}" shows ${attB}, the original ${attA}`);
        const ca = slotA.appliedPose.color, cb = slotB!.appliedPose.color;
        let c = Math.max(Math.abs(ca.r - cb.r), Math.abs(ca.g - cb.g), Math.abs(ca.b - cb.b), Math.abs(ca.a - cb.a));
        const da = slotA.appliedPose.darkColor, db = slotB!.appliedPose.darkColor;
        if (da && db) c = Math.max(c, Math.abs(da.r - db.r), Math.abs(da.g - db.g), Math.abs(da.b - db.b));
        else if (da && (da.r || da.g || da.b)) fail(where, `slot "${slotA.data.name}" lost its dark colour`);
        worst.color = Math.max(worst.color, c);
        if (c > 3 / 255) fail(where, `slot "${slotA.data.name}" colour off by ${c}`);
        const va = verts(a, i), vb = verts(b, b.slots.indexOf(slotB!));
        if (!va || !vb) return;
        if (va.length !== vb.length) fail(where, `slot "${slotA.data.name}" has ${vb.length / 2} vertices, the original ${va.length / 2}`);
        const v = Math.max(...va.map((x, k) => Math.abs(x - vb[k]!)));
        worst.vertex = Math.max(worst.vertex, v);
        if (v > 0.05) fail(where, `slot "${slotA.data.name}" vertices off by ${v}`);
      });
    }
  }
  return { worst, baked: imported.baked, warnings: imported.diagnostics.map((d) => d.message) };
}

beforeEach(() => reseed());

const found = sampleRigs();

describe.skipIf(found.length === 0)("opening a Spine file and exporting it again", () => {
  it("finds the sample rigs", () => {
    expect(found.length).toBeGreaterThanOrEqual(16);
  });

  // Intervals each rig has written frame by frame today (per-axis curves,
  // pieces of a curve that do not play as the whole). A ratchet: a change
  // that keeps fewer curves fails here; one that keeps more lowers these.
  const BAKED: Record<string, number> = {
    Dragon: 16, Eyes: 0, FootSoldier: 14, Gauge: 0, Goblins: 0, Hero: 82, "Raggedy Spineboy": 1, Raptor: 0,
    Spineunitygirl: 105, Stretchyman: 42, "celestial-circus": 15, "mix-and-match": 17, "raptor-pro-and-mask": 203,
    "spineboy-pro": 27, "spineboy-unity": 62, whirlyblendmodes: 0,
  };

  for (const rig of found) {
    it(`plays ${rig.name} as the original does`, () => {
      const { worst, baked, warnings } = compare(rig);
      console.log(rig.name, JSON.stringify(worst), "baked", baked, warnings.length ? `\n  ${warnings.join("\n  ")}` : "");
      expect(worst.frames).toBeGreaterThan(0);
      expect(baked).toBeLessThanOrEqual(BAKED[rig.name] ?? Infinity);
    });
    it(`plays ${rig.name} as the original does without nonessential data`, () => {
      expect(compare(rig, undefined, 5, false).worst.frames).toBeGreaterThan(0);
    });
    const skins = ((JSON.parse(rig.json).skins ?? []) as Array<{ name: string }>).map((sk) => sk.name).filter((n) => n !== "default");
    if (skins.length) {
      // The skins become the model's (ARCHITECTURE ▸ Skins): each must play as it did.
      it(`plays each of ${rig.name}'s ${skins.length} skins as the original does`, () => {
        for (const skin of skins) expect(compare(rig, skin, 7).worst.frames).toBeGreaterThan(0);
      });
    }
  }
});
